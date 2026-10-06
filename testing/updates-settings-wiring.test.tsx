import { beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { updatePreferencesStore, type UpdatePreferencesState } from '@/conveyor/stores/update-preferences'
import { type UpdateStatusState } from '@/conveyor/stores/update-status'
import {
  DEFAULT_AUTO_DOWNLOAD,
  UPDATE_STATES,
  UPDATES_DISABLED_IN_DEV,
  UPDATES_DOWNLOAD_FAILED,
  updateStatusWord,
} from '@/conveyor/protocol/updates'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Updates settings section: wiring, not pixels.
 *
 * The updater's rule is `tests/updates/updates-rules-test.ts`'s — which word a state is called, which
 * offer a state allows. What can only be seen here is that the section *reads* that rule rather than
 * restating it: every status line asserted below is compared against `updateStatusWord` itself, so a
 * component with its own second copy of the words fails here. The same is true of the three controls,
 * whose presence and enabled state are the rule's `canCheck`/`canDownload`/`canInstall` and never an
 * ad-hoc conditional on the state.
 *
 * Main is simulated rather than faked for the one store the section writes: the preference store's own
 * action is applied to a copy of its state and the result pushed down the changed channel the mirror
 * listens on, so "the toggle persists" is a claim about the store the app ships. The status store is
 * seeded per case, because the section only reads it and the updater is the only writer.
 *
 * The one thing the section must never do is print main's sentence: a failure crosses as a code, and a
 * value that is not a declared code must fall back to the state's own word rather than being shown.
 * That is asserted directly below, with a message-shaped string pushed through the store.
 *
 * Residual, named rather than claimed: jsdom lays nothing out, so this file proves the section says the
 * right words and reaches the right stores. That it reads well in both themes is Boss's eyes.
 */

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]

const HOUR = 60 * 60 * 1000

/** The status store's state, as the section reads it: one case per field the surface draws. */
function statusState(over: Partial<UpdateStatusState> = {}): UpdateStatusState {
  return {
    state: 'idle',
    availableVersion: null,
    currentVersion: '1.2.0',
    lastCheckedAt: null,
    errorCode: null,
    ...over,
  }
}

/**
 * The main process's half of one cross-window store.
 *
 * A cross-window store is owned by main: the renderer's action call travels to the store channel and the
 * mirror changes only when the result is broadcast. This applies that definition's own reducer to its own
 * copy and pushes the result down the changed channel, so a test can assert both what was asked for and
 * what the screen does once main has answered.
 */
function fakeMain<S>(
  stub: BridgeStub,
  storeId: string,
  actions: Record<string, (draft: S, input: unknown) => void>,
  initial: S
): { state: () => S } {
  let state = structuredClone(initial)
  stubStore(stub, storeId, state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${storeId}` && method in actions) {
      // Recorded here rather than by the transport: this loop answers the action itself instead of
      // forwarding it, so without this line a dispatch would leave no trace for a test to assert on.
      stub.calls.push({ channel, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      actions[method](next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel(`conveyor:store:${storeId}:changed`, structuredClone(state)))
      return state
    }
    return invoke(channel, method, ...args)
  }

  return { state: () => state }
}

/** The preference store's one action, as the payload-agnostic loop above has to see it. */
const PREFERENCE_ACTIONS = updatePreferencesStore.actions as unknown as Record<
  string,
  (draft: UpdatePreferencesState, input: unknown) => void
>

async function openUpdates() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Updates' }))
}

/** Settings over one status and one stored preference, with the preference store owned by a stand-in main. */
function stubSettings(status: UpdateStatusState = statusState(), autoDownload = DEFAULT_AUTO_DOWNLOAD) {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    // The three acts answer emptily here: what this file asserts is that a control dispatches its own
    // act, and a stub that did more would be inventing an updater.
    check: () => undefined,
    download: () => undefined,
    install: () => undefined,
  })
  stubStore(stub, 'update-status', status)
  const preferences = fakeMain<UpdatePreferencesState>(stub, 'update-preferences', PREFERENCE_ACTIONS, {
    autoDownload,
  })
  setActiveStub(stub)
  return { stub, preferences }
}

/** Seed the status store again, as main does when the updater reports a transition. */
function pushStatus(stub: BridgeStub, status: UpdateStatusState) {
  stubStore(stub, 'update-status', status)
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
}

/** The section row, by the marker the shell's own panel carries. */
function sectionRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-slot="settings-sections"]')
  if (!row) throw new Error('the settings section row is not in the document')
  return row
}

/** One of the section panels, or null while it is the one that is not showing. */
function section(slot: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
  if (!node || node.hasAttribute('hidden')) return null
  return node
}

/** The Updates panel, or a failure — every case below is about what is inside it. */
function updatesSection(): HTMLElement {
  const panel = section('settings-section-updates')
  if (!panel) throw new Error('the Updates section is not showing')
  return panel
}

/** One marked node inside the section, by its slot. */
function slot(name: string): HTMLElement {
  const node = updatesSection().querySelector<HTMLElement>(`[data-slot="${name}"]`)
  if (!node) throw new Error(`the section draws no ${name}`)
  return node
}

/** A marked node inside the section, or null while the rule draws it not at all. */
function maybeSlot(name: string): HTMLElement | null {
  return updatesSection().querySelector<HTMLElement>(`[data-slot="${name}"]`)
}

/** Whether a control is disabled, as the DOM states it. */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled')
}

/** The methods the section called on the updates module, in order. */
function updateMethods(stub: BridgeStub): string[] {
  return stub.methodsOn('updates')
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's, and the store is module-level: a test that left the screen on
  // another section would otherwise decide the next one's first render.
  useWorkbenchStore.setState({
    activeActivity: 'settings',
    settingsReturnView: null,
    settingsSection: 'providers',
  })
})

describe('the Updates settings section', () => {
  it('is the eighth entry in the rail, and the section a visit lands on is the one it names', async () => {
    stubSettings()
    renderSettings()

    // The whole set, in order, with the section this phase added after it: a rail that grew a section in
    // the middle would be a different navigation from the one the design names.
    const entries = within(sectionRow()).getAllByRole('tab')
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'Providers',
      'MCP Servers',
      'Skills',
      'Terminal',
      'Context',
      'Appearance',
      'Buddies',
      'Updates',
      'Engines',
    ])

    await openUpdates()
    expect(section('settings-section-updates')).not.toBeNull()
    expect(section('settings-section-providers')).toBeNull()
    expect(updatesSection().querySelector('h1')?.textContent).toBe('Updates')

    // And the same section is what a caller landing on it by name gets: the store's own entry point, the
    // one a header control or a deep link would use, resolved by the shell's panel.
    await userEvent.click(await screen.findByRole('tab', { name: 'Providers' }))
    expect(section('settings-section-updates')).toBeNull()

    act(() => useWorkbenchStore.getState().openSettingsAt('updates'))
    await waitFor(() => expect(section('settings-section-updates')).not.toBeNull())
    expect(useWorkbenchStore.getState().settingsSection).toBe('updates')
  })

  it('draws the version, the last check and the status word the rule gives every state', async () => {
    for (const state of UPDATE_STATES) {
      const errorCode = state === 'error' ? UPDATES_DOWNLOAD_FAILED : null
      stubSettings(statusState({ state, errorCode, availableVersion: state === 'available' ? '1.3.0' : null }))
      renderSettings()
      await openUpdates()

      // The line is the rule's own answer for this state, not a second copy of the words: the comparison
      // is against `updateStatusWord`, so a component that restated them would have to be right twice.
      expect(slot('updates-status').textContent).toBe(updateStatusWord(state, errorCode))
      // Beside it, the build the updater is speaking for, and the part of the mirror the store starts with.
      expect(slot('updates-version').textContent).toContain('1.2.0')

      cleanup()
    }
  })

  it('says when the last check was, and says a build that has never checked as such', async () => {
    const checkedAt = Date.now() - 2 * HOUR
    const { stub } = stubSettings(statusState({ state: 'up-to-date', lastCheckedAt: checkedAt }))
    renderSettings()
    await openUpdates()

    // Two hours is past the formatter's minute threshold, so the line is its own coarse reading rather
    // than a timestamp: the section shows what `formatRelativeTime` says, and a launch that just checked
    // is not a different sentence from one that checked a moment ago.
    expect(slot('updates-last-checked').textContent).toContain('2h ago')

    // Nothing has checked in this process: `null` is not epoch zero, and the line says the absence rather
    // than inventing a date.
    pushStatus(stub, statusState({ state: 'idle', lastCheckedAt: null }))
    await waitFor(() => expect(slot('updates-last-checked').textContent).toMatch(/never/i))
  })

  it('persists the auto-download preference, and the download offer follows it', async () => {
    const { stub, preferences } = stubSettings(statusState({ state: 'available', availableVersion: '1.3.0' }))
    renderSettings()
    await openUpdates()

    // On by default, and with it on there is nothing to offer: the updater is already fetching the update,
    // which is what `canDownload` says. Both readings come from the rule rather than from this file.
    const toggle = await screen.findByRole('switch', { name: 'Download updates automatically' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(maybeSlot('updates-download')).toBeNull()

    await userEvent.click(toggle)

    await waitFor(() => expect(preferences.state().autoDownload).toBe(false))
    expect(lastPayload(stub, 'update-preferences', 'setAutoDownload')).toEqual({ autoDownload: false })
    // The switch drew from the store, so it states the new value rather than its own copy of the old one.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    // And the manual half of the preference appears with it: the state is still `available` and the app is
    // no longer fetching the update by itself.
    await waitFor(() => expect(maybeSlot('updates-download')).not.toBeNull())
  })

  it('dispatches one check when it is asked for, and offers none while one is in flight', async () => {
    const { stub } = stubSettings(statusState({ state: 'up-to-date' }))
    renderSettings()
    await openUpdates()

    const check = await screen.findByRole('button', { name: 'Check for updates' })
    expect(isDisabled(check)).toBe(false)

    await userEvent.click(check)
    await waitFor(() => expect(updateMethods(stub)).toContain('check'))
    // Once, from one click: the button is not a schedule.
    expect(updateMethods(stub).filter((method) => method === 'check')).toHaveLength(1)

    // A check in flight offers no second one — the state says the work is already being done — and the
    // control is drawn disabled rather than absent, because the offer is what changed, not the surface.
    pushStatus(stub, statusState({ state: 'checking' }))
    await waitFor(() => expect(isDisabled(check)).toBe(true))

    await userEvent.click(check)
    expect(updateMethods(stub).filter((method) => method === 'check')).toHaveLength(1)
  })

  it('offers the install only when the rule does, and dispatches it', async () => {
    const { stub } = stubSettings(statusState({ state: 'ready', availableVersion: '1.3.0' }))
    renderSettings()
    await openUpdates()

    // Ready offers the install and nothing else: the bytes are here, so a download would be work already
    // done, and the check is drawn disabled rather than removed — the offer of a check is what the rule
    // withdrew (`canCheck` is false in this state), and the control stays where the user last saw it.
    expect(isDisabled(slot('updates-check'))).toBe(true)
    expect(maybeSlot('updates-download')).toBeNull()

    const install = await screen.findByRole('button', { name: 'Install and restart' })
    await userEvent.click(install)
    await waitFor(() => expect(updateMethods(stub)).toContain('install'))

    // The states either side of it offer no install: a state that is not ready has nothing to install.
    for (const state of ['available', 'downloading'] as const) {
      pushStatus(stub, statusState({ state, availableVersion: '1.3.0' }))
      await waitFor(() => expect(maybeSlot('updates-install')).toBeNull())
    }
  })

  it('says a failure in the rule’s words for its code, and never prints a message', async () => {
    const { stub } = stubSettings(statusState({ state: 'error', errorCode: UPDATES_DOWNLOAD_FAILED }))
    renderSettings()
    await openUpdates()

    // The code's own sentence, pinned as the words a person reads — and the same answer the rule gives,
    // which is what keeps the two from drifting apart.
    expect(slot('updates-status').textContent).toBe('Could not download the update')
    expect(slot('updates-status').textContent).toBe(updateStatusWord('error', UPDATES_DOWNLOAD_FAILED))

    // A refusal of the build rather than of the network has its own words, and they are not the same ones.
    pushStatus(stub, statusState({ state: 'error', errorCode: UPDATES_DISABLED_IN_DEV }))
    await waitFor(() => expect(slot('updates-status').textContent).toBe('Updates are off in this build'))

    // The sentence main's Error carried is not a code, so it is not a word: a value outside the declared
    // set falls back to the state's own word rather than being printed. The string below is the one
    // electron-updater raises for a lost connection — the shape of text that must never reach a status line.
    const message = 'Error: connect ECONNREFUSED 140.82.121.6:443 at https://api.github.com/…'
    pushStatus(stub, { ...statusState({ state: 'error' }), errorCode: message } as unknown as UpdateStatusState)
    await waitFor(() => expect(slot('updates-status').textContent).toBe('Update failed'))
    expect(document.body.textContent).not.toContain('ECONNREFUSED')
    expect(document.body.textContent).not.toContain('api.github.com')
  })
})

/** The last payload sent to one store's action, or undefined when it was never called. */
function lastPayload(stub: BridgeStub, storeId: string, method: string): unknown {
  const asked = stub.calls
    .filter((call) => call.channel === `conveyor:store:${storeId}` && call.method === method)
    .at(-1)
  return (asked?.args[0] as { payload?: unknown } | undefined)?.payload
}
