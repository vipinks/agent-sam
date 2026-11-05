import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The working row: the one thing a bubble says while a run has not spoken yet.
 *
 * Three claims, and the order between them is the claim. A send opens an assistant turn with nothing in
 * it, and that turn says it is working; the first `text_delta` writes content, the first tool frame
 * appends a step, and either one drops the row on the same render — no timer, no stored flag, nothing
 * to fall out of step with the transcript. The last case is the other half of the same derivation: a
 * turn that is empty because it ended without saying anything draws nothing at all, which is the
 * behaviour that replaces the static `Thinking…` a settled empty turn used to wear.
 *
 * What only a rendered pane can show is that the derivation is wired to the run at all — the row is
 * drawn from the pane's own `streaming` flag and the fact that a send appends its assistant turn last,
 * so the pin drives a real send through the real transport and asserts the row's appearance and its
 * disappearance as chunks land. The predicate itself is one exported function of data.
 *
 * Residual, named rather than claimed: jsdom draws no animation, so "the dots pulse" is asserted as the
 * class pair that makes them pulse — `animate-pulse` with its reduced-motion guard — and never as
 * motion on a screen.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * The virtualizer measures the scroll element's own `offsetWidth`/`offsetHeight`, both of which jsdom
 * reports as 0 — and a zero-height window renders no rows, so every assertion below would be made
 * against an empty list. Scoped to this file and restored afterwards, exactly as `narration-join`
 * does it, so no other suite inherits a fabricated size.
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

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation with a run in it',
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

/** Send one message through the composer, and hand back the channel the run opened. */
async function startRun(stub: BridgeStub): Promise<string> {
  renderChat()
  await userEvent.type(await composer(), 'refactor the parser{Enter}')
  return streamChannel(stub)
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** The working row as the document has it right now, or null. */
function workingRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="message-working"]')
}

/** The working row, waited for: a send opens the turn asynchronously, on the stream's first frame. */
async function workingRowAppears(): Promise<HTMLElement> {
  return waitFor(() => {
    const row = workingRow()
    if (row === null) throw new Error('the bubble draws no working row')
    return row
  })
}

describe('the working row on a live turn', () => {
  it('says Thinking… with three guarded dots before the run has written anything', async () => {
    const stub = stubChat()
    await startRun(stub)

    const row = await workingRowAppears()
    // Announced, not decorative: the row is the only thing the screen says while nothing else has
    // arrived, and a reader using a screen reader has no other way to hear that the run started.
    expect(row.getAttribute('role')).toBe('status')
    expect(row.textContent).toContain('Thinking…')

    // Three dots, each carrying the base reduced-motion guard. The row is conditionally rendered and has
    // no data-attribute variant, so the class-level guard is the one that applies — there is no stacked
    // specificity-equal form to need.
    const dots = Array.from(row.querySelectorAll('span.animate-pulse'))
    expect(dots).toHaveLength(3)
    for (const dot of dots) {
      expect(dot.className).toContain('motion-reduce:animate-none')
    }
  })

  it('drops the row the instant the first text lands', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)
    await workingRowAppears()

    chunk(stub, channel, { type: 'text_delta', text: 'Here it is.' })

    // The same render that draws the words is the one that drops the row: `content` is no longer empty,
    // so the derivation is false and no timer had to fire for it.
    await waitFor(() => expect(workingRow()).toBeNull())
    expect(await screen.findByText('Here it is.')).toBeTruthy()
  })

  it('drops the row the instant the first tool card lands', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)
    await workingRowAppears()

    chunk(stub, channel, { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'parser.ts' } })

    // A run that starts by working rather than talking stops saying "Thinking…" the moment its first
    // card exists: the step list is no longer empty, which is the other half of the same derivation.
    await waitFor(() => expect(workingRow()).toBeNull())
    expect(await screen.findByText('Reading parser.ts')).toBeTruthy()
  })

  it('draws nothing at all on a settled empty turn', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'say nothing', steps: [] },
        { id: 'assistant-2', role: 'assistant', content: '', steps: [] },
      ],
    }

    stubChat({ loadTranscript: () => snapshot })
    renderChat()

    // The turn is there — the conversation has two bubbles — and it says nothing, because nothing is
    // running. The static `Thinking…` this case used to draw was a claim about work that ended.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="message-row"]')).toHaveLength(2))
    expect(workingRow()).toBeNull()
    expect(screen.queryByText(/Thinking/)).toBeNull()
  })
})
