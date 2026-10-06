/**
 * The transcript column, as wiring.
 *
 * The defect this pins: the container stopped scrolling sideways and started clipping instead. With
 * `overflow-x-hidden` on the transcript, a child wider than the container no longer produced a
 * scrollbar — it was simply cut off at the right edge, which is what Boss's screenshot shows: prose
 * wrapped at a widened column width, and a "Running <command>" marker row whose command ran past the
 * edge of the pane.
 *
 * Where the width came from, traced in the real engine before anything here was written, and in the
 * app's own built stylesheet rather than in a transcription of its classes:
 *
 *   - `chat-panel.tsx:1989` the transcript container, `overflow-y-auto overflow-x-hidden`
 *   - `chat-panel.tsx:2005` the virtual row, `absolute top-0 left-0 w-full`
 *   - `message-bubble.tsx:274-275` the message row, `flex w-full px-4 py-2.5`
 *   - `message-bubble.tsx:289` the bubble column, `group flex max-w-[85%] min-w-0 flex-col gap-1`
 *   - `message-bubble.tsx:294-296` `[data-slot="message-body"]`, `min-w-0 rounded-lg px-3.5 py-2.5`
 *   - `message-bubble.tsx:380` the turn-steps list, `mb-2 space-y-1.5`
 *   - `agent-action-card.tsx:59-77` the marker row (its section `overflow-hidden`, its header
 *     `flex w-full items-center gap-2`), and `agent-action-card.tsx:110` the args `<pre>`, whose
 *     `whitespace-pre-wrap` body of JSON carries the long command as one unbreakable run
 *   - `agent-action-card.tsx:289` the summary the header states, `Running ${command}`
 *
 * The body was the box that widened. It carries `min-w-0`, which constrains the *main* axis of its own
 * parent — vertical, here, since the column is `flex-col` — and does nothing to the horizontal axis: a
 * `flex-col` item's cross size is `fit-content`, floored at its own min-content, and the long command
 * inside the marker row made that floor roughly 900px. The body therefore painted out of the 85%-capped
 * column and out of the container, and `overflow-x-hidden` clipped it. `max-w-full` is what caps that
 * cross size at the column's own content width; the row's command text then truncates, and the args
 * `<pre>` scrolls inside the card.
 *
 * Measured, in headless Chrome, mounting the real pane against `out/renderer/assets/index-*.css` with a
 * long Hindi prose line and a long-command marker row: the container reported `clientWidth` 560 against
 * a `scrollWidth` of 916, the bubble column 449 against 900, and the first box past the container's
 * right edge was `[data-slot="message-body"]` at right 915.52 against the container's right 560 — width
 * 899.52, exactly its own min-content. The prose block inside it was drawn 869.52 wide on the same
 * run, which is the "prose wraps at that widened column width" half of the report.
 *
 * The honest ceiling of these assertions. jsdom lays nothing out: every box reports zero, no assertion
 * here can see a scrollbar or an edge, and the containment is asserted as the classes that state the
 * policy. jsdom proves wiring and classes, not pixels; pixel acceptance is Boss's eyes in both themes on
 * the same Hindi session — prose wrapped, no scrollbar, no clipping, the long command row contained, and
 * the code blocks scrolling inside themselves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's measured size, both of which read
 * as 0 here — and a zero-height window renders no rows, so every assertion would be made against an
 * empty transcript. Scoped to this file and restored afterwards.
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

/**
 * The command the fixture runs: one unbreakable run, several hundred pixels wide at the card's own
 * font, and the widest thing in the turn.
 */
const LONG_COMMAND =
  'node ./testing/planChatTranscriptOverflowContainmentForTheChatPaneAndEveryNestedChild.mjs --root C:/xampp8212/htdocs/sam-ai'

/** A long Hindi prose line, spaces and all: it may break at every space it has. */
const HINDI_PROSE =
  'यह उत्तर बताता है कि चैट पैनल की चौड़ाई कैसे तय होती है और क्यों कोई लंबा कमांड पूरी पंक्ति को दाईं ओर खींच लेता है।'

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'the transcript clips its wide content',
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

/**
 * One assistant turn: the prose, then a `run_command` call that starts and does not finish.
 *
 * Left running on purpose — a call in flight is the one state whose row is drawn open, which is the
 * state Boss's screenshot caught, and it is the state in which the command text is on screen at all.
 */
async function turnWithRunningCommand(): Promise<void> {
  const stub = stubChat()
  renderChat()

  await userEvent.type(await screen.findByLabelText('Message'), 'why is the row cut off?{Enter}')
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  const channel = `conveyor:stream:${started?.method}`
  const chunk = (value: unknown) => stub.emit(channel, { type: 'data', value })

  chunk({ type: 'text_delta', text: HINDI_PROSE })
  chunk({ type: 'tool_call_start', callId: 'cmd-1', tool: 'run_command', args: { command: LONG_COMMAND } })

  await waitFor(() => expect(markerRow()).toBeTruthy())
}

/** The transcript's scroll container, by the slot the pane puts on it. */
function transcript(): HTMLElement {
  const box = document.querySelector<HTMLElement>('[data-slot="chat-transcript"]')
  if (!box) throw new Error('the pane renders no transcript container')
  return box
}

/** The assistant's message row: the one that is not the user's own question. */
function assistantRow(): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="message-row"]')]
  const row = rows.find((node) => !(node.textContent ?? '').includes('why is the row cut off?'))
  if (!row) throw new Error('the turn drew no assistant row')
  return row
}

/** The bubble's own column, inside that row: the box that carries the width cap. */
function bubbleColumn(): HTMLElement {
  const column = assistantRow().firstElementChild
  if (!(column instanceof HTMLElement)) throw new Error('the assistant row draws no bubble column')
  return column
}

/** The bubble itself, by the slot the bubble puts on it. */
function messageBody(): HTMLElement {
  const body = assistantRow().querySelector<HTMLElement>('[data-slot="message-body"]')
  if (!body) throw new Error('the assistant row draws no message body')
  return body
}

/** The tool-marker row, by the slot the shared section renders it under. */
function markerRow(): HTMLElement {
  const card = assistantRow().querySelector<HTMLElement>('[data-slot="agent-action-card"]')
  if (!card) throw new Error('the turn drew no tool-marker row')
  return card
}

/** That row's header, which is what states the call in one line. */
function markerHeader(): HTMLElement {
  const header = markerRow().querySelector<HTMLElement>('button[aria-expanded]')
  if (!header) throw new Error('the tool-marker row draws no header')
  return header
}

/** The line the header states, which is where the command is rendered. */
function markerSummary(): HTMLElement {
  const summary = [...markerHeader().querySelectorAll<HTMLElement>('span')].find((node) =>
    (node.textContent ?? '').startsWith('Running ')
  )
  if (!summary) throw new Error('the tool-marker row states no running command')
  return summary
}

describe('the transcript column’s containment', () => {
  it('caps every box in the chain, so no child can widen the column past the container', async () => {
    await turnWithRunningCommand()

    // The container: vertical scroll, and the horizontal axis closed as the backstop. Nothing may widen
    // inside it, which is the whole reason the two rules below exist.
    const container = transcript().classList
    expect(container.contains('overflow-y-auto')).toBe(true)
    expect(container.contains('overflow-x-hidden')).toBe(true)

    // The row fills the container and no more.
    expect(assistantRow().classList.contains('w-full')).toBe(true)

    // The bubble's column: the 85% cap, and `min-w-0` so the column itself can be narrowed by its parent
    // rather than asserting its own min-content width.
    const column = bubbleColumn().classList
    expect(column.contains('max-w-[85%]')).toBe(true)
    expect(column.contains('min-w-0')).toBe(true)

    // The body: the box that widened. `min-w-0` alone is not containment here — it constrains the main
    // axis of a column flex container, which is vertical — so `max-w-full` is what caps the body's
    // fit-content cross size at the column's own content width. This is the assertion that fails on the
    // defective tree.
    const body = messageBody().classList
    expect(body.contains('min-w-0')).toBe(true)
    expect(body.contains('max-w-full')).toBe(true)

    // The marker row clips its own paint rather than spilling it into the bubble.
    expect(markerRow().classList.contains('overflow-hidden')).toBe(true)
  })

  it('renders the long command in a box that truncates, with the whole command as its tooltip', async () => {
    await turnWithRunningCommand()

    const summary = markerSummary()
    expect(summary.textContent).toBe(`Running ${LONG_COMMAND}`)

    // `truncate` is `overflow-hidden` + `text-overflow: ellipsis` + `nowrap`, and the `min-w-0 flex-1`
    // that must sit beside it is what stops the flex row from taking the text's full width as its
    // min-content: with both, the row's command contributes no intrinsic width to the bubble.
    expect(summary.classList.contains('truncate')).toBe(true)
    expect(summary.classList.contains('min-w-0')).toBe(true)

    // Truncation is only honest if the text is still reachable, so the header carries the untruncated
    // line as its native title. Without this, a command clipped to "Running node ./testing/planChat…"
    // could not be read at all.
    expect(markerHeader().getAttribute('title')).toBe(`Running ${LONG_COMMAND}`)
  })

  it('leaves the row’s own argument block scrolling inside itself, not widening the bubble', async () => {
    await turnWithRunningCommand()

    // The args `<pre>` is the unbreakable run's home: `whitespace-pre-wrap` keeps it copyable as written,
    // and `overflow-auto` gives it its own scroll so the JSON — the long command included — moves inside
    // the card once the card itself has a definite width.
    const args = markerRow().querySelector<HTMLElement>('pre')
    expect(args).toBeTruthy()
    expect(args?.classList.contains('overflow-auto')).toBe(true)
    expect(args?.classList.contains('whitespace-pre-wrap')).toBe(true)
  })
})
