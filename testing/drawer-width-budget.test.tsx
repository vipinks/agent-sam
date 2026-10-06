import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { defaultLayoutForState, percentSize } from '@/app/components/workbench/layout'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The width the drawer's share is a share of, and the header that has to live in it.
 *
 * The drawer's saved set is a *share* of the outer group, so what it buys in pixels depends on what
 * else is in the row: at `8d9c03b` the only fixed-width element outside the outer group was the left
 * icon rail, so a 34 percent drawer was 34 percent of the window minus that rail. Phase 39 put the
 * right rail into the same row as a sibling of the group, and its 64 pixels came out of the group's
 * box — the same saved share then bought 0.34 * 64 = 21.76 pixels less (12.8 at the maximized set's
 * fifth). The rail belongs to the main area's budget instead, which is what these assertions pin:
 * the elements outside the group are the left rail and nothing else, the right rail is inside the
 * main column, and the drawer's declared share is unchanged.
 *
 * The pixels are a model, and the limit is jsdom's and is named rather than papered over: nothing
 * lays out here, so a width is read from *declarations* — `w-16` is 4rem, `w-px` is the separator's
 * own pixel, and the resize library gives each panel `flex-basis: 0` with `flex-grow` set to its
 * share. What the model therefore asserts is the budget the share is resolved against, which is
 * exactly the claim; a live window's measured pixels remain the app's to confirm.
 *
 * The header half is the same claim one level down. Its children are a 14-pixel glyph, the title, and
 * the trailing controls; the title is the only one of them whose text can reflow, so an over-tight
 * header used to wrap *it* onto a second line. What is asserted at the drawer's own narrowest — the
 * panel's declared `minSize`, read from the primitive — is that the title can no longer wrap at all
 * (`truncate` is nowrap plus an ellipsis, and the full label travels in `title`), that the field is
 * the child that gives up its width, and that the fixed children of the row cannot be squeezed.
 */

/**
 * The resize primitive, stood in for so the declared shares and floors are readable.
 *
 * The same stand-in the other workbench layout suites use, plus the panel's `minSize`: with the real
 * library every declared size is replaced by a computed layout on the first effect, and in jsdom —
 * where everything measures zero — that computation writes `0px` over all of them. The library's own
 * hooks (`data-group`, `data-panel`) are kept, so the panels are found the way its DOM is.
 */
const standIn = vi.hoisted(() => ({
  groups: new Map<string, { defaultLayout?: Record<string, number> }>(),
  panels: new Map<string, { defaultSize?: string; minSize?: number }>(),
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
  ResizablePanel: ({
    id,
    defaultSize,
    minSize,
    children,
  }: {
    id?: string
    defaultSize?: string
    minSize?: number
    children?: ReactNode
  }) => {
    if (id) standIn.panels.set(id, { defaultSize, minSize })
    return (
      <div data-panel id={id} data-default-size={defaultSize} data-min-size={minSize}>
        {children}
      </div>
    )
  },
  ResizableHandle: () => <div data-separator />,
}))

/** The width the app opens a windowed window at, from `lib/main/app.ts` (`width: 1240`). */
const WINDOWED_WINDOW_PX = 1240

/**
 * The maximized width, simulated.
 *
 * A maximized window is the screen's work area, which no test can know; the number is named as this
 * suite's stand-in for it, and only the *share* of the rail that reaches the drawer is under test —
 * that is what the delta below is independent of.
 */
const MAXIMIZED_WINDOW_PX = 1920

/** A rail's declared width: `w-16`, asserted on the element itself below. */
const RAIL_PX = 64

/** The separator's own width: `w-px`, taken out of the group before the shares are divided. */
const HANDLE_PX = 1

/** The drawer's share of the group, per state, as `layout.ts` states it. */
const WINDOWED = defaultLayoutForState('windowed')
const MAXIMIZED = defaultLayoutForState('maximized')

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/**
 * The whole workbench, over a folder with one text file in it.
 *
 * The window state is the one argument: main's answer about the window it created is the launch fact
 * this file varies, and every other read a pane makes is answered emptily — the git panel and the
 * provider lists are not the subject, and an unstubbed query is noise in the middle of a width claim.
 */
function renderWorkbench({ maximized = false }: { maximized?: boolean } = {}) {
  const stub = createBridgeStub({
    isMaximized: () => maximized,
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
    openRoot: () => ROOT,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeId: null })
  setActiveStub(stub)

  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/** The workbench's own row: the root `div` of the shell. */
function workbenchRow(container: HTMLElement): HTMLElement {
  const row = container.firstElementChild as HTMLElement | null
  if (!row) throw new Error('the workbench rendered nothing')
  return row
}

/**
 * The fixed-width elements that sit outside the outer resize group, in the row's order.
 *
 * This is the whole subject of the file: a share is a share *of* what the group's box turns out to
 * be, so an element in this list next to the group is a slice taken from every panel in it. At
 * `8d9c03b` the list was the left icon rail alone.
 *
 * Elements the row declares as overlays are left out, and only those: an absolutely positioned box takes
 * no share of the row whatever else it does, so counting one here would be measuring the wrong thing. The
 * update-ready notice is the first such element, and it states the marker itself rather than being named
 * here — a fixed-width column added beside the group is still caught by this walk.
 */
function columnOutsideTheGroup(container: HTMLElement): HTMLElement[] {
  return [...workbenchRow(container).children].filter(
    (child) => !child.hasAttribute('data-group') && !child.hasAttribute('data-overlay')
  ) as HTMLElement[]
}

/** The outer group's own panel children, as ids and declared shares. */
function outerColumns(container: HTMLElement): { id: string; defaultSize: string | null }[] {
  const group = container.querySelector<HTMLElement>('[data-group]#workbench')
  if (!group) throw new Error('the workbench rendered no outer group')
  return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map((panel) => ({
    id: panel.id,
    defaultSize: panel.getAttribute('data-default-size'),
  }))
}

/**
 * The drawer's content box in pixels: the window, less the fixed columns outside the group, less the
 * group's own separator, times the share the drawer declares.
 *
 * The arithmetic is spelled out here rather than read off a rendered rect because jsdom lays nothing
 * out — and it is the arithmetic the *library* performs, which is why the declared share is the only
 * of the three numbers the panel owns.
 */
function drawerContentBoxPx(windowPx: number, sharedColumns: HTMLElement[], share: number): number {
  const railsPx = sharedColumns.length * RAIL_PX
  return (windowPx - railsPx - HANDLE_PX) * (share / 100)
}

/** The drawer's panel, or null while it is out of the outer group. */
function drawer(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#secondary')
}

/** The drawer's own header, wherever the panel it is showing puts its controls. */
function drawerHeader(container: HTMLElement): HTMLElement {
  const header = drawer(container)?.querySelector('header')
  if (!header) throw new Error('the drawer rendered no header')
  return header as HTMLElement
}

/** One of the right rail's residents, by its label. */
function resident(label: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Right rail' })).getByRole('button', { name: label })
}

beforeEach(() => {
  standIn.groups.clear()
  standIn.panels.clear()
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

describe('the drawer’s share, and the box it is a share of', () => {
  it('measures a windowed launch against the window and the left rail alone, as it did at 8d9c03b', () => {
    const { container } = renderWorkbench()

    // One fixed-width column beside the group, and it is the left rail: 64 pixels, non-shrinking. The
    // right rail is not on this list — that is the regression this file exists for.
    const shared = columnOutsideTheGroup(container)
    expect(shared.map((node) => node.getAttribute('aria-label'))).toEqual(['Workbench'])
    for (const node of shared) {
      expect(node.className).toContain('w-16')
      expect(node.className).toContain('shrink-0')
    }

    // The right rail's cost is the main column's now, so the drawer's share is untouched by it.
    expect(container.querySelector('[data-panel]#main [aria-label="Right rail"]')).toBeTruthy()
    expect(container.querySelector('[data-group]#workbench > [aria-label="Right rail"]')).toBeNull()

    // The saved set's semantics as they stood then: the drawer's own share of the group, unchanged —
    // and the group's box the window less that one rail, so a 34 percent drawer is 399.5 pixels rather
    // than the 377.74 those same 34 percent bought while the rail was taking its 64 pixels out of the
    // group's box.
    const columns = outerColumns(container)
    expect(columns.map((panel) => panel.id)).toEqual(['secondary', 'main'])
    expect(columns[0]?.defaultSize).toBe(percentSize(WINDOWED.outer.drawer))
    expect(drawerContentBoxPx(WINDOWED_WINDOW_PX, shared, WINDOWED.outer.drawer)).toBeCloseTo(399.5, 2)
    expect(drawerContentBoxPx(WINDOWED_WINDOW_PX, shared, WINDOWED.outer.drawer) - RAIL_PX * 0.34).toBeCloseTo(
      377.74,
      2
    )
  })

  it('measures a maximized launch the same way, at the maximized set’s fifth', async () => {
    const { container } = renderWorkbench({ maximized: true })

    // Main's answer about the window arrives as a query, so the maximized set lands after the launch
    // render rather than with it — the wait the other layout suites make for the same reason.
    await waitFor(() => expect(outerColumns(container)[0]?.defaultSize).toBe(percentSize(MAXIMIZED.outer.drawer)))

    const shared = columnOutsideTheGroup(container)
    expect(shared.map((node) => node.getAttribute('aria-label'))).toEqual(['Workbench'])
    expect(container.querySelector('[data-panel]#main [aria-label="Right rail"]')).toBeTruthy()

    const columns = outerColumns(container)
    expect(columns.map((panel) => panel.id)).toEqual(['secondary', 'main'])
    // 0.20 of the window less the rail, less the separator: 371 pixels, where the rail's cut of the
    // same share left 358.2.
    expect(drawerContentBoxPx(MAXIMIZED_WINDOW_PX, shared, MAXIMIZED.outer.drawer)).toBeCloseTo(371, 2)
    expect(drawerContentBoxPx(MAXIMIZED_WINDOW_PX, shared, MAXIMIZED.outer.drawer) - RAIL_PX * 0.2).toBeCloseTo(
      358.2,
      2
    )
  })
})

describe('the drawer’s header, at the narrowest share the saved sets can produce', () => {
  it('keeps the title on one line and gives the field up first', () => {
    const { container } = renderWorkbench()

    // The narrowest is the panel's own floor, read from the primitive rather than assumed: a drag
    // cannot leave the drawer below it, so no saved set can.
    const floorPx = standIn.panels.get('secondary')?.minSize
    expect(floorPx).toBe(180)

    const header = drawerHeader(container)
    const title = within(header).getByText('Chat Sessions')

    // One line, by construction: `truncate` is nowrap with an ellipsis, which is what replaced the
    // wrap. The full label is still reachable, through the attribute rather than through a second line.
    expect(title.className).toContain('truncate')
    expect(title.getAttribute('title')).toBe('Chat Sessions')

    // The child that gives up width: the field, down to its 3rem floor, while nothing else moves.
    const field = screen.getByLabelText('Search conversations')
    expect(field.className).toContain('w-28')
    expect(field.className).toContain('min-w-12')
    for (const label of ['New chat', 'Collapse drawer']) {
      expect(within(header).getByRole('button', { name: label }).className).toContain('shrink-0')
    }

    // And the floors fit inside the floor, which is what makes "no child wraps at any width" true
    // rather than likely: px-3 (24) + the glyph (14) + the row's two 8-pixel gaps (16) + the trailing
    // row's two 4-pixel gaps (8) + two 24-pixel buttons (48) + the field's 3rem floor (48) is 158 of
    // the drawer's 180, which leaves the title 22 pixels to truncate into.
    const headerFixedPx = 24 + 14 + 16 + 8 + 48 + 48
    expect(headerFixedPx).toBe(158)
    expect(headerFixedPx).toBeLessThanOrEqual(floorPx as number)
  })
})

describe('a rail that is docked or put away', () => {
  it('moves neither the drawer’s share nor the header it renders', async () => {
    const { container } = renderWorkbench()

    const before = {
      columns: outerColumns(container),
      header: drawerHeader(container).outerHTML,
      outside: columnOutsideTheGroup(container).map((node) => node.getAttribute('aria-label')),
    }

    await userEvent.click(resident('Code'))
    act(() => useWorkbenchStore.getState().closeRightPanel())

    // The left percentage is the state's own fact and no dock may write it: the outer group declares
    // the same pair, and the drawer's own share never becomes a narrower one to pay for the rail.
    expect(outerColumns(container)).toEqual(before.columns)
    // And the header is not re-laid-out by a change in the column beside it — same element, same
    // markup, so a wrap cannot reappear with a dock.
    expect(drawerHeader(container).outerHTML).toBe(before.header)
    expect(columnOutsideTheGroup(container).map((node) => node.getAttribute('aria-label'))).toEqual(before.outside)
  })
})
