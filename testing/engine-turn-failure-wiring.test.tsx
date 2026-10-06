/**
 * The engine turn as the pane lives it when it does not finish: a failure ends the turn with its cause in
 * words, and a second turn in the same conversation still streams.
 *
 * The node suite proves the lifecycle and the legibility — that the ACP client keeps the engine's own code
 * and words, and that each turn opens its own child and session. What only a rendered pane can be asked is
 * what the user is left looking at when the engine refuses: the app's own log showed `ACP_REFUSED` reaching
 * the pane as a turn whose bubble still said `Thinking…` with an early-ending card that named a dropped
 * connection. Both were untrue — the engine had answered, and the answer said why it would not proceed — and
 * a turn that has stopped must not look like one that is still working.
 *
 * The stream's failure is delivered as the transport delivers it, because that is the path a real refusal
 * takes: main's `engine.turn` raises the failure after the chunks it did produce, and the pane's run loop
 * catches it. The error carries the sentence main now composes, which repeats the engine's own words.
 *
 * The chunks themselves are hand-written, as the sibling suite's are: the mapper is proved against the
 * fixture in the node suites, and what is under test here is what the pane does with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'dddddddd-4444-4444-8444-444444444444'
const KIMI = 'kimi'

/** The sentence main composes from the engine's own refusal, verbatim: a live one reads exactly like this. */
const REFUSAL = 'The engine refused the request: Authentication required'

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
  delete proto.offsetWidth
  delete proto.offsetHeight
})

/** A conversation that runs as Kimi, which is what makes the pane take the engine path at all. */
const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation on Kimi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      engineId: KIMI,
    },
  ],
  activeSessionId: SESSION_ID,
}

function stubEngineChat(): BridgeStub {
  const stub = createBridgeStub({ turn: () => undefined, chatWithTools: () => undefined })
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

/** The stream ids main was told to start, in order, read from the recorded calls rather than guessed. */
async function startedStreams(stub: BridgeStub, count: number): Promise<string[]> {
  await waitFor(() => {
    const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (started.length < count) throw new Error(`only ${started.length} stream(s) started`)
  })
  return stub.calls.filter((call) => call.channel === 'conveyor:stream:start').map((call) => String(call.method))
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** Fail a stream the way main does: the chunks it produced, then the failure itself. */
function fail(stub: BridgeStub, channel: string, code: string, message: string): void {
  stub.emit(channel, { type: 'error', error: { code, message } })
}

async function drawnText(text: string): Promise<void> {
  await waitFor(() => expect(document.body.textContent).toContain(text))
}

const SEND = { name: 'Send message' }

describe('an engine turn that failed', () => {
  it('renders its cause in words and leaves no Thinking bubble behind', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'a question the engine will refuse{Enter}')
    const [started] = await startedStreams(stub, 1)
    expect(started?.startsWith('engine.turn#')).toBe(true)

    const channel = `conveyor:stream:${started}`
    // The engine said nothing before it refused, which is the live shape: `session/new` was answered with an
    // error, so the turn produced no narration at all.
    fail(stub, channel, 'ACP_REFUSED', REFUSAL)

    // The cause, in the pane's own words: main's sentence repeats what the engine said rather than naming a
    // dropped connection, which is what this turn used to be worded as.
    await drawnText(REFUSAL)
    // And nothing still claims to be thinking: the turn is over, and its bubble says only that.
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull())
    // The turn ended in the ordinary sense too — the composer offers a send, not a stop.
    await screen.findByRole('button', SEND)
  })

  it('streams a second turn in the same session, with its narration marked via Kimi', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'the first question{Enter}')
    const [first] = await startedStreams(stub, 1)
    const firstChannel = `conveyor:stream:${first}`
    chunk(stub, firstChannel, { type: 'text_delta', text: 'the first answer' })
    chunk(stub, firstChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(firstChannel, { type: 'end' })
    await drawnText('the first answer')
    await screen.findByRole('button', SEND)

    await userEvent.type(await composer(), 'the second question{Enter}')
    const streams = await startedStreams(stub, 2)
    expect(streams).toHaveLength(2)
    expect(streams[1]).not.toBe(streams[0])

    const secondChannel = `conveyor:stream:${streams[1]}`
    chunk(stub, secondChannel, {
      type: 'tool_call_start',
      callId: 'call-2',
      tool: 'run_command',
      args: { command: 'git status --short' },
      via: 'Kimi',
    })
    chunk(stub, secondChannel, { type: 'tool_result', callId: 'call-2', ok: true, output: ' M notes.md' })
    chunk(stub, secondChannel, { type: 'text_delta', text: 'the second answer' })
    chunk(stub, secondChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(secondChannel, { type: 'end' })

    await drawnText('the second answer')
    // The marker is the engine's, and it is what keeps an engine's call from reading as one of our own.
    await drawnText('via Kimi')
    await screen.findByRole('button', SEND)
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull())
  })
})
