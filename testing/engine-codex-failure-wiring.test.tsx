/**
 * The Codex failure chunk, as the pane draws it: the exit code, the bounded stderr tail, the
 * Continue-after-failure copy, and no bubble still claiming to think.
 *
 * The node suite proves what the runner emits. This one proves what the renderer does with it: the
 * failure chunk is the only chunk that carries a cause the pane can word, so a turn that ends on one
 * must leave an error line and a recorded, resumable ending — never the empty `Thinking…` bubble that
 * the ordinary stop path leaves when nothing is written and no error is set.
 *
 * The chunks are hand-written because this suite is about renderer wiring; the mapper and runner are
 * proved against the capture in the node suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'
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

/** A conversation that runs as Codex, which is what makes the pane take the engine path at all. */
const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation on Codex',
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

async function drawnText(text: string): Promise<void> {
  await waitFor(() => expect(document.body.textContent).toContain(text))
}

describe('a Codex turn that failed', () => {
  it('renders the exit code and collapsed tail with the Continue-after-failure copy', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'a question the engine will fail{Enter}')
    const [started] = await startedStreams(stub, 1)
    expect(started?.startsWith('engine.turn#')).toBe(true)

    const channel = `conveyor:stream:${started}`
    chunk(stub, channel, {
      type: 'turn_end_notice',
      cause: 'stream_error',
      resumable: true,
      failure: { exitCode: 3, tail: 'Error: model overloaded\n  retry later  ' },
    })
    chunk(stub, channel, { type: 'turn_end', cause: 'stream_error' })
    stub.emit(channel, { type: 'end' })

    // D4: the affordance's copy, single-line-collapsed and bounded.
    await drawnText('Continue after failure (exit 3): Error: model overloaded retry later')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()
    // The bubble's own line names the same cause, so the transcript is legible without the card.
    await drawnText('The engine failed (exit 3)')
    // And the turn is over: nothing still claims to be thinking.
    expect(screen.queryByText(/Thinking/)).toBeNull()
  })

  it('never leaves a terminated turn as a bare Thinking card when the spawn is refused', async () => {
    const stub = stubEngineChat()
    renderChat()

    await userEvent.type(await composer(), 'a question the engine cannot start{Enter}')
    const [started] = await startedStreams(stub, 1)
    const channel = `conveyor:stream:${started}`

    chunk(stub, channel, {
      type: 'turn_end_notice',
      cause: 'stream_error',
      resumable: true,
      failure: { exitCode: null, code: 'ENGINE_NOT_INSTALLED', tail: 'spawn codex ENOENT' },
    })
    stub.emit(channel, { type: 'end' })

    await drawnText('Continue after failure (ENGINE_NOT_INSTALLED): spawn codex ENOENT')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()
    await drawnText('The engine failed (ENGINE_NOT_INSTALLED)')
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull())
  })
})
