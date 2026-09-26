import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The terminal's session across the three things that happen to a pane: a remount, an undock, and a
 * change of folder.
 *
 * Phase 39's suite was the same claim about a transcript the renderer owned. Both halves of that have
 * moved since: the shell now belongs to main, and the pane is a view of it — so what has to survive is
 * not a renderer object but the pair of facts that make the pane disposable. The xterm instance and its
 * element outlive the pane, and everything the pane missed while it was away is still in main's
 * transcript, waiting to be read back.
 *
 * Both halves are asserted, because either alone would pass while the other was broken: the element the
 * pane mounts is the same node before and after (the mechanism), and the text on screen after the
 * remount is the whole of the shell's transcript rather than the tail of it (the consequence). And the
 * shell is asserted *not* to have been opened a second time, which is what a pane that owned its
 * terminal would have done.
 *
 * jsdom hosts no terminal: xterm is stubbed, so pixel acceptance and the real chord handling are Boss's
 * live keystroke test, not this file's. What is real here is the client, the bridge, the store mirror,
 * the pane's effects and the module-level host they talk to.
 */

const xterm = vi.hoisted(() => ({
  writes: [] as string[],
  options: [] as Array<Record<string, unknown>>,
  /**
   * The marker the stubbed `reset()` pushes.
   *
   * Held here rather than as a module constant because a `vi.mock` factory is hoisted above every
   * module constant and may read only hoisted state. A clear has to be visible to the suite for the
   * same reason the host performs it: reseeding means clearing first, so a mock whose clear is silent
   * cannot tell a replay from a duplication.
   */
  resetMarker: '\u001b[RESET]',
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 80
    rows = 24

    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.options.push(options)
    }

    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    dispose(): void {}

    write(data: string): void {
      xterm.writes.push(data)
    }

    reset(): void {
      xterm.writes.push(xterm.resetMarker)
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
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

/**
 * Main's transcript per folder, as this suite dictates it, and the pid each folder's shell was given.
 *
 * The suite is main here: it answers `create` and `read` from a map it owns, which is what makes "the
 * pane caught up from the transcript" a claim about a replay rather than about a mock that happens to
 * return the same thing twice.
 */
const transcripts = new Map<string, string[]>()
const pids = new Map<string, number>()
let nextPid = 4200

function sessionFor(rootPath: string): { rootPath: string; pid: number; cwd: string; lines: string[] } {
  let pid = pids.get(rootPath)
  if (pid === undefined) {
    nextPid += 1
    pid = nextPid
    pids.set(rootPath, pid)
  }
  return { rootPath, pid, cwd: rootPath, lines: [...(transcripts.get(rootPath) ?? [])] }
}

/** The session id the session store has open, so the workbench has a folder to be working in. */
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

let rootSeq = 0

/**
 * A folder no other test has opened.
 *
 * The host outlives the pane, which is this file's whole subject, so it also outlives a *test*: a root
 * already opened is not opened again. A folder per test is what keeps that rule from being read as a
 * missing call.
 */
function freshRoot(): string {
  rootSeq += 1
  return `C:/w/pty${rootSeq}`
}

function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    create: (input) => sessionFor((input as { rootPath: string }).rootPath),
    read: (input) => sessionFor((input as { rootPath: string }).rootPath),
    // Every writer is a no-op, and every one of them is asserted on through the call record instead:
    // a handler that threw would end the test for a reason the test is not about.
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
  setActiveStub(stub)
  return stub
}

/**
 * Render the workbench with a folder open.
 *
 * Both stores are seeded *before* the render, and the order is load-bearing rather than stylistic. The
 * store mirror answers its one initial read asynchronously, so a seed that arrives after the pane has
 * mounted is overwritten by that read's own answer — an empty `{ rootPath: null }` landing on a pane
 * that has already opened the folder's shell, which closes it again mid-flight and leaves a test
 * asserting against a terminal that never finished opening.
 */
function renderWorkbench(stub: BridgeStub, rootPath: string) {
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeId: SESSION_ID })
  stubStore(stub, 'workspace', { rootPath, recentRoots: [rootPath] })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
  return view
}

/** Open the bottom terminal panel, which is what makes the pane mount. */
function dock(): void {
  act(() => useWorkbenchStore.setState({ bottomPanelOpen: true }))
}

/** Put it away again without ending anything. */
function undock(): void {
  act(() => useWorkbenchStore.setState({ bottomPanelOpen: false }))
}

/** The folder main is working in, broadcast the way main broadcasts it. */
function switchRoot(stub: BridgeStub, rootPath: string): void {
  act(() => stub.pushToChannel('conveyor:store:workspace:changed', { rootPath, recentRoots: [rootPath] }))
}

/**
 * What the terminal is showing, and the whole log it was written from.
 *
 * The distinction is not cosmetic. `reset()` is the screen being cleared before a transcript is
 * replayed, so the screen is what came *after* the last clear — while the log still holds every write
 * ever made, this folder's and the previous one's. A `not.toContain` claim made against the log would
 * pass or fail for a reason that has nothing to do with what is on screen.
 */
function shown(): string {
  const whole = xterm.writes.join('')
  const at = whole.lastIndexOf(xterm.resetMarker)
  return at === -1 ? whole : whole.slice(at + xterm.resetMarker.length)
}

/** The whole log, clears included. For the claims about the clears themselves. */
function log(): string {
  return xterm.writes.join('')
}

/** How many times the pane called one PTY method, over all folders or over one. */
function calls(stub: BridgeStub, method: string, rootPath?: string): number {
  return stub
    .callsTo('terminalPty')
    .filter((call) => call.method === method)
    .filter((call) => rootPath === undefined || (call.args[0] as { rootPath?: string })?.rootPath === rootPath).length
}

/** The pane's own box, and inside it the element the host created and keeps. */
function terminalBox(container: HTMLElement): HTMLElement {
  const pane = container.querySelector<HTMLElement>('[data-slot="terminal"]')
  if (!pane) throw new Error('the terminal pane is not on screen')
  const box = pane.firstElementChild
  if (!(box instanceof HTMLElement)) throw new Error('the host has not created its element yet')
  return box
}

beforeEach(() => {
  xterm.writes.length = 0
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    bottomPanelOpen: false,
  })
})

describe('a keyed remount', () => {
  it('re-seeds the terminal from the shell’s transcript and does not open a second shell', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    transcripts.set(root, ['$ npm test', 'ok 12 passing'])
    const view = renderWorkbench(stub, root)
    dock()

    await waitFor(() => expect(shown()).toContain('ok 12 passing'))
    expect(calls(stub, 'create', root), 'the folder’s shell was opened once').toBe(1)
    expect(calls(stub, 'read', root), 'and its transcript was read').toBeGreaterThanOrEqual(1)

    // The element the host drew into, before the window state changes under it.
    const box = terminalBox(view.container)

    // The shell kept printing while the window was windowed. Nothing pushed this to a renderer yet —
    // it is in main's transcript, which is exactly where a pane resuming has to look for it.
    transcripts.set(root, ['$ npm test', 'ok 12 passing', 'done'])

    // The maximize: the workbench keys both groups on the window state, so every pane under them is
    // unmounted and mounted again. That is the remount this suite exists for.
    act(() => stub.emit('conveyor:event:window:onMaximizeChange', true))

    await waitFor(() => expect(shown()).toContain('done'))

    // Read again rather than opened again: a second `create` would have been a second shell in the same
    // folder, fighting the first over the same files.
    expect(calls(stub, 'create', root), 'still one shell').toBe(1)
    expect(calls(stub, 'read', root), 'the transcript was read again').toBeGreaterThanOrEqual(2)
    expect(calls(stub, 'kill'), 'and nothing was ended').toBe(0)

    // The scrollback is not rebuilt, it is restored: the terminal was cleared and the whole transcript
    // replayed, which is why the text before the remount is still there afterwards.
    expect(shown()).toContain('$ npm test')
    expect(log(), 'the screen was cleared before the replay').toContain(xterm.resetMarker)

    // And it was restored into the same element, which is the mechanism behind all of the above.
    expect(terminalBox(view.container), 'the same element is re-parented').toBe(box)
  })
})

describe('an undock', () => {
  it('leaves the shell running, and the dock that follows catches up from the transcript', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    transcripts.set(root, ['$ ls', 'notes.txt'])
    renderWorkbench(stub, root)
    dock()

    await waitFor(() => expect(shown()).toContain('notes.txt'))

    undock()
    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(false)
    expect(screen.queryByLabelText('Terminal pane'), 'the pane is gone').toBeNull()
    expect(calls(stub, 'kill'), 'putting the pane away ends nothing').toBe(0)

    // The shell was never waiting on the pane: it kept running, and main kept its transcript.
    transcripts.set(root, ['$ ls', 'notes.txt', '$ npm run build', 'built in 1.2s'])

    dock()

    await waitFor(() => expect(shown()).toContain('built in 1.2s'))
    expect(calls(stub, 'create', root), 'the same shell, not a new one').toBe(1)
    expect(calls(stub, 'kill')).toBe(0)
  })
})

describe('a change of folder', () => {
  it('attaches to that folder’s own shell, and back again, without ending either', async () => {
    const stub = stubWorkbench()
    const first = freshRoot()
    const second = freshRoot()
    transcripts.set(first, ['$ pwd', first])
    transcripts.set(second, ['$ pwd', second])

    renderWorkbench(stub, first)
    dock()

    await waitFor(() => expect(shown()).toContain(first))
    const box = terminalBox(document.body)

    // The switcher opens another folder. Main broadcasts the new state; the pane reads it there.
    switchRoot(stub, second)

    await waitFor(() => expect(shown()).toContain(second))

    // The two shells are two shells: each opened once, neither ended, and the pane is showing the one
    // belonging to the folder that is open — not the previous folder's output with the new one's below.
    expect(calls(stub, 'create', first)).toBe(1)
    expect(calls(stub, 'create', second), 'the second folder’s shell was opened on arrival').toBe(1)
    expect(calls(stub, 'read', second), 'and its transcript was read').toBeGreaterThanOrEqual(1)
    expect(calls(stub, 'kill'), 'switching folders ends nothing').toBe(0)
    expect(shown()).not.toContain(`$ pwd\r\n${first}`)

    // And back: the first folder's shell was alive the whole time, so returning re-attaches to it by
    // reading it rather than opening it.
    switchRoot(stub, first)

    await waitFor(() => expect(shown()).toContain(`$ pwd\r\n${first}`))
    expect(calls(stub, 'create', first), 'still the one shell in the first folder').toBe(1)
    expect(terminalBox(document.body), 'the same element, whichever shell it is showing').toBe(box)
  })
})
