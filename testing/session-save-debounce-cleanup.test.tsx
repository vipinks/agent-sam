import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import type { ChatSessions } from '@/app/components/workbench/use-chat-sessions'
import { SAVE_DEBOUNCE_MS } from '@/app/components/workbench/session-rules'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The debounced save's lifetime, as the hook actually runs it.
 *
 * A pending timer and an in-flight IPC write both outlive the render that started them. The first must
 * be cancelled when the hook goes away; the second must not mark its snapshot saved after the hook has
 * gone away. A session switch has the same race from the other side: a timer queued for the old session
 * must not wake up and write whichever transcript is current.
 *
 * The tests drive the session context rather than the debounce helper, because the defect is in the
 * hook's ownership of that helper. T2 observes the guard through its behavioral consequence — a second
 * `saveNow` still sees the transcript as dirty and writes again — rather than reaching into a ref.
 */

const FIRST_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

const FIRST_TURN: TranscriptTurn = { id: 'user-1', role: 'user', content: 'the first message', steps: [] }
const SECOND_TURN: TranscriptTurn = { id: 'user-2', role: 'user', content: 'the second message', steps: [] }

function snapshot(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
}

function sessionStore() {
  return {
    sessions: [
      {
        id: FIRST_ID,
        title: 'the first conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
      {
        id: SECOND_ID,
        title: 'the second conversation',
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_001,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId: FIRST_ID,
  }
}

interface SaveCall {
  id: string
  snapshot: TranscriptSnapshot
}

function saveCalls(stub: BridgeStub): SaveCall[] {
  return stub
    .callsTo('sessions')
    .filter((call) => call.method === 'saveTranscript')
    .map((call) => call.args[0] as SaveCall)
}

/**
 * The provider with a capture point, so a test can call the same operations its consumers do.
 *
 * Reading the latest context value into a ref is deliberate: the render after a session switch is the
 * one whose `openId` and callbacks describe the new session, and a stale reading would make T3 assert
 * against the wrong transcript.
 */
function SessionProbe({ capture }: { capture: (sessions: ChatSessions) => void }) {
  const sessions = useChatSessionsContext()
  capture(sessions)
  return <div data-testid="open-session">{sessions.openId ?? 'none'}</div>
}

function renderSessions(saveTranscript?: (input: unknown) => unknown, deleteTranscript?: (input: unknown) => unknown) {
  const files: Record<string, TranscriptSnapshot> = {
    [FIRST_ID]: snapshot([FIRST_TURN]),
    [SECOND_ID]: snapshot([SECOND_TURN]),
  }
  const stub = createBridgeStub({
    loadTranscript: (input) => files[(input as { id: string }).id] ?? null,
    saveTranscript:
      saveTranscript ??
      ((input) => {
        const { id, snapshot: written } = input as SaveCall
        files[id] = written
        return undefined
      }),
    deleteTranscript: deleteTranscript ?? (() => undefined),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore())
  setActiveStub(stub)

  const api = { current: null as ChatSessions | null }
  const view = render(
    <ChatSessionsProvider>
      <SessionProbe capture={(sessions) => (api.current = sessions)} />
    </ChatSessionsProvider>
  )

  return { ...view, api, stub }
}

async function hydrated(api: { current: ChatSessions | null }, id = FIRST_ID): Promise<void> {
  await waitFor(() => expect(api.current?.openId).toBe(id))
}

/** Change the message on screen, and optionally queue the save that change belongs to. */
function changeMessage(api: { current: ChatSessions | null }, content: string, schedule: boolean): void {
  act(() => {
    const sessions = api.current
    if (!sessions) throw new Error('the session context has not rendered')
    sessions.setTurns([...sessions.transcript.turns, { id: `user-${content}`, role: 'user', content, steps: [] }])
    if (schedule) sessions.scheduleSave()
  })
}

/** Let the real debounce window pass and its IPC chain settle. */
async function afterDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100))
}

describe('a debounced session save that outlives its render', () => {
  it('T1: cancels the timer when the hook unmounts', async () => {
    const { api, stub, unmount } = renderSessions()
    await hydrated(api)

    changeMessage(api, 'scheduled before unmount', true)
    unmount()
    await afterDebounce()

    // The transcript change queued a write, but its owner is gone. Letting the timer wake up would
    // write a session from a hook that can no longer tell the user anything about the result.
    expect(saveCalls(stub)).toHaveLength(0)
  })

  it('T2: does not mark an in-flight save as saved after unmount', async () => {
    let resolveWrite: (() => void) | undefined
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    const saveTranscript = vi.fn(() => write)
    const { api, stub, unmount } = renderSessions(saveTranscript)
    await hydrated(api)

    changeMessage(api, 'dirty while the write is in flight', true)

    // The timer has fired and the IPC write is parked on `write`; unmount before it resolves.
    await waitFor(() => expect(saveTranscript).toHaveBeenCalledTimes(1), { timeout: SAVE_DEBOUNCE_MS + 1000 })
    unmount()
    await act(async () => {
      resolveWrite?.()
      await write
    })

    // If the completed write had set `savedRef`, this second call would be a no-op. The transcript is
    // still dirty to an unmounted hook that did not record its snapshot, so it must ask again.
    await act(async () => {
      await api.current?.saveNow()
    })
    expect(saveTranscript).toHaveBeenCalledTimes(2)
    expect(saveCalls(stub)).toHaveLength(2)
  })

  it('T3: cancels an old session timer before the switch can make it write the new session', async () => {
    const { api, stub } = renderSessions()
    await hydrated(api)

    changeMessage(api, 'queued while the first conversation is open', true)
    await act(async () => {
      await api.current?.openSession(SECOND_ID)
    })
    expect(api.current?.openId).toBe(SECOND_ID)

    // Switching saved the first conversation immediately. Its debounce must not still be queued.
    expect(saveCalls(stub).map((call) => call.id)).toEqual([FIRST_ID])

    // The new conversation is changed before the old timer's original deadline. If that timer survived
    // the switch, it would wake now and persist a transcript the queued save never belonged to.
    changeMessage(api, 'changed in the second conversation', false)
    await afterDebounce()

    expect(saveCalls(stub).map((call) => call.id)).toEqual([FIRST_ID])
  })

  it('T1: cancels a pre-home timer before it can write the next conversation', async () => {
    const { api, stub } = renderSessions()
    await hydrated(api)

    changeMessage(api, 'queued before going home', true)
    act(() => {
      api.current?.goHome()
    })
    expect(api.current?.openId).toBeNull()

    // `goHome` writes the conversation it is leaving immediately. That write is not the stale one;
    // every call after this point would be the timer waking against something it was not queued for.
    const callsAtHome = saveCalls(stub).length

    // Start another conversation inside the first timer's window. Without a cancel, the timer wakes
    // with this conversation's id and transcript, or with the old id if the store broadcast has not
    // landed yet, and writes a snapshot its schedule never belonged to.
    act(() => {
      api.current?.createSession()
    })
    changeMessage(api, 'written after going home', false)
    await afterDebounce()

    expect(saveCalls(stub).slice(callsAtHome)).toEqual([])
  })

  it('T2: cancels the active-session timer before deleting that session', async () => {
    let finishDelete: (() => void) | undefined
    const deletion = new Promise<void>((resolve) => {
      finishDelete = resolve
    })
    const { api, stub } = renderSessions(undefined, () => deletion)
    await hydrated(api)

    changeMessage(api, 'queued before deleting the conversation', true)

    let deleting: Promise<void> | undefined
    act(() => {
      deleting = api.current?.deleteSession(FIRST_ID)
    })

    // Main is still deleting while the original debounce deadline arrives. The metadata command has
    // already removed the row, so a save here would recreate the file of a conversation that is gone.
    await afterDebounce()
    expect(saveCalls(stub)).toHaveLength(0)

    await act(async () => {
      finishDelete?.()
      await deleting
    })
  })
})
