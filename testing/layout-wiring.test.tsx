import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { defaultLayoutForState, percentSize, type LayoutSizes } from '@/app/components/workbench/layout'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The sets the workbench hands its two resize groups, and the window state it hands them for.
 *
 * `layout-rules.test.ts` owns the numbers themselves, including the product of the two groups. What
 * only a rendered workbench can show is that those numbers *arrive* — and that the set which arrives
 * is the one belonging to the window the workbench is in. A window state is not a property of the
 * layout module: it is main's answer about the window it created, kept live by main's own push event,
 * so both halves of that are wiring and neither can be read off the source.
 *
 * The resize primitive is stood in for here, and that is the whole reason this file exists rather than
 * one more assertion in the workbench's other tests. With the real library the declared defaults are
 * not readable from the DOM: it replaces them, on the first layout effect, with a computed layout, and
 * in jsdom — where every element measures zero — that computation writes `0px` on every panel. So the
 * stand-in records what the workbench passed, which is exactly the claim ("each group receives its
 * state's set"), and the library's own arithmetic over those numbers is covered by the rules suite.
 * What no test here can see is a rendered width: jsdom does not lay out, so the pixels a real window
 * gets from these proportions are checked live, in the app, and are named as residual.
 *
 * The stand-ins keep the library's own hooks — `data-group` with the group's id, `data-panel` with the
 * panel's — so the panels are found the way the other workbench tests find them.
 */

/**
 * What each group was handed, by the id the workbench gives it.
 *
 * Hoisted rather than declared in the file body, because the module factory below is hoisted above
 * every import: a map it closed over from the body would be in its temporal dead zone when the
 * workbench imports the primitive. The group's own props are read back from here rather than out of
 * the DOM because one of them is a map of panel id to share, which is a record a test can compare
 * against the helper and an attribute it would have to be encoded into.
 */
const standIn = vi.hoisted(() => ({
  groups: new Map<
    string,
    {
      defaultLayout?: Record<string, number>
      onLayoutChanged?: (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void
    }
  >(),
}))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    id,
    defaultLayout,
    onLayoutChanged,
    children,
  }: {
    id?: string
    defaultLayout?: Record<string, number>
    onLayoutChanged?: (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void
    children?: ReactNode
  }) => {
    // Recorded on every render, so what is read back is what the group was last given — including
    // after a remount, which is the mechanism a window-state change applies its set through.
    if (id) standIn.groups.set(id, { defaultLayout, onLayoutChanged })
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

/** The whole workbench, with the reads its panes make answered emptily — the layout is the subject. */
function renderWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const stub = createBridgeStub({
    // The window's own state, as main answers it at launch. Windowed unless a test says otherwise,
    // which is what the app opens.
    isMaximized: () => false,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
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

  return {
    stub,
    ...render(
      <QueryClientProvider client={queryClient}>
        <Workbench />
      </QueryClientProvider>
    ),
  }
}

/** The set one group was declared, as the resize library would receive it. */
function declared(groupId: string): Record<string, number> | undefined {
  return standIn.groups.get(groupId)?.defaultLayout
}

/**
 * The panels of one group, in the order the group was built with, as id and declared size.
 *
 * Scoped to the group's own direct children for the same reason the viewer's expand test is: how many
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

/** The windowed set and the maximized set, as the rules suite computes them, for the expectations below. */
const WINDOWED: LayoutSizes = defaultLayoutForState('windowed')
const MAXIMIZED: LayoutSizes = defaultLayoutForState('maximized')

beforeEach(() => {
  standIn.groups.clear()
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
  })
  queryClient.clear()
})

describe('the workbench columns', () => {
  it('opens a windowed window at the helper’s 34/66 and 50/50', () => {
    renderWorkbench()

    expect(declared('workbench')).toEqual({ secondary: WINDOWED.outer.drawer, main: WINDOWED.outer.main })
    expect(declared('workbench-main')).toEqual({ chat: WINDOWED.main.chat, code: WINDOWED.main.viewer })
  })

  it('nests the chat-and-viewer group inside the main column, so the two shares multiply', () => {
    // The structure the numbers depend on: 37 of the *main column* is a different width from 37 of the
    // window, and the group being inside `#main` is what makes the first true rather than the second.
    // Nothing about the values can be read off the panels alone.
    const { container } = renderWorkbench()

    expect(container.querySelector('[data-panel]#main [data-group]#workbench-main')).toBeTruthy()
    expect(columns(container, 'workbench').map((panel) => panel.id)).toEqual(['secondary', 'main'])
  })

  it('writes each pane size as a share of its group rather than as a length', () => {
    // The unit, stated once more as its own claim: a bare `20` would be twenty pixels, and `20%` is a
    // fifth of whatever the group turns out to be. The library is what reads it that way.
    const { container } = renderWorkbench()

    for (const panel of [...columns(container, 'workbench'), ...columns(container, 'workbench-main')]) {
      expect(panel.defaultSize).toMatch(/^\d+(\.\d+)?%$/)
    }
  })

  it('still hands each panel its own size, which is what a one-panel group falls back to', () => {
    const { container } = renderWorkbench()

    expect(columns(container, 'workbench-main')).toEqual([
      { id: 'chat', defaultSize: percentSize(WINDOWED.main.chat) },
      { id: 'code', defaultSize: percentSize(WINDOWED.main.viewer) },
    ])
  })
})

describe('the window state the layout is for', () => {
  it('lays a windowed window out at the windowed set', () => {
    renderWorkbench()

    expect(declared('workbench')).toEqual({ secondary: WINDOWED.outer.drawer, main: WINDOWED.outer.main })
    expect(declared('workbench-main')).toEqual({ chat: WINDOWED.main.chat, code: WINDOWED.main.viewer })
  })

  it('lays a maximized window out at the maximized set, because the launch state is main’s answer', async () => {
    // The launch state is main's, not the renderer's assumption: main created the window, so only main
    // can say whether the one the app is looking at is maximized. A renderer that assumed "windowed"
    // would open a maximized window on the one set of proportions that is certainly wrong for it.
    renderWorkbench({ isMaximized: () => true })

    await waitFor(() => {
      expect(declared('workbench')).toEqual({ secondary: MAXIMIZED.outer.drawer, main: MAXIMIZED.outer.main })
    })
    expect(declared('workbench-main')).toEqual({ chat: MAXIMIZED.main.chat, code: MAXIMIZED.main.viewer })
  })

  it('swaps to the maximized set when the window is maximized, and back when it is restored', async () => {
    const { stub } = renderWorkbench()
    expect(declared('workbench-main')).toEqual({ chat: 50, code: 50 })

    act(() => stub.emit('conveyor:event:window:onMaximizeChange', true))
    await waitFor(() => {
      expect(declared('workbench-main')).toEqual({ chat: MAXIMIZED.main.chat, code: MAXIMIZED.main.viewer })
    })
    expect(declared('workbench')).toEqual({ secondary: 20, main: 80 })

    act(() => stub.emit('conveyor:event:window:onMaximizeChange', false))
    await waitFor(() => {
      expect(declared('workbench-main')).toEqual({ chat: 50, code: 50 })
    })
    expect(declared('workbench')).toEqual({ secondary: 34, main: 66 })
  })
})
