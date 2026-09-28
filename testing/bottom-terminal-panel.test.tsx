import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { WindowFrame } from '@/app/shell'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { percentSize } from '@/app/components/workbench/layout'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The bottom terminal panel: the glyph that opens it, the column it lives in, and what survives a
 * remount.
 *
 * The window frame is rendered rather than the workbench alone, because the toggle is the title bar's
 * — a claim about where the glyph is and what it is next to cannot be read off a workbench that does
 * not draw one. Everything else is the app's real code: the conveyor client, the bridge transport, the
 * store, the layout rules and the pane's own effects.
 *
 * Two stand-ins, both of them the same ones the neighbouring suites use and for the same reasons. The
 * resize primitive records what the workbench declared — with the real library, jsdom's zero-width
 * boxes are computed into the layout and every panel is written `0px` — and xterm is replaced by a
 * terminal whose writes are collected, because jsdom hosts no terminal. What that leaves unverified is
 * named rather than implied: **jsdom lays nothing out**, so the panel's pixels, the divider's height,
 * the drag itself and the shell's latency are Boss's live eyes. What is asserted here is the structure
 * the workbench declares, which call the pane makes, and which flag the glyph is reading.
 */

const xterm = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
    }

    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    dispose(): void {}

    write(data: string): void {
      xterm.writes.push(data)
    }

    reset(): void {
      // A marker, so a replay can be told from an append.
      xterm.writes.push('\u001b[RESET]')
    }

    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }

    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    clearSelection(): void {}

    get cols(): number {
      return 100
    }

    get rows(): number {
      return 30
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

type GroupLayout = Record<string, number>
type LayoutListener = (layout: GroupLayout, meta: { isUserInteraction: boolean }) => void

const standIn = vi.hoisted(() => ({
  groups: new Map<
    string,
    { orientation?: string; defaultLayout?: Record<string, number>; onLayoutChanged?: LayoutListener }
  >(),
}))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    id,
    orientation,
    defaultLayout,
    onLayoutChanged,
    children,
  }: {
    id?: string
    orientation?: string
    defaultLayout?: GroupLayout
    onLayoutChanged?: LayoutListener
    children?: ReactNode
  }) => {
    if (id) standIn.groups.set(id, { orientation, defaultLayout, onLayoutChanged })
    return (
      <div data-group id={id} data-orientation={orientation}>
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

/** The record the layout preferences are stored in. */
const STORED_KEY = 'sam-ai-layout-preferences'

let rootSeq = 0

/** A folder no other test has opened, because the host is a singleton keyed by root. */
function freshRoot(): string {
  rootSeq += 1
  return `C:/w/bottom${rootSeq}`
}

function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
    isMaximized: () => false,
    // Every writer is a no-op and every read this suite is not about answers emptily: a handler that
    // threw would end a test for a reason the test is not about.
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    list: () => [],
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
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeId: null })
  setActiveStub(stub)
  return stub
}

/**
 * The whole window, over a folder, with the folder seeded before the render.
 *
 * The order matters for the reason `terminal-pty-wiring.test.tsx` states: the store mirror answers its
 * one initial read asynchronously, so a seed arriving after the pane mounted would be overwritten by an
 * empty answer landing on a pane that had already opened the folder's shell.
 */
function renderApp(stub: BridgeStub, rootPath: string) {
  stubStore(stub, 'workspace', { rootPath, recentRoots: [rootPath] })
  return render(
    <QueryClientProvider client={queryClient}>
      <WindowFrame>
        <Workbench />
      </WindowFrame>
    </QueryClientProvider>
  )
}

/** The title bar's toggle, by the label it is announced with. */
function glyph(): HTMLElement {
  return screen.getByRole('button', { name: 'Terminal panel' })
}

function terminalPane(container: HTMLElement): Element | null {
  return container.querySelector('[data-slot="terminal"]')
}

function ptyCalls(stub: BridgeStub): Array<{ method: string; input: unknown }> {
  return stub.callsTo('terminalPty').map((call) => ({ method: call.method, input: (call.args[0] ?? {}) as unknown }))
}

function ptyMethods(stub: BridgeStub): string[] {
  return ptyCalls(stub).map((call) => call.method)
}

/** The record as it was left in storage. */
function record(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}') as Record<string, unknown>
}

/**
 * Drag the bottom panel's separator, as the library reports a completed drag.
 *
 * Called with `isUserInteraction: true`, which is the difference between a pointer resize and the
 * library's own mount — the field the workbench's rule reads before it is willing to remember anything.
 */
function dragBottomPanel(layout: GroupLayout): void {
  const group = standIn.groups.get('workbench-chat')
  if (!group?.onLayoutChanged) throw new Error('the chat column’s group was given no layout listener')
  act(() => group.onLayoutChanged?.(layout, { isUserInteraction: true }))
}

/** Open the panel the way a reader does, and wait until the pane is in the tree. */
async function openFromGlyph(container: HTMLElement): Promise<void> {
  await userEvent.click(glyph())
  await waitFor(() => expect(terminalPane(container), 'the pane is in the bottom panel').not.toBeNull())
}

beforeEach(() => {
  standIn.groups.clear()
  xterm.writes.length = 0
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    bottomPanelOpen: false,
  })
  queryClient.clear()
})

describe('the title bar’s toggle', () => {
  it('draws its glyph after the theme controls, behind a vertical divider', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    renderApp(stub, root)

    const control = glyph()
    expect(control.getAttribute('aria-pressed')).toBe('false')

    // The glyph's own row, which the divider shares with it: the divider is the first thing in it, and
    // what precedes the row is the theme controls. Asserted as DOM order rather than as a class name,
    // because "after the theme icons and behind a divider" is an order, and jsdom draws none of it.
    const row = control.parentElement as HTMLElement
    const divider = row.firstElementChild as HTMLElement
    expect(divider.getAttribute('data-slot'), 'the divider is the row’s first child').toBe('separator')
    expect(divider.getAttribute('data-orientation')).toBe('vertical')

    const themeRow = row.parentElement as HTMLElement
    expect(themeRow.contains(screen.getByRole('button', { name: 'Brightness' }))).toBe(true)
    expect(themeRow.contains(screen.getByRole('button', { name: 'Toggle theme' }))).toBe(true)
    // The theme controls lead the row and the window controls are what follows the glyph, so "after the
    // theme icons" is the window controls' own block being this row's next sibling.
    expect(row.nextElementSibling, 'the window controls follow the glyph').toBe(themeRow.lastElementChild)
    expect(
      screen.getByRole('button', { name: 'Brightness' }).compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      control.compareDocumentPosition(screen.getByRole('button', { name: 'Close' })) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('reports the persisted flag and nothing else, and opens and closes the panel with it', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    const { container } = renderApp(stub, root)

    // Set without a click: the glyph is reading the store's flag, not a piece of state of its own that a
    // click happens to set. This is the title bar's half of "the state derives from the persisted flag".
    act(() => useWorkbenchStore.setState({ bottomPanelOpen: true }))
    expect(glyph().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(terminalPane(container)).not.toBeNull())

    act(() => useWorkbenchStore.setState({ bottomPanelOpen: false }))
    expect(glyph().getAttribute('aria-pressed')).toBe('false')
    expect(terminalPane(container)).toBeNull()
  })

  it('opens the folder’s shell from a click and seeds the terminal from read', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    const { container } = renderApp(stub, root)

    await openFromGlyph(container)

    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(true)
    expect(glyph().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(ptyMethods(stub)).toContain('create'))
    expect(ptyCalls(stub).find((call) => call.method === 'create')?.input).toEqual({ rootPath: root })
    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))
    expect(ptyCalls(stub).find((call) => call.method === 'read')?.input).toEqual({ rootPath: root })
    await waitFor(() => expect(xterm.writes.join('')).toContain('notes.txt'))
  })

  it('closes the panel on a second click without ending the session, and stores the closed state as an absence', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls'] }))
    const { container } = renderApp(stub, root)

    await openFromGlyph(container)
    expect(record().bottomPanelOpen).toBe(true)

    await userEvent.click(glyph())

    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(false)
    expect(glyph().getAttribute('aria-pressed')).toBe('false')
    expect(terminalPane(container)).toBeNull()
    // The session is main's and outlives the panel: closing a panel is a view going away, not a shell
    // being killed. The host keeps it and the next open re-attaches to the same one.
    expect(ptyMethods(stub)).not.toContain('kill')
    // Absent rather than `false`: that is what "closed" is stored as, and what a record written by a
    // version that did not know the key looks like.
    expect('bottomPanelOpen' in record()).toBe(false)
  })

  it('toggles the same panel with Ctrl+`', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    const { container } = renderApp(stub, root)

    await userEvent.keyboard('{Control>}`{/Control}')
    await waitFor(() => expect(terminalPane(container)).not.toBeNull())
    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(true)

    await userEvent.keyboard('{Control>}`{/Control}')
    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(false)
    expect(terminalPane(container)).toBeNull()
  })

  it('is absent while the settings screen has the workbench over, and returns with the panel open', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    const { container } = renderApp(stub, root)

    await openFromGlyph(container)

    act(() => useWorkbenchStore.setState({ activeActivity: 'settings' }))
    expect(screen.queryByRole('button', { name: 'Terminal panel' })).toBeNull()
    expect(terminalPane(container)).toBeNull()

    act(() => useWorkbenchStore.setState({ activeActivity: 'chat' }))
    expect(glyph().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(terminalPane(container)).not.toBeNull())
  })
})

describe('the panel’s own place in the layout', () => {
  it('nests a vertical split inside the chat column, leaving the row to the rail', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    const { container } = renderApp(stub, root)

    await openFromGlyph(container)

    const chatColumn = container.querySelector('[data-panel]#chat')
    expect(chatColumn?.querySelector('[data-group]#workbench-chat')).not.toBeNull()
    expect(standIn.groups.get('workbench-chat')?.orientation).toBe('vertical')

    // Under the chat column, and not in the row: the column is still one of the row's two panels, and
    // the panel is not one of them.
    expect(container.querySelector('[data-group]#workbench-main > [data-panel]#chat')).not.toBeNull()
    expect(container.querySelector('[data-group]#workbench-main > [data-panel]#terminal')).toBeNull()
    expect(container.querySelector('[data-group]#workbench-chat > [data-panel]#terminal')).not.toBeNull()
    expect(container.querySelector('[data-group]#workbench-chat > [data-panel]#conversation')).not.toBeNull()

    // Docking a resident still takes the row's right slot, with the panel where it was.
    act(() => useWorkbenchStore.setState({ rightPanel: 'code' }))
    expect(container.querySelector('[data-group]#workbench-main > [data-panel]#code')).not.toBeNull()
    expect(container.querySelector('[data-group]#workbench-chat > [data-panel]#terminal')).not.toBeNull()
  })

  it('offers the rail its four residents and no Terminal anywhere', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    const { container } = renderApp(stub, root)

    const rail = screen.getByRole('navigation', { name: 'Right rail' })
    expect([...rail.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Code',
      'Preview',
      'Overview',
      'Tools',
    ])
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()

    // Still nowhere while the pane is mounted: the panel's own header offers a way out of the panel,
    // and it is not the rail's resident by another name.
    await openFromGlyph(container)
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()
    expect(within(rail).queryByRole('button', { name: 'Terminal' })).toBeNull()
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
  })

  it('re-seeds from read and stays open across a keyed remount, at the new state’s own height', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    const { container } = renderApp(stub, root)

    await openFromGlyph(container)
    const before = ptyMethods(stub).filter((method) => method === 'read').length

    // The maximize: the workbench keys each group on the window state, so the whole column — panel
    // included — is remounted. What must survive is main's session, and what must come back is the
    // transcript: the host replays it into the fresh view from `read`.
    act(() => stub.emit('conveyor:event:window:onMaximizeChange', true))

    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(true)
    await waitFor(() => expect(terminalPane(container)).not.toBeNull())
    await waitFor(() => expect(ptyMethods(stub).filter((method) => method === 'read').length).toBeGreaterThan(before))
    expect(xterm.writes.join('')).toContain('notes.txt')
    // The group was rebuilt for the new state, so its declared pair is the new state's — the default
    // height here, because nothing has been dragged in either state.
    expect(
      [
        ...(container.querySelector('[data-group]#workbench-chat') as HTMLElement).querySelectorAll(
          ':scope > [data-panel]'
        ),
      ].map((panel) => panel.getAttribute('data-default-size'))
    ).toEqual([percentSize(65), percentSize(35)])
  })

  it('re-attaches to the new root’s session when the folder changes', async () => {
    const stub = stubWorkbench()
    const first = freshRoot()
    const second = freshRoot()
    stub.on('create', () => ({ rootPath: first, pid: 4242, cwd: first, lines: [] }))
    stub.on('read', () => ({ rootPath: first, pid: 4242, cwd: first, lines: [] }))
    const { container } = renderApp(stub, first)

    await openFromGlyph(container)

    stub.on('read', () => ({ rootPath: second, pid: 4243, cwd: second, lines: ['$ pwd', second] }))
    act(() => stubStore(stub, 'workspace', { rootPath: second, recentRoots: [second] }))

    // The existing path, unchanged: the pane tells the host which folder is open, and the host opens
    // that folder's session and replays that folder's transcript.
    await waitFor(() =>
      expect(
        ptyCalls(stub).some(
          (call) => call.method === 'read' && (call.input as { rootPath: string }).rootPath === second
        ),
        'the new root’s buffer was read'
      ).toBe(true)
    )
    expect(
      ptyCalls(stub).some(
        (call) => call.method === 'create' && (call.input as { rootPath: string }).rootPath === second
      )
    ).toBe(true)
    expect(terminalPane(container)).not.toBeNull()
    expect(xterm.writes.join('')).toContain(second)
  })

  it('stores a dragged separator as the current window state’s height, and touches nothing else', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    renderApp(stub, root)

    act(() => useWorkbenchStore.setState({ bottomPanelOpen: true }))
    dragBottomPanel({ conversation: 40, terminal: 60 })

    await waitFor(() => expect(record().bottomPanelHeightWindowed).toBe(60))
    // The other state's height, both layout sets and the flags are exactly as they were: a drag writes
    // one number into one state's key and nothing else.
    expect(Object.keys(record()).sort()).toEqual(['bottomPanelHeightWindowed', 'bottomPanelOpen'])
  })
})
