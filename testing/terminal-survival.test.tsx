import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { terminalHost } from '@/app/components/workbench/terminal-host'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The terminal's session, and the pane that only shows it.
 *
 * Phase 39 makes the shell a resident of the right rail, so its pane is now something a click puts away
 * and the same click brings back. This file is the claim that nothing about the shell is lost when that
 * happens: the scrollback is the same scrollback, the run in flight is the same run, and the second
 * `execute` a rebuilt pane would have opened is asserted *not* to have happened — one stream start across
 * a close and a reopen.
 *
 * The transcript is read through the host rather than through the DOM, because that is where a reader's
 * scrollback actually is: xterm's buffer, which is readable whether or not a pane is on screen. The
 * element identity is asserted too, because "the same terminal" is the mechanism and not a consequence.
 *
 * What this deliberately does not claim is that the pane's own state survives, because there is none
 * worth keeping: the input box is what the pane holds, and an empty box is what a reopen should show.
 */

const ROOT = 'C:/projects/sam-ai'
const COMMAND = 'npm test'

function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    readFile: () => ({ path: `${ROOT}/notes.txt`, content: 'just words\n', baselineMtime: 0 }),
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
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/** The terminal resident's own button, on the rail it now belongs to. */
function terminalResident(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Right rail' })).getByRole('button', { name: 'Terminal' })
}

/** The xterm the pane is showing, as the node itself — the same node has to come back. */
function terminalNode(container: HTMLElement): Element | null {
  return container.querySelector('.xterm')
}

/**
 * The command, entered as a change event rather than by typing.
 *
 * `userEvent.type` cannot drive this box while the workbench is around it: the resizable group moves focus
 * to its own separator whenever its layout changes — the library's keyboard affordance for resizing, made
 * for a reader who has just opened a panel — and that happens while the dock is still settling, so the
 * keystrokes land on a divider instead of the input. Asked of this harness twice and left alone: what this
 * file asserts is the session across a close, and the change event is the same state change the Run
 * button reads.
 */
function enterCommand(command: string): HTMLInputElement {
  const box = screen.getByLabelText('Command') as HTMLInputElement
  fireEvent.change(box, { target: { value: command } })
  expect(box.value, 'the box holds the command').toBe(command)
  return box
}

/** The channel this run's chunks arrive on, read from the recorded start call rather than guessed. */
async function runOnce(stub: BridgeStub): Promise<string> {
  enterCommand(COMMAND)

  // Checked rather than waited on: a Run that is not offered would make everything after this a claim
  // about nothing, and the button is offered exactly when there is a command and a folder to run it in.
  const run = screen.getByRole('button', { name: 'Run' })
  expect(run.hasAttribute('disabled'), 'Run is offered once there is a command').toBe(false)

  await userEvent.click(run)

  await waitFor(() => {
    if (!streamStart(stub)) {
      throw new Error(`no stream: ${stub.calls.map((call) => `${call.channel}/${call.method}`).join(' ')}`)
    }
  })

  return `conveyor:stream:${streamStart(stub)?.method}`
}

/** The one stream this suite starts. Filtered by member so no other stream can be mistaken for it. */
function streamStart(stub: BridgeStub) {
  return stub.calls.find(
    (call) => call.channel === 'conveyor:stream:start' && call.method.startsWith('terminal.execute#')
  )
}

function chunk(stub: BridgeStub, channel: string, text: string): void {
  stub.emit(channel, { type: 'data', value: text })
}

beforeEach(() => {
  queryClient.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    drawerCollapsed: false,
    selectedFile: null,
    selectedChange: null,
    viewerExpanded: false,
    rightPanel: null,
  })
})

describe('the terminal, across a close and a reopen', () => {
  it('keeps its scrollback, its run, and its one stream', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    const host = terminalHost()

    await userEvent.click(terminalResident())

    // The pane is showing the session's terminal, and the folder it runs in: both are the state this run
    // needs, and asserting them here keeps a disabled Run button from looking like a missing stream.
    expect(screen.getByLabelText('Command').getAttribute('placeholder')).toBe('Type a command, e.g. ls -la')
    expect(terminalNode(container), 'the terminal the pane drew into').not.toBeNull()

    const channel = await runOnce(stub)

    chunk(stub, channel, 'BEFORE-THE-CLOSE')
    await waitFor(() => expect(host.transcript()).toContain('BEFORE-THE-CLOSE'))
    expect(screen.getByText('1 run this session')).toBeTruthy()

    const terminal = terminalNode(container)
    expect(terminal, 'the terminal the pane drew into').not.toBeNull()

    // The close: a second click on the resident that is docked, which is the rail's own rule.
    await userEvent.click(terminalResident())

    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
    expect(screen.queryByLabelText('Command')).toBeNull()
    // The scrollback is not the pane's, so it is still here with no pane to show it.
    expect(host.transcript()).toContain('BEFORE-THE-CLOSE')
    expect(host.transcript()).toContain(COMMAND)

    // Output that lands while the pane is away is consumed and written all the same — which is the run's
    // attachment surviving, not merely the transcript's text.
    chunk(stub, channel, 'WHILE-AWAY')
    await waitFor(() => expect(host.transcript()).toContain('WHILE-AWAY'))

    await userEvent.click(terminalResident())

    // Everything before and after the close is on screen again, from one terminal rather than a second:
    // the pane is handed the element back instead of being given a new one.
    expect(host.transcript()).toContain('BEFORE-THE-CLOSE')
    expect(host.transcript()).toContain('WHILE-AWAY')
    expect(terminalNode(container)).toBe(terminal)
    expect(screen.getByLabelText('Command')).toBeTruthy()
    expect(screen.getByText('1 run this session')).toBeTruthy()

    // The backend was never restarted and the stream was never reopened: one run started, one stream
    // opened, across the whole cycle.
    expect(stub.calls.filter((call) => call.channel === 'conveyor:stream:start')).toHaveLength(1)

    // The run ends where it always did, and the pane is left able to take another — with the session's
    // own count, not this mount's.
    chunk(stub, channel, 'AFTER-THE-REOPEN')
    stub.emit(channel, { type: 'end' })

    await waitFor(() => expect(host.status().running).toBe(false))
    expect(host.transcript()).toContain('AFTER-THE-REOPEN')
    expect(screen.getByText('1 run this session')).toBeTruthy()
  })
})
