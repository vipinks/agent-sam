import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * How a turn's tool steps are drawn: one slim row per run of them.
 *
 * The grouping rule is pure, and is stated in `tests/ui/step-runs-test.ts` without a DOM. What is left
 * here is the half a rule test cannot see: that the bubble draws one row per run with the count on it,
 * that the row folds by the same rule every other section folds by, that opening it reveals the cards
 * with their consent UI intact, and that a run holding an undecided call opens its own row with the
 * decision reachable rather than folded away behind it.
 *
 * The turn here is three calls, which is the shortest transcript that carries a count worth reading, and
 * the calls are consecutive because that is the case the grouping is about. Driven through the pane for
 * the same reason the other section suites are: only the transport can say when a turn is in flight.
 *
 * jsdom proves wiring and words, not pixels: a `hidden` body and a class on a chevron are read here, and
 * whether the row *looks* slim is read by eye beside the reference.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const PROSE = 'Let me look at the parser.'
const APPEARANCE_STORE_ID = 'appearance-preferences'

/** A viewport for the virtualized transcript, which jsdom has none of. Restored afterwards. */
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

async function startRun(stub: BridgeStub): Promise<string> {
  renderChat()
  await userEvent.type(await screen.findByLabelText('Message'), 'refactor the parser{Enter}')
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** Three calls and their results, in one consecutive run, then the end of the turn. */
function threeCalls(stub: BridgeStub, channel: string): void {
  chunk(stub, channel, { type: 'text_delta', text: PROSE })
  for (const path of ['parser.ts', 'lexer.ts', 'tokens.ts']) {
    chunk(stub, channel, { type: 'tool_call_start', callId: path, tool: 'read_file', args: { path } })
  }
  for (const path of ['parser.ts', 'lexer.ts', 'tokens.ts']) {
    chunk(stub, channel, { type: 'tool_result', callId: path, tool: 'read_file', ok: true, output: `${path} body` })
  }
}

function finishTurn(stub: BridgeStub, channel: string): void {
  chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
  chunk(stub, channel, { type: 'done', reason: 'complete', steps: 3 })
  stub.emit(channel, { type: 'end' })
}

// ---------------------------------------------------------------- reading the rows

/** Every group row in the document, in the order the turn drew them. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="step-run"]')]
}

/** The one group row, or a sentence naming what was found instead. */
function row(): HTMLElement {
  const found = rows()
  if (found.length !== 1) throw new Error(`expected exactly one step-run row, found ${found.length}`)
  return found[0]
}

/** The cards the row reveals, which are the cards inside its body rather than rows of their own. */
function cards(): HTMLElement[] {
  return [...row().querySelectorAll<HTMLElement>('[data-slot="agent-action-card"]')]
}

/** A row's header button, which is what a user clicks and what states the state. */
function header(section: HTMLElement): HTMLElement {
  const found = section.querySelector<HTMLElement>('button[aria-expanded]')
  if (!found) throw new Error('the row draws no header button')
  return found
}

/** A row's body, which stays in the document whether or not it is shown. */
function body(section: HTMLElement): HTMLElement {
  const found = section.querySelector<HTMLElement>('[data-slot$="-body"]')
  if (!found) throw new Error('the row draws no body')
  return found
}

/** Whether a row is open, read the way a screen reader reads it. */
function isOpen(section: HTMLElement): boolean {
  return header(section).getAttribute('aria-expanded') === 'true'
}

/** The chevron's own class, which is what turns with the row. */
function chevronClass(section: HTMLElement): string {
  const svg = header(section).querySelector('[data-slot="section-chevron"]')
  if (!svg) throw new Error('the row draws no chevron')
  return svg.getAttribute('class') ?? ''
}

describe('a turn’s runs of tool steps', () => {
  it('draws one row for three consecutive steps, counting three, folded at rest', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'text_delta', text: PROSE })
    for (const path of ['parser.ts', 'lexer.ts', 'tokens.ts']) {
      chunk(stub, channel, { type: 'tool_call_start', callId: path, tool: 'read_file', args: { path } })
    }

    // Open while the calls are out, which is the same rule every section follows: the work the user is
    // watching is the work on screen.
    await waitFor(() => expect(rows().length).toBe(1))
    expect(isOpen(row())).toBe(true)

    const label = header(row()).textContent ?? ''
    expect(label).toContain('View Steps')
    expect(label).toContain('3')

    for (const path of ['parser.ts', 'lexer.ts', 'tokens.ts']) {
      chunk(stub, channel, { type: 'tool_result', callId: path, tool: 'read_file', ok: true, output: 'body' })
    }
    finishTurn(stub, channel)

    // Folded when the run lands, and still the one row: three cards did not become three headers.
    await waitFor(() => expect(isOpen(row())).toBe(false))
    expect(body(row()).hasAttribute('hidden')).toBe(true)
    expect(chevronClass(row())).not.toContain('rotate-90')
    expect(cards().length).toBe(3)
  })

  it('reveals the three tool cards, with their status, when the row is opened', async () => {
    const user = userEvent.setup()
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(row())).toBe(false))

    // Folded at rest and opened by one click: the reveal is the point of the row, and the cards inside
    // are the cards the transcript has always drawn.
    expect(cards().length).toBe(3)
    expect(body(row()).hasAttribute('hidden')).toBe(true)

    await user.click(header(row()))

    expect(isOpen(row())).toBe(true)
    expect(body(row()).hasAttribute('hidden')).toBe(false)
    expect(within(body(row())).getByText('Reading parser.ts')).toBeTruthy()
    expect(within(body(row())).getByText('Reading lexer.ts')).toBeTruthy()
    expect(within(body(row())).getByText('Reading tokens.ts')).toBeTruthy()
    // The status marks travel with the cards rather than being flattened into the row's count.
    expect(within(body(row())).getAllByLabelText('succeeded').length).toBe(3)
  })

  it('opens the row and leaves the decision reachable while a step awaits its result', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'w1', tool: 'write_file', args: { path: 'parser.ts' } })
    chunk(stub, channel, {
      type: 'awaiting_approval',
      callId: 'w1',
      tool: 'write_file',
      args: { path: 'parser.ts' },
      calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"parser.ts"}' } }],
      messages: [],
      steps: 1,
      plan: [],
    })

    // An undecided call is a step that has not landed, so its run is in flight and its row is open —
    // a folded row over a waiting question would hide the one thing the user has to act on.
    await waitFor(() => expect(rows().length).toBe(1))
    expect(isOpen(row())).toBe(true)

    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(body(row()).hasAttribute('hidden')).toBe(false)
    expect(cards().length).toBe(1)
  })

  it('keeps a row the user opened open through the next state tick', async () => {
    const user = userEvent.setup()
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(row())).toBe(false))

    await user.click(header(row()))
    expect(isOpen(row())).toBe(true)

    // A tick that really reaches the bubble: the appearance store moving redraws the transcript at a
    // new size, and the size class proves the redraw happened. The row the user opened is still open,
    // which is the claim — the rule folds a row on completion and never on a redraw.
    const bubble = row().closest<HTMLElement>('[data-slot="message-body"]')
    expect(bubble?.className).toContain('text-[13px]')

    act(() =>
      stub.pushToChannel(`conveyor:store:${APPEARANCE_STORE_ID}:changed`, {
        alignment: 'same-side',
        fontPreset: 'large',
      })
    )

    await waitFor(() => {
      const redrawn = row().closest<HTMLElement>('[data-slot="message-body"]')
      expect(redrawn?.className).toContain('text-[15px]')
    })
    expect(isOpen(row())).toBe(true)
  })

  it('keeps a folded row’s cards in the DOM, in a copy, and in the transcript out', async () => {
    const user = userEvent.setup()
    // Spied after `setup()`, which defines the clipboard stub this file reads: a double installed first
    // is silently replaced, and the assertion would then watch a mock nothing calls.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(row())).toBe(false))

    // Hidden, not removed: the cards are still in the document with their results in them, which is what
    // keeps a folded row a drawing decision rather than a claim about what the turn ran.
    expect(body(row()).hasAttribute('hidden')).toBe(true)
    expect(body(row()).textContent).toContain('parser.ts body')

    await user.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(PROSE)

    // And the way out of the app reads the turn data rather than the DOM: the snapshot the pane hands to
    // main carries all three calls while their row is folded and hidden on screen.
    await waitFor(
      () => {
        const saved = stub.callsTo('sessions').filter((call) => call.method === 'saveTranscript')
        expect(saved.length).toBeGreaterThan(0)
        const input = saved[saved.length - 1].args[0] as {
          snapshot: { turns: Array<{ steps: Array<{ callId: string }> }> }
        }
        const calls = input.snapshot.turns.flatMap((turn) => turn.steps.map((step) => step.callId))
        expect(calls).toEqual(expect.arrayContaining(['parser.ts', 'lexer.ts', 'tokens.ts']))
      },
      { timeout: 6000 }
    )
  })

  it('draws one row per run, in the order the runs happened', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'r1', tool: 'read_file', args: { path: 'parser.ts' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'r1', tool: 'read_file', ok: true, output: 'body' })
    // The seam is the break in the run: what follows it is a second stretch of work, so it is a second
    // row, and the answer text between the two rows stays plain visible words.
    chunk(stub, channel, { type: 'auto_continue', count: 1, max: 8, cause: 'model_stop' })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'r2', tool: 'read_file', args: { path: 'lexer.ts' } })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'r3', tool: 'read_file', args: { path: 'tokens.ts' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'r2', tool: 'read_file', ok: true, output: 'body' })
    chunk(stub, channel, { type: 'tool_result', callId: 'r3', tool: 'read_file', ok: true, output: 'body' })
    finishTurn(stub, channel)

    await waitFor(() => expect(rows().length).toBe(2))

    const labels = rows().map((node) => header(node).textContent ?? '')
    expect(labels[0]).toContain('1')
    expect(labels[1]).toContain('2')
    // Every step is in exactly one row, and no card is drawn outside a row.
    const allCards = document.querySelectorAll('[data-slot="agent-action-card"]').length
    const cardsInRows = rows().reduce(
      (total, node) => total + node.querySelectorAll('[data-slot="agent-action-card"]').length,
      0
    )
    expect(allCards).toBe(3)
    expect(cardsInRows).toBe(3)
  })
})
