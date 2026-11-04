import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The composer pickers' dismissal, as the exit the primitive already knew how to draw.
 *
 * `popover.tsx` has carried `data-[state=closed]:animate-out` since the picker was built, and it has
 * never played: both pickers were conditionally rendered from `pickerOpen`/`commandOpen`, so the
 * content was gone on the same frame the state became closed. The fix is not a new animation but a
 * mount that outlives the state by one window — the last picker stays in the popover while it is
 * closed, pointer-transparent, and unmounts on the timer.
 *
 * What this file proves is the part that is easy to lose while keeping the picture: the listbox is
 * still there on the frame after Escape, it is not interactive, it is gone after the window, and the
 * caret never left the textarea — the composer is still the place the next keystroke goes.
 */

/**
 * The viewport the virtualized transcript needs. jsdom has no layout, and a zero-height scroll element
 * makes `@tanstack/react-virtual` render no rows — the composer is inside the pane, so the pane needs a
 * size before the picker has somewhere to open over. Scoped to this file and restored afterwards.
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

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const FILES = ['src/app.tsx', 'src/lib/utils.ts', 'README.md']

function renderChat() {
  const stub = createBridgeStub({ listFilesFlat: () => FILES })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
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

async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

/** The popover's content element, which is where the closing class and the pointer guard land. */
function popoverContent(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="popover-content"]') as HTMLElement
}

describe('a picker being dismissed', () => {
  it('keeps the mention listbox for the window, pointer-transparent, with the caret still in the textarea', async () => {
    renderChat()
    const area = await composer()

    await userEvent.type(area, '@app')
    expect(await screen.findByRole('listbox', { name: 'Mention a file' })).toBeTruthy()

    await userEvent.keyboard('{Escape}')

    // The state is closed at once; the drawing is still leaving.
    expect(screen.getByRole('listbox', { name: 'Mention a file' })).toBeTruthy()
    expect((popoverContent().getAttribute('class') ?? '').split(/\s+/)).toContain('pointer-events-none')

    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Mention a file' })).toBeNull())
    expect(document.activeElement).toBe(area)
    expect(area.value).toBe('@app')
  })

  it('keeps the command listbox for the same window, and the draft is where it was', async () => {
    renderChat()
    const area = await composer()

    await userEvent.type(area, '/new')
    expect(await screen.findByRole('listbox', { name: 'Run a command' })).toBeTruthy()

    await userEvent.keyboard('{Escape}')

    expect(screen.getByRole('listbox', { name: 'Run a command' })).toBeTruthy()
    expect((popoverContent().getAttribute('class') ?? '').split(/\s+/)).toContain('pointer-events-none')

    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Run a command' })).toBeNull())
    expect(document.activeElement).toBe(area)
    expect(area.value).toBe('/new')
  })
})
