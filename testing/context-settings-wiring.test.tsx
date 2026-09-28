import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { providerConfigStore, type ProviderConfigState } from '@/conveyor/stores/provider-config'
import { contextPreferencesStore, type ContextPreferencesState } from '@/conveyor/stores/context-preferences'
import {
  CONTEXT_WINDOWS,
  DEFAULT_COMPACT_PERCENT,
  MAX_COMPACT_PERCENT,
  MIN_COMPACT_PERCENT,
  resolveWindow,
} from '@/conveyor/protocol/context-window'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Context settings section and the window field on a model's row: wiring, not pixels.
 *
 * Two surfaces, one file, because they are one story to a reader: the card in the Overview says how
 * much of a window a conversation is about to spend, the section sets the point it is measured against,
 * and the model row is where a window the shipped table has never heard of is declared. What is asserted
 * here is that each of the three reaches the store that owns it — the field writes the preference main
 * reads, the row writes the window `resolveWindow` prefers, and the numbers behind both arrive from the
 * Turn 1 rules rather than from a second copy written in a component.
 *
 * The stores main owns are simulated rather than faked: each `fakeMain` applies the definition's own
 * reducer to its own copy and pushes the result down the changed channel the mirror listens on. So a
 * persisted percent is a claim about the store the app ships, and `resolveWindow` is read over the map
 * main actually holds rather than over a local variable the test kept in step by hand.
 *
 * Residual, named rather than claimed: jsdom lays nothing out. That the card, the field and the row read
 * as one surface at the widths the app draws them is Boss's eyes on a live turn.
 */

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]

const CHAT = 'deepseek-chat'
/** A model beside it in the same catalogue, so a declaration can be shown to belong to one model only. */
const REASONER = 'deepseek-reasoner'
/** A model the shipped table has never heard of: a gateway's own name, which is what the field is for. */
const HOUSE = 'house-model'

/** The fetched catalogue, as the provider's box draws it once Fetch has answered. */
const CATALOGUE: ProviderConfigState = {
  providers: {
    deepseek: {
      fetchedModels: [{ id: CHAT }, { id: REASONER }, { id: HOUSE }],
      enabledModels: [],
    },
  },
  customProviders: [],
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

/** The provider-config store's actions, as the payload-agnostic loop above has to see them. */
const PROVIDER_ACTIONS = providerConfigStore.actions as unknown as Record<
  string,
  (draft: ProviderConfigState, input: unknown) => void
>

/** The context-preferences store's one action, read the same way. */
const CONTEXT_ACTIONS = contextPreferencesStore.actions as unknown as Record<
  string,
  (draft: ContextPreferencesState, input: unknown) => void
>

/** Settings over one catalogue and one stored preference, with both stores owned by a stand-in main. */
function stubSettings(catalogue: ProviderConfigState = CATALOGUE, compactPoint = DEFAULT_COMPACT_PERCENT) {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    fetchModels: () => [],
  })
  const providers = fakeMain<ProviderConfigState>(stub, 'provider-config', PROVIDER_ACTIONS, catalogue)
  const preferences = fakeMain<ContextPreferencesState>(stub, 'context-preferences', CONTEXT_ACTIONS, {
    compactPoint,
  })
  setActiveStub(stub)
  return { stub, providers, preferences }
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

/** Every provider box on screen, in the order the list reads them. */
function boxes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="provider-box"]')]
}

/** One box, by the kind it is and the provider it belongs to. */
function boxFor(container: HTMLElement, name: string): HTMLElement {
  const found = boxes(container).find((box) => box.textContent?.includes(name) === true)
  if (!found) throw new Error(`no box for ${name}`)
  return found
}

/** One model's row, by the list it is in and the id it states. */
function modelRow(box: HTMLElement, providerName: string, modelId: string): HTMLElement {
  const list = within(box).getByRole('list', { name: `${providerName} models` })
  const row = [...list.querySelectorAll<HTMLElement>('li')].find((li) => within(li).queryByText(modelId) !== null)
  if (!row) throw new Error(`no row for ${modelId}`)
  return row
}

/** One model's window field, by the accessible name the field states. */
function windowField(row: HTMLElement, modelId: string): HTMLInputElement {
  return within(row).getByLabelText(`Context window for ${modelId}`) as HTMLInputElement
}

/** The calls the screen made on one store's channel, by action name. */
function storeMethods(stub: BridgeStub, storeId: string): string[] {
  return stub.calls.filter((call) => call.channel === `conveyor:store:${storeId}`).map((call) => call.method)
}

/** The last payload sent to one store's action, or undefined when it was never called. */
function lastPayload(stub: BridgeStub, storeId: string, method: string): unknown {
  const asked = stub.calls
    .filter((call) => call.channel === `conveyor:store:${storeId}` && call.method === method)
    .at(-1)
  return (asked?.args[0] as { payload?: unknown } | undefined)?.payload
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

describe('the Context settings section', () => {
  it('is a section of the shell, and draws the compact point its store holds', async () => {
    stubSettings(CATALOGUE, 80)
    renderSettings()

    // Reached the way a reader reaches it, from the row the shell draws: the section is registered there
    // rather than only in the panel below it.
    await userEvent.click(await screen.findByRole('tab', { name: 'Context' }))

    expect(section('settings-section-context')).not.toBeNull()
    expect(section('settings-section-providers')).toBeNull()
    expect(within(sectionRow()).getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Context' })).toBeTruthy()

    // The stored percent, in the field, as the string a person would type.
    const field = (await screen.findByLabelText('Compact point')) as HTMLInputElement
    expect(field.value).toBe('80')
  })

  it('writes the compact point through the store, and refuses a percent outside its bounds', async () => {
    const { stub, preferences } = stubSettings()
    renderSettings()

    await userEvent.click(await screen.findByRole('tab', { name: 'Context' }))
    const field = (await screen.findByLabelText('Compact point')) as HTMLInputElement

    // Typed rather than set, so the field sees real edits and the store sees the write the last one
    // settles on. 75 is inside the bounds and is therefore persisted.
    await userEvent.clear(field)
    await userEvent.type(field, '75')

    await waitFor(() => expect(storeMethods(stub, 'context-preferences')).toContain('setCompactPoint'))
    expect(lastPayload(stub, 'context-preferences', 'setCompactPoint')).toEqual({ percent: 75 })
    expect(preferences.state().compactPoint).toBe(75)

    // Below the floor: the field says so under itself, and nothing is written — the app is not told about
    // a percent it would have had to walk back.
    const writes = storeMethods(stub, 'context-preferences').length
    await userEvent.clear(field)
    await userEvent.type(field, '40')

    const error = document.querySelector<HTMLElement>('[data-slot="context-compact-point-error"]')
    expect(error?.textContent).toBe(`Enter a whole number between ${MIN_COMPACT_PERCENT} and ${MAX_COMPACT_PERCENT}.`)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(storeMethods(stub, 'context-preferences').length).toBe(writes)
    expect(preferences.state().compactPoint).toBe(75)

    // And a percent is a whole number someone typed: a letter is refused in words rather than swallowed.
    await userEvent.clear(field)
    await userEvent.type(field, 'x')
    expect(document.querySelector<HTMLElement>('[data-slot="context-compact-point-error"]')?.textContent).toBe(
      'Enter a whole number of percent.'
    )
    expect(preferences.state().compactPoint).toBe(75)
  })
})

describe("a model row's context window", () => {
  /** Open a box's model list, which is where the field lives. */
  async function openModels(box: HTMLElement): Promise<void> {
    await userEvent.click(within(box).getByRole('button', { name: 'Show DeepSeek models' }))
  }

  it('draws the built-in table behind a blank field, and nothing for a model the table never knew', async () => {
    stubSettings()
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'DeepSeek'))
    await openModels(deepseek)

    // A model the table prices: the field is empty because nobody declared a window for it, and the
    // number behind it is the table's own — the same number `resolveWindow` would place it against.
    const chat = modelRow(deepseek, 'DeepSeek', CHAT)
    expect(windowField(chat, CHAT).value).toBe('')
    expect(windowField(chat, CHAT).placeholder).toBe(String(CONTEXT_WINDOWS[CHAT]))

    // A model the table has never heard of, which is the case the field exists for: no number to show
    // behind it, so the placeholder says nothing rather than saying zero.
    const house = modelRow(deepseek, 'DeepSeek', HOUSE)
    expect(windowField(house, HOUSE).value).toBe('')
    expect(windowField(house, HOUSE).placeholder).toBe('')

    // Bounded in tokens: a window is a positive whole number, and the ceiling is a typo-catcher rather
    // than a policy — no shipped model's window is anywhere near it.
    expect(windowField(chat, CHAT).getAttribute('type')).toBe('number')
    expect(Number(windowField(chat, CHAT).getAttribute('min'))).toBeGreaterThan(0)
    expect(Number(windowField(chat, CHAT).getAttribute('max'))).toBeGreaterThan(CONTEXT_WINDOWS[CHAT])
  })

  it('persists a typed window and feeds it to the resolution for that model alone', async () => {
    const { stub, providers } = stubSettings()
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'DeepSeek'))
    await openModels(deepseek)
    const chat = modelRow(deepseek, 'DeepSeek', CHAT)

    // A smaller window than the table's, which is what a gateway with a trimmed context would be: the
    // declaration has to win over the shipped number, or the field would be decorative.
    await userEvent.type(windowField(chat, CHAT), '32000')

    await waitFor(() => expect(storeMethods(stub, 'provider-config')).toContain('setModelWindows'))
    // The settled write is the last one: the field commits as it is typed into, so the keystrokes before
    // it wrote the states the user passed through.
    expect(lastPayload(stub, 'provider-config', 'setModelWindows')).toEqual({
      providerId: 'deepseek',
      modelId: CHAT,
      window: 32_000,
    })

    // Read back over the map main actually holds, which is the claim: the row's number is the number the
    // resolution prefers for this model...
    const declared = providers.state().providers.deepseek.modelWindows
    expect(resolveWindow({ model: CHAT, modelWindows: declared })).toBe(32_000)

    // ...and for the model beside it in the same catalogue the table still answers, because a window
    // belongs to the model that enforces it.
    expect(resolveWindow({ model: REASONER, modelWindows: declared })).toBe(CONTEXT_WINDOWS[REASONER])

    // Blank means the table: clearing the field takes the declaration off rather than storing a zero.
    await userEvent.clear(windowField(chat, CHAT))
    await waitFor(() =>
      expect(resolveWindow({ model: CHAT, modelWindows: providers.state().providers.deepseek.modelWindows })).toBe(
        CONTEXT_WINDOWS[CHAT]
      )
    )
    expect(lastPayload(stub, 'provider-config', 'setModelWindows')).toEqual({
      providerId: 'deepseek',
      modelId: CHAT,
      window: undefined,
    })
  })
})
