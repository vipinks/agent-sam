import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { percentSize, type LayoutSizes } from '@/app/components/workbench/layout'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The right rail, and the panels it docks into the inner group's right slot.
 *
 * Phase 39's shell restructure is a claim about the *layout*, not about styling: the inner group now
 * holds whichever of the right rail's panels is docked, and nothing at all at launch. So the
 * assertions are on the group's own panel children — the columns sharing the width — and on which
 * panel's own node is inside the slot, never on a measured width, which is jsdom's business only.
 *
 * The resize primitive is stood in for, exactly as `layout-wiring.test.tsx` stands in for it and for
 * the same reason: with the real library the declared sizes are replaced on the first layout effect
 * with a computed layout, and in jsdom — where everything measures zero — that computation writes
 * `0px` on every panel. The stand-in records what the workbench passed, which is the claim here: a
 * docked panel is handed the *persisted* share of the inner group, and the chat keeps the rest. It
 * keeps the library's own hooks (`data-group`, `data-panel`), so the panels are found the way the
 * other workbench suites find them.
 *
 * Three things only a rendered workbench can show, and each has a way of being wrong that no rule
 * test would catch:
 *
 * - The right panel's open state is in memory and nowhere else. It survives a session switch — which
 *   is a re-render of the panes around it, not a relaunch — and it is gone at a launch, reached the
 *   way a restart reaches it, by evaluating the module graph again. A flag that had been written to
 *   storage would pass the first half and fail the second.
 * - The viewer's expansion composes with a docked panel: the chat column is removed from the group
 *   while the docked panel stays mounted, so an edited buffer or a chosen sheet survives the toggle.
 * - The header's collapse glyph and the rail are two controls over one flag, and neither is a second
 *   source of truth for it.
 *
 * Residual, named rather than claimed: jsdom lays nothing out, so that a real window's docked panel
 * comes back at its persisted share is verified in the app; what is asserted here is the share it is
 * handed.
 */

const standIn = vi.hoisted(() => ({
  groups: new Map<string, { defaultLayout?: Record<string, number> }>(),
}))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    id,
    defaultLayout,
    children,
  }: {
    id?: string
    defaultLayout?: Record<string, number>
    children?: ReactNode
  }) => {
    if (id) standIn.groups.set(id, { defaultLayout })
    return (
      <div data-group id={id}>
        {children}
      </div>
    )
  },
  ResizablePanel: ({ id, defaultSize, children }: { id?: string; defaultSize?: string; children?: ReactNode }) => (
    <div data-panel id={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'
const MD_PATH = 'C:/w/notes.md'

/** The record the layout sets are stored in, so "the dock wrote nothing" is checkable. */
const STORED_KEY = 'sam-ai-layout-preferences'

const TEXT_SOURCE = ['just words', 'on two lines', ''].join('\n')
const MD_SOURCE = ['# Release notes', '', '- one', ''].join('\n')

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222'
const OTHER_TITLE = 'unrelated subject entirely'

/** Two conversations in the open folder, so a switch is a switch between two real rows. */
function sessionStore() {
  const row = (id: string, title: string, updatedAt: number) => ({
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    rootPath: ROOT,
  })
  return {
    sessions: [
      row(SESSION_ID, 'the parser drops newlines', 1_700_000_000_000),
      row(OTHER_ID, OTHER_TITLE, 1_700_000_000_001),
    ],
    activeId: SESSION_ID,
  }
}

/**
 * The whole workbench, over a folder with one text file and one markdown file in it.
 *
 * The window is windowed — the state the app opens — and every other read a pane makes is answered
 * emptily: the git panel and the provider lists are not this file's subject, and an unstubbed query
 * would be noise in the middle of a layout claim.
 */
function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    readFile: (input) => {
      const path = (input as { path: string }).path
      return path === MD_PATH
        ? { path: MD_PATH, content: MD_SOURCE, baselineMtime: 0 }
        : { path: TEXT_PATH, content: TEXT_SOURCE, baselineMtime: 0 }
    },
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    // A session switch asks main to open the folder the conversation was used in. Answered with the
    // folder already open, which is the case that changes nothing around the dock.
    openRoot: () => ROOT,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore())
  setActiveStub(stub)
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/** The right rail, by the name it states to everything that is not a pointer. */
function rightRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Right rail' })
}

/** One of the right rail's residents, by its label. */
function resident(label: string): HTMLElement {
  return within(rightRail()).getByRole('button', { name: label })
}

/** The drawer, so a session row can be reached. */
function drawer(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-panel]#secondary')
  if (!found) throw new Error('the drawer is not in the outer group')
  return found
}

/**
 * The panels of one group, in the order the group was built with, as id and declared size.
 *
 * Scoped to the group's own direct children, for the reason the other layout suites are: how many
 * columns share a width is the grouping, and a nested panel belonging to another group is not one of
 * them.
 */
function columns(container: HTMLElement, groupId: string): { id: string; defaultSize: string | null }[] {
  const group = container.querySelector<HTMLElement>(`[data-group]#${groupId}`)
  if (!group) throw new Error(`no group #${groupId} in the rendered workbench`)
  return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map((panel) => ({
    id: panel.id,
    defaultSize: panel.getAttribute('data-default-size'),
  }))
}

/** The inner group's own columns: the chat, and the docked panel while there is one. */
function innerColumns(container: HTMLElement): { id: string; defaultSize: string | null }[] {
  return columns(container, 'workbench-main')
}

/** The docked panel's node, or null while the right rail is alone. */
function docked(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#code')
}

/** The open-file state the two viewer residents both read. */
function open(path: string | null): void {
  act(() => useWorkbenchStore.setState({ selectedFile: path, selectedChange: null }))
}

beforeEach(() => {
  standIn.groups.clear()
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

describe('the right rail, at launch', () => {
  it('holds the chat alone, with the chat handed the whole group', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    // The launch default: nothing is docked, so the inner group has one column and that column
    // declares everything — the same fallback a group of one relies on everywhere else here. The
    // group's own declared layout still names both panels; it is set aside because the group has one.
    expect(innerColumns(container)).toEqual([{ id: 'chat', defaultSize: percentSize(100) }])
    expect(docked(container)).toBeNull()

    await waitFor(() => expect(screen.getByLabelText('Message')).toBeTruthy())
  })

  it('offers its three residents, in order, with none of them pressed', async () => {
    stubWorkbench()
    renderWorkbench()

    const labels = [...rightRail().querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(['Code', 'Preview', 'Tools'])
    expect(
      labels.map((_, index) => [...rightRail().querySelectorAll('button')][index]?.getAttribute('aria-pressed'))
    ).toEqual(['false', 'false', 'false'])
  })
})

describe('docking a resident', () => {
  it('docks each of the three into the right slot at the persisted inner percentage', async () => {
    // A set dragged in this window state, which is what "the persisted inner percentage" means: the
    // dock reads a share that was chosen, not the default it would have opened with.
    const dragged: LayoutSizes = { outer: { drawer: 34, main: 66 }, main: { chat: 41, viewer: 59 } }
    stubWorkbench()
    act(() => useWorkbenchStore.getState().saveLayout('windowed', dragged))

    const { container } = renderWorkbench()

    open(TEXT_PATH)
    await userEvent.click(resident('Code'))
    expect(innerColumns(container)).toEqual([
      { id: 'chat', defaultSize: percentSize(41) },
      { id: 'code', defaultSize: percentSize(59) },
    ])
    // The resident's own node, so "it docked" is a claim about content rather than about a slot id.
    await waitFor(() => expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull())
    expect(resident('Code').getAttribute('aria-pressed')).toBe('true')

    // Switching residents moves the slot rather than adding a second one.
    open(MD_PATH)
    await userEvent.click(resident('Preview'))
    expect(innerColumns(container)[1]?.id).toBe('code')
    await waitFor(() => expect(container.querySelector('[data-slot="markdown-preview"]')).not.toBeNull())
    expect(container.querySelector('[data-slot="code-gutter"]')).toBeNull()
    expect(resident('Preview').getAttribute('aria-pressed')).toBe('true')
    expect(resident('Code').getAttribute('aria-pressed')).toBe('false')

    // And the dock wrote nothing into either layout set: the share it took was already stored.
    expect(JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}')).toEqual({ layoutWindowed: dragged })
  })

  it('returns to the rail when the active resident is clicked a second time', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(resident('Preview'))
    expect(docked(container)).not.toBeNull()

    await userEvent.click(resident('Preview'))
    expect(docked(container)).toBeNull()
    expect(innerColumns(container)).toEqual([{ id: 'chat', defaultSize: percentSize(100) }])
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
    // The choice of panel is what went, not the file: the open file is the explorer's business.
    expect(resident('Preview').getAttribute('aria-pressed')).toBe('false')
  })

  it('returns to the rail from the panel header’s own collapse glyph', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(resident('Tools'))
    const header = within(docked(container) as HTMLElement).getAllByRole('button', { name: 'Collapse panel' })[0]
    expect(header?.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(header as HTMLElement)
    expect(docked(container)).toBeNull()
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
  })
})

describe('the dock’s open state, in memory only', () => {
  it('survives a session switch within the run', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    open(MD_PATH)
    await userEvent.click(resident('Preview'))
    await waitFor(() => expect(container.querySelector('[data-slot="markdown-preview"]')).not.toBeNull())
    const slot = docked(container)
    const surface = container.querySelector('[data-slot="markdown-preview"]')

    // The switch: another conversation is opened, which loads its transcript and opens the folder it
    // was used in. Nothing about that is about the right slot.
    await userEvent.click(within(drawer(container)).getByText(OTHER_TITLE))

    await waitFor(() => expect(useWorkbenchStore.getState().activeActivity).toBe('chat'))
    expect(useWorkbenchStore.getState().rightPanel).toBe('preview')
    expect(docked(container)).toBe(slot)
    expect(container.querySelector('[data-slot="markdown-preview"]')).toBe(surface)
  })

  it('is gone at a relaunch, and was never stored on the way', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(resident('Preview'))
    expect(docked(container)).not.toBeNull()
    expect(localStorage.getItem(STORED_KEY)).toBeNull()

    // A launch is the module graph evaluated again, which is how the other launch claims are reached.
    vi.resetModules()
    const freshStore = await import('@/app/components/workbench/store')
    expect(freshStore.useWorkbenchStore.getState().rightPanel).toBeNull()

    stubWorkbench()
    const { Workbench: FreshWorkbench } = await import('@/app/components/workbench/workbench')
    const freshClient = await import('@/conveyor/client')

    const fresh = render(
      <QueryClientProvider client={freshClient.queryClient}>
        <FreshWorkbench />
      </QueryClientProvider>
    )

    expect(freshStore.useWorkbenchStore.getState().rightPanel).toBeNull()
    expect(fresh.container.querySelector('[data-panel]#code')).toBeNull()
    expect(columns(fresh.container, 'workbench-main')).toEqual([{ id: 'chat', defaultSize: percentSize(100) }])
  })
})

describe('the viewer’s expansion, with a panel docked', () => {
  it('takes the chat’s column for whichever panel is open, and remounts nothing', async () => {
    const dragged: LayoutSizes = { outer: { drawer: 34, main: 66 }, main: { chat: 41, viewer: 59 } }
    stubWorkbench()
    act(() => useWorkbenchStore.getState().saveLayout('windowed', dragged))

    const { container } = renderWorkbench()
    open(MD_PATH)
    await userEvent.click(resident('Preview'))

    await waitFor(() => expect(container.querySelector('[data-slot="markdown-preview"]')).not.toBeNull())
    const slot = docked(container)
    const surface = container.querySelector('[data-slot="markdown-preview"]')

    await userEvent.click(screen.getByRole('button', { name: 'Expand the viewer' }))

    // The chat's column is removed rather than narrowed, and the docked panel is handed everything —
    // the same shape the expansion has always had, with the Preview in the slot instead of the Code.
    expect(container.querySelector('[data-panel]#chat')).toBeNull()
    expect(innerColumns(container)).toEqual([{ id: 'code', defaultSize: percentSize(100) }])
    expect(docked(container)).toBe(slot)
    expect(container.querySelector('[data-slot="markdown-preview"]')).toBe(surface)
    expect(useWorkbenchStore.getState().rightPanel).toBe('preview')

    await userEvent.click(screen.getByRole('button', { name: 'Restore the chat column' }))

    expect(container.querySelector('[data-panel]#chat')).not.toBeNull()
    expect(innerColumns(container)).toEqual([
      { id: 'chat', defaultSize: percentSize(41) },
      { id: 'code', defaultSize: percentSize(59) },
    ])
    // Restoring is a layout change, not a drag, so neither stored set moved.
    expect(JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}')).toEqual({ layoutWindowed: dragged })
  })
})
