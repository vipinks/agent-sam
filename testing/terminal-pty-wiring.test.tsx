import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { themeVarsFor } from '@/app/components/workbench/theme-apply'
import { DEFAULT_THEME_ID } from '@/app/components/workbench/themes'
import { useThemeStore } from '@/app/shell'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The terminal resident, as a view of a shell that lives in main.
 *
 * jsdom hosts no terminal. xterm draws into a canvas, measures real fonts and reads real key events, so
 * what is stubbed here is the terminal itself: a `Terminal` whose writes are collected, whose `onData`
 * and custom key handler a test can call, whose dimensions a stubbed `fit()` sets, and whose observer
 * callback the suite can fire. Everything between the pane and main — the conveyor client, the bridge
 * transport, the store mirror and the pane's own effects — is the app's real code.
 *
 * What that leaves unverified is stated rather than implied: pixels, latency, selection rendering and
 * the real Ctrl+C chord are Boss's live keystroke test. This suite is about which call the pane makes,
 * with which payload, in which order.
 *
 * One consequence of the host being a module singleton: a root already opened in an earlier test is not
 * opened again — which is the behaviour one of these tests asserts — so each test takes a folder of its
 * own from `freshRoot()`. That is the same rule the app has, reached through the same code path.
 */

const xterm = vi.hoisted(() => ({
  /** Everything written into the terminal, in order. */
  writes: [] as string[],
  /** The options objects handed to the constructor — one per terminal, which is one for the file. */
  options: [] as Array<Record<string, unknown>>,
  /** What a stubbed `fit()` measures the box to be. */
  cols: 80,
  rows: 24,
  fitCalls: 0,
  /** The current selection, as `hasSelection`/`getSelection` report it. */
  selection: '',
  /** The handlers xterm would call back into. Held so a test can drive them. */
  onData: null as null | ((data: string) => void),
  keyHandler: null as null | ((event: KeyboardEvent) => boolean),
  /** The observers installed here, each with the elements it was asked to watch. */
  observers: [] as Array<{ targets: Element[]; callback: () => void }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    /** Measured by the addon rather than fixed, so a `fit()` is observable through the terminal. */
    get cols(): number {
      return xterm.cols
    }

    get rows(): number {
      return xterm.rows
    }

    options: Record<string, unknown>

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
      // Written as a marker so a test can see that the terminal was cleared before a replay.
      xterm.writes.push('\u001b[RESET]')
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      xterm.onData = handler
      return { dispose: () => {} }
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      xterm.keyHandler = handler
    }

    hasSelection(): boolean {
      return xterm.selection !== ''
    }

    getSelection(): string {
      return xterm.selection
    }

    clearSelection(): void {
      xterm.selection = ''
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      xterm.fitCalls += 1
      xterm.cols = 100
      xterm.rows = 30
    }
  },
}))

/**
 * A `ResizeObserver` that keeps its callbacks and their targets, so a test can be the container change.
 *
 * Installed over the suite's own no-op: the setup file's stand-in exists so Radix can mount, and it
 * never fires — which would leave this suite unable to distinguish "the pane never observes its box"
 * from "the box never changed".
 *
 * The targets are kept, not just the callbacks, because this class takes over the global: every other
 * component that observes something now lands in the same list, and a test that fired all of them would
 * be simulating a resizable group's relayout to ask the terminal a question about its own box.
 */
class ObservableResizeObserver {
  private readonly targets: Element[] = []

  constructor(callback: () => void) {
    xterm.observers.push({ targets: this.targets, callback })
  }

  observe(target: Element): void {
    this.targets.push(target)
  }

  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  globalThis.ResizeObserver = ObservableResizeObserver as unknown as typeof ResizeObserver
})

afterAll(() => {
  // Left as the suite found it: the setup file installs a no-op, and another file may rely on it.
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

/** The clipboard, which jsdom does not implement. Both directions are recorded. */
const clipboard = { copies: [] as string[], paste: '' }

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboard.copies.push(text)
      },
      readText: async () => clipboard.paste,
    },
  })
})

let rootSeq = 0

/**
 * A folder no other test has opened.
 *
 * The host a pane talks to outlives the pane — that is its whole reason for existing — so `create` is
 * dispatched for a root the first time it is bound and not for the second. A folder per test is what
 * keeps that rule from being read as "the call went missing".
 */
function freshRoot(): string {
  rootSeq += 1
  return `C:/w/t${rootSeq}`
}

function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    // Every writer is a no-op and every read answers emptily. What this suite asserts is *which* call
    // the pane made with which payload, which the stub's own call record holds — a handler that threw
    // would end the test for a reason the test is not about.
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
 * Render the workbench and dock the terminal resident.
 *
 * The folder is seeded *before* the render, and the order is load-bearing rather than stylistic. The
 * store mirror answers its one initial read asynchronously, so a seed that arrives after the pane has
 * mounted is overwritten by that read's own answer — an empty `{ rootPath: null }` landing on a pane
 * that has already opened the folder's shell, which closes it again mid-flight and leaves the test
 * asserting against a terminal that never finished opening.
 */
function dock(stub: BridgeStub, rootPath: string): HTMLElement {
  stubStore(stub, 'workspace', { rootPath, recentRoots: [rootPath] })
  act(() => useWorkbenchStore.setState({ activeActivity: 'chat', selectedFile: null, selectedChange: null }))
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
  act(() => useWorkbenchStore.setState({ rightPanel: 'terminal' }))
  return view.container
}

/** Every call the pane made on the PTY module, in order. */
function ptyCalls(stub: BridgeStub): Array<{ method: string; input: unknown }> {
  return stub.callsTo('terminalPty').map((call) => ({
    method: call.method,
    input: (call.args[0] ?? {}) as unknown,
  }))
}

/** The methods the pane called on the PTY module. */
function ptyMethods(stub: BridgeStub): string[] {
  return ptyCalls(stub).map((call) => call.method)
}

/** Push a chunk of shell output the way main does. */
function pushOutput(stub: BridgeStub, rootPath: string, chunk: string): void {
  act(() => stub.emit('conveyor:event:terminalPty:data', { rootPath, chunk }))
}

/** The element the host draws into: the terminal slot's only child. */
function terminalBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector('[data-slot="terminal"]')?.firstElementChild
  if (!(box instanceof HTMLElement)) throw new Error('the terminal has no box')
  return box
}

/** Everything the terminal has been given, as one string. */
function shown(): string {
  return xterm.writes.join('')
}

beforeEach(() => {
  xterm.writes.length = 0
  xterm.fitCalls = 0
  xterm.selection = ''
  xterm.cols = 80
  xterm.rows = 24
  clipboard.copies.length = 0
  clipboard.paste = ''
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
  })
})

describe('docking the terminal', () => {
  it('opens the folder’s shell and fills the terminal from its transcript', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ ls', 'notes.txt'] }))

    dock(stub, root)

    await waitFor(() => expect(ptyMethods(stub)).toContain('create'))
    expect(ptyCalls(stub).find((call) => call.method === 'create')?.input).toEqual({ rootPath: root })

    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))
    expect(ptyCalls(stub).find((call) => call.method === 'read')?.input).toEqual({ rootPath: root })

    // The transcript is what the terminal shows, so a pane that opened a shell and drew nothing would
    // fail here rather than looking like a shell with no output.
    await waitFor(() => expect(shown()).toContain('notes.txt'))
    expect(screen.getByLabelText('Terminal pane')).toBeTruthy()
  })

  it('writes a pushed chunk into the terminal, and drops one for another folder', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))

    pushOutput(stub, root, '$ npm test\r\n')
    await waitFor(() => expect(shown()).toContain('$ npm test'))

    // A second shell's output arrives on the same channel, and the pane is the only thing that can tell
    // them apart: writing it here would put another folder's command line in this terminal.
    pushOutput(stub, 'C:/w/somewhere-else', 'SECRET-OF-ANOTHER-SHELL\r\n')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shown()).not.toContain('SECRET-OF-ANOTHER-SHELL')
  })

  it('sends a keystroke to the shell, escaped sequences and all', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))

    await waitFor(() => expect(xterm.onData).not.toBeNull())
    // What xterm hands over for a typed line: the characters, then the carriage return. Arrow keys and
    // control codes arrive the same way, which is why nothing here inspects the data.
    act(() => {
      xterm.onData?.('ls')
      xterm.onData?.('\r')
    })

    await waitFor(() => expect(ptyMethods(stub)).toContain('write'))
    expect(
      ptyCalls(stub)
        .filter((call) => call.method === 'write')
        .map((call) => call.input)
    ).toEqual([
      { rootPath: root, data: 'ls' },
      { rootPath: root, data: '\r' },
    ])
  })

  it('measures the box and tells the shell how large it is, once per change', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    const container = dock(stub, root)
    expect(container.querySelector('[data-slot="terminal"]'), 'the pane is on screen').not.toBeNull()

    // Docking measures the box it just took: the shell starts at the pty's default 80x24, so the first
    // size it hears is the only one that makes its line wrapping match the pane.
    await waitFor(() => expect(ptyMethods(stub)).toContain('resize'))
    expect(ptyCalls(stub).find((call) => call.method === 'resize')?.input).toEqual({
      rootPath: root,
      cols: 100,
      rows: 30,
    })

    const before = ptyCalls(stub).filter((call) => call.method === 'resize').length

    // A container change — the dock dragged, the viewer expanded — reaches the terminal through the
    // observer rather than through a window resize, because the pane resizes inside a group. Fired on
    // the host's own observer only: the group installs one too, and it is not this test's subject.
    const box = terminalBox(container)
    await waitFor(() => expect(xterm.observers.some((o) => o.targets.includes(box))).toBe(true))
    const watchers = xterm.observers.filter((o) => o.targets.includes(box))
    expect(watchers, 'the host watches the box it draws into, once').toHaveLength(1)
    act(() => {
      watchers[0].callback()
    })

    await waitFor(() =>
      expect(ptyCalls(stub).filter((call) => call.method === 'resize').length).toBeGreaterThan(before)
    )
  })
})

describe('copy and paste, the terminal’s own', () => {
  it('copies the selection on Ctrl+C instead of interrupting the shell', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull())

    xterm.selection = 'picked out of the scrollback'
    let handled = true
    act(() => {
      handled = xterm.keyHandler?.({ type: 'keydown', key: 'c', ctrlKey: true } as KeyboardEvent) ?? true
    })

    // `false` is the whole contract: xterm must not go on to turn this chord into a keystroke, because
    // the byte it would send is the one that kills whatever the user was about to paste around.
    expect(handled).toBe(false)
    await waitFor(() => expect(clipboard.copies).toEqual(['picked out of the scrollback']))
    expect(ptyMethods(stub)).not.toContain('write')
  })

  it('interrupts the shell on Ctrl+C when nothing is selected', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull())

    let handled = false
    act(() => {
      handled = xterm.keyHandler?.({ type: 'keydown', key: 'c', ctrlKey: true } as KeyboardEvent) ?? false
    })
    expect(handled, 'xterm keeps the chord, and its default is the interrupt').toBe(true)
    expect(clipboard.copies).toEqual([])

    // And the byte reaches the shell by the one route a keystroke takes, so an interrupt is not a second
    // implementation of input.
    await waitFor(() => expect(xterm.onData).not.toBeNull())
    act(() => xterm.onData?.('\u0003'))
    await waitFor(() =>
      expect(
        ptyCalls(stub)
          .filter((call) => call.method === 'write')
          .map((call) => call.input)
      ).toEqual([{ rootPath: root, data: '\u0003' }])
    )
  })

  it('pastes through the renderer’s clipboard on Ctrl+V', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull())

    clipboard.paste = 'echo pasted\n'
    let handled = true
    const chord = {
      type: 'keydown',
      key: 'v',
      ctrlKey: true,
      // A real keydown can have its default stopped, and this route depends on that: refusing the chord
      // to xterm is not enough, the DOM's own paste has to be stopped with it.
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent
    act(() => {
      handled = xterm.keyHandler?.(chord) ?? true
    })

    // Refused, so the browser's own paste does not fire as well: two routes to one paste is a command
    // run twice.
    expect(handled).toBe(false)
    expect(chord.preventDefault, 'the browser’s own paste is stopped with the chord').toHaveBeenCalled()
    await waitFor(() =>
      expect(
        ptyCalls(stub)
          .filter((call) => call.method === 'write')
          .map((call) => call.input)
      ).toEqual([{ rootPath: root, data: 'echo pasted\n' }])
    )
  })
})

describe('the theme', () => {
  it('paints the terminal from the document’s own tokens, and follows a switch', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    // Whatever the document is in is what is asserted against: the point is that the terminal and the
    // stylesheet agree, not that this file knows which mode a headless jsdom opens in.
    act(() => useWorkbenchStore.setState({ themeId: DEFAULT_THEME_ID, brightness: 0 }))
    const mode = useThemeStore.getState().theme

    dock(stub, root)

    /** The colours xterm was handed: the same object it was built with, as it is mutated in place. */
    const options = () => xterm.options[0]?.theme as { background?: string; foreground?: string } | undefined

    const first = themeVarsFor(DEFAULT_THEME_ID, mode, 0)
    await waitFor(() => expect(options()?.background).toBe(first.background))
    expect(options()?.foreground, 'and its text is the app’s text').toBe(first.foreground)

    // A theme switch is the document's, and the terminal is re-painted from it rather than left on
    // whatever it was born with — the failure this asserts against is a terminal that is the one
    // rectangle unchanged by a theme the rest of the window just moved to.
    act(() => useWorkbenchStore.setState({ themeId: 'ocean' }))
    const second = themeVarsFor('ocean', mode, 0)

    expect(second.background, 'two themes, two backgrounds').not.toBe(first.background)
    await waitFor(() => expect(options()?.background).toBe(second.background))
    expect(options()?.foreground).toBe(second.foreground)
  })
})

describe('the shell ending', () => {
  it('writes a named exit line into the terminal and says so on the pane', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ exit'] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: ['$ exit'] }))

    const container = dock(stub, root)
    await waitFor(() => expect(shown()).toContain('$ exit'))

    act(() => stub.emit('conveyor:event:terminalPty:exit', { rootPath: root, exitCode: 3 }))

    // Named as a code rather than left as the raw number a reader would have to interpret, and written
    // into the terminal so it sits after the last thing the shell printed.
    await waitFor(() => expect(shown()).toContain('exit code 3'))
    await waitFor(() => expect(within(container).getByText(/exit code 3/i), 'the pane states it too').toBeTruthy())
  })

  it('offers a new shell after an exit, and starting one opens it and re-seeds', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    let pid = 4242
    // A second create answers with a second pid, so "a new shell" is assertable and not a reply the pane
    // could have been handed twice.
    stub.on('create', () => ({ rootPath: root, pid: (pid += 1), cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid, cwd: root, lines: ['$ echo fresh', 'fresh'] }))

    const container = dock(stub, root)
    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))

    const creates = () => ptyCalls(stub).filter((call) => call.method === 'create').length
    expect(creates(), 'the folder’s shell was opened once').toBe(1)

    act(() => stub.emit('conveyor:event:terminalPty:exit', { rootPath: root, exitCode: 0 }))
    await waitFor(() => expect(shown()).toContain('exit code 0'))

    // An exit on its own reopens nothing: a pane that respawned whenever a shell ended would fight
    // whoever typed `exit`, and would do it for a shell nothing asked to replace.
    expect(creates()).toBe(1)

    await userEvent.click(within(container).getByRole('button', { name: /start a new shell/i }))

    // The forced open: this renderer had already asked for this root, and main has forgotten the exited
    // session — so the request is a new shell rather than the dead one, and the screen is re-seeded from
    // its (empty) transcript so the exit line does not sit above a live shell.
    await waitFor(() => expect(creates()).toBe(2))
    await waitFor(() => expect(shown()).toContain('$ echo fresh'))
    await waitFor(() => expect(within(container).getByText(/live shell in/i)).toBeTruthy())

    // And the action goes away with the state that offered it.
    expect(within(container).queryByRole('button', { name: /start a new shell/i })).toBeNull()
  })

  it('ignores an exit that belongs to another folder', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    dock(stub, root)
    await waitFor(() => expect(ptyMethods(stub)).toContain('read'))

    act(() => stub.emit('conveyor:event:terminalPty:exit', { rootPath: 'C:/w/another-folder', exitCode: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shown()).not.toContain('exit code')
  })
})

describe('the rail still docks it', () => {
  it('is one of the rail’s residents, reached by its own button', async () => {
    const stub = stubWorkbench()
    const root = freshRoot()
    stub.on('create', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))
    stub.on('read', () => ({ rootPath: root, pid: 4242, cwd: root, lines: [] }))

    const view = render(
      <QueryClientProvider client={queryClient}>
        <Workbench />
      </QueryClientProvider>
    )
    stubStore(stub, 'workspace', { rootPath: root, recentRoots: [root] })

    const rail = screen.getByRole('navigation', { name: 'Right rail' })
    await userEvent.click(within(rail).getByRole('button', { name: 'Terminal' }))

    expect(useWorkbenchStore.getState().rightPanel).toBe('terminal')
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="terminal"]'), 'the pane is in the slot').not.toBeNull()
    )
    expect(within(rail).getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('true')
  })
})
