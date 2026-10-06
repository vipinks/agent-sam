/**
 * The engine turn as the pane lives it: a second turn in one session, and Stop on a turn in flight.
 *
 * This is the renderer half of the child-lifecycle turn. The lifecycle itself — one child per turn, stdin
 * closed at spawn so `codex exec` has nothing to wait for, the child reaped on its own exit, cancel killing a
 * running one — is the node suite's subject, because only that suite can hold a real process. What only a
 * rendered pane can be asked is what the user sees while that happens: that a conversation running as an engine
 * opens a fresh stream per turn and draws the narration of *that* stream, that the turn ends when its stream
 * ends, and that Stop both ends the turn and tells main to cancel the stream it was reading.
 *
 * The chunks are the transcript vocabulary the real mapper produces, hand-written here because the mapper is
 * proved against the capture elsewhere; the transport is the real conveyor client over a stubbed bridge, so
 * the assertion is made against what a run actually delivers rather than against a prop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333'
const CODEX = 'codex'

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

/**
 * A conversation that runs as the engine, which is what makes the pane take the engine path at all: the record
 * is the one thing that decides it, and it is written at creation and never rewritten.
 */
const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation on the engine',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      engineId: CODEX,
    },
  ],
  activeSessionId: SESSION_ID,
}

function stubEngineChat(): BridgeStub {
  // Both run paths are stubbed, and which one is used is asserted rather than assumed: a pane that quietly fell
  // back to the app's own loop would otherwise pass every case below for the wrong reason.
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

/** The words drawn anywhere on the screen, which is the only claim about prose a jsdom suite should make. */
async function drawnText(text: string): Promise<void> {
  await waitFor(() => expect(document.body.textContent).toContain(text))
}

const STOP = { name: 'Stop' }
const SEND = { name: 'Send message' }

describe('an engine turn in the pane', () => {
  it('opens a stream of its own for the second turn in one session, and ends when that stream ends', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'first question{Enter}')
    const [first] = await startedStreams(stub, 1)
    expect(first?.startsWith('engine.turn#')).toBe(true)
    // The engine path, stated: the app's own loop was never asked for.
    expect(stub.calls.some((call) => call.method?.startsWith('agent.chatWithTools'))).toBe(false)

    const firstChannel = `conveyor:stream:${first}`
    chunk(stub, firstChannel, { type: 'text_delta', text: 'the first answer' })
    chunk(stub, firstChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(firstChannel, { type: 'end' })

    await drawnText('the first answer')
    // The turn ended, so the control beside the composer is the one that sends again.
    await screen.findByRole('button', SEND)

    await userEvent.type(await composer(), 'second question{Enter}')
    const streams = await startedStreams(stub, 2)
    expect(streams).toHaveLength(2)
    expect(streams[1]?.startsWith('engine.turn#')).toBe(true)
    // Its own stream, not the first turn's: a pane reading a stale reference would still be on the first id.
    expect(streams[1]).not.toBe(streams[0])

    const secondChannel = `conveyor:stream:${streams[1]}`
    chunk(stub, secondChannel, { type: 'text_delta', text: 'the second answer' })
    chunk(stub, secondChannel, { type: 'usage', prompt: 20775, completion: 5 })
    chunk(stub, secondChannel, { type: 'turn_end', cause: 'model_stop' })
    stub.emit(secondChannel, { type: 'end' })

    // Narration and an ending: the state a hung engine turn never reached — no text at all, and Thinking left
    // on screen. The lifecycle fix is what makes main send these; the pane's half is drawing them.
    await drawnText('the second answer')
    await screen.findByRole('button', SEND)
    expect(screen.queryByRole('button', STOP)).toBeNull()
  })

  it('Stop ends a turn in flight and cancels the stream main is reading the child on', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'a long question{Enter}')
    const [started] = await startedStreams(stub, 1)
    const channel = `conveyor:stream:${started}`

    chunk(stub, channel, { type: 'text_delta', text: 'still working on it' })
    await drawnText('still working on it')

    const stop = await screen.findByRole('button', STOP)
    await userEvent.click(stop)

    // The turn is over as far as the pane is concerned...
    await screen.findByRole('button', SEND)
    expect(screen.queryByRole('button', STOP)).toBeNull()

    // ...and main was told, on the transport's own cancel channel: that call is what aborts the turn's signal,
    // which is what the spawn layer's kill hangs off. A Stop that only stopped the reader would leave the child.
    await waitFor(() => {
      expect(stub.calls.some((call) => call.channel === 'conveyor:stream:cancel')).toBe(true)
    })
  })
})
