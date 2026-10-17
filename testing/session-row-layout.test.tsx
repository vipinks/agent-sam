import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The conversation row's two alignments: under the project it belongs to, and under its own actions.
 *
 * jsdom lays nothing out, so this suite pins structure rather than pixels. What it can hold is the
 * contract the running window then draws: the row indents by the group header's chevron column, the
 * title keeps the full row width, and the action cluster is taken out of that flow and laid over the
 * title's tail. The icons themselves are verified by eye in the running window.
 */

const PROJECT_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const LOOSE_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** The folder the window is showing; the loose row deliberately has none. */
const ROOT = 'C:/work/sam-ai'

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

/** Install a stub, seed one project row and one no-project row, and render the real panel. */
function renderPanel(activeSessionId: string | null = null) {
  const stub = createBridgeStub({
    loadTranscript: () => null,
    listFilesFlat: () => [],
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: PROJECT_ID,
        title: 'project work',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_002,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        lastRoot: ROOT,
      },
      {
        id: LOOSE_ID,
        title: 'before projects existed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <SessionListPanel
          onCreate={vi.fn()}
          onOpen={vi.fn()}
          onRename={vi.fn()}
          onExport={vi.fn()}
          onDelete={vi.fn()}
          onMove={vi.fn()}
          error={null}
          notice={null}
        />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The row container for a title: the open control's parent, which also holds the actions. */
function rowFor(title: string): HTMLElement {
  const open = screen.getByText(title).closest('button') as HTMLElement
  return open.parentElement as HTMLElement
}

/** The open control whose text and meta line make up the row's title area. */
function titleButtonFor(title: string): HTMLElement {
  return screen.getByText(title).closest('button') as HTMLElement
}

/** The hover cluster: the Rename control's parent, which is the row's action surface. */
function clusterFor(title: string): HTMLElement {
  return screen.getByLabelText(`Rename ${title}`).parentElement as HTMLElement
}

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean)
}

describe('the session row aligns under its project and its actions', () => {
  it("indents every row by the group header's chevron column", async () => {
    renderPanel()
    await screen.findByText('project work')

    // The header's chevron is size-3.5 with gap-1.5 after it, and the header itself starts at px-3:
    // 12 + 14 + 6 = 32px, which is pl-8. A row in the no-project group indents the same way, because
    // that group has a chevron too.
    expect(tokens(rowFor('project work'))).toContain('pl-8')
    expect(tokens(rowFor('before projects existed'))).toContain('pl-8')
  })

  it("leaves the title the row's full width and overlays the actions at its tail", async () => {
    renderPanel()
    const title = await screen.findByText('project work')
    const button = titleButtonFor('project work')
    const cluster = clusterFor('project work')

    // The title is the in-flow child that takes the whole row; the cluster is out of that flow and
    // pinned to the right edge, vertically centred, so it overlays the title rather than sitting in
    // a gutter beside it.
    expect(tokens(button)).toContain('flex-1')
    expect(tokens(button)).toContain('min-w-0')
    expect(cluster.parentElement).toBe(button.parentElement)
    expect(tokens(cluster)).toContain('absolute')
    expect(tokens(cluster)).toContain('right-3')
    expect(tokens(cluster)).toContain('top-1/2')
    expect(tokens(cluster)).toContain('-translate-y-1/2')
    expect(tokens(cluster)).not.toContain('shrink-0')
    expect(tokens(title)).toContain('truncate')
  })

  it('keeps the title truncating underneath the cluster when the row is hovered', async () => {
    renderPanel()
    const title = await screen.findByText('project work')
    const before = title.className

    // Hover only reveals the actions; it must not reflow the title or reserve width for them.
    await userEvent.hover(rowFor('project work'))

    expect(title.className).toBe(before)
    expect(tokens(title)).toContain('truncate')
  })

  it('paints the cluster from the row state it covers', async () => {
    renderPanel()
    await screen.findByText('project work')

    // Transparent would let the title's tail show through the icons; inheriting the row's own
    // background covers it in the resting, hovered and selected tints alike, in both themes.
    expect(tokens(clusterFor('project work'))).toContain('bg-inherit')
  })
})

describe('the action cluster hides the title beneath it opaquely', () => {
  it('paints an opaque row background in the two states that reveal the cluster', async () => {
    renderPanel()
    await screen.findByText('project work')

    // The resting row stays bare, but the two states that reveal the actions resolve to the solid
    // accent token, so the cluster inherits a colour the title cannot show through.
    const row = tokens(rowFor('project work'))
    expect(row).toContain('hover:bg-accent')
    expect(row).toContain('focus-within:bg-accent')
  })

  it('resolves the opaque state over the selected tint too', async () => {
    renderPanel(PROJECT_ID)
    await screen.findByText('project work')

    // The selected tint is translucent over the panel, so it cannot be the colour the cluster
    // inherits while the actions are up: the hover and focus states must win on a selected row.
    const row = tokens(rowFor('project work'))
    expect(row).toContain('bg-brand-soft')
    expect(row).toContain('hover:bg-accent')
    expect(row).toContain('focus-within:bg-accent')
  })

  it('keeps the cluster inheriting that background, out of the title flow', async () => {
    renderPanel()
    await screen.findByText('project work')

    const cluster = tokens(clusterFor('project work'))
    expect(cluster).toContain('bg-inherit')
    expect(cluster).toContain('absolute')
    expect(cluster).toContain('right-3')
    expect(cluster).toContain('top-1/2')
    expect(cluster).toContain('-translate-y-1/2')
  })

  it('fades the title into the cluster along its left edge', async () => {
    renderPanel()
    await screen.findByText('project work')

    // A filler, not an action: the cluster's first child is the strip that carries the row colour
    // out to transparent, so the last visible glyph softens instead of meeting a hard edge.
    const fade = clusterFor('project work').firstElementChild as HTMLElement
    expect(fade.tagName).toBe('SPAN')
    expect(fade.getAttribute('aria-hidden')).toBe('true')
    expect(tokens(fade)).toContain('bg-linear-to-r')
    expect(tokens(fade)).toContain('from-transparent')
    expect(tokens(fade)).toContain('to-accent')
  })
})
