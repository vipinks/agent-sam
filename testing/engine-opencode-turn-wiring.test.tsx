/**
 * The OpenCode turn as the pane lives it: a second turn in one session, and a turn that cannot start.
 *
 * The node suite (`tests/engines/engine-acp-lifecycle-test.ts`) owns the lifecycle — one child per turn, the
 * child's whole tree reaped when the turn ends, and every ending kind ending inside a stated bound. What only a
 * rendered pane can be asked is what the user is left looking at: that the second ACP turn draws its own
 * narration with its call marked via OpenCode, and that a turn which cannot start states its cause in words
 * instead of leaving `Thinking…` on screen — which is exactly what the reported defect left there, with no
 * `[engine]` line in the terminal to read either.
 *
 * The failure is delivered as the transport delivers it, because that is the path a real unanswered call takes:
 * main's `engine.turn` raises the failure after the chunks it did produce, and the pane's run loop catches it.
 * The sentence is main's own, composed from the code the client threw — the call that never answered and the
 * budget it was given.
 *
 * The chunks are hand-written, as the sibling suites' are: the mapper is proved against the fixture in the node
 * suites, and what is under test here is what the pane does with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'
const OPENCODE = 'opencode'

/** The sentence main composes from the bound: the call that was never answered, and the budget it had. */
const BOUND_CAUSE =
  'The engine did not answer session/new within 120 seconds. Check that the engine is signed in, then try again.'

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

/** A conversation that runs as OpenCode, which is what makes the pane take the engine path at all. */
const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation on OpenCode',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      engineId: OPENCODE,
    },
  ],
  activeSessionId: SESSION_ID,
}

function stubEngineChat(): BridgeStub {
  // Both run paths are stubbed, and which one is used is asserted rather than assumed: a pane that quietly fell
  // back to the app's own loop would otherwise pass for the wrong reason.
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

describe('an OpenCode turn in the pane', () => {
  it('streams a second turn in the same session, with its narration marked via OpenCode', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'the first question{Enter}')
    const [first] = await startedStreams(stub, 1)
    expect(first?.startsWith('engine.turn#')).toBe(true)
    const firstChannel = `conveyor:stream:${first}`
    chunk(stub, firstChannel, { type: 'text_delta', text: 'the first answer' })
    chunk(stub, firstChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(firstChannel, { type: 'end' })
    await drawnText('the first answer')
    await screen.findByRole('button', SEND)

    // The reported defect: this send is the one that hung, so the pane must open a stream of its own for it.
    await userEvent.type(await composer(), 'the second question{Enter}')
    const streams = await startedStreams(stub, 2)
    expect(streams).toHaveLength(2)
    expect(streams[1]).not.toBe(streams[0])
    expect(streams[1]?.startsWith('engine.turn#')).toBe(true)

    const secondChannel = `conveyor:stream:${streams[1]}`
    chunk(stub, secondChannel, {
      type: 'tool_call_start',
      callId: 'call-1',
      tool: 'write_file',
      args: { path: 'notes.md' },
      via: 'OpenCode',
    })
    chunk(stub, secondChannel, { type: 'tool_result', callId: 'call-1', ok: true, output: 'wrote notes.md' })
    chunk(stub, secondChannel, { type: 'text_delta', text: 'the second answer' })
    chunk(stub, secondChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(secondChannel, { type: 'end' })

    await drawnText('the second answer')
    // The marker is the engine's, and it is what keeps an engine's call from reading as one of our own.
    await drawnText('via OpenCode')
    await screen.findByRole('button', SEND)
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull())
  })

  it('renders its cause in words when a turn cannot start inside the bound, and leaves no Thinking behind', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'a question the engine never answers{Enter}')
    const [started] = await startedStreams(stub, 1)
    const channel = `conveyor:stream:${started}`

    // Nothing was narrated, because the call that hangs is the handshake's second step: the live shape, where
    // the turn produced no chunk at all and the pane had nothing to draw but its own optimism.
    fail(stub, channel, 'ACP_CALL_TIMEOUT', BOUND_CAUSE)

    // The cause, in words, naming the call and the budget rather than leaving the claim that it is thinking.
    await drawnText(BOUND_CAUSE)
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull())
    // And the turn ended in the ordinary sense: the composer offers a send, not a stop.
    await screen.findByRole('button', SEND)
  })
})
