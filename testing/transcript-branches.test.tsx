import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The transcript's branch points, drawn.
 *
 * An edit and a regenerate are branch points: the tail they replace — the question, its answer, and
 * every turn after them — is parked rather than overwritten, and a single switcher at that turn walks
 * the whole checked-out trail from there. This suite holds the four claims that need a rendered pane:
 * a rewrite parks the old tail and the pane shows the branch it is on, and walking the switcher back
 * checks out the trail that was parked, from that turn onward, in both directions.
 *
 * The switch is asserted on the trail as well as on the screen, because "the whole conversation moves,
 * not one bubble's words" is the claim this model replaces the old per-message pager with — and the
 * record is where that is checkable without trusting the rendering of it.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window renders no rows at all.
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

const SESSION_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

const QUESTION = 'set up the parser'
const EDITED_TARGET = 'refactor the lexer'
const EDITED_TEXT = 'refactor the lexer, and keep the tokens split'
const AFTER_TEXT = 'and the readme?'
const ANSWER = 'Set up.'
const DISCARDED = 'The lexer is rewritten.'
const REWRITTEN = 'Tokens split.'

/**
 * A conversation with a message in the middle to rewrite, and turns after it to park.
 *
 * The reply after the edit target carries a tool card and a finished plan on purpose: they are the
 * pieces of a tail that are not prose, and a branch that parked the words while leaving the work of an
 * answer on screen would be the visible half of getting this wrong.
 */
function transcriptTurns(): TranscriptTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [], mentionPaths: ['src/parser.ts'] },
    { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
    {
      id: 'user-3',
      role: 'user',
      content: EDITED_TARGET,
      steps: [],
      mentionPaths: ['src/lexer.ts', 'src/tokens.ts'],
    },
    {
      id: 'assistant-4',
      role: 'assistant',
      content: DISCARDED,
      steps: [{ callId: 'call-4', tool: 'read_file', args: { path: 'src/lexer.ts' }, status: 'ok', output: 'body' }],
      plan: [{ id: 'plan-4', text: 'Rewrite the lexer', status: 'done' }],
    },
    { id: 'user-5', role: 'user', content: AFTER_TEXT, steps: [] },
  ]
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
function renderChat() {
  const sent: unknown[] = []
  const transcripts = transcriptFiles(snapshot(transcriptTurns()))
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

/** The bubble a message's own text sits in, which is the row its controls belong to. */
function bubbleOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[data-slot="message-row"]')
  if (!row) throw new Error(`no bubble row around ${text}`)
  return row as HTMLElement
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Edit message' }).length).toBeGreaterThan(0))
}

/** The channel main's chunks arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub): Promise<string> {
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length === 0) throw new Error('no stream started')
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[0]
  return `conveyor:stream:${started?.method}`
}

/** Rewrite the middle question and let its new reply land. */
async function rewriteTheQuestion(stub: BridgeStub): Promise<void> {
  await userEvent.click(screen.queryAllByRole('button', { name: 'Edit message' })[1])
  const area = (await screen.findByLabelText('Edit message text')) as HTMLTextAreaElement
  await userEvent.clear(area)
  await userEvent.type(area, EDITED_TEXT)
  await userEvent.click(screen.getByRole('button', { name: 'Save and resend' }))

  const channel = await streamChannel(stub)
  stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: REWRITTEN } })
  stub.emit(channel, { type: 'end' })
  await waitFor(() => expect(screen.getByText(REWRITTEN)).toBeTruthy())
}

/** Write the first reply again and let its new answer land. */
async function regenerateTheReply(stub: BridgeStub): Promise<void> {
  await userEvent.click(screen.queryAllByRole('button', { name: 'Regenerate reply' })[0])

  const channel = await streamChannel(stub)
  stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: 'Set up, again.' } })
  stub.emit(channel, { type: 'end' })
  await waitFor(() => expect(screen.getByText('Set up, again.')).toBeTruthy())
}

describe('an edit as a branch point', () => {
  it('parks the old tail, and the switcher at that turn reads 2/2', async () => {
    const { stub, transcripts } = renderChat()
    await loaded()

    await rewriteTheQuestion(stub)

    // The conversation the pane shows is the branch it checked out: the edited question, the reply
    // written again for it, and nothing after them. The message that followed is in the parked tail.
    expect(screen.queryByText(AFTER_TEXT)).toBeNull()
    expect(screen.queryByText(EDITED_TARGET)).toBeNull()
    // One switcher, at the branch point, saying which of the two trails is on screen.
    const row = bubbleOf(EDITED_TEXT)
    await waitFor(() => expect(within(row).getByText('2/2')).toBeTruthy())
    expect(screen.queryAllByText(/^\d+\/\d+$/).length).toBe(1)

    // And the record holds both tails: the checked-out one in `turns`, the parked one behind it.
    const stored = transcripts.files[SESSION_ID]
    expect(stored.turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2', 'user-3', 'assistant-4'])
    const head = stored.turns[2]
    expect(head.branchPoints?.map((tail) => tail.turns.map((turn) => turn.id))).toEqual([
      ['user-3', 'assistant-4', 'user-5'],
    ])
    expect(head.branch).toBe(1)
    expect(head.branchPoints?.[0]?.turns[0]?.content).toBe(EDITED_TARGET)
  })

  it('swaps the whole trail from that turn when the switcher is walked back to 1', async () => {
    const { stub } = renderChat()
    await loaded()

    await rewriteTheQuestion(stub)
    const row = bubbleOf(EDITED_TEXT)
    await waitFor(() => expect(within(row).getByText('2/2')).toBeTruthy())

    await userEvent.click(within(row).getByRole('button', { name: 'Previous branch' }))

    // The branch point's own message is the one that was parked, with its chips, and everything the
    // trail carried after it is back — the answer written from those words and the message after it.
    expect(within(bubbleOf(EDITED_TARGET)).getByText('1/2')).toBeTruthy()
    expect(screen.getByText(DISCARDED)).toBeTruthy()
    expect(screen.getByText(AFTER_TEXT)).toBeTruthy()
    expect(screen.getByText('Reading src/lexer.ts')).toBeTruthy()
    // And what the other branch wrote is gone from the pane, not merely dimmed.
    expect(screen.queryByText(EDITED_TEXT)).toBeNull()
    expect(screen.queryByText(REWRITTEN)).toBeNull()
  })
})

describe('a regenerate as a branch point', () => {
  it('parks the old tail, and the switcher at that turn reads 2/2', async () => {
    const { stub, transcripts } = renderChat()
    await loaded()

    await regenerateTheReply(stub)

    expect(screen.queryByText(EDITED_TARGET)).toBeNull()
    expect(screen.queryByText(DISCARDED)).toBeNull()
    const row = bubbleOf('Set up, again.')
    await waitFor(() => expect(within(row).getByText('2/2')).toBeTruthy())
    expect(screen.queryAllByText(/^\d+\/\d+$/).length).toBe(1)

    // The question is untouched and stays in the checked-out trail; the reply and everything after it
    // are the parked tail, in the order they were spoken.
    const stored = transcripts.files[SESSION_ID]
    expect(stored.turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2'])
    const head = stored.turns[1]
    expect(head.branchPoints?.map((tail) => tail.turns.map((turn) => turn.id))).toEqual([
      ['assistant-2', 'user-3', 'assistant-4', 'user-5'],
    ])
    expect(head.branch).toBe(1)
    expect(head.branchPoints?.[0]?.turns[0]?.content).toBe(ANSWER)
  })

  it('swaps the whole trail from that turn when the switcher is walked back to 1', async () => {
    const { stub } = renderChat()
    await loaded()

    await regenerateTheReply(stub)
    const row = bubbleOf('Set up, again.')
    await waitFor(() => expect(within(row).getByText('2/2')).toBeTruthy())

    await userEvent.click(within(row).getByRole('button', { name: 'Previous branch' }))

    // The answer that was, and every turn that followed it — the conversation the regenerate parked,
    // back under the same question, which was never part of the branch.
    expect(within(bubbleOf(ANSWER)).getByText('1/2')).toBeTruthy()
    expect(screen.getByText(EDITED_TARGET)).toBeTruthy()
    expect(screen.getByText(DISCARDED)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(AFTER_TEXT)).toBeTruthy())
    expect(screen.queryByText('Set up, again.')).toBeNull()
  })
})
