import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { RESUME_MESSAGE } from '@/conveyor/protocol/turn-end'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The turn-end notice, as wiring rather than as rules.
 *
 * Every rule the card relies on — which cause a stream's evidence maps to, and which causes can be
 * continued — is tested directly in `turn-end-rules.test.ts` and through the loop in the node suite.
 * What is left here is the part a rule test cannot see: that the chunk the loop sends reaches the
 * card, that each cause is worded for the user, that Continue sends the resume text as a user
 * message, and that a transcript read back from disk shows the reason without offering the button.
 *
 * The transport is the real conveyor client over a stubbed bridge, and the resume is asserted on the
 * payload the transport received — because "the button sends the message" is exactly the claim that
 * cannot be checked by reading the component.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` measures the scroll element's own `offsetWidth`/`offsetHeight`, and jsdom
 * implements no layout, so both read as 0 — and a zero-height window renders no rows, which would
 * make the prose assertions below assert against an empty list. Scoped to this file and restored
 * afterwards, so no other suite inherits a fabricated size.
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

/** Every stream start the panel made, in order. */
function starts(stub: BridgeStub): Array<{ input?: { messages?: Array<{ role: string; content: string }> } }> {
  return stub.calls
    .filter((call) => call.channel === 'conveyor:stream:start')
    .map((call) => call.args[0] as { input?: { messages?: Array<{ role: string; content: string }> } })
}

describe('the turn-end notice', () => {
  it('says the reply was cut off at the output limit, and continues when asked', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: 'The parser works by ' })
    chunk(stub, channel, { type: 'turn_end', cause: 'truncated' })
    chunk(stub, channel, { type: 'turn_end_notice', cause: 'truncated', resumable: true })
    stub.emit(channel, { type: 'end' })

    // The half-reply is on screen, and so is the reason it stops there.
    expect(await screen.findByText('The parser works by')).toBeTruthy()
    expect(await screen.findByText('Ended early: the reply was cut off (output limit)')).toBeTruthy()

    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    // The resume is an ordinary send, so what has to be true is what the transport was asked to send:
    // the resume text as the last user message, with the conversation as it stood behind it.
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const messages = starts(stub)[1].input?.messages ?? []
    expect(messages.at(-1)).toEqual({ role: 'user', content: RESUME_MESSAGE })
    expect(messages[0]).toEqual({ role: 'user', content: 'refactor the parser' })

    // And the card is gone, because the conversation has moved on: the notice belongs to the last
    // turn, so continuing clears it rather than leaving a stale offer on screen.
    await waitFor(() => expect(screen.queryByText(/Ended early/)).toBeNull())
  })

  it('says the connection dropped, which is the other wording of the same news', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'turn_end', cause: 'stream_error' })
    chunk(stub, channel, { type: 'turn_end_notice', cause: 'stream_error', resumable: true })
    stub.emit(channel, { type: 'end' })

    expect(await screen.findByText('Ended early: the reply was cut off (the connection dropped)')).toBeTruthy()
    // Named by the cause and not by a sentence, so the two branches are one card with two wordings
    // rather than two cards that happen to look alike.
    expect(screen.queryByText(/output limit/)).toBeNull()
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('shows nothing at all for a reply the model finished', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: 'The parser is fine.' })
    chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, channel, { type: 'done', reason: 'complete', steps: 1 })
    stub.emit(channel, { type: 'end' })

    // The diagnosis arrives and is ignored: the ordinary ending must not look like an incident, or
    // the one that matters becomes one more row in a column of them.
    expect(await screen.findByText('The parser is fine.')).toBeTruthy()
    expect(screen.queryByText(/Ended early/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('shows nothing for a cause this build does not know', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    // A chunk from a newer build: it must leave the turn exactly as a clean stop would rather than
    // render a card with no wording behind it.
    chunk(stub, channel, { type: 'turn_end_notice', cause: 'rate_limit_reset', resumable: true })
    stub.emit(channel, { type: 'end' })

    // The run is over — the composer is offering to send again — and nothing was shown for it.
    expect(await screen.findByLabelText('Send message')).toBeTruthy()
    expect(screen.queryByText(/Ended early/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('shows the reason a reopened transcript stored, with nothing to click', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'The parser works by',
          steps: [],
          // The cause alone, which is all a transcript keeps: a stored notice is history.
          endNotice: { cause: 'stream_error' },
        },
      ],
    }

    stubChat({ loadTranscript: () => snapshot })
    renderChat()

    expect(await screen.findByText('The parser works by')).toBeTruthy()
    expect(await screen.findByText('Ended early: the reply was cut off (the connection dropped)')).toBeTruthy()
    // History is a record, not a thing to click: the run behind this notice is not in this process.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
