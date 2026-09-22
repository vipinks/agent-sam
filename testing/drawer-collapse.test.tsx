import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { LayoutSizes } from '@/app/components/workbench/layout'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The drawer, put away: the rail's own control, the three triggers that move it, and what the layout
 * writes while it is gone.
 *
 * The rail's top control was a status dot — a `<span>` with a brand mark in it, no `title`, no
 * `aria-label` and no handler — so there was no action to keep and it becomes the collapse control
 * instead, in the slot it already held. That repurpose is pinned below rather than left to the diff:
 * the same slot is asserted to be a button now, and the span that used to fill it to be gone.
 *
 * What only a rendered workbench can show, and what no rule test would catch, is the composition. The
 * collapse removes the drawer *panel* from the outer group rather than narrowing it, hiding it or
 * overlaying it, so the assertion is on the group's own panel children and on the absence of the
 * drawer's node, never on a measured width, which is jsdom's business only. Toggling it must also not
 * reach the stored sets: a drag writes a state's numbers, and a collapse three inches away must not be
 * able to write one — the case that fails silently, as a layout that is 34/66 on the next launch for no
 * reason anyone can see.
 *
 * The last two claims are the ones that live in a seam. `drawerCollapsed` and the viewer's
 * `viewerExpanded` are two removals in two groups, and either toggle must leave the other exactly as it
 * was; and the flag is persisted in the record the layout sets already live in, so the read has to
 * happen before the first render — a rehydrated store is reached the way a restart reaches it, by
 * loading the module a second time.
 *
 * Residual, named rather than claimed: jsdom lays nothing out. That a real window's drawer comes back at
 * forty-something percent of the window is verified in the app, and the declared share it is handed is
 * asserted in `layout-wiring.test.tsx`, where the resize primitive is stood in for and its props are
 * readable.
 */

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/** The record the collapse is stored in, beside the two layout sets. */
const STORED_KEY = 'sam-ai-layout-preferences'

/** The stored record as the renderer's settings slice holds it. */
function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}') as Record<string, unknown>
}

/**
 * The whole workbench, over a folder with one file in it.
 *
 * The window is windowed — the state the app opens — and every read the other panes make is answered
 * emptily: the composer, the session list and the git panel are not this file's subject, and an
 * unstubbed query would be noise in the middle of a layout claim.
 */
function stubWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    readFile: () => ({ path: TEXT_PATH, content: 'just words\n', baselineMtime: 0 }),
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
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
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

/** The rail, by the name it states to everything that is not a pointer. */
function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Workbench' })
}

/** One of the rail's own controls, by the direction or the view it names. */
function railControl(label: string): HTMLElement {
  return within(rail()).getByRole('button', { name: label })
}

/**
 * The drawer's panel, or null while it is out of the outer group.
 *
 * `data-panel` is a marker attribute with no value, and the id is the name the outer group is built
 * with. Absence of this node is what "collapsed" means; a drawer narrowed to nothing would still be
 * here, which is why nothing narrower is asserted.
 */
function drawer(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#secondary')
}

/** The drawer's own header, wherever the panel it is showing puts its controls. */
function drawerHeader(container: HTMLElement): HTMLElement {
  const header = drawer(container)?.querySelector('header')
  if (!header) throw new Error('the drawer rendered no header')
  return header as HTMLElement
}

/**
 * The panels of the *outer* group, in the order the group was built with.
 *
 * Scoped to the group's own direct children, as the viewer's suite is and for the same reason: the chat
 * and the viewer are panels too, and how many columns the outer group is sharing its width with is the
 * claim — a nested panel found by a document-wide search would make a collapsed drawer look present.
 */
function outerColumns(container: HTMLElement): string[] {
  const group = container.querySelector<HTMLElement>('[data-group]#workbench')
  if (!group) throw new Error('the workbench rendered no outer group')
  return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map((panel) => panel.id)
}

/**
 * The two layout sets as they are stored, without the collapse flag beside them.
 *
 * Read off the record's own text rather than from a parsed copy, so "byte-identical" is what is being
 * asserted: a collapse that recomputed the drawer's share for the half-width group — or wrote a zero
 * where the drawer used to be — would still parse back into a plausible-looking set.
 */
function storedSets(): string {
  const record = stored()
  return JSON.stringify({ layoutWindowed: record.layoutWindowed, layoutMaximized: record.layoutMaximized })
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

describe('the rail', () => {
  it('reads its five controls in order, with Settings still at the foot', async () => {
    stubWorkbench()
    renderWorkbench()

    // DOM order is the tab order and the visual order at once: the buttons are the rail's children in
    // the order the registry holds, so one reading answers for all three. The collapse control leads,
    // then the conversation, the folder it is about, that folder's state, and the shell beside it.
    const labels = [...rail().querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))

    expect(labels).toEqual(['Collapse drawer', 'Chat', 'Explorer', 'Git', 'Terminal', 'Settings'])
    // The five, and then the foot: Settings is a place you visit and leave, and is not one of them.
    expect(labels.slice(0, 5)).toHaveLength(5)
  })

  it('opens each activity’s own panel from the rail', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(railControl('Chat'))
    expect(within(drawer(container) as HTMLElement).getByText('Chat Sessions')).toBeTruthy()
    expect(useWorkbenchStore.getState().activeActivity).toBe('chat')

    await userEvent.click(railControl('Explorer'))
    expect(within(drawer(container) as HTMLElement).getByText('Explorer')).toBeTruthy()

    await userEvent.click(railControl('Git'))
    expect(within(drawer(container) as HTMLElement).getByText('Git Changes')).toBeTruthy()

    // Terminal is one of the two views that take the whole main area rather than the drawer, so what it
    // opens is asserted where it draws: the group and the drawer are gone, and the transcript is up.
    await userEvent.click(railControl('Terminal'))
    expect(useWorkbenchStore.getState().activeActivity).toBe('terminal')
    expect(container.querySelector('[data-panel]#secondary')).toBeNull()
    expect(screen.getByLabelText('Command')).toBeTruthy()
  })
})

describe('the collapse control', () => {
  it('puts the drawer away, and brings it back, from the rail alone', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    expect(drawer(container)).not.toBeNull()

    await userEvent.click(railControl('Collapse drawer'))

    // Gone from the layout rather than narrowed: one panel in the outer group, and the rail beside it.
    expect(drawer(container)).toBeNull()
    expect(outerColumns(container)).toEqual(['main'])
    expect(rail()).toBeTruthy()

    await userEvent.click(railControl('Expand drawer'))

    expect(drawer(container)).not.toBeNull()
    expect(outerColumns(container)).toEqual(['secondary', 'main'])
    // The panel it opens onto is the one that was selected, which the collapse never moved.
    expect(useWorkbenchStore.getState().activeActivity).toBe('files')
  })

  it('puts the drawer away when the icon of the panel already on screen is clicked', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    // The explorer is the panel that is up, so its icon is the one that means "put this away".
    await userEvent.click(railControl('Explorer'))

    expect(useWorkbenchStore.getState().drawerCollapsed).toBe(true)
    expect(drawer(container)).toBeNull()
    // The view is still the explorer: the drawer is what went, not the choice.
    expect(useWorkbenchStore.getState().activeActivity).toBe('files')
    expect(railControl('Explorer').getAttribute('aria-pressed')).toBe('true')
  })

  it('brings the drawer back onto the panel of the icon clicked while collapsed', async () => {
    stubWorkbench()
    useWorkbenchStore.setState({ activeActivity: 'files', drawerCollapsed: true })
    const { container } = renderWorkbench()

    expect(drawer(container)).toBeNull()

    await userEvent.click(railControl('Git'))

    expect(useWorkbenchStore.getState().activeActivity).toBe('git')
    expect(useWorkbenchStore.getState().drawerCollapsed).toBe(false)
    expect(within(drawer(container) as HTMLElement).getByText('Git Changes')).toBeTruthy()
  })

  it('toggles from the drawer’s own header, naming the direction it offers', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    const chevron = within(drawerHeader(container)).getByRole('button', { name: 'Collapse drawer' })

    await userEvent.click(chevron)
    expect(drawer(container)).toBeNull()

    // There is no drawer header while the drawer is away, so the way back is the rail's own control —
    // the two state one direction each, and the header's copy comes back offering the same direction as
    // before, because the drawer is on screen again.
    await userEvent.click(railControl('Expand drawer'))

    expect(within(drawerHeader(container)).getByRole('button', { name: 'Collapse drawer' })).toBeTruthy()
    expect(useWorkbenchStore.getState().drawerCollapsed).toBe(false)
  })
})

describe('the control the status dot used to be', () => {
  it('holds that slot as a button, and the dot is gone', async () => {
    stubWorkbench()
    renderWorkbench()

    // Named before it was changed, and pinned here so the repurpose is recorded rather than smuggled:
    // the rail's first element was a decorative `<span>` around a brand dot — no `title`, no
    // `aria-label`, no handler, so a status mark and nothing else. That element is the collapse control
    // now, first in the rail, with a glyph and a tooltip that name the direction on offer.
    const top = rail().firstElementChild as HTMLElement
    expect(top.tagName).toBe('BUTTON')
    expect(top.getAttribute('aria-label')).toBe('Collapse drawer')
    expect(top.getAttribute('title')).toBe('Collapse drawer')

    // The retired markup: the rail held a nameless span, and it holds none at all now.
    expect(rail().querySelectorAll('span')).toHaveLength(0)

    await userEvent.click(top)

    expect(top.getAttribute('aria-label')).toBe('Expand drawer')
    expect(rail().querySelector('[aria-label="Collapse drawer"]')).toBeNull()
  })
})

describe('the flag, and the two groups it sits between', () => {
  it('opens collapsed when the stored preference says so, before anything is drawn', async () => {
    // Read at the moment the store is created, which is what a launch is: the record has to be in
    // storage before the module is evaluated, and a fresh module graph is the only way to reach that.
    localStorage.setItem(STORED_KEY, JSON.stringify({ drawerCollapsed: true }))

    vi.resetModules()
    const freshStore = await import('@/app/components/workbench/store')
    expect(freshStore.useWorkbenchStore.getState().drawerCollapsed, 'the flag read at store creation').toBe(true)

    stubWorkbench()
    const { Workbench: FreshWorkbench } = await import('@/app/components/workbench/workbench')
    const freshClient = await import('@/conveyor/client')

    const { container } = render(
      <QueryClientProvider client={freshClient.queryClient}>
        <FreshWorkbench />
      </QueryClientProvider>
    )

    // The first render is already collapsed: there is no drawer node to have been expanded and then
    // removed, and the rail's control offers the way back rather than the way in.
    expect(container.querySelector('[data-panel]#secondary')).toBeNull()
    expect(
      within(screen.getByRole('navigation', { name: 'Workbench' })).getByRole('button', { name: 'Expand drawer' })
    ).toBeTruthy()
  })

  it('leaves both stored sets byte-identical, and a drag while collapsed keeps the collapse', async () => {
    const windowed: LayoutSizes = { outer: { drawer: 44, main: 56 }, main: { chat: 40, viewer: 60 } }
    const maximized: LayoutSizes = { outer: { drawer: 12, main: 88 }, main: { chat: 65, viewer: 35 } }
    act(() => {
      const store = useWorkbenchStore.getState()
      store.saveLayout('windowed', windowed)
      store.saveLayout('maximized', maximized)
    })
    const before = storedSets()

    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(railControl('Collapse drawer'))
    // The flag is the only key that moved; the sets are the ones the drags left, character for
    // character.
    expect(storedSets()).toBe(before)
    expect(stored()).toEqual({ layoutWindowed: windowed, layoutMaximized: maximized, drawerCollapsed: true })

    await userEvent.click(railControl('Expand drawer'))

    // Byte-identical, not merely equal field by field: the toggle wrote no width at all — not a
    // hundred, not zero, not the drawer's share recalculated for the collapsed group — and the record
    // it leaves behind is the one it found.
    expect(localStorage.getItem(STORED_KEY)).toBe(before)
    expect(storedSets(), 'and wrote nothing on the way out either').toBe(before)
    expect(stored()).toEqual({ layoutWindowed: windowed, layoutMaximized: maximized })

    // The other direction of the same seam: a drag is the only thing allowed to write a set, and it
    // must not take the collapse with it.
    const dragged: LayoutSizes = { outer: { drawer: 30, main: 70 }, main: { chat: 45, viewer: 55 } }
    await userEvent.click(railControl('Collapse drawer'))
    act(() => useWorkbenchStore.getState().saveLayout('windowed', dragged))

    expect(stored()).toEqual({ layoutWindowed: dragged, layoutMaximized: maximized, drawerCollapsed: true })

    await userEvent.click(railControl('Expand drawer'))
    // Expanded is the default and is stored as absence: a record that says nothing about the drawer is
    // one written before it could be put away, and the two must not be told apart by a `false`.
    expect(stored()).toEqual({ layoutWindowed: dragged, layoutMaximized: maximized })
    expect(drawer(container)).not.toBeNull()
  })

  it('composes with the viewer’s expansion, and neither toggle moves the other', async () => {
    stubWorkbench()
    useWorkbenchStore.setState({ selectedFile: TEXT_PATH })
    const { container } = renderWorkbench()

    await waitFor(() => expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Expand the viewer' }))
    await userEvent.click(railControl('Collapse drawer'))

    // Both on: the rail, and the viewer that has taken the chat's column.
    expect(container.querySelector('[data-panel]#secondary')).toBeNull()
    expect(container.querySelector('[data-panel]#chat')).toBeNull()
    expect(container.querySelector('[data-panel]#code')).toBeTruthy()
    expect(rail()).toBeTruthy()

    // Bringing the drawer back leaves the viewer expanded...
    await userEvent.click(railControl('Expand drawer'))
    expect(useWorkbenchStore.getState().viewerExpanded).toBe(true)
    expect(container.querySelector('[data-panel]#chat')).toBeNull()
    expect(drawer(container)).not.toBeNull()

    // ...and restoring the chat column leaves the drawer where it was.
    await userEvent.click(railControl('Collapse drawer'))
    await userEvent.click(screen.getByRole('button', { name: 'Restore the chat column' }))
    expect(useWorkbenchStore.getState().drawerCollapsed).toBe(true)
    expect(container.querySelector('[data-panel]#chat')).not.toBeNull()
    expect(drawer(container)).toBeNull()
  })
})
