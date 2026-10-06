/**
 * The transcript's own scroll, as wiring.
 *
 * The defect this pins: the chat box scrolled sideways. The container was `overflow-auto` — both axes —
 * and the markdown prose was contained in exactly one place, the paragraph. Everything else markdown
 * can draw as prose — a list item, a heading, a blockquote — carried no wrap rule of its own, so a long
 * inline code span in one of them was an unbreakable run several hundred pixels wide. It painted past
 * its block box, past the bubble, and into the scroll container's scrollable overflow area, and the
 * reader's reward was a horizontal scrollbar under an answer that had done nothing wrong.
 *
 * Reproduced before it was fixed, with the pane's own class chain transcribed into a real engine rather
 * than reasoned about here: with the shipped classes the container's `scrollWidth` was 1465 against a
 * 560 client width, and the three children painted past its right edge were the `<code>` spans inside a
 * `<li>`, an `<h3>` and a `<blockquote>`; with `break-words` on those same blocks it was 560 against
 * 560, with the table still scrolling inside its own wrapper. The fixture below is that answer; jsdom is
 * the wiring, the engine run was the pixels.
 *
 * The honest ceiling of these assertions. jsdom lays nothing out: every element reports a zero-size box,
 * nothing here can observe that a scrollbar is gone, and the `pre` and table wrappers are asserted as
 * classes rather than as regions that scroll. So this suite asserts the *structure* that states the
 * policy — which node is the transcript's scroll container, which axis it is allowed to scroll, which
 * markdown blocks carry the wrap that keeps them inside it, and that the two constructs which are
 * allowed their own horizontal scroll still declare it. Pixel acceptance is Boss's eyes in both themes:
 * the long Hindi session showing no horizontal scrollbar on the chat box while a code block scrolls
 * inside it.
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
 * `@tanstack/react-virtual` sizes its window from the scroll element's own measured size, both of which
 * read as 0 in jsdom — and a zero-height window renders no rows, so every assertion about a message
 * would be made against an empty transcript. Scoped to this file and restored afterwards.
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

/** The unbreakable run the list item carries: one token, no space and no hyphen to break at. */
const LONG_TOKEN = 'planChatTranscriptOverflowContainmentForTheChatPaneAndEveryNestedChild'.repeat(3)

/**
 * The answer: a long line of mixed Hindi prose with inline code spans, a list item carrying the long
 * token, a fenced code block whose line cannot wrap either, and a table wide enough to need the
 * wrapper's own scroll. Every construct the fix has an opinion about is in it.
 */
const ANSWER = [
  'यह उत्तर `resolveSessionRootPath` और `planChatTranscriptOverflowContainment` के बारे में है, और',
  'यह एक लंबी हिंदी पंक्ति है जो `conveyor/protocol/root-name.ts` का पूरा नाम भी लेती है।',
  '',
  `- \`${LONG_TOKEN}\` — यह सूची आइटम एक ही पंक्ति में बहुत लंबा है और टूटता नहीं है।`,
  `1. \`${LONG_TOKEN}\` — क्रमबद्ध सूची में भी वही एक ही पंक्ति है।`,
  '',
  `# \`${LONG_TOKEN}\` अध्याय`,
  '',
  `## \`${LONG_TOKEN}\` उपशीर्षक`,
  '',
  `### \`${LONG_TOKEN}\` शीर्षक`,
  '',
  `> \`${LONG_TOKEN}\``,
  '',
  '```ts',
  'const containment = planChatTranscriptOverflowContainment(transcript, pane, ' + LONG_TOKEN + ')',
  '```',
  '',
  '| पंक्ति | संदर्भ | पथ | नाम | विवरण | स्थिति | टिप्पणी |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| बहुत लंबा हिंदी वाक्य जो कोशिका को चौड़ा करता है | `resolveSessionRootPath` | `conveyor/protocol/root-name.ts` | एक | दो | तीन | चार |',
].join('\n')

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'the transcript scrolls sideways',
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

/** One assistant turn carrying the fixture, from its words through the end of the turn. */
async function answerWithFixture(): Promise<void> {
  const stub = stubChat()
  renderChat()

  await userEvent.type(await screen.findByLabelText('Message'), 'why does the chat box scroll sideways?{Enter}')
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  const channel = `conveyor:stream:${started?.method}`

  stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: ANSWER } })
  stub.emit(channel, { type: 'data', value: { type: 'turn_end', cause: 'model_stop' } })
  stub.emit(channel, { type: 'data', value: { type: 'done', reason: 'complete', steps: 1 } })
  stub.emit(channel, { type: 'end' })

  await waitFor(() => expect(markdownBody()).toBeTruthy())
}

/** The transcript's scroll container, by the slot the pane puts on it. */
function transcript(): HTMLElement {
  const box = document.querySelector<HTMLElement>('[data-slot="chat-transcript"]')
  if (!box) throw new Error('the pane renders no transcript container')
  return box
}

/** The markdown body the fixture answer is drawn in. */
function markdownBody(): HTMLElement {
  const body = [...document.querySelectorAll<HTMLElement>('[data-slot="markdown"]')].find((node) =>
    (node.textContent ?? '').includes('resolveSessionRootPath')
  )
  if (!body) throw new Error('no markdown body draws the fixture answer')
  return body
}

/** One construct inside that body, by selector, or a readable failure when the fixture drew none. */
function within(selector: string): HTMLElement {
  const node = markdownBody().querySelector<HTMLElement>(selector)
  if (!node) throw new Error(`the fixture answer draws no ${selector}`)
  return node
}

describe('the transcript’s own scroll', () => {
  it('scrolls vertically only, so a wide child cannot put a second bar under the chat box', async () => {
    await answerWithFixture()

    const classes = transcript().classList

    // The vertical axis, stated rather than inherited from a shorthand that also opens the other one.
    expect(classes.contains('overflow-y-auto')).toBe(true)
    // And the horizontal axis closed. The child containment below is the real fix; this is the container
    // refusing to be the second place a wide child can go, which is what stops a future one from
    // redrawing the defect without anyone touching the transcript's children.
    expect(classes.contains('overflow-x-hidden')).toBe(true)
    // The both-axes shorthand is gone: `overflow-auto` beside `overflow-x-hidden` would be a declaration
    // whose meaning depends on the order Tailwind happens to emit them in.
    expect(classes.contains('overflow-auto')).toBe(false)
    expect(classes.contains('overflow-x-auto')).toBe(false)
  })

  it('wraps the prose blocks that markdown can draw, not only the paragraph', async () => {
    await answerWithFixture()

    // The paragraph already carried it; the leak was everywhere else, and the list item in the fixture is
    // the one that produced the reproduced overflow.
    for (const selector of ['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'blockquote']) {
      const node = within(selector)
      expect(node.classList.contains('break-words'), `${selector} wraps`).toBe(true)
    }
  })

  it('leaves the code block and the table their own horizontal scroll', async () => {
    await answerWithFixture()

    // The two constructs that are allowed to be wider than the bubble, and the only two. A fenced block
    // scrolls inside itself and must not be handed the prose's wrap: a wrapped code line is a line the
    // reader can no longer copy as it was written.
    const fence = within('pre')
    expect(fence.classList.contains('overflow-x-auto')).toBe(true)
    expect(fence.classList.contains('break-words')).toBe(false)
    expect(fence.querySelector('code')?.classList.contains('break-words')).toBe(false)

    // The table's own scroll lives on the wrapper the renderer puts around it, and the wrapper is what
    // the prose's wrap must not reach — a wrapped cell is a table that reflows instead of scrolling.
    const table = within('table')
    const wrapper = table.parentElement
    expect(wrapper?.classList.contains('overflow-x-auto')).toBe(true)
    expect(wrapper?.classList.contains('break-words')).toBe(false)
  })
})
