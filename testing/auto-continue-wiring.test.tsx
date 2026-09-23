import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { AUTO_CONTINUE_MAX } from '@/conveyor/protocol/turn-end'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Bounded auto-continue, as wiring rather than as rules.
 *
 * The rule that decides whether a turn continues itself is tested directly in
 * `turn-end-rules.test.ts`, and the loop that applies it is tested against a mocked provider in
 * `tests/agent/auto-continue-test.ts`. What is left here is what only the pane can get wrong: that
 * the chunk the loop sends becomes a line the user can read, that the line sits where the resumed
 * work begins, that the plan-unfinished card still appears exactly once the budget is spent, and
 * that the count is per turn rather than carried across sends.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the assertions are made
 * against what a run actually delivers rather than against a prop drilled into a component.
 */

const SESSION_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** A viewport for the virtualized transcript, which jsdom does not have. */
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
  // Deleted rather than redefined, so jsdom's own accessor is what any later reader sees.
  delete proto.offsetWidth
  delete proto.offsetHeight
})

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

function stubChat(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({ chatWithTools: () => undefined, ...overrides })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)
  return stub
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

/** The channel main's chunks would arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub, index = 0): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[index]
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** One `read_file` call as a run delivers it: announced, then answered. */
function readCall(stub: BridgeStub, channel: string, callId: string, path: string): void {
  chunk(stub, channel, { type: 'tool_call_start', callId, tool: 'read_file', args: { path } })
  chunk(stub, channel, { type: 'tool_result', callId, tool: 'read_file', ok: true, output: 'const x = 1' })
}

const PLAN = [
  { id: 'read', text: 'Read the parser', status: 'done' },
  { id: 'edit', text: 'Change the precedence table', status: 'pending' },
]

describe('bounded auto-continue', () => {
  it('writes the continuation into the transcript as a line the user can read', async () => {
    const stub = stubChat()
    renderChat()
    await userEvent.type(await composer(), 'refactor the parser{Enter}')
    const channel = await streamChannel(stub)

    chunk(stub, channel, { type: 'plan', plan: PLAN })
    chunk(stub, channel, { type: 'text_delta', text: 'I have started on the precedence table.' })
    // The model stopped with work left on its plan: the loop nudges it rather than ending the turn,
    // and says so where the resumed work begins.
    chunk(stub, channel, { type: 'auto_continue', count: 1, max: AUTO_CONTINUE_MAX })
    readCall(stub, channel, 'c1', 'src/parser.ts')
    chunk(stub, channel, { type: 'text_delta', text: 'The table is on line 12.' })
    // And the resumed stretch finishes the work, which is the whole point of nudging it: the plan is
    // done by the time the turn ends, so there is nothing left for a card to announce.
    chunk(stub, channel, {
      type: 'plan',
      plan: [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
      ],
    })
    chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, channel, { type: 'done', reason: 'complete', steps: 3 })
    stub.emit(channel, { type: 'end' })

    const marker = await screen.findByText(`Auto-continuing — 1 of ${AUTO_CONTINUE_MAX}`)
    // The count is the chunk's, rendered as it arrived: the pane is not counting anything itself.
    expect(screen.queryByText('Auto-continuing — 2 of 4')).toBeNull()

    // It sits at the seam: the resumed call is carded under it, so the line reads as the boundary it
    // is rather than as a comment on the answer above.
    const card = await screen.findByText('Reading src/parser.ts')
    expect(marker.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // And the whole thing is still one turn with no card: the nudge is main's, and the user is never
    // shown a second message that they did not type.
    expect(await screen.findByText('The table is on line 12.')).toBeTruthy()
    expect(screen.queryByText(/Ended with the plan unfinished/)).toBeNull()
    expect(screen.queryByText(/You stopped with/)).toBeNull()
  })

  it('shows the plan-unfinished card only once the budget is spent', async () => {
    const stub = stubChat()
    renderChat()
    await userEvent.type(await composer(), 'refactor the parser{Enter}')
    const channel = await streamChannel(stub)

    chunk(stub, channel, { type: 'plan', plan: PLAN })
    for (let count = 1; count <= AUTO_CONTINUE_MAX; count += 1) {
      chunk(stub, channel, { type: 'text_delta', text: `Pass ${count}. ` })
      chunk(stub, channel, { type: 'auto_continue', count, max: AUTO_CONTINUE_MAX })
    }

    // The spend is visible, and nothing has been claimed about the ending: a card raised while the
    // loop was still going would be telling the user the turn was over when it was not.
    expect(await screen.findByText(`Auto-continuing — ${AUTO_CONTINUE_MAX} of ${AUTO_CONTINUE_MAX}`)).toBeTruthy()
    expect(screen.queryByText(/Ended with the plan unfinished/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()

    // The fifth stop is the one the loop will not nudge: it ends the turn, and the card is the card
    // this app already had, in the same words.
    chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, channel, { type: 'turn_end_notice', cause: 'model_stop', resumable: true, unfinishedSteps: 1 })
    chunk(stub, channel, { type: 'done', reason: 'complete', steps: 5 })
    stub.emit(channel, { type: 'end' })

    expect(await screen.findByText('Ended with the plan unfinished — 1 step remain')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('starts the count over on a real send, because the budget belongs to one turn', async () => {
    const stub = stubChat()
    renderChat()
    const composerField = await composer()
    await userEvent.type(composerField, 'refactor the parser{Enter}')
    const first = await streamChannel(stub)

    for (let count = 1; count <= 3; count += 1) {
      chunk(stub, first, { type: 'auto_continue', count, max: AUTO_CONTINUE_MAX })
    }
    chunk(stub, first, { type: 'turn_end_notice', cause: 'model_stop', resumable: true, unfinishedSteps: 1 })
    chunk(stub, first, { type: 'done', reason: 'complete', steps: 4 })
    stub.emit(first, { type: 'end' })
    expect(await screen.findByText(`Auto-continuing — 3 of ${AUTO_CONTINUE_MAX}`)).toBeTruthy()

    // A second message is a second turn: the loop starts its own budget, so what arrives is a count
    // of one. A pane that remembered the first turn's count would render four and be wrong.
    await userEvent.type(await composer(), 'and now the lexer{Enter}')
    const second = await streamChannel(stub, 1)
    chunk(stub, second, { type: 'auto_continue', count: 1, max: AUTO_CONTINUE_MAX })
    stub.emit(second, { type: 'end' })

    expect(await screen.findByText(`Auto-continuing — 1 of ${AUTO_CONTINUE_MAX}`)).toBeTruthy()
  })

  it('draws the seams a reopened transcript was saved with', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Still working on the table.',
          steps: [],
          // Two seams, as the save kept them: a turn that picked itself up twice is not one
          // uninterrupted answer, and the reply cannot say so — only the record can.
          continuations: [
            { count: 1, max: AUTO_CONTINUE_MAX, afterSteps: 0 },
            { count: 2, max: AUTO_CONTINUE_MAX, afterSteps: 0 },
          ],
          // And the card it ended on, which is what a turn that spent its budget ends with.
          endNotice: { cause: 'model_stop', unfinishedSteps: 2 },
        },
      ],
    }

    stubChat({ loadTranscript: () => snapshot })
    renderChat()

    expect(await screen.findByText(`Auto-continuing — 1 of ${AUTO_CONTINUE_MAX}`)).toBeTruthy()
    expect(await screen.findByText(`Auto-continuing — 2 of ${AUTO_CONTINUE_MAX}`)).toBeTruthy()
    expect(await screen.findByText('Ended with the plan unfinished — 2 steps remain')).toBeTruthy()
    // History is not actionable, and neither is a seam: the run those lines belong to is gone.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
