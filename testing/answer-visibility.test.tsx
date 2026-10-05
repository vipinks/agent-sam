import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * What a turn's answer is, on screen, at rest.
 *
 * The one claim here is the plainest in the app and the one the transcript most needs to keep: what the
 * assistant said is words the reader can read, without opening anything first. It is asserted because it
 * was broken — a turn's prose was drawn inside a foldable section that named itself "Thinking", so every
 * finished reply arrived as a collapsed header over its own answer and the conversation appeared to have
 * said nothing.
 *
 * Driven through the pane rather than by rendering the bubble directly, because the folding rule reads a
 * fact only the pane holds: a turn is in flight while its own chunks arrive, and only the transport can
 * say when that starts and stops. The same harness the section suite uses, so a change in how the pane
 * feeds a turn reaches both.
 *
 * jsdom proves wiring and words, not pixels. "Visible" here means the words are in the document and no
 * ancestor carries the `hidden` attribute — which is exactly what a folded section draws — and not that
 * they occupy space on a painted screen.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const PROSE = 'The parser is renamed, and the suite is green.'
const APPEARANCE_STORE_ID = 'appearance-preferences'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` measures the scroll element's own `offsetWidth`/`offsetHeight`, and jsdom
 * implements no layout, so both read as 0 — and a zero-height window renders no rows, which would make
 * every assertion here assert against an empty list. Scoped to this file and restored afterwards.
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
      title: 'an existing conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

function stubChat(): BridgeStub {
  const stub = createBridgeStub({ chatWithTools: () => undefined })
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
  await userEvent.type(await screen.findByLabelText('Message'), 'refactor the parser{Enter}')
  return streamChannel(stub)
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** One run, from its prose through the end of the turn. */
function finishTurn(stub: BridgeStub, channel: string): void {
  chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
  chunk(stub, channel, { type: 'done', reason: 'complete', steps: 1 })
  stub.emit(channel, { type: 'end' })
}

// ---------------------------------------------------------------- reading the answer

/** Every markdown body in the document, which is how an answer's own words are drawn. */
function markdownBodies(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="markdown"]')]
}

/** The one markdown body drawing `text`. */
function bodyDrawing(text: string): HTMLElement {
  const found = markdownBodies().find((node) => node.textContent?.includes(text))
  if (!found) throw new Error(`no markdown body draws ${text}`)
  return found
}

/**
 * The nearest ancestor that hides this node, or `null` when nothing does.
 *
 * `hidden` is the attribute a folded section draws on its body, and it is an attribute rather than a
 * class precisely so it can be read here — a stylesheet-driven fold would be invisible to jsdom.
 */
function hiddenAncestorOf(node: HTMLElement): HTMLElement | null {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return current
  }
  return null
}

/** Every foldable section a turn has drawn, whatever it calls itself. */
function sections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="thinking-section"], [data-slot="step-run"]')]
}

describe('the answer a completed turn leaves on screen', () => {
  it('is plain visible words, with nothing foldable drawn around them', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    finishTurn(stub, channel)

    const answer = await waitFor(() => bodyDrawing(PROSE))

    // The regression, stated as the two things it was: a section existed, and it hid the answer.
    expect(document.querySelector('[data-slot="thinking-section"]')).toBeNull()
    expect(hiddenAncestorOf(answer)).toBeNull()

    // And no header stood over it claiming the turn was still thinking about a reply it had finished.
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull()
  })

  it('is visible while the turn is still writing it, and stays visible when the turn ends', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })

    // In flight the answer is being written, so it is on screen for the same reason: the reader watches
    // the reply arrive rather than a folded header over it.
    const answer = await waitFor(() => bodyDrawing(PROSE))
    expect(hiddenAncestorOf(answer)).toBeNull()

    finishTurn(stub, channel)

    // The transition is the case the defect turned on — the run's own ending folded the answer away —
    // so it is asserted after the end rather than before it.
    await waitFor(() => expect(document.querySelector('[data-slot="thinking-section"]')).toBeNull())
    expect(hiddenAncestorOf(bodyDrawing(PROSE))).toBeNull()
  })

  it('stays visible across every prose stretch of a turn that continued itself', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: 'I have started on the precedence table.' })
    chunk(stub, channel, { type: 'auto_continue', count: 1, max: 8, cause: 'model_stop' })
    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    finishTurn(stub, channel)

    // Both stretches are words the turn said. A seam is where the loop nudged itself, which is a fact
    // about how the reply was produced and not a reason to hide one half of it behind a header.
    const first = await waitFor(() => bodyDrawing('I have started on the precedence table.'))
    const second = bodyDrawing(PROSE)
    expect(hiddenAncestorOf(first)).toBeNull()
    expect(hiddenAncestorOf(second)).toBeNull()

    // And the seam itself is still drawn, because it is what tells the reader the app continued on its
    // own there rather than that the model wrote one seamless answer.
    expect(await screen.findByText('Auto-continuing after a plain stop — 1 of 8')).toBeTruthy()
    expect(sections()).toHaveLength(0)
  })

  it('survives the next state tick that redraws the message', async () => {
    const user = userEvent.setup()
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    finishTurn(stub, channel)
    await waitFor(() => bodyDrawing(PROSE))

    // A tick that really does reach the bubble: the appearance store moving is the pane redrawing the
    // transcript at a new size, which is the app's own way of re-rendering a message nobody is editing.
    // The size class proves the redraw happened, so the answer still being visible afterwards is the
    // claim rather than a render that never occurred.
    const bubble = bodyDrawing(PROSE).closest<HTMLElement>('[data-slot="message-body"]')
    expect(bubble?.className).toContain('text-[13px]')

    act(() =>
      stub.pushToChannel(`conveyor:store:${APPEARANCE_STORE_ID}:changed`, {
        alignment: 'same-side',
        fontPreset: 'large',
      })
    )

    await waitFor(() => {
      const redrawn = bodyDrawing(PROSE).closest<HTMLElement>('[data-slot="message-body"]')
      expect(redrawn?.className).toContain('text-[15px]')
    })
    expect(hiddenAncestorOf(bodyDrawing(PROSE))).toBeNull()

    // Nothing about a redraw is a fold: the answer the user was reading is the answer still on screen.
    await user.click(screen.getByRole('button', { name: 'Copy reply' }))
    expect(document.querySelector('[data-slot="thinking-section"]')).toBeNull()
  })
})
