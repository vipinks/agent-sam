import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * A double-click on an explorer row: the file's own viewer, opened beside the conversation.
 *
 * The rule — given the row's kind and what is docked, whether a double-click docks the code viewer —
 * is proved without a DOM in `tests/ui/dock-rules-test.ts`. What only a rendered workbench can show is
 * whether the row reaches it, and what the dock does afterwards: that the panel really mounts, that
 * the row's own two clicks still select the file, and that the flag this phase must not touch is left
 * exactly where it was.
 *
 * Every assertion is on the state the app is in after the gesture — `rightPanel`, `selectedFile`,
 * `viewerExpanded` and the panel node in the inner group — never on a click handler having been
 * called, because the failure this guards against is a handler that runs and changes nothing.
 *
 * Rendered whole rather than as the explorer alone for the reason `right-rail-docking.test.tsx` renders
 * it whole: the dock is a claim about the inner group's columns, and the explorer panes are not where
 * that claim lives. The resize primitive is stood in for exactly as that suite stands in for it, with
 * the same library hooks, so the panels are found the same way.
 *
 * Residual, named rather than claimed: jsdom fires no real double-click, so what is pinned here is the
 * sequence the browser delivers — two clicks and then a `dblclick` — and a real window is where the
 * gesture itself is verified.
 */

const standIn = vi.hoisted(() => ({ groups: new Map<string, { defaultLayout?: Record<string, number> }>() }))

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
  ResizablePanel: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-panel id={id}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const SRC = 'C:/w/src'
const NOTES = 'C:/w/notes.txt'
const TODO = 'C:/w/todo.md'

/** The record the layout sets are stored in, so "no dock key was written" is checkable. */
const STORED_KEY = 'sam-ai-layout-preferences'

const NOTES_SOURCE = ['just words', 'on two lines', ''].join('\n')
const TODO_SOURCE = ['# Todo', '', '- one', ''].join('\n')

/**
 * The whole workbench, over a folder holding one folder and two files.
 *
 * Two files rather than one, because the two halves of the dock's behaviour under a double-click need
 * a file that is not already the one on screen: what is asserted for the second is that the panel
 * stays where it is and the file behind it changes.
 */
function stubWorkbench() {
  const stub = createBridgeStub({
    isMaximized: () => false,
    listDirectory: (input) => {
      const path = (input as { path: string }).path
      if (path !== ROOT) return []
      return [
        { name: 'src', path: SRC, isDirectory: true },
        { name: 'notes.txt', path: NOTES, isDirectory: false },
        { name: 'todo.md', path: TODO, isDirectory: false },
      ]
    },
    readFile: (input) => {
      const path = (input as { path: string }).path
      return { path, content: path === TODO ? TODO_SOURCE : NOTES_SOURCE, baselineMtime: 0 }
    },
    // Every other read a pane makes is answered emptily: the git panel, the provider lists and the
    // mention index are not this file's subject, and an unstubbed query would be noise in the middle
    // of a docking claim.
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
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
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

/** The docked panel's node, or null while the right rail is alone. */
function docked(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#code')
}

/** One row of the tree, by the name it shows. Found rather than got: the listing arrives async. */
function row(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name })
}

/** The path the viewer's own header states for the open file — the viewer's answer to "which file". */
function shownPath(container: HTMLElement, path: string): string | null {
  const panel = docked(container)
  if (!panel) return null
  return within(panel).getByText(path).textContent
}

beforeEach(() => {
  standIn.groups.clear()
  localStorage.clear()
  useWorkbenchStore.setState({
    // The explorer's own drawer view: the tree has to be on screen for its rows to be clicked.
    activeActivity: 'files',
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

describe('a double-click on a file row', () => {
  it('docks the code viewer and shows that file, from rail-only', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeTruthy())

    // The launch state this starts from: nothing docked.
    expect(docked(container)).toBeNull()

    await userEvent.dblClick(await row('notes.txt'))

    expect(useWorkbenchStore.getState().rightPanel).toBe('code')
    expect(useWorkbenchStore.getState().selectedFile).toBe(NOTES)
    expect(resident('Code').getAttribute('aria-pressed')).toBe('true')
    // The panel's own node, so "it opened" is a claim about content rather than about a slot id.
    await waitFor(() => expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull())
    expect(shownPath(container, NOTES)).toBe(NOTES)
  })

  it('keeps the dock and loads the other file, when Code is already the docked resident', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.dblClick(await row('notes.txt'))
    await waitFor(() => expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull())
    const slot = docked(container)

    // A different file: the panel is not docked a second time, and the click is what changes what it
    // is showing. That is the whole reason a double-click here must not toggle the resident away.
    await userEvent.dblClick(await row('todo.md'))

    expect(useWorkbenchStore.getState().rightPanel).toBe('code')
    expect(useWorkbenchStore.getState().selectedFile).toBe(TODO)
    expect(docked(container)).toBe(slot)
    expect(resident('Code').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(shownPath(container, TODO)).toBe(TODO))
  })

  it('switches the dock to Code when another resident was docked', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(resident('Preview'))
    expect(useWorkbenchStore.getState().rightPanel).toBe('preview')

    await userEvent.dblClick(await row('notes.txt'))

    expect(useWorkbenchStore.getState().rightPanel).toBe('code')
    expect(useWorkbenchStore.getState().selectedFile).toBe(NOTES)
    await waitFor(() => expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull())
    // Switched rather than added: the slot holds the viewer's own node, and the resident that was
    // docked there is no longer pressed.
    expect(container.querySelector('[data-slot="code-gutter"]')).not.toBeNull()
    expect(resident('Preview').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a single click on a file row', () => {
  it('changes the selection and nothing about the dock', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(await row('notes.txt'))

    expect(useWorkbenchStore.getState().selectedFile).toBe(NOTES)
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
    expect(docked(container)).toBeNull()
    expect(resident('Code').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a double-click on a folder row', () => {
  it('expands or collapses it as it always did, and docks nothing', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    const folder = await row('src')

    await userEvent.dblClick(folder)

    // Nothing is docked, and the folder's own clicks still reached main for its listing — which is
    // what "the row keeps its expand/collapse behaviour" means at this level.
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
    expect(docked(container)).toBeNull()
    expect(stub.callsTo('workspace').some((call) => (call.args[0] as { path: string }).path === SRC)).toBe(true)

    // And a single click still opens it, which is the behaviour this phase leaves alone.
    await userEvent.click(folder)
    await waitFor(() => expect(folder.getAttribute('aria-expanded')).toBe('true'))
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
  })
})

describe("the viewer's expansion, across a double-click", () => {
  it('leaves a collapsed viewer collapsed', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.dblClick(await row('notes.txt'))

    expect(useWorkbenchStore.getState().viewerExpanded).toBe(false)
    expect(container.querySelector('[data-panel]#chat')).not.toBeNull()
  })

  it('leaves an expanded viewer expanded', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.dblClick(await row('notes.txt'))
    act(() => useWorkbenchStore.getState().setViewerExpanded(true))
    expect(container.querySelector('[data-panel]#chat')).toBeNull()

    await userEvent.dblClick(await row('todo.md'))

    // The double-click docks and loads; how much room the docked column takes is not its business.
    expect(useWorkbenchStore.getState().viewerExpanded).toBe(true)
    expect(container.querySelector('[data-panel]#chat')).toBeNull()
    expect(useWorkbenchStore.getState().rightPanel).toBe('code')
    expect(useWorkbenchStore.getState().selectedFile).toBe(TODO)
  })
})

describe("the dock's open state, in memory only", () => {
  it('opens rail-only again at a relaunch, having written nothing on the way', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.dblClick(await row('notes.txt'))
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
  })
})
