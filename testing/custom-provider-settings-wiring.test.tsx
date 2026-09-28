import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import {
  CUSTOM_PROVIDER_ONLY_CONTROLS,
  PROVIDER_BOX_CONTROLS,
  PROVIDER_BOX_CORE_CONTROLS,
} from '@/app/components/workbench/provider-box'
import { providerConfigStore, type ProviderConfigState } from '@/conveyor/stores/provider-config'
import { declaredRates, resolveRates } from '@/conveyor/protocol/session-usage'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Settings, as wiring: what the custom-provider boxes and the add-provider dialog reach.
 *
 * The rules these flows apply — which draft is acceptable, how an id is derived — are
 * `custom-provider-rules.test.ts`'s, and their main-side outcome is the node suite's. What can only be
 * seen here is the screen: that the button after the predefined boxes opens the dialog, that a refusal
 * lands on the field it belongs to and adds nothing, that a save appends a box which carries the same
 * controls a predefined box carries plus exactly two of its own, that a fetch fills the box's list or
 * says why in words its code chose, and that a delete asks first and then leaves the persisted list
 * without the provider.
 *
 * The store main owns is simulated, not faked: `fakeMain` applies the real reducer from
 * `conveyor/stores/provider-config` to its own copy of the state and pushes the result down the changed
 * channel, which is the route the mirror actually listens on. So the box that appears after a save is
 * the box main's answer makes appear, and the payload a delete sends is the one main would receive.
 */

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

/** A provider the user adds: a server on this machine, which is the ordinary case for the feature. */
const LLAMA = {
  id: 'local-llama',
  name: 'Local Llama',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: ['llama-3.1-8b', 'qwen2.5-coder-7b'],
}

const EMPTY_STATE: ProviderConfigState = { providers: {}, customProviders: [] }

/** The seeded catalogue, so a box that has fetched something has something to show. */
const POPULATED_STATE: ProviderConfigState = {
  providers: {
    deepseek: { fetchedModels: [{ id: 'deepseek-chat' }], enabledModels: ['deepseek-chat'] },
    [LLAMA.id]: { fetchedModels: [], enabledModels: [LLAMA.models[0]] },
  },
  customProviders: [LLAMA],
}

/**
 * The main process's half of the provider-config store.
 *
 * A cross-window store is owned by main: the renderer's action call travels to the store channel and
 * the mirror changes only when the result is broadcast. This applies that reducer to its own copy and
 * pushes the result down the changed channel, so a test can assert both what was asked for and what the
 * screen does once main has answered.
 */
function fakeMain(stub: BridgeStub, initial: ProviderConfigState): { state: () => ProviderConfigState } {
  let state = structuredClone(initial)
  stubStore(stub, 'provider-config', state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === 'conveyor:store:provider-config' && method in providerConfigStore.actions) {
      // Recorded here rather than by the transport: this loop answers the action itself instead of
      // forwarding it, so without this the call the screen made would leave no trace to assert on.
      stub.calls.push({ channel, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      // The definition's own reducer, cast for the call: each action's payload type comes from its
      // schema, and this loop is deliberately payload-agnostic.
      const reduce = providerConfigStore.actions[method as keyof typeof providerConfigStore.actions] as unknown as (
        draft: ProviderConfigState,
        input: unknown
      ) => void
      reduce(next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel('conveyor:store:provider-config:changed', structuredClone(state)))
      return state
    }
    return invoke(channel, method, ...args)
  }

  return { state: () => state }
}

/** Install a bridge whose settings answers are the ones this suite describes. */
function stubSettings(
  overrides: Record<string, (input: unknown) => unknown> = {},
  store: ProviderConfigState = EMPTY_STATE
): { stub: BridgeStub; main: { state: () => ProviderConfigState } } {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    saveApiKey: (input) => ({ providerId: (input as { providerId: string }).providerId }),
    clearApiKey: () => undefined,
    fetchModels: () => [],
    listModels: () => LLAMA.models,
    ...overrides,
  })
  const main = fakeMain(stub, store)
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

/** Every provider box on screen, in the order the list reads them. */
function boxes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="provider-box"]')]
}

/** One box, by the kind it is and the provider it belongs to. */
function boxFor(container: HTMLElement, kind: 'predefined' | 'custom', name: string): HTMLElement {
  const found = boxes(container).find(
    (box) => box.dataset.providerKind === kind && box.textContent?.includes(name) === true
  )
  if (!found) throw new Error(`no ${kind} box for ${name}`)
  return found
}

/** Whether a box renders a control, by the shared slot the control carries. */
function hasControl(box: HTMLElement, slot: string): boolean {
  return box.querySelector(`[data-slot="${slot}"]`) !== null
}

/** Every slot a box renders in its own subtree, in document order. */
function slotsOf(box: HTMLElement): string[] {
  return [...box.querySelectorAll<HTMLElement>('[data-slot]')].map((node) => node.dataset.slot as string)
}

/**
 * What the screen asked of the store main owns, in order.
 *
 * Read off the store's own channel rather than through `callsTo`, which splits on the first colon and
 * would file these under `store:provider-config`.
 */
function storeMethods(stub: BridgeStub): string[] {
  return stub.calls.filter((call) => call.channel === 'conveyor:store:provider-config').map((call) => call.method)
}

/** The dialog's own field, by the label it states. */
async function field(label: string): Promise<HTMLElement> {
  return await screen.findByLabelText(label)
}

/** Fill the add-provider form and save it. Each field is typed, not set, so the form sees real edits. */
async function fillAndSave(fields: { name?: string; url?: string; key?: string }): Promise<void> {
  if (fields.name !== undefined) await userEvent.type(await field('Provider name'), fields.name)
  if (fields.key !== undefined) await userEvent.type(await field('API key'), fields.key)
  if (fields.url !== undefined) await userEvent.type(await field('API URL'), fields.url)
  await userEvent.click(screen.getByRole('button', { name: 'Save provider' }))
}

/** The add-provider button, which the brief places after the predefined boxes. */
async function addProviderButton(): Promise<HTMLElement> {
  return await screen.findByRole('button', { name: '+ Add Provider' })
}

beforeEach(() => {
  localStorage.clear()
})

describe('the add-provider dialog', () => {
  it('opens from the button that follows the predefined boxes', async () => {
    stubSettings()
    const { container } = renderSettings()

    const button = await addProviderButton()
    // The predefined boxes are a query's answer, so their number is the fact that says the list is up.
    await waitFor(() => expect(boxes(container)).toHaveLength(2))
    const listed = [
      ...container.querySelectorAll<HTMLElement>('[data-slot="provider-box"], [data-slot="add-provider"]'),
    ]
    // After them, not among them: the button is the list's next row, so DOM order answers for position.
    expect(listed.map((node) => node.dataset.slot)).toEqual(['provider-box', 'provider-box', 'add-provider'])

    await userEvent.click(button)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByLabelText('Provider name')).toBeTruthy()
    expect(within(dialog).getByLabelText('API key')).toBeTruthy()
    expect(within(dialog).getByLabelText('API URL')).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('masks the key until the reveal toggle is used', async () => {
    stubSettings()
    renderSettings()

    await userEvent.click(await addProviderButton())

    const key = await field('API key')
    expect(key.getAttribute('type')).toBe('password')

    await userEvent.click(screen.getByRole('button', { name: 'Show API key' }))
    expect((await field('API key')).getAttribute('type')).toBe('text')

    await userEvent.click(screen.getByRole('button', { name: 'Hide API key' }))
    expect((await field('API key')).getAttribute('type')).toBe('password')
  })

  it('refuses a blank name on the field it belongs to, and adds nothing', async () => {
    const { stub, main } = stubSettings()
    renderSettings()

    await userEvent.click(await addProviderButton())
    await fillAndSave({ name: '   ', url: 'http://localhost:1234/v1' })

    const error = await screen.findByText('A name is required.')
    expect(error.dataset.slot).toBe('provider-name-error')
    // Still open, nothing added, and nothing asked of main: a refusal is local to the form.
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(main.state().customProviders).toEqual([])
    expect(storeMethods(stub)).not.toContain('addCustomProvider')
  })

  it('refuses a name already taken, and a URL that is not an http address', async () => {
    const { main } = stubSettings(undefined, { providers: {}, customProviders: [LLAMA] })
    renderSettings()

    await userEvent.click(await addProviderButton())
    await fillAndSave({ name: '  local llama ', url: 'http://localhost:9999/v1' })

    expect((await screen.findByText('A provider with this name already exists.')).dataset.slot).toBe(
      'provider-name-error'
    )
    expect(main.state().customProviders).toHaveLength(1)

    await userEvent.type(await field('Provider name'), 'Local Mistral')
    await userEvent.clear(await field('API URL'))
    await userEvent.type(await field('API URL'), 'localhost:1234')
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    const urlError = await screen.findByText('Enter an http(s) URL, like http://localhost:1234/v1.')
    expect(urlError.dataset.slot).toBe('provider-url-error')
    expect(main.state().customProviders).toHaveLength(1)
  })

  it('appends a valid provider as the last box, and closes', async () => {
    const { stub, main } = stubSettings()
    const { container } = renderSettings()

    await userEvent.click(await addProviderButton())
    await fillAndSave({ name: 'Local Llama', url: 'http://localhost:1234/v1/', key: 'sk-local' })

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // The list grew by one, on the end, and the trailing slash a user would type is gone.
    expect(main.state().customProviders).toEqual([{ ...LLAMA, models: [], baseUrl: 'http://localhost:1234/v1' }])
    const listed = boxes(container)
    expect(listed).toHaveLength(3)
    expect(listed[2].dataset.providerKind).toBe('custom')
    expect(listed[2].dataset.providerId).toBe(LLAMA.id)

    // The key went to main's key store under the id derived from the name — the renderer never keeps it.
    const saved = stub.callsTo('settings').find((call) => call.method === 'saveApiKey')
    expect(saved?.args[0]).toEqual({ providerId: LLAMA.id, apiKey: 'sk-local' })
  })
})

describe('the custom provider box', () => {
  it('renders the controls a predefined box renders, with exactly two of its own', async () => {
    // Both kinds hold a key here, so the two boxes are in the same state: parity is a claim about the
    // boxes, and comparing a configured box with an unconfigured one would only prove they differ.
    stubSettings({ listConfigured: () => ['deepseek', LLAMA.id] }, POPULATED_STATE)
    const { container } = renderSettings()

    await waitFor(() => expect(boxes(container)).toHaveLength(3))
    const predefined = boxFor(container, 'predefined', 'DeepSeek')
    const custom = boxFor(container, 'custom', 'Local Llama')

    // Control for control, through the shared sub-component's own slots: that is parity, asserted once
    // for the set rather than once per control.
    for (const slot of PROVIDER_BOX_CONTROLS) {
      expect(hasControl(predefined, slot), `the predefined box renders ${slot}`).toBe(true)
      expect(hasControl(custom, slot), `the custom box renders ${slot}`).toBe(true)
    }

    // And exactly two affordances the custom box has on its own: the fetch that asks the provider
    // itself, and the delete that removes it.
    const own = slotsOf(custom).filter(
      (slot) => slot.startsWith('provider-') && !(PROVIDER_BOX_CONTROLS as readonly string[]).includes(slot)
    )
    expect(own).toEqual([...CUSTOM_PROVIDER_ONLY_CONTROLS])
  })

  it('is a box like a predefined one even before it has fetched anything', async () => {
    stubSettings(undefined, { providers: {}, customProviders: [{ ...LLAMA, models: [] }] })
    const { container } = renderSettings()

    await waitFor(() => expect(boxes(container)).toHaveLength(3))
    const custom = boxFor(container, 'custom', 'Local Llama')

    // The core controls are there whatever the state: what a box is missing is its catalogue, not
    // its controls.
    for (const slot of PROVIDER_BOX_CORE_CONTROLS) {
      expect(hasControl(custom, slot), `the fresh custom box renders ${slot}`).toBe(true)
    }
  })

  it('fetches the models of the provider it names, and fills its list with them', async () => {
    const { stub, main } = stubSettings(undefined, { providers: {}, customProviders: [{ ...LLAMA, models: [] }] })
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Fetch models for Local Llama' }))

    // The URL and the id of the provider the box belongs to, and no key: main holds the one this
    // provider was saved with, and the renderer has never had it.
    const asked = stub.callsTo('provider').find((call) => call.method === 'listModels')
    await waitFor(() => expect(asked).toBeTruthy())
    expect(asked?.args[0]).toEqual({ baseUrl: LLAMA.baseUrl, apiKey: '', providerId: LLAMA.id })

    // Recorded against that provider, and shown: a fetch that filled nothing visible would be a
    // dead end.
    await waitFor(() => expect(main.state().customProviders[0].models).toEqual(LLAMA.models))
    expect(await screen.findByText(`${LLAMA.models.length} models available`)).toBeTruthy()
    for (const model of LLAMA.models) expect(await screen.findByText(model)).toBeTruthy()
  })

  it('says why a fetch failed in the words its code chose, never in main’s message', async () => {
    stubSettings(
      {
        listModels: () => {
          throw new ConveyorError('PROVIDER_UNREACHABLE', 'BANANA')
        },
      },
      { providers: {}, customProviders: [{ ...LLAMA, models: [] }] }
    )
    const { container, unmount } = renderSettings()

    const first = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(first).getByRole('button', { name: 'Fetch models for Local Llama' }))

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('could not be reached')
    // Branched on the code: the sentence main sent never reaches the screen.
    expect(notice.textContent).not.toContain('BANANA')
    unmount()

    stubSettings(
      {
        listModels: () => {
          throw new ConveyorError('PROVIDER_LIST_FAILED', 'BANANA', { status: 500 })
        },
      },
      { providers: {}, customProviders: [{ ...LLAMA, models: [] }] }
    )
    const second = renderSettings()
    const box = await waitFor(() => boxFor(second.container, 'custom', 'Local Llama'))
    await userEvent.click(within(box).getByRole('button', { name: 'Fetch models for Local Llama' }))

    const rejected = await screen.findByRole('status')
    expect(rejected.textContent).toContain('500')
    expect(rejected.textContent).not.toContain('BANANA')
    // A different code, a different sentence — which is the whole reason the code is what it branches on.
    expect(rejected.textContent).not.toEqual(notice.textContent)
  })

  it('asks before deleting, and the list that persists follows the answer', async () => {
    const { stub, main } = stubSettings(undefined, { providers: {}, customProviders: [LLAMA] })
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Delete Local Llama' }))

    // The question first, with the provider still there: a delete that removed on the way to asking
    // would be the very thing the confirm exists to prevent.
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Remove Local Llama?')).toBeTruthy()
    expect(storeMethods(stub)).not.toContain('removeCustomProvider')
    expect(main.state().customProviders).toHaveLength(1)

    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove provider' }))

    await waitFor(() => expect(main.state().customProviders).toEqual([]))
    expect(storeMethods(stub)).toContain('removeCustomProvider')
    await waitFor(() => expect(screen.queryByText('Local Llama')).toBeNull())
  })
})

describe('a rehydrated settings store', () => {
  it('renders the custom boxes again, after every predefined one', async () => {
    stubSettings(
      { listConfigured: () => [LLAMA.id] },
      { providers: {}, customProviders: [LLAMA, { ...LLAMA, id: 'second', name: 'Second Server' }] }
    )
    const { container } = renderSettings()

    await waitFor(() => expect(boxes(container)).toHaveLength(4))

    const kinds = boxes(container).map((box) => box.dataset.providerKind)
    expect(kinds).toEqual(['predefined', 'predefined', 'custom', 'custom'])
    // Order is the order they were added, which is what the list this state came from holds.
    const custom = boxes(container).filter((box) => box.dataset.providerKind === 'custom')
    expect(custom.map((box) => box.dataset.providerId)).toEqual([LLAMA.id, 'second'])
    expect(boxFor(container, 'custom', 'Second Server')).toBeTruthy()
  })
})

describe('the image-support switch', () => {
  it('is off for a provider nothing has been said about, and says what off means', async () => {
    stubSettings()
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    const toggle = within(deepseek).getByRole('switch', { name: /Image support/ })

    // Off, without carrying a value: a provider nobody has been asked about has no opinion rather than a
    // `false`, and the switch shows that as the off position because that is what the composer does with
    // it. The sentence beside it says which way off falls for the user.
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(within(deepseek).getByText(/refuses them until you do/i)).toBeTruthy()
  })

  it('records the declaration per provider, and clearing it takes the key back off', async () => {
    const { stub, main } = stubSettings()
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    const openai = boxFor(container, 'predefined', 'OpenAI')

    await userEvent.click(within(deepseek).getByRole('switch', { name: /Image support/ }))

    // The action is the store's own, addressed to the provider whose box it was: the setting is a
    // provider preference, so the id has to travel with it or one switch would configure them all.
    await waitFor(() => expect(storeMethods(stub)).toContain('setSupportsImages'))
    const asked = stub.calls.find((call) => call.method === 'setSupportsImages')
    expect((asked?.args[0] as { payload: unknown }).payload).toEqual({ providerId: 'deepseek', supported: true })
    // And the screen follows main's answer rather than the click: the box is reading the record.
    await waitFor(() =>
      expect(
        within(deepseek)
          .getByRole('switch', { name: /Image support/ })
          .getAttribute('aria-checked')
      ).toBe('true')
    )
    expect(
      within(openai)
        .getByRole('switch', { name: /Image support/ })
        .getAttribute('aria-checked')
    ).toBe('false')
    expect(main.state().providers.deepseek?.supportsImages).toBe(true)

    await userEvent.click(within(deepseek).getByRole('switch', { name: /Image support/ }))

    // Switched off means the key is gone rather than set to false: that is what the node suite asserts
    // about the record, and it is what an older build reading this file has to be handed.
    await waitFor(() => expect(main.state().providers.deepseek?.supportsImages).toBeUndefined())
    expect('supportsImages' in (main.state().providers.deepseek ?? {})).toBe(false)
  })

  it('reads as on for a provider that has already declared it', async () => {
    stubSettings(undefined, {
      providers: { deepseek: { enabledModels: [], fetchedModels: [], supportsImages: true } },
      customProviders: [],
    })
    const { container } = renderSettings()
    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    expect(
      within(deepseek)
        .getByRole('switch', { name: /Image support/ })
        .getAttribute('aria-checked')
    ).toBe('true')
    expect(within(deepseek).getByText(/can attach images while this provider is selected/i)).toBeTruthy()
  })
})

describe('the rate override fields', () => {
  /** The declared pair the seeded record holds: prices the shipped table does not agree with. */
  const DECLARED: ProviderConfigState = {
    providers: { deepseek: { enabledModels: [], fetchedModels: [], inputRate: 0.15, outputRate: 0.6 } },
    customProviders: [],
  }

  /** One of a box's two price fields, by the side of the declaration it holds. */
  function rateField(box: HTMLElement, side: 'Input' | 'Output'): HTMLInputElement {
    return within(box).getByLabelText(new RegExp(`^${side} price`, 'i')) as HTMLInputElement
  }

  it('renders one field per side in the unit the number is in, and empty for a provider nobody priced', async () => {
    stubSettings(undefined, DECLARED)
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    const openai = boxFor(container, 'predefined', 'OpenAI')

    // The declaration reads back the way it was typed, and the unit is on the field rather than only in
    // the documentation: a bare 0.6 beside a dollars-per-million table is a guess at which one it is.
    await waitFor(() => expect(rateField(deepseek, 'Input').value).toBe('0.15'))
    expect(rateField(deepseek, 'Output').value).toBe('0.6')
    expect(within(deepseek).getByText(/dollars per million tokens/i)).toBeTruthy()

    // Bounded, so the control refuses a negative price and a slipped decimal point at the field.
    const field = rateField(deepseek, 'Input')
    expect(field.getAttribute('type')).toBe('number')
    expect(field.getAttribute('min')).toBe('0')
    expect(Number(field.getAttribute('max'))).toBeGreaterThan(0)

    // And a provider nobody has priced shows empty fields rather than zeros: a zero is a price, and the
    // Overview would bill every token of it.
    expect(rateField(openai, 'Input').value).toBe('')
    expect(rateField(openai, 'Output').value).toBe('')
  })

  it('writes both sides to the provider whose box was edited, and clearing a field takes its key off', async () => {
    const { stub, main } = stubSettings(undefined, DECLARED)
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    const openai = boxFor(container, 'predefined', 'OpenAI')

    await userEvent.clear(rateField(deepseek, 'Input'))
    await userEvent.type(rateField(deepseek, 'Input'), '1.5')
    await userEvent.tab()

    // Addressed to one provider and carrying both sides: the pair is one declaration, so the field the
    // user did not touch travels with the one they did rather than being dropped by an edit next door.
    //
    // The settled write — the last one — rather than the first: the field commits as it is typed into, so
    // the keystrokes before the final one write the states the user passed through. What is asserted is
    // the declaration the box and the store have agreed on once the typing stopped, which is the state
    // every reader of the record sees.
    await waitFor(() => expect(storeMethods(stub)).toContain('setRates'))
    const asked = stub.calls.filter((call) => call.method === 'setRates').at(-1)
    expect((asked?.args[0] as { payload: unknown }).payload).toEqual({
      providerId: 'deepseek',
      input: 1.5,
      output: 0.6,
    })
    expect(main.state().providers.deepseek?.inputRate).toBe(1.5)
    expect(main.state().providers.deepseek?.outputRate).toBe(0.6)
    // The box a click did not touch, and the price it still does not carry.
    expect(main.state().providers.openai?.inputRate).toBeUndefined()
    expect(rateField(openai, 'Input').value).toBe('')

    // The record those fields wrote is the one the pricing rule reads, which is the point of the fields:
    // this provider's sessions are priced in micros at what was typed here, ahead of the shipped table.
    expect(
      resolveRates({ model: 'deepseek-chat', override: declaredRates(main.state().providers.deepseek ?? {}) })
    ).toEqual({ input: 1_500_000, output: 600_000 })

    await userEvent.clear(rateField(deepseek, 'Output'))
    await userEvent.tab()

    // Blanked means the key goes rather than becoming a zero: no price is declared for that side, so the
    // Overview draws an em dash for Cost instead of a confident bill priced at nothing.
    await waitFor(() => expect('outputRate' in (main.state().providers.deepseek ?? {})).toBe(false))
    expect(main.state().providers.deepseek?.inputRate).toBe(1.5)
  })
})
