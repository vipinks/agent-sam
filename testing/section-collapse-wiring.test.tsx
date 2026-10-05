import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The collapsible sections of a live transcript, as wiring.
 *
 * The decision itself — open in flight, fold on completion, never fight a manual toggle — is a pure
 * rule and is tested in `tests/ui/section-collapse-test.ts`, without a DOM. What is left here is the
 * half a rule test cannot see: that the component which draws a section is wired to that rule, that a
 * live run's own chunks drive it, and that folding a section hides its body without taking it out of
 * the document.
 *
 * Driven through the panel rather than by rendering the component directly, because the in-flight
 * signal is a step's own status, which only the transport's chunks move. The turn here is prose, a tool
 * call and its result.
 *
 * The prose cases this file used to hold are gone with the sections they asserted: a turn's answer is
 * plain visible words now and there is nothing about it to fold, which is asserted in
 * `testing/answer-visibility.test.tsx` instead.
 *
 * jsdom proves wiring and words, not pixels: that a section's chevron carries the class that rotates it
 * is a claim about the class, and whether it looks like a chevron is read by eye. The copy path is
 * asserted on the string the platform clipboard receives, which is the only place that claim is
 * checkable, and the transcript-out path on the snapshot the pane hands to main — the data an export is
 * rendered from.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const PROSE = 'Let me look at the parser.'
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

/** One turn, from prose through a call and its result, to the end of the run. */
function finishTurn(stub: BridgeStub, channel: string): void {
  chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
  chunk(stub, channel, { type: 'done', reason: 'complete', steps: 2 })
  stub.emit(channel, { type: 'end' })
}

// ---------------------------------------------------------------- reading the sections

/** The one node a selector matches, or a sentence naming what was found instead. */
function only<T extends HTMLElement>(selector: string): T {
  const nodes = [...document.querySelectorAll<T>(selector)]
  if (nodes.length !== 1) throw new Error(`expected exactly one ${selector}, found ${nodes.length}`)
  return nodes[0]
}

/** The one tool-call card on screen. */
function card(): HTMLElement {
  return only<HTMLElement>('[data-slot="agent-action-card"]')
}

/** A section's header button, which is what a user clicks and what states the state. */
function header(section: HTMLElement): HTMLElement {
  const found = section.querySelector<HTMLElement>('button[aria-expanded]')
  if (!found) throw new Error('the section draws no header button')
  return found
}

/** A section's body, which stays in the document whether or not it is shown. */
function body(section: HTMLElement): HTMLElement {
  const found = section.querySelector<HTMLElement>('[data-slot$="-body"]')
  if (!found) throw new Error('the section draws no body')
  return found
}

/** Whether a section is open, read the way a screen reader reads it. */
function isOpen(section: HTMLElement): boolean {
  return header(section).getAttribute('aria-expanded') === 'true'
}

/** Whether a section's body is hidden rather than absent. */
function bodyIsHidden(section: HTMLElement): boolean {
  return body(section).hasAttribute('hidden')
}

/** The bubble the sections sit in, which is where the message's own size class is painted. */
function bubbleOf(section: HTMLElement): HTMLElement {
  const found = section.closest<HTMLElement>('[data-slot="message-body"]')
  if (!found) throw new Error('the section is not inside a message body')
  return found
}

describe('the collapsible sections of a transcript', () => {
  it('opens a tool card while its result is out, and folds it when the result arrives', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'parser.ts' } })

    // Open on arrival, because the call is in flight: the card the user is watching is the step being
    // taken.
    //
    // Found by its accessible name rather than by its words, which is what a reader who cannot see the
    // header is given: the name is the intent plus the status glyph's own label, and both are part of
    // what the header says about the call.
    await waitFor(() => expect(screen.getByRole('button', { name: /Reading parser\.ts/ })).toBeTruthy())
    expect(isOpen(card())).toBe(true)

    chunk(stub, channel, { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'body' })

    await waitFor(() => expect(isOpen(card())).toBe(false))
    expect(bodyIsHidden(card())).toBe(true)
  })

  it('leaves a section the user reopened open through the next state tick', async () => {
    const user = userEvent.setup()
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'parser.ts' } })
    await waitFor(() => expect(isOpen(card())).toBe(true))
    chunk(stub, channel, { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'body' })
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(card())).toBe(false))

    await user.click(header(card()))
    expect(isOpen(card())).toBe(true)

    // A state tick that reaches the bubble: the appearance store moving is the pane re-rendering the
    // transcript with a different size, which is the app's own way of redrawing a message it is not
    // editing. The bubble really did re-render — the size class proves it — and the section the user
    // opened is still open, which is the claim.
    const sizeBefore = bubbleOf(card()).className
    expect(sizeBefore).toContain('text-[13px]')
    act(() =>
      stub.pushToChannel(`conveyor:store:${APPEARANCE_STORE_ID}:changed`, {
        alignment: 'same-side',
        fontPreset: 'large',
      })
    )

    await waitFor(() => expect(bubbleOf(card()).className).toContain('text-[15px]'))
    expect(isOpen(card())).toBe(true)
  })

  it('keeps a folded section’s content in the DOM, in a copy, and in the transcript out', async () => {
    const user = userEvent.setup()
    // Spied after `setup()`, which defines the clipboard stub this file reads: a double installed first
    // is silently replaced, and the assertion would then watch a mock nothing calls.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'parser.ts' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'the file body' })
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(card())).toBe(false))

    // Hidden, not removed: the body is still in the document, with the call's own content still in it.
    // That parity is what keeps a folded section a drawing decision rather than a claim about what the
    // turn did.
    expect(bodyIsHidden(card())).toBe(true)
    expect(body(card()).textContent).toContain('the file body')

    await user.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(PROSE)

    // And the way out of the app reads the same turn data rather than the DOM: the snapshot the pane
    // hands to main — the one an export is rendered from — carries the prose in full while its section
    // is folded and hidden on screen. The save is debounced, so this waits for the boundary write.
    await waitFor(
      () => {
        const saved = stub.callsTo('sessions').filter((call) => call.method === 'saveTranscript')
        expect(saved.length).toBeGreaterThan(0)
        const input = saved[saved.length - 1].args[0] as { snapshot: { turns: Array<{ content: string }> } }
        expect(input.snapshot.turns.some((turn) => turn.content.includes(PROSE))).toBe(true)
      },
      { timeout: 6000 }
    )
  })
})
