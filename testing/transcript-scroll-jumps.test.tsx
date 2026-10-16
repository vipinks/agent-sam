/**
 * Where an opened conversation is scrolled to, and the two controls that move it.
 *
 * The defect this pins: an old conversation opened at its *top*. The reader clicked the row of a session
 * they had left mid-thread and landed on the first question it ever asked, then scrolled the whole
 * transcript down to find out what had been said last. The pane already knew how to do this — the
 * streaming path carries the container to the bottom on every flushed chunk — and it did it only for a
 * run, never for a load.
 *
 * The controls are the other half of the same complaint: a long transcript offered no way from the
 * middle of it to either end but the scrollbar. They are drawn per edge rather than per "in the middle"
 * as a state of its own — the top one whenever the top is somewhere to go, the bottom one whenever the
 * bottom is — which is what makes each end of a traversal show exactly the control that still does
 * something, and the middle show both.
 *
 * What this file asserts, and what it cannot. jsdom lays nothing out: every element reports a zero-size
 * box, `scrollTop` is a property nothing writes, and a programmatic scroll fires no event. So this file
 * gives the transcript the box a browser would give it — a client height, a taller scroll height, and an
 * offset that a write is visible in — and asserts the pane's own answers to it: where the pane puts the
 * container when a conversation loads, which control it draws for the offset it has been told about, and
 * what a click on one writes back. The roster the pane hands the virtualizer agrees with that box by
 * construction (a row is measured at the pane's own estimate), so a measurement is not a correction and
 * the library never re-scrolls the container behind the pane's back. Pixels are Boss's: whether the
 * arrows land where the eye expects on a long session, in both themes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** The pane's own `estimateSize`, so a measured row equals the estimate and the library corrects nothing. */
const ROW_HEIGHT = 92

/** The viewport jsdom does not have, and the one the virtualizer sizes its window from. */
const VIEWPORT = { width: 900, height: 800 }

/** A conversation four screens tall: the transcript has somewhere to go in both directions. */
const TURN_COUNT = 40
const SCROLL_HEIGHT = ROW_HEIGHT * TURN_COUNT
const BOTTOM = SCROLL_HEIGHT - VIEWPORT.height

/** Somewhere in the middle of it, which is where the reader of a long conversation usually is. */
const MIDPOINT = 1_200

/**
 * A few pixels from an end, and a place well past one.
 *
 * Named as what they are rather than as the pane's slack: what matters to a reader is that the control
 * that goes nowhere is not offered *at* the end, and that a stray pixel of a fractional offset or a
 * pending measurement is not mistaken for having left it. The number the pane picks to mean that is its
 * own to change.
 */
const NEAR_THE_TOP = 20
const PAST_THE_TOP = 200

/** The two controls, by the name a reader (and a screen reader) knows them by. */
const JUMP_TO_TOP = 'Jump to the top of the conversation'
const JUMP_TO_BOTTOM = 'Jump to the bottom of the conversation'

/**
 * One element's box, as the browser would report it.
 *
 * Held per element rather than as module state, because the pane is not the only thing in the tree and
 * only the transcript's box is this file's business. An element the file never mentions answers with a
 * box that has nothing to scroll, which is the honest reading for something jsdom cannot lay out — and
 * the reason a conversation with nothing in it draws no jump control without being special-cased.
 */
interface ScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const boxes = new WeakMap<HTMLElement, ScrollBox>()

function boxOf(element: HTMLElement): ScrollBox {
  const known = boxes.get(element)
  if (known) return known
  const fresh: ScrollBox = { scrollTop: 0, scrollHeight: VIEWPORT.height, clientHeight: VIEWPORT.height }
  boxes.set(element, fresh)
  return fresh
}

/**
 * The virtualizer's viewport, and a row's measured height, out of the one property it reads both from.
 *
 * `observeElementRect` sizes the window from the scroll element's own `offsetWidth`/`offsetHeight`, and
 * `measureElement` falls back to the same pair for a row. jsdom reports 0 for both, which renders no
 * rows at all — so the container is given the viewport and a row is given the pane's estimate. That is
 * not a convenience: a measured row that matches the estimate is a measurement with no delta, and a
 * delta is what makes the library re-scroll the container on its own.
 */
function offsetHeightOf(this: HTMLElement): number {
  return this.hasAttribute('data-index') ? ROW_HEIGHT : VIEWPORT.height
}

function clientHeightOf(this: HTMLElement): number {
  return boxOf(this).clientHeight
}

function scrollHeightOf(this: HTMLElement): number {
  return boxOf(this).scrollHeight
}

function readScrollTop(this: HTMLElement): number {
  return boxOf(this).scrollTop
}

function writeScrollTop(this: HTMLElement, value: number): void {
  boxOf(this).scrollTop = value
}

/**
 * The library's own route to the same offset: it scrolls through `element.scrollTo`, and a browser
 * honors that into the offset the pane's own assignment writes. jsdom has no such method, so the route
 * is added here rather than left as a no-op that would hide the pin.
 */
function scrollToOf(this: HTMLElement, options?: ScrollToOptions): void {
  if (typeof options?.top === 'number') boxOf(this).scrollTop = options.top
}

beforeAll(() => {
  const proto = HTMLElement.prototype
  const installed: Array<[string, PropertyDescriptor]> = [
    ['offsetWidth', { configurable: true, get: () => VIEWPORT.width }],
    ['offsetHeight', { configurable: true, get: offsetHeightOf }],
    ['clientHeight', { configurable: true, get: clientHeightOf }],
    ['scrollHeight', { configurable: true, get: scrollHeightOf }],
    ['scrollTop', { configurable: true, get: readScrollTop, set: writeScrollTop }],
    ['scrollTo', { configurable: true, writable: true, value: scrollToOf }],
  ]
  for (const [property, descriptor] of installed) Object.defineProperty(proto, property, descriptor)
})

afterAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  for (const property of ['offsetWidth', 'offsetHeight', 'clientHeight', 'scrollHeight', 'scrollTop', 'scrollTo']) {
    delete proto[property]
  }
})

/** A conversation that alternates, so a row's role is not something the fixture has to be told. */
function manyTurns(): TranscriptTurn[] {
  return Array.from({ length: TURN_COUNT }, (_, index) => ({
    id: index % 2 === 0 ? `user-${index}` : `assistant-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index % 2 === 0 ? `question ${index}` : `answer ${index}`,
    steps: [],
  }))
}

function snapshotOf(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
}

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation left mid-thread',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/** Home: no conversation at all, which is the other screen this pane draws. */
const HOME_STATE = { sessions: [], activeSessionId: null }

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

/** The transcript's scroll container, by the slot the pane puts on it. */
function transcript(): HTMLElement {
  const box = document.querySelector<HTMLElement>('[data-slot="chat-transcript"]')
  if (!box) throw new Error('the pane renders no transcript container')
  return box
}

async function awaitTranscript(): Promise<HTMLElement> {
  return await waitFor(transcript)
}

function setBox(element: HTMLElement, next: Partial<ScrollBox>): void {
  Object.assign(boxOf(element), next)
}

/** Put the transcript's offset somewhere, as a reader's own scroll would, and tell the pane about it. */
function scrollTo(element: HTMLElement, offset: number): void {
  boxOf(element).scrollTop = offset
  fireEvent.scroll(element)
}

function topControl(): HTMLElement | null {
  return screen.queryByRole('button', { name: JUMP_TO_TOP })
}

function bottomControl(): HTMLElement | null {
  return screen.queryByRole('button', { name: JUMP_TO_BOTTOM })
}

/** The control a test is about to click, with a readable failure rather than a null dereference. */
function requiredControl(control: HTMLElement | null, name: string): HTMLElement {
  if (!control) throw new Error(`the transcript draws no control to ${name}`)
  return control
}

/**
 * A conversation loading over a stub, with the load held open until the test releases it.
 *
 * Held rather than immediate because the geometry has to be in place before the pane's own landing runs:
 * the transcript's container exists as soon as the store says a conversation is active, and the turns
 * land a tick later. Every test here that reads an offset goes through this, so none of them depends on
 * winning that race.
 */
function heldLoad(turns: TranscriptTurn[]): { pending: Promise<TranscriptSnapshot>; release: () => void } {
  let release: () => void = () => {}
  const pending = new Promise<TranscriptSnapshot>((resolve) => {
    release = () => resolve(snapshotOf(turns))
  })
  return { pending, release }
}

/**
 * Let the pane's own frames run before a test takes the container's offset into its own hands.
 *
 * The landing is a chain of animation frames, and a test that scrolled the container the moment the turns
 * landed would be racing it: whichever write came second would be the one asserted, and the test would
 * pass or fail on the order two frames happened to run in. Four frames is more than the chain needs — it
 * is scheduled within a frame of the render and runs two callbacks — so this settles it rather than
 * guessing at it.
 */
async function settleFrames(): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  })
}

/**
 * Open a conversation whose transcript is taller than its viewport, and hand back its box.
 *
 * Deliberately *not* waiting for the pane's own landing here. That is the subject of exactly one test
 * below, and a helper that waited for it would make every other assertion in the file a second test of
 * it — the controls would never get to say what they are about. The frames are settled, though, so a
 * test that drives the offset itself is not racing a landing it is not about.
 */
async function openTallConversation(): Promise<{ box: HTMLElement; stub: BridgeStub }> {
  const held = heldLoad(manyTurns())
  const stub = createBridgeStub({ loadTranscript: () => held.pending, chatWithTools: () => undefined })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)

  renderChat()
  const box = await awaitTranscript()
  setBox(box, { scrollTop: 0, scrollHeight: SCROLL_HEIGHT })
  held.release()
  await settleFrames()
  return { box, stub }
}

describe('a window with nothing open', () => {
  /**
   * The home case, stated first on purpose.
   *
   * conveyor's store mirror reads its state once per module and caches it for the life of the file, so
   * this file's first read of the chat-sessions store is the one every later render starts from. Seeding
   * home after a test has opened a conversation would mount the pane on the previous test's conversation
   * for its first render, and a conversation that has been opened stays open — so the pane would never
   * reach home, and the absence asserted below would be a fact about the harness rather than about the
   * pane.
   */
  it('draws no jump control on the home screen', async () => {
    const home = createBridgeStub({ loadTranscript: () => null })
    stubStore(home, CHAT_SESSIONS_STORE_ID, HOME_STATE)
    setActiveStub(home)
    renderChat()
    await screen.findByLabelText('Message')

    // No transcript at all: the space above the composer holds the headline, so there is nothing to jump
    // in and nothing for a control to be drawn on.
    expect(document.querySelector('[data-slot="chat-transcript"]')).toBeNull()
    expect(topControl()).toBeNull()
    expect(bottomControl()).toBeNull()
  })
})

describe('where an opened conversation starts', () => {
  it('lands on the last message rather than on the first', async () => {
    const held = heldLoad(manyTurns())
    const stub = createBridgeStub({ loadTranscript: () => held.pending, chatWithTools: () => undefined })
    stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
    setActiveStub(stub)

    renderChat()
    const box = await awaitTranscript()
    setBox(box, { scrollTop: 0, scrollHeight: SCROLL_HEIGHT })
    held.release()

    // The offset the container ends up at, and the only one a reader of a long conversation wants on a
    // row click: its bottom. The top is what this asserted against on the tree the defect was on.
    await waitFor(() => expect(box.scrollTop).toBe(BOTTOM))
    expect(box.scrollTop).not.toBe(0)
  })
})

describe('the two jump controls', () => {
  it('draws one for each end from the middle, and one click takes the reader to either', async () => {
    const { box } = await openTallConversation()

    // The reader scrolls into the middle of the conversation: both ends are somewhere to go.
    scrollTo(box, MIDPOINT)
    expect(topControl()).toBeTruthy()
    expect(bottomControl()).toBeTruthy()

    await userEvent.click(requiredControl(topControl(), 'go to the top'))
    expect(box.scrollTop).toBe(0)
    // At the top, the top control has nowhere to take anyone, so it is gone — and the other one is drawn,
    // which is what keeps a traversal one click per end rather than two clicks with nothing between them.
    expect(topControl()).toBeNull()
    expect(bottomControl()).toBeTruthy()

    await userEvent.click(requiredControl(bottomControl(), 'go to the bottom'))
    expect(box.scrollTop).toBe(BOTTOM)
    expect(bottomControl()).toBeNull()
    expect(topControl()).toBeTruthy()
  })

  it('draws only the control that has somewhere to go at either end', async () => {
    const { box } = await openTallConversation()

    // The reader is at the bottom of the conversation: the bottom control would go nowhere, so only the
    // top one is drawn.
    scrollTo(box, BOTTOM)
    expect(bottomControl()).toBeNull()
    expect(topControl()).toBeTruthy()

    // And a stray pixel from the top is not having left it: the control that goes nowhere stays drawn
    // until the reader has actually arrived, which is what the pane's own slack is for.
    scrollTo(box, NEAR_THE_TOP)
    expect(topControl()).toBeNull()
    expect(bottomControl()).toBeTruthy()

    // Past it, both ends are somewhere to go again.
    scrollTo(box, PAST_THE_TOP)
    expect(topControl()).toBeTruthy()
    expect(bottomControl()).toBeTruthy()
  })

  it('draws none in a conversation with no messages yet', async () => {
    // The box a conversation with nothing in it has is a box with nothing to scroll — which is what a
    // browser reports for an empty transcript. Handing it an overflow would be a geometry no empty
    // conversation has, and the controls below would be right to answer a transcript that does not exist.
    const held = heldLoad([])
    const stub = createBridgeStub({ loadTranscript: () => held.pending })
    stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
    setActiveStub(stub)

    renderChat()
    const box = await awaitTranscript()
    held.release()
    await waitFor(() => expect(document.querySelector('[data-slot="chat-transcript"]')).toBeTruthy())

    setBox(box, { scrollTop: 0, scrollHeight: VIEWPORT.height })
    scrollTo(box, 0)
    expect(topControl()).toBeNull()
    expect(bottomControl()).toBeNull()
  })
})

describe('the controls against a live reply', () => {
  it('keeps the bottom control away while the run pins the end, and shows it when the reader scrolls up', async () => {
    const { box, stub } = await openTallConversation()

    await userEvent.type(await screen.findByLabelText('Message'), 'what did we settle on?{Enter}')
    // A live run, by the one control only a live run draws.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeTruthy())

    const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
    const channel = `conveyor:stream:${started?.method}`
    stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: 'the reply is arriving' } })

    // The run's own pin, on the chunk it flushed: the pane carries the container to the bottom, and the
    // library lands it there against the same geometry this file states. A browser fires `scroll` for a
    // programmatic move; jsdom does not, so the test says what the browser would.
    await waitFor(() => expect(box.scrollTop).toBe(BOTTOM))
    fireEvent.scroll(box)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(bottomControl()).toBeNull()

    // The reader scrolls up mid-reply: the bottom is somewhere to go again the moment they do.
    scrollTo(box, MIDPOINT)
    expect(bottomControl()).toBeTruthy()
  })
})
