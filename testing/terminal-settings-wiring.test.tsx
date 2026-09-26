import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { terminalPreferencesStore, type TerminalPreferencesState } from '@/conveyor/stores/terminal-preferences'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Terminal section of Settings: the two preferences, and the two things each of them must do.
 *
 * jsdom hosts no terminal. xterm is stubbed here for the same reason the terminal suites stub it — it
 * draws into a canvas and measures real fonts — with one addition this file needs: the options object
 * it was constructed with is kept, because "the font size reached the terminal" is a claim about that
 * object and about nothing else. Pixels and latency remain Boss's live keystroke test.
 *
 * The section's own writes are asserted twice, deliberately. The store call is what persists the value,
 * and the terminal's options are what makes it visible — a change that only did one of the two would
 * pass a suite that asserted the other, which is exactly the failure this pair exists to catch.
 *
 * The pane is docked before Settings is opened, and the order is the point rather than a convenience:
 * the terminal that has to be re-painted is the one the host already built, and Settings takes the whole
 * main area — so the pane is *unmounted* while the field is on screen, which is the situation the live
 * change has to work in.
 */

const xterm = vi.hoisted(() => ({
  /** The options each constructed terminal was handed. One per constructed terminal. */
  options: [] as Array<Record<string, unknown>>,
  writes: [] as string[],
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

    reset(): void {}

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

const EMPTY_STATE: TerminalPreferencesState = { scrollbackLines: 1000, fontSize: 12 }

/**
 * The main process's half of the terminal-preferences store.
 *
 * A cross-window store is owned by main: the renderer's action call travels to the store channel and the
 * mirror changes only when the result is broadcast. This applies the definition's own reducer to its own
 * copy and pushes the result down the changed channel, so a claim about what was persisted is a claim
 * about the store the app ships rather than about a mock that echoes.
 */
function fakeMain(stub: BridgeStub, initial: TerminalPreferencesState): { state: () => TerminalPreferencesState } {
  let state = structuredClone(initial)
  stubStore(stub, 'terminal-preferences', state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (c, method, ...args) => {
    if (c === 'conveyor:store:terminal-preferences' && method in terminalPreferencesStore.actions) {
      // Recorded here rather than by the transport: this loop answers the call instead of forwarding it,
      // so without this line a dispatched preference would leave no trace for a test to assert on.
      stub.calls.push({ channel: c, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      const reduce = terminalPreferencesStore.actions[
        method as keyof typeof terminalPreferencesStore.actions
      ] as unknown as (draft: TerminalPreferencesState, input: unknown) => void
      reduce(next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel('conveyor:store:terminal-preferences:changed', structuredClone(state)))
      return state
    }
    return invoke(c, method, ...args)
  }

  return { state: () => state }
}

let rootSeq = 0

/** A folder no other test has opened, for the reason the terminal suites keep one per test. */
function freshRoot(): string {
  rootSeq += 1
  return `C:/w/prefs${rootSeq}`
}

function stubWorkbench(initial: TerminalPreferencesState = EMPTY_STATE) {
  const stub = createBridgeStub({
    isMaximized: () => false,
    // Every PTY writer is a no-op and its reads answer emptily: what this file asserts about the shell
    // is that nothing was sent to it, which the call record states on its own.
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    list: () => [],
    create: (input) => ({
      rootPath: (input as { rootPath: string }).rootPath,
      pid: 4242,
      cwd: (input as { rootPath: string }).rootPath,
      lines: [],
    }),
    read: (input) => ({
      rootPath: (input as { rootPath: string }).rootPath,
      pid: 4242,
      cwd: (input as { rootPath: string }).rootPath,
      lines: [],
    }),
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
    listServers: () => ({ user: [], project: [], errors: [] }),
    listRunningTools: () => [],
  })
  const main = fakeMain(stub, initial)
  setActiveStub(stub)
  return { stub, main }
}

/**
 * Render the workbench with a folder open, dock the terminal, then open Settings on its Terminal section.
 *
 * The terminal is docked first so that a terminal instance exists to be re-painted; leaving the docks in
 * place while the settings screen takes the main area is the app's own behaviour, not a shortcut — the
 * right panel id stays what it was, and the pane simply is not mounted.
 */
async function openTerminalSettings(stub: BridgeStub, rootPath: string): Promise<HTMLElement> {
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeId: null })
  stubStore(stub, 'workspace', { rootPath, recentRoots: [rootPath] })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )

  act(() => useWorkbenchStore.setState({ rightPanel: 'terminal' }))
  await waitFor(() => expect(screen.getByLabelText('Terminal pane'), 'the pane is docked').toBeTruthy())
  await waitFor(() => expect(terminalOptions().fontSize, 'and the terminal is built').toBeTruthy())
  // The dock's own resize is debounced, so waiting for it here is what makes a later count a statement
  // about what the *fields* sent: taken before it lands, the timer's own call would look like one of
  // theirs.
  await waitFor(() => expect(stub.methodsOn('terminalPty'), 'the shell was told its size').toContain('resize'))

  act(() => useWorkbenchStore.setState({ activeActivity: 'settings', settingsSection: 'terminal' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Terminal' })).toBeTruthy())

  return view.container
}

/** Every call the screen made on the PTY module, so "nothing was sent to the shell" is assertable. */
function ptyCalls(stub: BridgeStub): number {
  return stub.callsTo('terminalPty').length
}

/** The calls the section made on the preferences store, by action name. */
function storeMethods(stub: BridgeStub): string[] {
  return stub.calls.filter((call) => call.channel === 'conveyor:store:terminal-preferences').map((call) => call.method)
}

/**
 * The options of the terminal this file's renderer built.
 *
 * Not cleared between tests, deliberately: `terminalHost()` is a module singleton, so one terminal is
 * constructed for the whole file and every test asserts against that same object as xterm mutates it
 * in place. Emptying the record in `beforeEach` would hide the instance the host still owns — which is
 * how this suite first misread four passing mutations as "the terminal was never built".
 */
function terminalOptions(): Record<string, unknown> {
  const options = xterm.options[0]
  if (!options) throw new Error('no terminal was constructed')
  return options
}

beforeEach(() => {
  xterm.writes.length = 0
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsSection: 'providers',
    settingsReturnView: null,
    rightPanel: null,
    viewerExpanded: false,
    drawerCollapsed: false,
  })
})

describe('the Terminal section', () => {
  it('shows both controls with the values the store holds', async () => {
    const { stub } = stubWorkbench({ scrollbackLines: 2000, fontSize: 15 })
    const root = freshRoot()
    const container = await openTerminalSettings(stub, root)

    const section = container.querySelector<HTMLElement>('[data-slot="settings-section-terminal"]')
    expect(section, 'the section is the one showing').not.toBeNull()

    // The persisted values, not the defaults: a section that rendered its own initial state would look
    // right on a first launch and lose the setting on every visit after it.
    expect((within(section as HTMLElement).getByLabelText('Scrollback limit') as HTMLInputElement).value).toBe('2000')
    expect((within(section as HTMLElement).getByLabelText('Font size') as HTMLInputElement).value).toBe('15')
  })

  it('persists a new scrollback limit and sends nothing to a living shell', async () => {
    const { stub, main } = stubWorkbench({ scrollbackLines: 2000, fontSize: 12 })
    const root = freshRoot()
    await openTerminalSettings(stub, root)

    const before = ptyCalls(stub)
    const field = screen.getByLabelText('Scrollback limit') as HTMLInputElement
    await userEvent.clear(field)
    await userEvent.type(field, '2500')

    await waitFor(() => expect(main.state().scrollbackLines).toBe(2500))
    expect(storeMethods(stub), 'written through the store that persists it').toContain('setScrollbackLines')

    // The bound a running session was created with is its own: the limit is read when a shell is created,
    // so a change here must not reach back into a transcript, or tell the live shell anything at all.
    expect(ptyCalls(stub), 'nothing was sent to the shell').toBe(before)
    expect(main.state().fontSize, 'and the other preference is untouched').toBe(12)
  })

  it('re-applies a new font size to the terminal that is already built', async () => {
    const { stub, main } = stubWorkbench({ scrollbackLines: 1000, fontSize: 12 })
    const root = freshRoot()
    await openTerminalSettings(stub, root)

    expect(terminalOptions().fontSize, 'born at the persisted size').toBe(12)
    const before = ptyCalls(stub)

    const field = screen.getByLabelText('Font size') as HTMLInputElement
    await userEvent.clear(field)
    await userEvent.type(field, '18')

    await waitFor(() => expect(main.state().fontSize).toBe(18))
    // The instance the host kept, re-painted — the pane that would otherwise apply this is not mounted
    // while Settings is open, so a change that only wrote the store would leave the terminal at 12.
    await waitFor(() => expect(terminalOptions().fontSize).toBe(18))
    expect(ptyCalls(stub), 'a size is not a message to the shell').toBe(before)
  })

  it('explains an out-of-range entry under its own field and dispatches nothing', async () => {
    const { stub, main } = stubWorkbench({ scrollbackLines: 2000, fontSize: 12 })
    const root = freshRoot()
    await openTerminalSettings(stub, root)

    const lines = screen.getByLabelText('Scrollback limit') as HTMLInputElement
    // One change event rather than a keystroke per character, so the value under test is the whole value
    // the field is showing: typing passes through prefixes, and a valid prefix (a font size of `9`) is a
    // value in its own right.
    fireEvent.change(lines, { target: { value: '99' } })

    // The field's own words, from the rule both sides share, and no write at all.
    await waitFor(() => expect(screen.getByText('Enter a whole number of lines between 100 and 50,000.')).toBeTruthy())
    expect(lines.getAttribute('aria-invalid')).toBe('true')
    expect(main.state().scrollbackLines, 'a refused value is not persisted').toBe(2000)
    expect(storeMethods(stub)).not.toContain('setScrollbackLines')

    const size = screen.getByLabelText('Font size') as HTMLInputElement
    fireEvent.change(size, { target: { value: '99' } })

    await waitFor(() => expect(screen.getByText('Enter a whole number of pixels between 8 and 32.')).toBeTruthy())
    expect(main.state().fontSize).toBe(12)
    expect(storeMethods(stub)).not.toContain('setFontSize')
    expect(terminalOptions().fontSize, 'and the terminal keeps the size it had').toBe(12)

    // A letter is the other refusal, and the one a number input would have swallowed silently.
    fireEvent.change(lines, { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByText('Enter a whole number of lines.')).toBeTruthy())
    expect(storeMethods(stub)).not.toContain('setScrollbackLines')
  })
})
