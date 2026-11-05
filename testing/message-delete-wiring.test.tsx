import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import type { ChatSessions } from '@/app/components/workbench/use-chat-sessions'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Deleting from a turn, as wiring.
 *
 * The one message action that removes rather than rewrites, so the four claims that need a rendered
 * pane are made here. The affordance exists on both kinds of bubble and asks before acting; the
 * confirmation runs the reducer once and writes once, with the deleted turn ids on the same save so
 * main can prune the episode page; and every refused case — a run in flight, a consent pause, an id
 * that names no turn — leaves the transcript and the disk exactly as they were. Nothing is parked:
 * that is edit and regenerate, and their suites hold it.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window renders no rows at all.
 * The viewport the browser would have measured is stated here, scoped to this file.
 */

const VIEWPORT = { width: 900, height: 800 }

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  for (const [property, value] of [
    ['offsetWidth', VIEWPORT.width],
    ['offsetHeight', VIEWPORT.height],
  ] as const) {
    Object.defineProperty(proto, property, { configurable: true, get: () => value })
  }
})

afterAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  delete proto.offsetWidth
  delete proto.offsetHeight
})

const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333'

const QUESTION = 'set up the parser'
const ANSWER = 'Set up.'
const SECOND_QUESTION = 'refactor the lexer'
const DISCARDED = 'The lexer is rewritten.'
const LATER_QUESTION = 'also update the docs'

/** A conversation with a message of either role in the middle, and turns after them. */
function transcriptTurns(): TranscriptTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [] },
    { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
    { id: 'user-3', role: 'user', content: SECOND_QUESTION, steps: [] },
    { id: 'assistant-4', role: 'assistant', content: DISCARDED, steps: [] },
    { id: 'user-5', role: 'user', content: LATER_QUESTION, steps: [] },
  ]
}

function snapshot(turns: TranscriptTurn[]): TranscriptSnapshot {
  // Key order matches `serializeTranscript`'s, which is what `isDirty` compares: the hook holds the
  // loaded snapshot as "what is on disk", and a fixture written in another order would read as dirty
  // and make an unrelated best-effort save appear in the middle of a delete assertion.
  return { version: TRANSCRIPT_VERSION, turns, interrupted: false }
}

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'an existing conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

interface SaveCall {
  id: string
  snapshot: TranscriptSnapshot
  deletedTurnIds?: string[]
}

/** Transcript files held in memory, read back exactly as written. */
function transcriptFiles(initial: TranscriptSnapshot) {
  const files: Record<string, TranscriptSnapshot> = { [SESSION_ID]: initial }
  return {
    files,
    load: () => files[SESSION_ID] ?? null,
    save: (input: unknown) => {
      const { id, snapshot: written } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = written
      return undefined
    },
  }
}

/**
 * The provider with a capture point, so a test can call the same operations the pane's bubbles do.
 *
 * Reading the latest context value into a ref is the debounce suite's own pattern: the callbacks are
 * re-created as the transcript moves, and a stale reading would assert against the wrong one.
 */
function SessionProbe({ capture }: { capture: (sessions: ChatSessions) => void }) {
  const sessions = useChatSessionsContext()
  capture(sessions)
  return <div data-testid="open-session">{sessions.openId ?? 'none'}</div>
}

/** The panel over a stored conversation, with every run and save recorded. */
function renderChat(options: { turns?: TranscriptTurn[] } = {}) {
  const sent: unknown[] = []
  const transcripts = transcriptFiles(snapshot(options.turns ?? transcriptTurns()))
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: transcripts.load,
    saveTranscript: transcripts.save,
    chatWithTools: (input) => void sent.push(input),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)

  const api = { current: null as ChatSessions | null }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <SessionProbe capture={(sessions) => (api.current = sessions)} />
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { stub, sent, transcripts, api }
}

/** The bubble a message's own text sits in, which is the row its controls belong to. */
function bubbleOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[data-slot="message-row"]')
  if (!row) throw new Error(`no bubble row around ${text}`)
  return row as HTMLElement
}

/** The from-here controls on screen, in transcript order. */
function deleteButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: 'Delete from here' })
}

function saveCalls(stub: BridgeStub): SaveCall[] {
  return stub
    .callsTo('sessions')
    .filter((call) => call.method === 'saveTranscript')
    .map((call) => call.args[0] as SaveCall)
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(deleteButtons().length).toBe(5))
}

/** The channel main's chunks arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub, which = 0): Promise<string> {
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length <= which) throw new Error(`no stream started at ${which}`)
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[which]
  return `conveyor:stream:${started?.method}`
}

/** Begin a run, so the pane has a turn in flight. */
async function startRun(stub: BridgeStub): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), 'one more thing{Enter}')
  return streamChannel(stub)
}

describe('the from-here affordance', () => {
  it('opens a confirmation that names the scope, and differs by which role is deleted', async () => {
    renderChat()
    await loaded()

    await userEvent.click(within(bubbleOf(SECOND_QUESTION)).getByRole('button', { name: 'Delete from here' }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete this message and everything after it?')).toBeTruthy()
    // This question, the reply after it and the message after that.
    expect(within(dialog).getByText(/3 turns/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await userEvent.click(within(bubbleOf(ANSWER)).getByRole('button', { name: 'Delete from here' }))
    dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete this reply and everything after it?')).toBeTruthy()
    // The reply and the three turns after it.
    expect(within(dialog).getByText(/4 turns/)).toBeTruthy()
  })

  it('removes the range through the reducer, and saves exactly once', async () => {
    const { stub, transcripts, api } = renderChat()
    await loaded()

    await userEvent.click(within(bubbleOf(SECOND_QUESTION)).getByRole('button', { name: 'Delete from here' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // One write, and it is the delete's: the immediate save, carrying the ids main prunes episodes for.
    await waitFor(() => expect(saveCalls(stub)).toHaveLength(1))
    const call = saveCalls(stub)[0]
    expect(call.id).toBe(SESSION_ID)
    expect(call.snapshot.turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2'])
    expect(call.deletedTurnIds).toEqual(['user-3', 'assistant-4', 'user-5'])
    expect(call.snapshot.version).toBe(TRANSCRIPT_VERSION)

    // The pane shows the surviving prefix: the removed words are gone, not parked behind a switcher.
    expect(screen.queryByText(SECOND_QUESTION)).toBeNull()
    expect(screen.queryByText(DISCARDED)).toBeNull()
    expect(screen.queryByText(LATER_QUESTION)).toBeNull()
    expect(screen.getByText(QUESTION)).toBeTruthy()
    expect(screen.queryByText('2/2')).toBeNull()

    // And the file is the shrunk conversation, not the one that was there before the click.
    expect(transcripts.files[SESSION_ID].turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2'])
    expect(api.current?.transcript.turns).toHaveLength(2)
  })

  it('reopens as a blank conversation when the first turn is deleted', async () => {
    const { stub, transcripts } = renderChat()
    await loaded()

    await userEvent.click(within(bubbleOf(QUESTION)).getByRole('button', { name: 'Delete from here' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/5 turns/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(saveCalls(stub)).toHaveLength(1))
    expect(saveCalls(stub)[0].snapshot.turns).toEqual([])
    expect(transcripts.files[SESSION_ID].turns).toEqual([])
    // The empty state is what a reopened conversation holds, not the turns that were there.
    expect(screen.getByText('Start a conversation')).toBeTruthy()
  })
})

describe('a refused from-here delete', () => {
  it('performs no mutation and no save while a run is live', async () => {
    const { stub, api } = renderChat()
    await loaded()

    const channel = await startRun(stub)
    await waitFor(() => expect(deleteButtons()).toHaveLength(0))

    // The pane hides the control; the operation behind it refuses for the same reason, so a stale
    // click cannot remove a turn the running stream is still writing around.
    await act(async () => {
      await api.current?.deleteFromHere('user-1')
    })
    expect(saveCalls(stub)).toHaveLength(0)
    expect(api.current?.transcript.turns.some((turn) => turn.id === 'user-1')).toBe(true)

    stub.emit(channel, { type: 'end' })
  })

  it('performs no mutation and no save while a consent pause waits', async () => {
    const { stub, api } = renderChat()
    await loaded()

    const channel = await startRun(stub)
    stub.emit(channel, {
      type: 'data',
      value: { type: 'tool_call_start', callId: 'call-9', tool: 'write_file', args: { path: 'src/x.ts' } },
    })
    stub.emit(channel, {
      type: 'data',
      value: {
        type: 'awaiting_approval',
        callId: 'call-9',
        tool: 'write_file',
        messages: [],
        steps: 0,
        calls: [{ id: 'call-9', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
      },
    })

    // A pause has not ended its turn, so the transcript is still moving.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Approve' }).length).toBe(1))
    expect(deleteButtons()).toHaveLength(0)

    await act(async () => {
      await api.current?.deleteFromHere('assistant-2')
    })
    expect(saveCalls(stub)).toHaveLength(0)
    expect(api.current?.transcript.turns.some((turn) => turn.id === 'assistant-2')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const resumed = await streamChannel(stub, 1)
    stub.emit(resumed, { type: 'end' })
  })

  it('treats an id that names no turn as nothing to do', async () => {
    const { stub, api } = renderChat()
    await loaded()

    await act(async () => {
      await api.current?.deleteFromHere('ghost')
    })

    expect(saveCalls(stub)).toHaveLength(0)
    expect(api.current?.transcript.turns).toHaveLength(5)
  })
})
