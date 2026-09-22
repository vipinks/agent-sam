import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { COMPOSER_MAX_SHARE, COMPOSER_MIN_HEIGHT } from '@/app/components/workbench/composer-resize'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The composer's fixed height and its drag handle, as wiring.
 *
 * `composer-resize-rules.test.ts` owns the arithmetic. What only a rendered composer can show is that
 * the number arrives: that a draft longer than the box leaves its height alone, that a pointer drag
 * moves it, and that a drag past either bound stops there.
 *
 * jsdom performs no layout, so nothing here measures anything. The things it cannot do are stated
 * rather than guessed: the pane is given a height, because a panel in a zero-height column would clamp
 * every drag to the floor, and the composer's height is read from its style attribute — the number the
 * component wrote, which is the number a browser would lay out with.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** The pane height the drags are measured against, so the ceiling is a knowable number. */
const PANE_HEIGHT = 500
const PANE_CEILING = Math.round(PANE_HEIGHT * COMPOSER_MAX_SHARE)

/** A draft far taller than the composer can show, which is what a content-sized box would have grown for. */
const LONG_DRAFT = Array.from(
  { length: 24 },
  (_, line) => `line ${line + 1} of a draft that is much longer than the composer`
).join('\n')

function renderChat() {
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: () => null,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: 'a conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId: SESSION_ID,
  })
  setActiveStub(stub)

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
 * The chat pane, with the height jsdom cannot give it.
 *
 * The panel's root element *is* the pane the ceiling is a share of — the element the workbench puts
 * inside the chat column — so measuring it is what a real window does. Defined on that element rather
 * than on `HTMLElement.prototype`, so no other element in this file inherits a size it does not have.
 */
function chatPane(container: HTMLElement): HTMLElement {
  const pane = container.firstElementChild as HTMLElement | null
  if (!pane?.querySelector('[role="separator"]')) throw new Error('the rendered panel is not a chat pane')
  Object.defineProperty(pane, 'clientHeight', { value: PANE_HEIGHT, configurable: true })
  return pane
}

/** The composer, once React has mounted it. */
const composer = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('Message')) as HTMLTextAreaElement

/** The composer's top edge, as the user grabs it. */
const handle = (): Promise<HTMLElement> => screen.findByRole('separator', { name: 'Resize the composer' })

/** One drag: where the pointer went down, where it moved to, and the element it started on. */
function drag(from: number, to: number, on: HTMLElement): void {
  fireEvent.pointerDown(on, { clientY: from, button: 0 })
  fireEvent.pointerMove(window, { clientY: to })
  fireEvent.pointerUp(window)
}

describe('the composer as it opens', () => {
  it('renders at its own height, with a drag handle on its top edge', async () => {
    const { container } = renderChat()
    chatPane(container)

    const area = await composer()
    const edge = await handle()

    expect(area.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`)
    expect(edge.getAttribute('aria-orientation')).toBe('horizontal')
    expect(edge.className).toContain('cursor-row-resize')
  })

  it('renders a draft longer than the box at that height still, scrolling inside itself', async () => {
    const { container } = renderChat()
    chatPane(container)

    const area = await composer()
    fireEvent.change(area, { target: { value: LONG_DRAFT } })

    expect(area.value).toBe(LONG_DRAFT)
    expect(area.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`)
    // The two classes that make that true rather than merely stated: `field-sizing-fixed` overrides the
    // primitive's content sizing — tailwind-merge keeps the later of the two, which is why the looser one
    // is absent — and the box scrolls internally rather than pushing the transcript off the pane.
    expect(area.className).toContain('field-sizing-fixed')
    expect(area.className).not.toContain('field-sizing-content')
    expect(area.className).toContain('overflow-y-auto')
  })
})

describe('dragging the composer taller and shorter', () => {
  it('follows the pointer, and stops following it when the pointer is released', async () => {
    const { container } = renderChat()
    chatPane(container)

    const area = await composer()
    drag(400, 300, await handle())

    // Dragging up by 100 grows the composer by 100.
    expect(area.style.height).toBe(`${COMPOSER_MIN_HEIGHT + 100}px`)

    // The drag is over, so the composer keeps the height it was left at rather than tracking a pointer
    // that is no longer down.
    fireEvent.pointerMove(window, { clientY: 100 })
    expect(area.style.height).toBe(`${COMPOSER_MIN_HEIGHT + 100}px`)
  })

  it('stops at the floor when the pointer keeps going down', async () => {
    const { container } = renderChat()
    chatPane(container)

    const area = await composer()
    drag(400, 900, await handle())

    expect(area.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`)
  })

  it('stops at the pane share when the pointer keeps going up, and carries on from there', async () => {
    const { container } = renderChat()
    chatPane(container)

    const area = await composer()
    drag(400, -200, await handle())

    expect(area.style.height).toBe(`${PANE_CEILING}px`)

    // A second drag starts from where the composer is — at the ceiling, not at its opening height — so
    // four pixels down is four pixels shorter. That is what a drag held past the limit must leave behind:
    // a composer pinned where it was clamped is one the pointer can no longer get back out of.
    drag(400, 404, await handle())
    expect(area.style.height).toBe(`${PANE_CEILING - 4}px`)
  })
})
