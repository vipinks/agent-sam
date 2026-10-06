/**
 * The Engines section of Settings, as wiring.
 *
 * The claims only a rendered screen can make: that the rail grew a ninth entry with Engines last and that
 * `openSettingsAt` lands on it, that the section draws one row per engine config with the detected version
 * its probe published — the same probe the chat header's picker reads, not a second detection path — the
 * one-line auth hint, a binary path override, and a permission mode control starting on the default.
 *
 * Main is simulated rather than faked, in the shape the Appearance and Terminal suites established:
 * `fakeMain` holds the store's state, applies each action through the store's own reducer and pushes the
 * result down the changed channel, so a write made in the section reaches a reader the way it does in the
 * app — through main. The save itself is the one thing this file stubs as a *behaviour*: it is a command
 * whose body probes a process, and the probe is the node suite's (`tests/engines/engine-preferences-test.ts`).
 * What is asserted here is therefore the wiring around it — that a sanctioned path is what the store ends up
 * holding, and that a refused one renders the code's own word and leaves the last good value alone.
 *
 * The mode control is asserted twice, deliberately: once against the store, which is what persists the
 * choice, and once against `engineLaunchArgs` — the pure rule the turn is started with — so a control that
 * wrote a mode no flag carries would fail here rather than in a live turn nobody can see.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the section reads well in either theme, or
 * that a chosen mode is honoured by a live engine: the acceptance is Boss's eyes on the section and a real
 * turn under each mode.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import {
  ENGINE_AUTH_HINTS,
  ENGINE_DEFAULT_PERMISSION_MODE,
  ENGINE_LABELS,
  ENGINE_NOT_INSTALLED_NOTE,
  ENGINE_PERMISSION_MODE_IDS,
  ENGINE_PERMISSION_MODE_LABELS,
  ENGINE_PERMISSION_MODE_WARNINGS,
  ENGINE_SPAWN_CODES,
  engineLaunchArgs,
  enginePathRefusalWord,
  enginePreference,
  engineRows,
  type EnginePermissionMode,
} from '@/conveyor/protocol/engine'
import { enginePreferencesStore, type EnginePreferencesState } from '@/conveyor/stores/engine-preferences'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/** The engine this phase draws a row for, named rather than indexed, so a rename fails here loudly. */
const CODEX = 'codex'

/** The store's id, as `defineStore('engine-preferences', ...)` declares it. */
const PREFERENCES_STORE_ID = 'engine-preferences'

/** The version a probe on this machine answered, so the assertion is a real string. */
const PROBED_VERSION = '0.154.0-alpha.6.2'

/** Where the user says this machine keeps the binary. */
const OVERRIDE = 'D:/tools/codex/codex.exe'

/** The path a previous save left behind, which a refused save must not take away. */
const LAST_GOOD = 'C:/Program Files/codex/codex.exe'

/** The state a launch starts from, read off the definition rather than written out here. */
const INITIAL_STATE = structuredClone(
  (enginePreferencesStore as unknown as { initialState: EnginePreferencesState }).initialState
)

/** Every section the rail lists, in order, with the one this phase added last. */
const RAIL_ENTRIES = [
  'Providers',
  'MCP Servers',
  'Skills',
  'Terminal',
  'Context',
  'Appearance',
  'Buddies',
  'Updates',
  'Engines',
]

/**
 * Main's half of the engine-preferences store.
 *
 * The reducer is the definition's own, so a payload this suite asserts on is a payload the shipped store
 * accepts; the broadcast is the route main actually takes, which is the only one that reaches a mirror
 * another case in this file already cached.
 */
function fakeMain(
  stub: BridgeStub,
  initial: EnginePreferencesState
): { state: () => EnginePreferencesState; apply: (reduce: (draft: EnginePreferencesState) => void) => void } {
  let state = structuredClone(initial)
  stubStore(stub, PREFERENCES_STORE_ID, state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${PREFERENCES_STORE_ID}` && method in enginePreferencesStore.actions) {
      // Recorded here rather than by the transport: this loop answers the action itself instead of
      // forwarding it, so without this the call the screen made would leave no trace to assert on.
      stub.calls.push({ channel, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      const reduce = enginePreferencesStore.actions[
        method as keyof typeof enginePreferencesStore.actions
      ] as unknown as (draft: EnginePreferencesState, input: unknown) => void
      reduce(next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel(`conveyor:store:${PREFERENCES_STORE_ID}:changed`, structuredClone(state)))
      return state
    }
    return invoke(channel, method, ...args)
  }

  return {
    state: () => state,
    /**
     * Main writing through the store's own action, then broadcasting it.
     *
     * Pushed inside `act` because this is a store *change* rather than a reply to a call: the section reads
     * the mirrored state back on the render the push causes, and a push outside `act` would land after the
     * assertion that is waiting for it.
     */
    apply: (reduce) => {
      const next = structuredClone(state)
      reduce(next)
      state = next
      void act(() => {
        stub.pushToChannel(`conveyor:store:${PREFERENCES_STORE_ID}:changed`, structuredClone(state))
      })
    },
  }
}

/**
 * What main's own save does with the path a user stated: the probe gates it.
 *
 * The verdict is this suite's, because the probe is a process and this file runs in jsdom — the real one is
 * driven in the node suite against a scripted spawn. What is asserted here is the section's half of the
 * contract: a sanctioned path is what the store ends up holding, and a refused one renders the code's own
 * word and writes nothing at all.
 */
function stubPathSave(
  stub: BridgeStub,
  main: ReturnType<typeof fakeMain>,
  verdict: (path: string) => { ok: true } | { ok: false; code: string }
): void {
  stub.on('setBinaryPath', async (input) => {
    const { engineId, path } = input as { engineId: string; path: string }
    const stated = path.trim()

    // A cleared field is the allowlist answering again: absence is written through the same action, so the
    // stored override cannot outlive the field that named it.
    if (stated === '') {
      main.apply((draft) => enginePreferencesStore.actions.clearBinaryPath(draft, { engineId }))
      return undefined
    }

    const probed = verdict(stated)
    if (!probed.ok) throw new ConveyorError(probed.code, 'The engine path was not saved.')
    main.apply((draft) => enginePreferencesStore.actions.recordBinaryPath(draft, { engineId, path: stated }))
    return undefined
  })
}

/** The settings reads the shell makes for whichever section is showing. */
function settingsReads() {
  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }],
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
  }
}

/**
 * Install a bridge, with the rows a probe published and one preference state.
 *
 * The engine rows are seeded rather than stubbed as a call, because that is what they are in the app: a fact
 * main published after probing, mirrored by every window. A root is opened because the shell reads the
 * workspace for the sections beside this one.
 */
function stubEngines(options: { detected?: boolean; state?: EnginePreferencesState } = {}): {
  stub: BridgeStub
  main: ReturnType<typeof fakeMain>
} {
  const probe =
    options.detected === false
      ? { installed: false, code: ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED }
      : { installed: true, version: PROBED_VERSION }
  const stub = createBridgeStub(settingsReads())
  const main = fakeMain(stub, options.state ?? INITIAL_STATE)
  stubStore(stub, 'engine-status', { rows: engineRows({ [CODEX]: probe }) })
  stubStore(stub, 'workspace', { rootPath: 'C:/w', recentRoots: [] })
  stubPathSave(stub, main, () => ({ ok: true }))
  setActiveStub(stub)
  return { stub, main }
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

/** The Engines panel, or a failure — every case below is about what is inside it. */
function enginesSection(): HTMLElement {
  const panel = section('settings-section-engines')
  if (!panel) throw new Error('the Engines section is not showing')
  return panel
}

/** One marked node inside the section, by its slot. */
function slot(name: string): HTMLElement {
  const node = enginesSection().querySelector<HTMLElement>(`[data-slot="${name}"]`)
  if (!node) throw new Error(`the section draws no ${name}`)
  return node
}

/** A marked node inside the section, or null while the rules draw it not at all. */
function maybeSlot(name: string): HTMLElement | null {
  return enginesSection().querySelector<HTMLElement>(`[data-slot="${name}"]`)
}

/** The binary path field, by the engine it belongs to. */
function pathField(): HTMLElement {
  return screen.getByLabelText(`${ENGINE_LABELS[CODEX]} binary path`)
}

/** The permission mode control, by the engine it belongs to. */
function modeControl(): HTMLElement {
  return screen.getByRole('combobox', { name: `${ENGINE_LABELS[CODEX]} permission mode` })
}

/** Open a Select from the keyboard, the one path Radix routes without consulting the pointer. */
async function open(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/** The methods the section called on the preferences store, in order. */
function storeMethods(stub: BridgeStub): string[] {
  return stub.calls
    .filter((call) => call.channel === `conveyor:store:${PREFERENCES_STORE_ID}`)
    .map((call) => call.method)
}

/** One recorded call's payload, as main receives it. */
function payloadOf(stub: BridgeStub, module: string, method: string): Record<string, unknown> {
  const call = stub.callsTo(module).find((entry) => entry.method === method)
  if (!call) throw new Error(`no ${module}.${method} call was made`)
  return (call.args[0] ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's, and the store is module-level: a case that left the screen on
  // another section would otherwise decide the next one's first render.
  useWorkbenchStore.setState({
    activeActivity: 'settings',
    settingsReturnView: null,
    settingsSection: 'providers',
  })
})

describe('the Engines settings section', () => {
  it('is the ninth entry in the rail, last, and openSettingsAt lands on the section', async () => {
    stubEngines()
    renderSettings()

    // The whole set, in order, with Engines after the updater's own screen: a rail that grew a section in
    // the middle would be a different navigation from the one the design names.
    const entries = within(sectionRow()).getAllByRole('tab')
    expect(entries.map((entry) => entry.textContent)).toEqual(RAIL_ENTRIES)
    expect(entries).toHaveLength(9)
    expect(entries[entries.length - 1].textContent).toBe('Engines')

    // A launch opens Providers, and the section a deep link lands on is the one it names.
    expect(section('settings-section-engines')).toBeNull()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))

    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())
    expect(useWorkbenchStore.getState().settingsSection).toBe('engines')
    expect(screen.getByRole('tab', { name: 'Engines' }).getAttribute('aria-selected')).toBe('true')
    expect(enginesSection().querySelector('h1')?.textContent).toBe('Engines')
  })

  it('draws one row per engine, with the detected version, the auth hint, a path field and the default mode', async () => {
    stubEngines()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())

    // One row per allowlisted engine, and the config this phase has: Codex.
    expect(enginesSection().querySelectorAll('[data-slot="engine-row"]')).toHaveLength(1)
    expect(slot('engine-name').textContent).toBe(ENGINE_LABELS[CODEX])
    // The version is the probe's own answer — the same rows the chat header's picker draws, not a second
    // detection path and not a value this section invented.
    expect(slot('engine-status').textContent).toBe(PROBED_VERSION)
    expect(slot('engine-auth-hint').textContent).toBe(ENGINE_AUTH_HINTS[CODEX])

    // Nothing is overridden yet, so the field is empty and the mode is the shipped one.
    expect((pathField() as HTMLInputElement).value).toBe('')
    expect(modeControl().textContent).toContain(ENGINE_PERMISSION_MODE_LABELS[ENGINE_DEFAULT_PERMISSION_MODE])
    // And the default grants nothing to warn about, so no warning is drawn for it.
    expect(maybeSlot('engine-mode-warning')).toBeNull()
  })

  it('draws an engine the probe could not find as not installed rather than dropping the row', async () => {
    stubEngines({ detected: false })
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())

    // The row is still there, still named, and says which of the two things a reader is looking at: an
    // engine that is not on this machine rather than an engine this app has no config for.
    expect(enginesSection().querySelectorAll('[data-slot="engine-row"]')).toHaveLength(1)
    expect(slot('engine-name').textContent).toBe(ENGINE_LABELS[CODEX])
    expect(slot('engine-status').textContent).toBe(ENGINE_NOT_INSTALLED_NOTE)
    // The override is still offered: "not installed" is the answer to `PATH` and the vendor install, and the
    // field is exactly how a machine whose binary is elsewhere gets one.
    expect((pathField() as HTMLInputElement).value).toBe('')
  })

  it('persists a path override through the store, and main re-probes the path it was handed', async () => {
    const { stub, main } = stubEngines()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())

    await userEvent.type(pathField(), OVERRIDE)
    await userEvent.click(screen.getByRole('button', { name: `${ENGINE_LABELS[CODEX]} save binary path` }))

    // The write is a command rather than a store action, and that is the whole point of it: the save *is*
    // the re-probe, so it happens in main, where a process may be started and the allowlist may judge the
    // file the path names.
    await waitFor(() => expect(main.state().engines[CODEX]?.binaryPath).toBe(OVERRIDE))
    expect(payloadOf(stub, 'engine', 'setBinaryPath')).toEqual({ engineId: CODEX, path: OVERRIDE })
    // Persisted beside the mode, and a path save leaves the mode alone. Read through the preference rather
    // than off the raw record: the store holds only what a user set, and the shipped default is what the
    // reader fills in — that is the whole reason the two are separate.
    expect(enginePreference(main.state().engines[CODEX], CODEX).permissionMode).toBe(ENGINE_DEFAULT_PERMISSION_MODE)

    // Clearing the field puts the allowlist back in charge, through the same command: an absent override is
    // the resolution this app had before the field existed.
    await userEvent.clear(pathField())
    await userEvent.click(screen.getByRole('button', { name: `${ENGINE_LABELS[CODEX]} save binary path` }))
    await waitFor(() => expect(main.state().engines[CODEX]?.binaryPath).toBeNull())
  })

  it('renders the code’s word when the probe refuses a path, and keeps the last good value', async () => {
    const withLastGood: EnginePreferencesState = {
      engines: { [CODEX]: { binaryPath: LAST_GOOD, permissionMode: ENGINE_DEFAULT_PERMISSION_MODE } },
    }
    const { stub, main } = stubEngines({ state: withLastGood })
    stubPathSave(stub, main, () => ({ ok: false, code: ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED }))
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())

    // The field opens on what is stored, so the last good value is what a reader sees before touching it.
    expect((pathField() as HTMLInputElement).value).toBe(LAST_GOOD)

    await userEvent.clear(pathField())
    await userEvent.type(pathField(), OVERRIDE)
    await userEvent.click(screen.getByRole('button', { name: `${ENGINE_LABELS[CODEX]} save binary path` }))

    // The word is the code's own, out of the one mapping that turns a refusal into something a reader can
    // act on — so a refused path is said out loud rather than silently discarded.
    await waitFor(() =>
      expect(maybeSlot('engine-path-refusal')?.textContent).toBe(
        enginePathRefusalWord(ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED)
      )
    )
    // And the refusal wrote nothing: the store still holds the path that worked, and the field is back on
    // it, so a bad save costs the user nothing but the sentence.
    expect(main.state().engines[CODEX]?.binaryPath).toBe(LAST_GOOD)
    expect((pathField() as HTMLInputElement).value).toBe(LAST_GOOD)
  })

  it('warns when the chosen mode grants full access, and the args a turn is started with carry it', async () => {
    const { stub, main } = stubEngines()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(section('settings-section-engines')).not.toBeNull())

    await open(modeControl())
    // Every traced sandbox value is offered, in the order the protocol declares them, and nothing else.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
      ENGINE_PERMISSION_MODE_IDS.map((id) => ENGINE_PERMISSION_MODE_LABELS[id])
    )

    await userEvent.click(screen.getByRole('option', { name: ENGINE_PERMISSION_MODE_LABELS['danger-full-access'] }))

    await waitFor(() => expect(main.state().engines[CODEX]?.permissionMode).toBe('danger-full-access'))
    // Written through the store the picker and the turn both read, as one payload naming the engine.
    expect(storeMethods(stub)).toContain('setPermissionMode')
    const call = stub.calls.find((entry) => entry.method === 'setPermissionMode')
    expect((call?.args[0] as { payload?: unknown } | undefined)?.payload).toEqual({
      engineId: CODEX,
      mode: 'danger-full-access',
    })

    // Never silently: the mode that grants more than the default is warned about, in the section's own
    // words for it, and the warning is the protocol's rather than a second sentence written here.
    expect(maybeSlot('engine-mode-warning')?.textContent).toBe(ENGINE_PERMISSION_MODE_WARNINGS['danger-full-access'])
    // And the flag the spawned args carry is the chosen mode's: `engineLaunchArgs` is what a turn is
    // started with, so a control that wrote a mode no flag carries would fail here rather than in a live
    // turn nobody in this suite can see.
    const full = engineLaunchArgs(CODEX, 'danger-full-access')
    expect(full[full.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    expect(engineLaunchArgs(CODEX, main.state().engines[CODEX]?.permissionMode as EnginePermissionMode)).toContain(
      'danger-full-access'
    )

    // The stricter choice, on the same flag, and the warning goes away with it.
    await open(modeControl())
    await userEvent.click(screen.getByRole('option', { name: ENGINE_PERMISSION_MODE_LABELS['read-only'] }))
    await waitFor(() => expect(main.state().engines[CODEX]?.permissionMode).toBe('read-only'))
    expect(maybeSlot('engine-mode-warning')).toBeNull()
    const stricter = engineLaunchArgs(CODEX, 'read-only')
    expect(stricter[stricter.indexOf('--sandbox') + 1]).toBe('read-only')
  })
})
