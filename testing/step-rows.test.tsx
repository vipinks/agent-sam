import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import { LOST_PAUSE_CODE, type AgentTurn } from '@/app/components/workbench/agent-session'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * What a turn's tool steps are drawn as: one slim collapsible row each.
 *
 * The row is the first screenshot's row — a chevron, the step's own icon, the call named in one line in
 * the user's words, and the status glyph at the right — folded at rest, open while the call is running or
 * waiting on a decision. A row per *run* of steps was drawn for one turn and is gone: the count it
 * carried was a second thing to read, and the cards it folded away already said which call was which.
 *
 * The claims here are the ones only a rendered transcript can make: that three calls draw three rows and
 * not one, that each row folds by the shared rule and answers to a click, that a waiting call's row is
 * open with its decision reachable, that an undecided call's row is open with the news of how it ended,
 * that each row carries its own status glyph, and that the answer stays visible words outside all of it.
 *
 * Driven through the pane rather than by rendering the bubble directly, for the reason the other section
 * suites are: only the transport can say when a turn is in flight, and the auto-collapse rule is about
 * that transition. The one case rendered directly is a call nobody ever decided, because that state
 * arrives from a transcript read back from disk rather than from a stream.
 *
 * jsdom proves wiring and words, not pixels: a `hidden` body and a class on a chevron are read here, and
 * whether a row looks right is read by eye beside the first screenshot.
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

/** Three reads and their results, in one stretch, then the end of the turn. */
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

/** Every step row in the document, in the order the turn drew them. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="agent-action-card"]')]
}

/** The row whose header names `label`, or a sentence naming what was found instead. */
function rowFor(label: string): HTMLElement {
  const found = rows().find((row) => (header(row).textContent ?? '').includes(label))
  if (!found) throw new Error(`no step row names ${label}`)
  return found
}

/** A row's own header button, which is what a user clicks and what states the state. */
function header(row: HTMLElement): HTMLElement {
  const found = row.querySelector<HTMLElement>('button[aria-expanded]')
  if (!found) throw new Error('the row draws no header button')
  return found
}

/** A row's body, which stays in the document whether or not it is shown. */
function body(row: HTMLElement): HTMLElement {
  const found = row.querySelector<HTMLElement>('[data-slot="agent-action-card-body"]')
  if (!found) throw new Error('the row draws no body')
  return found
}

/** Whether a row is open, read the way a screen reader reads it. */
function isOpen(row: HTMLElement): boolean {
  return header(row).getAttribute('aria-expanded') === 'true'
}

/** A row's own chevron, which is the glyph that turns as the row opens. */
function chevronOf(row: HTMLElement): HTMLElement {
  const found = header(row).querySelector<HTMLElement>('[data-slot="section-chevron"]')
  if (!found) throw new Error('the row draws no chevron')
  return found
}

/** The bubble a row was drawn inside, which is how a redraw is observed. */
function bubbleOf(row: HTMLElement): HTMLElement | null {
  return row.closest<HTMLElement>('[data-slot="message-body"]')
}

/** The one markdown body drawing `text`. */
function bodyDrawing(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-slot="markdown"]')].find((node) =>
    node.textContent?.includes(text)
  )
  if (!found) throw new Error(`no markdown body draws ${text}`)
  return found
}

/** The nearest ancestor that hides this node, or `null` when nothing does. */
function hiddenAncestorOf(node: HTMLElement): HTMLElement | null {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return current
  }
  return null
}

describe('a turn’s tool steps, as rows', () => {
  it('draws one collapsed row per call, each with its own chevron, label and status', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)

    await waitFor(() => expect(rows().length).toBe(3))

    // Nothing groups the steps any more: no row over them, no count of them, no words naming them.
    expect(document.querySelector('[data-slot="step-run"]')).toBeNull()
    expect(screen.queryByText(/View Steps/)).toBeNull()

    for (const path of ['parser.ts', 'lexer.ts', 'tokens.ts']) {
      const row = rowFor(`Reading ${path}`)
      // The three glyphs the row is made of: a chevron that turns, the call named in one line, and the
      // status at the right — which is what makes a step readable without opening it.
      expect(chevronOf(row)).toBeTruthy()
      expect(within(row).getAllByLabelText('succeeded').length).toBe(1)
      // At rest a step that has landed is folded, and its body is still in the document behind it.
      expect(isOpen(row)).toBe(false)
      expect(body(row).hasAttribute('hidden')).toBe(true)
    }
  })

  it('carries the alert glyph on a failed row and the check on a landed one', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'ok1', tool: 'read_file', args: { path: 'parser.ts' } })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'no1', tool: 'run_command', args: { command: 'npm test' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'ok1', tool: 'read_file', ok: true, output: 'body' })
    chunk(stub, channel, { type: 'tool_result', callId: 'no1', tool: 'run_command', ok: false, output: 'exit 1' })
    finishTurn(stub, channel)

    await waitFor(() => expect(rows().length).toBe(2))

    const landed = rowFor('Reading parser.ts')
    const failed = rowFor('Running npm test')

    // On the row itself rather than only inside it: the status is half of what a row says, and a glyph
    // that only appeared once the row was opened would say nothing at a glance.
    expect(header(landed).contains(within(landed).getByLabelText('succeeded'))).toBe(true)
    expect(header(failed).contains(within(failed).getByLabelText('failed'))).toBe(true)
    // Both are over, so both are folded.
    expect(isOpen(landed)).toBe(false)
    expect(isOpen(failed)).toBe(false)
  })

  it('opens the row of a step waiting on the user, with its decision reachable', async () => {
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

    await waitFor(() => expect(rows().length).toBe(1))

    // A call waiting on an answer has not landed, so its row is open: a folded row over a question is a
    // question the user cannot find.
    const row = rowFor('Writing parser.ts')
    expect(isOpen(row)).toBe(true)
    expect(body(row).hasAttribute('hidden')).toBe(false)
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Deny' })).toBeTruthy()
  })

  it('opens the row of a call nobody ever decided, and says which way it ended', async () => {
    // Drawn from a turn directly, because this state comes back from a transcript read off disk rather
    // than from a stream: the pause that owned the call is gone, and the step keeps the code saying why.
    const turn: AgentTurn = {
      id: 'turn-1',
      role: 'assistant',
      content: '',
      steps: [
        {
          callId: 'lost',
          tool: 'write_file',
          args: { path: 'parser.ts' },
          status: 'interrupted',
          code: LOST_PAUSE_CODE,
        },
      ],
    }
    render(<MessageBubble message={turn} />)

    const row = rowFor('Writing parser.ts')
    expect(isOpen(row)).toBe(true)
    expect(body(row).hasAttribute('hidden')).toBe(false)
    expect(within(row).getByText(/the app closed before you answered/)).toBeTruthy()
  })

  it('keeps the answer visible at rest, outside every row', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)

    await waitFor(() => expect(rows().length).toBe(3))

    // The answer is words on screen with nothing around them to open: the fix that put the prose outside
    // a fold is the one thing this revert must leave exactly as it found it.
    const answer = bodyDrawing(PROSE)
    expect(hiddenAncestorOf(answer)).toBeNull()
    expect(rows().some((row) => row.contains(answer))).toBe(false)
    for (const row of rows()) expect(isOpen(row)).toBe(false)
  })

  it('leaves a row the user opened open through the next state tick', async () => {
    const user = userEvent.setup()
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)
    await waitFor(() => expect(rows().length).toBe(3))

    const row = rowFor('Reading parser.ts')
    expect(isOpen(row)).toBe(false)
    await user.click(header(row))
    expect(isOpen(row)).toBe(true)
    expect(chevronOf(row).getAttribute('class') ?? '').toContain('rotate-90')

    // A tick that really reaches the bubble: the appearance store moving redraws the transcript at a new
    // size, and the size class proves the redraw happened. The row the user opened is still open, which
    // is the claim — the rule folds a row when its step lands and never on a redraw.
    expect(bubbleOf(row)?.className).toContain('text-[13px]')

    act(() =>
      stub.pushToChannel(`conveyor:store:${APPEARANCE_STORE_ID}:changed`, {
        alignment: 'same-side',
        fontPreset: 'large',
      })
    )

    await waitFor(() => expect(bubbleOf(row)?.className).toContain('text-[15px]'))
    expect(isOpen(row)).toBe(true)
  })

  it('keeps a folded row’s body mounted and hidden, and its content in a copy and the export', async () => {
    const user = userEvent.setup()
    // Spied after `setup()`, which defines the clipboard stub this file reads: a double installed first
    // is silently replaced, and the assertion would then watch a mock nothing calls.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const stub = stubChat()
    const channel = await startRun(stub)

    threeCalls(stub, channel)
    finishTurn(stub, channel)
    await waitFor(() => expect(rows().length).toBe(3))

    // Hidden, not removed: every body is still in the document with its result in it, which is what keeps
    // a fold a drawing decision rather than a claim about what the turn ran.
    for (const row of rows()) expect(body(row).hasAttribute('hidden')).toBe(true)
    expect(body(rowFor('Reading parser.ts')).textContent).toContain('parser.ts body')

    await user.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(PROSE)

    // And the way out of the app reads the turn data rather than the DOM: the snapshot the pane hands to
    // main carries all three calls while every one of their rows is folded and hidden on screen.
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

  it('draws no row over the steps, while the turn runs or after it lands', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, {
      type: 'tool_call_start',
      callId: 'parser.ts',
      tool: 'read_file',
      args: { path: 'parser.ts' },
    })

    await waitFor(() => expect(rows().length).toBe(1))
    expect(screen.queryByRole('button', { name: /View Steps/ })).toBeNull()
    expect(screen.queryByText(/View Steps/)).toBeNull()

    chunk(stub, channel, { type: 'tool_result', callId: 'parser.ts', tool: 'read_file', ok: true, output: 'body' })
    finishTurn(stub, channel)
    await waitFor(() => expect(isOpen(rowFor('Reading parser.ts'))).toBe(false))

    expect(document.querySelector('[data-slot="step-run"]')).toBeNull()
    expect(screen.queryByText(/View Steps/)).toBeNull()
  })
})
