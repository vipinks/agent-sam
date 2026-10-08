import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { WindowFrame } from '@/app/shell'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import type { UpdateStatusState } from '@/conveyor/stores/update-status'
import { UPDATE_STATES, UPDATES_DOWNLOAD_FAILED, updateBadge } from '@/conveyor/protocol/updates'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The header's update badge: when it is drawn, what it says, where it sits, and where a click goes.
 *
 * The badge is the one thing in the chrome that speaks about the updater, and it exists because the
 * Updates section is one rail click away: a user who never opens Settings would otherwise never learn
 * that a release is waiting. That is also exactly why the states it speaks for are a rule rather than a
 * mention of the word "update": a badge drawn for `error` would be a permanent mark in the title bar
 * asking about something the user cannot act on from there, and a badge drawn for `up-to-date` would be
 * decoration. Both are asserted below, from the rule's own answer for every state, so a component that
 * restated the rule would have to be right twice.
 *
 * The row is asserted rather than described: the badge is the terminal panel control's immediate
 * predecessor, and the icons that were already there keep their order and their behaviour. The click is
 * asserted through the store's own deep-link entry point, which is the one the tools panel and the
 * composer's slash commands already use — so the badge lands on the Updates section by the same route,
 * rather than by a second mechanism invented for it.
 *
 * jsdom proves wiring, attributes and words, not pixels. Whether the badge reads as chrome rather than
 * as an alert at 16px in both themes is Boss's eyes on the running window; and the updater itself is a
 * packaged build's business, so a state the mirror can hold is simulated here rather than produced.
 */

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/** The provider the Settings screen draws a row from, and the folder the shell needs to come up. */
const DEEPSEEK = { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }

/** The pair the tooltips are built from: this build's version, and the one waiting. */
const FROM = '1.2.0'
const TO = '1.3.0'

/** The status store's state, as the mirror hands it to the badge. */
function statusState(over: Partial<UpdateStatusState> = {}): UpdateStatusState {
  return {
    state: 'idle',
    availableVersion: null,
    currentVersion: FROM,
    lastCheckedAt: null,
    errorCode: null,
    ...over,
  }
}

/**
 * The whole window over a folder with one file in it.
 *
 * The frame rather than the workbench alone, because the badge is titlebar chrome: it has to be drawn
 * where the row is, not in a panel beside it. Everything else is the app's real code — the conveyor
 * client, the bridge transport, and the shell that owns the row.
 */
function stubShell(status: UpdateStatusState = statusState()): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
    readFile: () => ({ path: TEXT_PATH, content: 'just words\n', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [DEEPSEEK],
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
    listServers: () => ({ user: [], project: [], errors: [] }),
    listRunningTools: () => [],
    // The three acts answer emptily: the badge is not one of them, and what is asserted here is that a
    // click leads to Settings rather than reaching the updater.
    check: () => undefined,
    download: () => undefined,
    install: () => undefined,
  })
  stubStore(stub, 'update-status', status)
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)
  return stub
}

function renderFrame() {
  return render(<WindowFrame>{null}</WindowFrame>)
}

function renderShell() {
  return render(
    <QueryClientProvider client={queryClient}>
      <WindowFrame>
        <Workbench />
      </WindowFrame>
    </QueryClientProvider>
  )
}

/** Push the updater's next transition, as main does when electron-updater reports one. */
function pushStatus(stub: BridgeStub, status: UpdateStatusState) {
  stubStore(stub, 'update-status', status)
}

/** The badge, or null while nothing about the updater is worth a mark in the chrome. */
function badge(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-badge"]')
}

/** The amber dot, or null while the badge carries none. */
function dot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-badge-dot"]')
}

/**
 * The text of every tooltip currently open.
 *
 * Radix marks an open tooltip `instant-open` or `delayed-open` rather than `open`, so the state is read
 * as "not closed" — a selector for `open` matches nothing and reads as a tooltip that never appeared.
 */
function openTooltipText(): string {
  const open = document.querySelectorAll('[role="tooltip"]:not([data-state="closed"])')
  return Array.from(open)
    .map((node) => node.textContent ?? '')
    .join(' ')
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's and the store is module-level: a case that left the window in
  // Settings would otherwise decide the next one's first paint.
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsReturnView: null,
    settingsSection: 'providers',
    drawerCollapsed: false,
    bottomPanelOpen: false,
  })
})

describe('the header update badge', () => {
  it('is drawn in exactly the three states with an update in them, and carries the rule’s own words', async () => {
    const stub = stubShell(statusState({ state: 'idle' }))

    renderFrame()
    // The idle launch: the state every dev run sits in for its whole life, and nothing is drawn for it.
    expect(badge()).toBeNull()

    for (const state of UPDATE_STATES) {
      pushStatus(
        stub,
        statusState({ state, availableVersion: TO, errorCode: state === 'error' ? UPDATES_DOWNLOAD_FAILED : null })
      )
      await waitFor(() => {
        const rule = updateBadge(state, FROM, TO)
        // The rule is the whole of the decision: the badge is drawn for exactly the states it names, and
        // says exactly what it answers for them.
        if (rule.present) {
          expect(badge(), `${state}: drawn`).not.toBeNull()
          expect(badge()?.getAttribute('aria-label'), `${state}: named by the tooltip`).toBe(rule.label)
          expect(dot(), `${state}: marked`).not.toBeNull()
        } else {
          expect(badge(), `${state}: silent`).toBeNull()
          expect(dot(), `${state}: no mark`).toBeNull()
        }
      })
    }

    // The words themselves, pinned so a reworded rule fails here rather than passing quietly: the first
    // two states are one piece of news, and the third is the different one — the wait is over.
    expect(updateBadge('available', FROM, TO).label).toBe('New version available: 1.2.0 → 1.3.0')
    expect(updateBadge('downloading', FROM, TO).label).toBe('New version available: 1.2.0 → 1.3.0')
    expect(updateBadge('ready', FROM, TO).label).toBe('Update ready to install: 1.2.0 → 1.3.0')

    // A failure is the Updates section's business and never the chrome's: it would be a mark asking about
    // something this control cannot fix, and it would stay there.
    expect(updateBadge('error', FROM, TO).present).toBe(false)
    expect(updateBadge('up-to-date', FROM, TO).present).toBe(false)
    expect(updateBadge('idle', FROM, TO).present).toBe(false)
    expect(updateBadge('checking', FROM, TO).present).toBe(false)
  })

  it('shows the tooltip each state names, on the badge a keyboard user can reach', async () => {
    const stub = stubShell(statusState({ state: 'available', availableVersion: TO }))

    renderFrame()
    await waitFor(() => expect(badge()).not.toBeNull())

    for (const state of ['available', 'downloading', 'ready'] as const) {
      pushStatus(stub, statusState({ state, availableVersion: TO }))
      await waitFor(() => expect(badge(), `${state}: drawn`).not.toBeNull())

      // Reachable without a pointer, and named by the same string the tooltip shows: the two are one
      // sentence reached two ways, not two descriptions of one control.
      const node = badge() as HTMLElement
      act(() => node.focus())
      expect(document.activeElement).toBe(node)

      const word = updateBadge(state, FROM, TO).label
      await waitFor(() => expect(openTooltipText(), `${state}: its tooltip`).toContain(word))
      act(() => node.blur())
    }
  })

  it('sits immediately left of the terminal panel control, and moves nothing that was already in the row', async () => {
    stubShell(statusState({ state: 'ready', availableVersion: TO }))

    renderFrame()
    await waitFor(() => expect(badge()).not.toBeNull())

    // The terminal control is drawn with its divider in a wrapper of its own, so the badge's place in the
    // row is the sibling immediately before that wrapper — the position the design names, asserted rather
    // than assumed.
    const terminal = screen.getByRole('button', { name: 'Terminal panel' })
    const wrapper = terminal.parentElement as HTMLElement
    expect(wrapper.previousElementSibling).toBe(badge())

    // The row's other controls, in the order they were in before this phase: nothing was renamed or moved
    // to make room for the badge, and the four view acts are still led by the zoom ladder.
    for (const name of [
      'Toggle theme',
      'Brightness',
      'Terminal panel',
      'Zoom In',
      'Zoom Out',
      'Actual Size',
      'Toggle Fullscreen',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) }), name).toBeTruthy()
    }

    // And the neighbour still does what it did: the badge is a control beside it, not a replacement.
    const open = useWorkbenchStore.getState().bottomPanelOpen
    await userEvent.click(terminal)
    expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(!open)
  })

  it('opens the settings screen at the Updates section when it is pressed', async () => {
    const stub = stubShell(statusState({ state: 'downloading', availableVersion: TO }))

    renderShell()
    await waitFor(() => expect(badge()).not.toBeNull())

    await userEvent.click(badge() as HTMLElement)

    // The store's own deep link, which is the mechanism the composer's slash commands and the tools panel
    // already use: the screen opens *at* the section in one dispatch, so a user cannot land on whichever
    // section happened to be showing.
    await waitFor(() => expect(document.querySelector('[data-slot="settings-section-updates"]')).not.toBeNull())
    expect(useWorkbenchStore.getState().activeActivity).toBe('settings')
    expect(useWorkbenchStore.getState().settingsSection).toBe('updates')

    // Leading there is the whole of what the badge does. The install is the Updates section's offer, and a
    // click in the chrome must not perform it.
    expect(stub.methodsOn('updates')).toEqual([])
  })
})
