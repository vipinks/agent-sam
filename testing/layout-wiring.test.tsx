import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { initialLayoutSizes, percentSize } from '@/app/components/workbench/layout'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The sizes the workbench hands its two resize groups.
 *
 * `layout-rules.test.ts` owns the numbers themselves, including the product of the two groups. What
 * only a rendered workbench can show is that those numbers *arrive*, and in the unit that means what
 * they say: the library reads a bare number as pixels (`defaultSize={20}` is a twenty-pixel drawer) and
 * a string as a share of its group, so a correct helper wired with the wrong unit is a layout that
 * looks broken rather than a test that looks failed.
 *
 * The resize primitive is stood in for here, and that is the whole reason this file exists rather than
 * one more assertion in the workbench's other tests. With the real library the declared defaults are
 * not readable from the DOM: it replaces them, on the first layout effect, with a computed layout, and
 * in jsdom — where every element measures zero — that computation writes `0px` on every panel. So the
 * stand-in records what the workbench passed, which is exactly the claim ("the groups receive the
 * helper's defaults"), and the library's own arithmetic over those numbers is covered by the rules
 * suite. What no test here can see is a rendered width: jsdom does not lay out, so the pixels a real
 * window gets from these proportions are checked live, in the app, and are named as residual.
 *
 * The stand-ins keep the library's own hooks — `data-group` with the group's id, `data-panel` with the
 * panel's — so the panels are found the way the other workbench tests find them.
 */

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-group id={id}>
      {children}
    </div>
  ),
  ResizablePanel: ({ id, defaultSize, children }: { id?: string; defaultSize?: string; children?: ReactNode }) => (
    <div data-panel id={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'

/** The whole workbench, with the reads its panes make answered emptily — the layout is the subject. */
function renderWorkbench() {
  const stub = createBridgeStub({
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
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)

  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
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

beforeEach(() => {
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
  it('opens the drawer and the main area at the helper’s 20 and 80', () => {
    const { container } = renderWorkbench()
    const sizes = initialLayoutSizes()

    expect(columns(container, 'workbench')).toEqual([
      { id: 'secondary', defaultSize: percentSize(sizes.outer.drawer) },
      { id: 'main', defaultSize: percentSize(sizes.outer.main) },
    ])
  })

  it('opens the chat and the viewer at the helper’s 62.5 and 37.5', () => {
    const { container } = renderWorkbench()
    const sizes = initialLayoutSizes()

    expect(columns(container, 'workbench-main')).toEqual([
      { id: 'chat', defaultSize: percentSize(sizes.main.chat) },
      { id: 'code', defaultSize: percentSize(sizes.main.viewer) },
    ])
  })

  it('nests the chat-and-viewer group inside the main column, so the two shares multiply', () => {
    // The structure the numbers depend on: 37.5 of the *main column* is a different width from 37.5 of
    // the window, and the group being inside `#main` is what makes the first true rather than the
    // second. Nothing about the values can be read off the panels alone.
    const { container } = renderWorkbench()

    expect(container.querySelector('[data-panel]#main [data-group]#workbench-main')).toBeTruthy()
    expect(columns(container, 'workbench').map((panel) => panel.id)).toEqual(['secondary', 'main'])
  })

  it('writes each size as a share of its group rather than as a length', () => {
    // The unit, stated once more as its own claim: a bare `20` would be twenty pixels, and `20%` is a
    // fifth of whatever the group turns out to be. The library is what reads it that way.
    const { container } = renderWorkbench()

    for (const panel of [...columns(container, 'workbench'), ...columns(container, 'workbench-main')]) {
      expect(panel.defaultSize).toMatch(/^\d+(\.\d+)?%$/)
    }
  })
})
