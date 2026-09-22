import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * Auto-approve as a setting of the conversation rather than of the pane.
 *
 * `auto-approve-rules.test.ts` owns what the record does with the field. What only a rendered pane can
 * show is that the toggle is wired to the record at all: that the header toggle writes the choice onto
 * the session on screen, that a session with nothing stored opens off, that a session read back from its
 * file restores what it was left with, and that switching between two sessions keeps each one's own
 * value.
 *
 * The stub keeps a file per session and reads back whatever was written to it, so "switch away and come
 * back" below is a round trip through the same two calls the app makes — a save for the session being
 * left, a load for the one being opened — rather than an assertion about a recorded invocation.
 */

const FIRST_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** Two conversations in the store, one of them open, as main would publish them on startup. */
function sessionStore(activeSessionId: string) {
  return {
    sessions: [FIRST_ID, SECOND_ID].map((id, index) => ({
      id,
      title: id === FIRST_ID ? 'the first conversation' : 'the second conversation',
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })),
    activeSessionId,
  }
}

/** A saved conversation, as a session that has been used and left behind. */
function storedTranscript(autoApprove: boolean): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'user-1', role: 'user', content: 'delete the build folder', steps: [] }],
    autoApprove,
  }
}

/** The transcript files, held in memory and read back exactly as written. */
function transcriptFiles(initial: Record<string, TranscriptSnapshot>) {
  const files: Record<string, TranscriptSnapshot> = { ...initial }
  return {
    files,
    load: (input: unknown) => files[(input as { id: string }).id] ?? null,
    save: (input: unknown) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = snapshot
      return undefined
    },
  }
}

/**
 * The switch itself, in the open.
 *
 * The session list's own row click is covered by `session-actions-wiring` and `session-resume-wiring`.
 * What this file needs is the switch between two conversations, so these buttons call the same
 * `openSession` the workbench hands to the list's `onOpen`.
 */
function SessionSwitch() {
  const sessions = useChatSessionsContext()
  return (
    <div>
      <button type="button" onClick={() => void sessions.openSession(FIRST_ID)}>
        open the first conversation
      </button>
      <button type="button" onClick={() => void sessions.openSession(SECOND_ID)}>
        open the second conversation
      </button>
      <button type="button" onClick={() => sessions.createSession()}>
        start a new conversation
      </button>
    </div>
  )
}

function renderChat(options: { active?: string; files?: Record<string, TranscriptSnapshot> } = {}) {
  const transcripts = transcriptFiles(options.files ?? {})
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: transcripts.load,
    saveTranscript: transcripts.save,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore(options.active ?? FIRST_ID))
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
        <SessionSwitch />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { ...view, stub, transcripts }
}

/** The header's toggle, as the state it reports. */
function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'Auto-approve tool actions' })
}

function isOn(): boolean {
  return toggle().getAttribute('aria-checked') === 'true'
}

/** Wait for the transcript store to have been read, so nothing is asserted before hydration. */
async function hydrated(stub: { methodsOn: (module: string) => string[] }) {
  await waitFor(() => expect(stub.methodsOn('sessions')).toContain('loadTranscript'))
}

describe('the auto-approve toggle', () => {
  it('opens off for a session with no stored value', async () => {
    const { stub } = renderChat()
    await hydrated(stub)

    // No file, no value, no assumption: the toggle's off state is what a session that has never had the
    // setting touched shows.
    expect(isOn()).toBe(false)
  })

  it('opens at the value a rehydrated session was left with', async () => {
    renderChat({ files: { [FIRST_ID]: storedTranscript(true) } })

    await waitFor(() => expect(isOn()).toBe(true))
  })

  it('writes the choice onto the session on screen', async () => {
    const { transcripts } = renderChat()

    await userEvent.click(toggle())

    await waitFor(() => expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true))
    // The record is the transcript's own shape, so the setting is additive: the version a reader was told
    // about is the one it already handles, and nothing is written for the session that was not toggled.
    expect(transcripts.files[FIRST_ID].version).toBe(TRANSCRIPT_VERSION)
    expect(transcripts.files[SECOND_ID]).toBeUndefined()
  })

  it('keeps each session on its own value across a switch', async () => {
    const { transcripts } = renderChat()

    await userEvent.click(toggle())
    await waitFor(() => expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: 'open the second conversation' }))
    // A session with nothing stored opens off, whatever the one before it was left as.
    await waitFor(() => expect(isOn()).toBe(false))

    await userEvent.click(screen.getByRole('button', { name: 'open the first conversation' }))
    await waitFor(() => expect(isOn()).toBe(true))
  })

  it('opens off in a session that has just been created', async () => {
    renderChat({ files: { [FIRST_ID]: storedTranscript(true) } })
    await waitFor(() => expect(isOn()).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: 'start a new conversation' }))

    // A conversation created a moment ago has no record and so no value: whatever the one before it was
    // left as, the session the composer now belongs to opens off.
    await waitFor(() => expect(isOn()).toBe(false))
  })

  it('stores nothing for a session turned back off', async () => {
    const { transcripts } = renderChat({ files: { [FIRST_ID]: storedTranscript(true) } })
    await waitFor(() => expect(isOn()).toBe(true))

    await userEvent.click(toggle())
    await waitFor(() => expect(isOn()).toBe(false))

    // Off is stored as the absence of the key, so the file cannot be read as carrying a decision the user
    // never made — which is what keeps an untouched session's file identical to one written by an older
    // build.
    await waitFor(() => {
      const stored = transcripts.files[FIRST_ID]
      expect(stored === undefined || 'autoApprove' in stored).toBe(false)
    })
  })
})
