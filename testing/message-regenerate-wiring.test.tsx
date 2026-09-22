import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Regenerating a reply, as wiring.
 *
 * Three claims are made here, and each needs a rendered pane to be real. The first is the affordance: a
 * regenerate control on an agent bubble, and on a *reply* only — a control that needs a reply to act on
 * has no business on the user's own message, and one offered mid-run would be offering to replace a turn
 * that is still being written. The second is what the run is: the discarded reply and everything after it
 * go, and the agent continues from the message that reply was answering — with no second copy of that
 * message sent on the user's behalf, because the user did not say anything new. The third is that the cut
 * reaches the record on disk, not only the screen.
 *
 * The history assertion is made against the payload itself rather than against a count of turns on
 * screen. "Re-ran on the remaining history" is a claim about what the loop was handed, and the only place
 * that is checkable is the argument `chatWithTools` received — the transcript it renders afterwards would
 * look identical if the pane had appended a duplicate user message to the history it sent.
 *
 * The mention chips are asserted for the same reason requirement by requirement as the edit suite does:
 * a regenerate sends no message of its own, so the files the run reads have to come from the turn whose
 * reply is being replaced, and a payload without them would quietly answer the same question with less
 * context than the first attempt had.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window renders no rows at all.
 * The transcript is the whole subject of this suite, so the viewport the browser would have measured is
 * stated here. Scoped to this file, and restored afterwards.
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

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

const QUESTION = 'set up the parser'
const ANSWER = 'Set up.'
const SECOND_QUESTION = 'refactor the lexer'
const DISCARDED = 'The lexer is rewritten.'
const LATER_QUESTION = 'also update the docs'
const CHIPS = ['src/lexer.ts']

/**
 * A conversation whose last turn is a reply, and nothing else.
 *
 * The reply at the end carries a tool card and a plan on purpose: those are the pieces of a turn that are
 * not prose, and a regenerate that dropped the paragraph while leaving a card and a checklist claiming
 * work that has been removed would be the visible half of getting this wrong.
 */
function transcriptTurns(): TranscriptTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [] },
    { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
    {
      id: 'user-3',
      role: 'user',
      content: SECOND_QUESTION,
      steps: [],
      mentionPaths: [...CHIPS],
    },
    {
      id: 'assistant-4',
      role: 'assistant',
      content: DISCARDED,
      steps: [{ callId: 'call-4', tool: 'read_file', args: { path: 'src/lexer.ts' }, status: 'ok', output: 'body' }],
      plan: [{ id: 'plan-4', text: 'Rewrite the lexer', status: 'done' }],
    },
  ]
}

/** The same conversation, with a message after the last reply. */
function withLaterTurn(): TranscriptTurn[] {
  return [...transcriptTurns(), { id: 'user-5', role: 'user', content: LATER_QUESTION, steps: [] }]
}

function snapshot(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
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

/** The panel over a stored conversation, with every run recorded. */
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

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { stub, sent, transcripts }
}

/** The regenerate controls on screen, in transcript order. */
function regenerateButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: 'Regenerate reply' })
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(regenerateButtons().length).toBeGreaterThan(0))
}

/**
 * The channel main's chunks arrive on, read from the recorded start call rather than guessed.
 *
 * `which` picks the start by position: a run that pauses and is decided opens a *second* stream, and the
 * chunks that belong to the resumed part of the turn arrive on that one rather than on the first.
 */
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

/** The last run the panel asked for, as the payload main would have validated. */
function lastRun(sent: unknown[]): { messages: { role: string; content: string }[]; mentionPaths?: string[] } {
  return sent[sent.length - 1] as { messages: { role: string; content: string }[]; mentionPaths?: string[] }
}

describe('the regenerate affordance', () => {
  it('offers a named regenerate button on every reply, and none on a user message', async () => {
    // The conversation ends on a user message, so it offers no target of its own: two replies mean two
    // controls, and the message after them is not one of them.
    renderChat({ turns: withLaterTurn() })
    await loaded()

    expect(regenerateButtons().length).toBe(2)
  })

  it('is absent mid-run and while a decision is pending, and back once the run ends', async () => {
    const { stub } = renderChat()
    await loaded()

    const channel = await startRun(stub)

    // Every reply, not only the streaming one: a run in flight is producing the very turns a regenerate
    // would discard.
    await waitFor(() => expect(regenerateButtons().length).toBe(0))

    stub.emit(channel, {
      type: 'data',
      value: { type: 'tool_call_start', callId: 'call-9', tool: 'write_file', args: { path: 'src/lexer.ts' } },
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

    // A pause has not ended its turn, so the conversation is still moving and nothing may be replaced.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Approve' }).length).toBe(1))
    expect(regenerateButtons().length).toBe(0)

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const resumed = await streamChannel(stub, 1)
    expect(regenerateButtons().length).toBe(0)

    stub.emit(resumed, { type: 'end' })

    // Answered, so the conversation can be regenerated again.
    await waitFor(() => expect(regenerateButtons().length).toBeGreaterThan(0))
  })
})

describe('regenerating the last reply', () => {
  it('runs the loop on the history that excludes it, without sending a message of its own', async () => {
    const { stub, sent, transcripts } = renderChat()
    await loaded()

    // The last reply, so there is nothing after it to remove and nothing to ask about.
    await userEvent.click(regenerateButtons()[1])
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await waitFor(() => expect(sent.length).toBe(1))
    const payload = lastRun(sent)

    // The history the loop was handed: the turns before the discarded reply, in order, and no fourth
    // entry — a regenerate does not append a user message, so the second question appears exactly once.
    expect(payload.messages).toEqual([
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: ANSWER },
      { role: 'user', content: SECOND_QUESTION },
    ])
    // The files that question attached, carried again by the run that answers it a second time.
    expect(payload.mentionPaths).toEqual(CHIPS)

    // And the reply that was discarded is gone from the screen, with the card and the plan it carried:
    // the checklist is recomputed from the turns that are left rather than kept beside them.
    expect(screen.queryByText(DISCARDED)).toBeNull()
    expect(screen.queryByText('Reading src/lexer.ts')).toBeNull()
    expect(screen.queryByText('Rewrite the lexer')).toBeNull()

    // The fresh reply is a turn the stream addresses: chunks land in it and are drawn.
    const channel = await streamChannel(stub)
    stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: 'Let me look again.' } })
    await waitFor(() => expect(screen.getByText('Let me look again.')).toBeTruthy())

    // Written through the same save path a turn boundary uses, so the cut is on disk and not only on
    // screen — and the file is still the version this build reads.
    await waitFor(() => {
      const stored = transcripts.files[SESSION_ID]
      expect(stored.turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2', 'user-3'])
      expect(stored.version).toBe(TRANSCRIPT_VERSION)
    })
  })
})

describe('regenerating an earlier reply', () => {
  it('asks first, naming how many turns will be removed, and proceeds on confirm', async () => {
    const { stub, sent } = renderChat({ turns: withLaterTurn() })
    await loaded()

    // The first reply of the conversation, with three turns after it.
    await userEvent.click(regenerateButtons()[0])

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('3 later turns will be removed from this conversation.')).toBeTruthy()

    // Nothing has run yet: the dialog is the whole point of asking before the cut.
    expect(sent.length).toBe(0)
    expect(stub.methodsOn('agent')).not.toContain('chatWithTools')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => expect(sent.length).toBe(1))
    // Everything after that reply went with it, and the history ends at the message it was answering.
    expect(lastRun(sent).messages).toEqual([{ role: 'user', content: QUESTION }])
    expect(screen.queryByText(SECOND_QUESTION)).toBeNull()
    expect(screen.queryByText(DISCARDED)).toBeNull()
    expect(screen.queryByText(LATER_QUESTION)).toBeNull()
    expect(screen.getByText(QUESTION)).toBeTruthy()
  })

  it('leaves the conversation untouched when the dialog is cancelled', async () => {
    const { stub, transcripts } = renderChat({ turns: withLaterTurn() })
    await loaded()

    await userEvent.click(regenerateButtons()[0])
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    // The transcript is as it was: the reply that was about to be replaced, and every turn after it.
    expect(screen.getByText(ANSWER)).toBeTruthy()
    expect(screen.getByText(SECOND_QUESTION)).toBeTruthy()
    expect(screen.getByText(LATER_QUESTION)).toBeTruthy()
    expect(stub.methodsOn('agent')).not.toContain('chatWithTools')
    expect(transcripts.files[SESSION_ID].turns.map((turn) => turn.id)).toEqual([
      'user-1',
      'assistant-2',
      'user-3',
      'assistant-4',
      'user-5',
    ])
  })
})
