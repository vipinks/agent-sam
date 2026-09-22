import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Narration either side of a card, as it reaches the screen.
 *
 * The rule itself is tested in `narration-rules.test.ts`; what is left here is the part a rule test
 * cannot see — that the panel marks the seam when a tool chunk lands, and that the assembled prose
 * reaches the bubble as two paragraphs rather than as one run-on wall. This is the live defect, driven
 * through the real transport: prose, a tool call and its result, then prose again.
 *
 * The second case is the rehydration half of the same claim. A transcript stores the content the
 * renderer assembled, so a conversation reopened tomorrow must draw the same two paragraphs; if the
 * break were applied only at draw time from state that is not stored, it would come back as one.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` measures the scroll element's own `offsetWidth`/`offsetHeight`, and jsdom
 * implements no layout, so both read as 0 — and a zero-height window renders no rows, which would make
 * these assertions assert against an empty list. Scoped to this file and restored afterwards, so no
 * other suite inherits a fabricated size.
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
async function streamChannel(stub: BridgeStub): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

async function startRun(stub: BridgeStub): Promise<string> {
  renderChat()
  await userEvent.type(await composer(), 'refactor the parser{Enter}')
  return streamChannel(stub)
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** The assistant's prose paragraphs, in order. Scoped to the markdown block, so the user's own bubble and its text is not counted. */
function proseParagraphs(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="markdown"] p')).map((p) => p.textContent ?? '')
}

describe('narration between tool calls', () => {
  it('renders the prose either side of a card as two paragraphs', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    // The stream as main sends it: prose, a call and its result, then prose again.
    chunk(stub, channel, { type: 'text_delta', text: 'Let me look at the parser.' })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'parser.ts' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'body' })
    chunk(stub, channel, { type: 'text_delta', text: 'Now the fix.' })
    chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, channel, { type: 'done', reason: 'complete', steps: 2 })
    stub.emit(channel, { type: 'end' })

    // Two paragraphs, each holding one piece of commentary: the separator is what puts them in two,
    // and a run-on wall would put both in one.
    await waitFor(() => expect(proseParagraphs()).toEqual(['Let me look at the parser.', 'Now the fix.']))
    expect(await screen.findByText('Reading parser.ts')).toBeTruthy()
  })

  it('renders a rehydrated turn the same way', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Let me look at the parser.\n\nNow the fix.',
          steps: [],
        },
      ],
    }

    stubChat({ loadTranscript: () => snapshot })
    renderChat()

    // The stored content is what the live assembly wrote, so it draws the same two paragraphs.
    await waitFor(() => expect(proseParagraphs()).toEqual(['Let me look at the parser.', 'Now the fix.']))
  })
})
