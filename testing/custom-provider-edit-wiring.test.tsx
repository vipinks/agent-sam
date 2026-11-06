import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { providerConfigStore, type ProviderConfigState } from '@/conveyor/stores/provider-config'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'
import type { ProviderEditRejection } from '@/conveyor/protocol/custom-provider'

/**
 * Settings, as wiring: editing a custom provider in place — its name, and its base URL.
 *
 * The rules these flows apply — which draft is acceptable, how an id is derived, and what an edit is
 * allowed to write — are the protocol suites' and the node suite's. What can only be seen here is the
 * screen: that the URL is a visible row of its own between the header and the key row, that the name is
 * the affordance rather than a dialog, that a committed edit leaves the saved badge and the catalogue
 * count exactly where they were, that a new URL is asked for its catalogue with the provider's own id
 * and no credential, that a failed fetch clears the model sets and says why in its code's words, and
 * that delete is still its own confirmed act rather than something an edit swallowed.
 *
 * The store main owns is simulated, not faked: `fakeMain` applies the real reducer from
 * `conveyor/stores/provider-config` to its own copy of the state and pushes the result down the changed
 * channel, which is the route the mirror actually listens on. So the new name on screen is main's answer,
 * and what a save asked for is what a test can read off the store channel.
 *
 * An edit must make no settings call at all: the key is kept per id, the id does not move, and the
 * ciphertext stays valid without this path ever touching it.
 */

/**
 * The two refusals the screen cannot type its way into, made able to happen here.
 *
 * `resolveProviderEdit` answers `NOT_FOUND` only for an id the list does not hold, and `NO_FIELDS` only
 * for an edit that named no field — while a box is drawn from a provider the list holds, through
 * dispatch sites that each name one field. So the two codes are unreachable from the box as it stands,
 * and the wiring that decides what a box does when it is handed one is exactly what this suite cannot
 * otherwise see: whether the field says why, or closes as though the edit had been saved. The forced
 * code answers only while a case sets it, and every other call goes to the real check, which is what
 * keeps the rest of this file a test of the rules rather than of a stub.
 */
const forced = vi.hoisted(() => ({ rejection: null as ProviderEditRejection | null }))

vi.mock('@/conveyor/protocol/custom-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/conveyor/protocol/custom-provider')>()
  return {
    ...actual,
    resolveProviderEdit: (...args: Parameters<typeof actual.resolveProviderEdit>) =>
      forced.rejection ? { ok: false as const, code: forced.rejection } : actual.resolveProviderEdit(...args),
  }
})

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

/** The provider being edited: a server on this machine, its catalogue fetched, a key on file. */
const LLAMA = {
  id: 'local-llama',
  name: 'Local Llama',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: ['llama-3.1-8b', 'qwen2.5-coder-7b'],
}

const EMPTY_STATE: ProviderConfigState = { providers: {}, customProviders: [] }

/** The same provider with both of its models switched on, so the count on the box has two of each. */
const SEEDED: ProviderConfigState = {
  providers: { [LLAMA.id]: { enabledModels: [...LLAMA.models], fetchedModels: [] } },
  customProviders: [LLAMA],
}

/** One provider and a second one whose name is taken, for the refusal that lands on the name field. */
const TWO_PROVIDERS: ProviderConfigState = {
  providers: {},
  customProviders: [LLAMA, { ...LLAMA, id: 'work-gateway', name: 'Work Gateway', models: [] }],
}

/**
 * The main process's half of the provider-config store.
 *
 * A cross-window store is owned by main: the renderer's action call travels to the store channel and the
 * mirror changes only when the result is broadcast. This applies that reducer to its own copy and pushes
 * the result down the changed channel, so a test can assert both what was asked for and what the screen
 * does once main has answered.
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

/** Install a bridge whose settings and catalogue answers are the ones this suite describes. */
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

/** What the screen asked of the store main owns, in order. */
function storeMethods(stub: BridgeStub): string[] {
  return stub.calls.filter((call) => call.channel === 'conveyor:store:provider-config').map((call) => call.method)
}

/** The last payload sent to one store action. */
function lastPayload(stub: BridgeStub, method: string): unknown {
  const call = stub.calls.filter((entry) => entry.method === method).at(-1)
  return (call?.args[0] as { payload?: unknown } | undefined)?.payload
}

/** Start editing a box's base URL, and commit what was typed in its place. */
async function editBaseUrl(box: HTMLElement, next: string): Promise<void> {
  // The URL is the affordance: the click turns the row's text into the field, in place.
  await userEvent.click(within(box).getByRole('button', { name: /^http/ }))
  const field = within(box).getByLabelText('API URL')
  await userEvent.clear(field)
  await userEvent.type(field, next)
  await userEvent.keyboard('{Enter}')
}

beforeEach(() => {
  localStorage.clear()
  // A forced code belongs to the case that set it, or the next case would commit against it too.
  forced.rejection = null
})

describe('the base URL row', () => {
  it('shows the URL between the header and the key row, and edits it in place', async () => {
    const { stub, main } = stubSettings({ listConfigured: () => [LLAMA.id] }, SEEDED)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))

    // An edit affordance on the URL itself: the row is drawn whether or not it is being edited, which is
    // what makes the URL discoverable rather than hidden behind a dialog.
    expect(custom.querySelector('[data-slot="provider-base-url"]')).not.toBeNull()
    expect(within(custom).queryByRole('button', { name: LLAMA.baseUrl })).not.toBeNull()

    // Between the header and the key row, in that order: the slot the custom box adds, and the one place
    // on the screen where the URL a provider is called at can be read.
    const header = custom.querySelector('[data-slot="provider-actions"]') as HTMLElement
    const urlRow = custom.querySelector('[data-slot="provider-base-url"]') as HTMLElement
    const keyInput = within(custom).getByLabelText('Local Llama API key')
    expect(header.compareDocumentPosition(urlRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(urlRow.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await editBaseUrl(custom, 'http://localhost:4321/v1/')

    // Saved normalised, first: the trailing slash is the user's habit, not part of the endpoint.
    await waitFor(() => expect(main.state().customProviders[0].baseUrl).toBe('http://localhost:4321/v1'))
    expect(lastPayload(stub, 'updateCustomProvider')).toEqual({ id: LLAMA.id, baseUrl: 'http://localhost:4321/v1' })

    // And then the new endpoint is asked for its catalogue with its own URL and the provider's id — no key
    // crosses, because main reads the one already stored under that id.
    await waitFor(() => expect(stub.methodsOn('provider')).toContain('listModels'))
    const listed = stub.callsTo('provider').find((call) => call.method === 'listModels')
    expect(listed?.args[0]).toEqual({ baseUrl: 'http://localhost:4321/v1', apiKey: '', providerId: LLAMA.id })

    // The row states what was saved, so an edit that landed is visible as one.
    await waitFor(() =>
      expect(within(custom).queryByRole('button', { name: 'http://localhost:4321/v1' })).not.toBeNull()
    )

    // The key store was neither written nor cleared: an edit has no business with a credential that is
    // already valid under an id that did not move.
    expect(stub.methodsOn('settings')).not.toContain('saveApiKey')
    expect(stub.methodsOn('settings')).not.toContain('clearApiKey')
  })

  it('reconciles the catalogue and the enabled set with what the new URL answered', async () => {
    const { main } = stubSettings({ listConfigured: () => [LLAMA.id], listModels: () => ['qwen2.5-coder-7b'] }, SEEDED)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await editBaseUrl(custom, 'http://localhost:4321/v1')

    // The new catalogue, and the enabled set pruned to it — the rule a refresh applies to a shipped
    // provider: the model the new endpoint does not list is no longer offered by the picker.
    await waitFor(() => expect(main.state().customProviders[0].models).toEqual(['qwen2.5-coder-7b']))
    await waitFor(() => expect(main.state().providers[LLAMA.id]?.enabledModels).toEqual(['qwen2.5-coder-7b']))
    expect(within(custom).getByText('1 models available')).toBeTruthy()
    expect(within(custom).getByText('1 on')).toBeTruthy()
  })

  it('keeps the URL, clears both model sets, and says why when the new endpoint cannot answer', async () => {
    const { main } = stubSettings(
      {
        listConfigured: () => [LLAMA.id],
        listModels: () => {
          throw new ConveyorError('PROVIDER_UNREACHABLE', 'BANANA')
        },
      },
      SEEDED
    )
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await editBaseUrl(custom, 'http://localhost:9999/v1')

    // The URL is saved either way: it is what the user asked for, and the failure is about the catalogue.
    await waitFor(() => expect(main.state().customProviders[0].baseUrl).toBe('http://localhost:9999/v1'))
    // Both sets named models of the old endpoint, so neither survives a server that never heard of them.
    await waitFor(() => expect(main.state().customProviders[0].models).toEqual([]))
    expect(main.state().providers[LLAMA.id]?.enabledModels).toEqual([])

    // The existing sentence for that code, and never main's message.
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('could not be reached')
    expect(notice.textContent).not.toContain('BANANA')
    expect(within(custom).queryByText(/models available/)).toBeNull()
  })
})

describe('editing the name in place', () => {
  it('turns the name into a field, and a committed edit keeps the badge and the catalogue count', async () => {
    const { stub, main } = stubSettings({ listConfigured: () => [LLAMA.id] }, SEEDED)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    // The name is the affordance: click it and it becomes the field, in the header, where the name was.
    expect(within(custom).queryByRole('button', { name: 'Local Llama' })).not.toBeNull()
    await userEvent.click(within(custom).getByRole('button', { name: 'Local Llama' }))

    const field = within(custom).getByLabelText('Provider name')
    await userEvent.clear(field)
    await userEvent.type(field, 'Local Mistral')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(main.state().customProviders[0].name).toBe('Local Mistral'))
    // The id is untouched: it was derived once, from the name it was created under.
    expect(main.state().customProviders[0].id).toBe(LLAMA.id)
    expect(lastPayload(stub, 'updateCustomProvider')).toEqual({ id: LLAMA.id, name: 'Local Mistral' })

    // What a user sees afterwards: the new name, the same saved badge, the same key controls, and the same
    // catalogue with the same number of models switched on.
    await waitFor(() => expect(within(custom).queryByRole('button', { name: 'Local Mistral' })).not.toBeNull())
    expect(custom.querySelector('[data-slot="provider-saved-badge"]')).not.toBeNull()
    expect(within(custom).getByLabelText('Local Mistral API key')).toBeTruthy()
    expect(within(custom).getByText('2 models available')).toBeTruthy()
    expect(within(custom).getByText('2 on')).toBeTruthy()
    expect(within(custom).getByRole('button', { name: 'Fetch models for Local Mistral' })).toBeTruthy()
    expect(within(custom).getByRole('button', { name: 'Delete Local Mistral' })).toBeTruthy()

    // A rename asks no server anything, and it does not touch the key.
    expect(stub.methodsOn('provider')).not.toContain('listModels')
    expect(stub.methodsOn('settings')).not.toContain('saveApiKey')
    expect(stub.methodsOn('settings')).not.toContain('clearApiKey')
  })

  it('leaves the name alone when Escape is pressed', async () => {
    const { stub, main } = stubSettings({ listConfigured: () => [LLAMA.id] }, SEEDED)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Local Llama' }))

    const field = within(custom).getByLabelText('Provider name')
    await userEvent.clear(field)
    await userEvent.type(field, 'Discarded')
    await userEvent.keyboard('{Escape}')

    // Back to the box as it was, with nothing written: Escape is a cancel rather than a save of the draft.
    expect(within(custom).getByRole('button', { name: 'Local Llama' })).toBeTruthy()
    expect(storeMethods(stub)).not.toContain('updateCustomProvider')
    expect(main.state().customProviders[0].name).toBe('Local Llama')
  })

  it('refuses a name another provider holds, on the name field, and writes nothing', async () => {
    const { stub } = stubSettings(undefined, TWO_PROVIDERS)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Local Llama' }))

    const field = within(custom).getByLabelText('Provider name')
    await userEvent.clear(field)
    await userEvent.type(field, 'Work Gateway')
    await userEvent.keyboard('{Enter}')

    // The same sentence the add form uses for the same code, on the field that caused it.
    const error = await within(custom).findByText('A provider with this name already exists.')
    expect(error.dataset.slot).toBe('provider-name-error')
    // Still editing, so the field the user must fix is still the field they are in.
    expect(within(custom).getByLabelText('Provider name')).toBeTruthy()
    expect(storeMethods(stub)).not.toContain('updateCustomProvider')
  })
})

describe('a refusal the screen cannot type its way into', () => {
  it('names a NOT_FOUND refusal on the name field, rather than closing as though it saved', async () => {
    const { stub } = stubSettings(undefined, SEEDED)
    forced.rejection = 'NOT_FOUND'
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Local Llama' }))

    const field = within(custom).getByLabelText('Provider name')
    await userEvent.clear(field)
    await userEvent.type(field, 'Local Mistral')
    await userEvent.keyboard('{Enter}')

    // The map's own sentence for that code, on the field it was committed from — and the editor still
    // open, because a draft that was not written is a draft the user is still fixing.
    const error = await within(custom).findByText('This provider is no longer in the list, so nothing was saved.')
    expect(error.dataset.slot).toBe('provider-name-error')
    expect(within(custom).getByLabelText('Provider name')).toBeTruthy()
    expect(storeMethods(stub)).not.toContain('updateCustomProvider')
  })

  it('names a NO_FIELDS refusal on the URL row, rather than closing as though it saved', async () => {
    const { stub } = stubSettings(undefined, SEEDED)
    forced.rejection = 'NO_FIELDS'
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await editBaseUrl(custom, 'http://localhost:4321/v1')

    const error = await within(custom).findByText('Nothing was saved: there was no edit to apply.')
    expect(error.dataset.slot).toBe('provider-url-error')
    expect(within(custom).getByLabelText('API URL')).toBeTruthy()
    // Refused before the write, so neither the store nor the server was asked anything: the URL row must
    // not show a moved endpoint it never saved.
    expect(storeMethods(stub)).not.toContain('updateCustomProvider')
    expect(stub.methodsOn('provider')).not.toContain('listModels')
  })
})

describe('what the edit leaves alone', () => {
  it('gives a predefined provider neither slot', async () => {
    stubSettings()
    const { container } = renderSettings()

    const deepseek = await waitFor(() => boxFor(container, 'predefined', 'DeepSeek'))
    expect(deepseek.querySelector('[data-slot="provider-base-url"]')).toBeNull()
    expect(deepseek.querySelector('[data-slot="provider-edit-name"]')).toBeNull()
    // Its name is still text rather than a control: a predefined provider's name is this app's to state.
    expect(within(deepseek).queryByRole('button', { name: 'DeepSeek' })).toBeNull()
  })

  it('still asks before a delete, which an edit does not replace', async () => {
    const { stub, main } = stubSettings({ listConfigured: () => [LLAMA.id] }, SEEDED)
    const { container } = renderSettings()

    const custom = await waitFor(() => boxFor(container, 'custom', 'Local Llama'))
    await userEvent.click(within(custom).getByRole('button', { name: 'Delete Local Llama' }))

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Remove Local Llama?')).toBeTruthy()
    // Still there while the question is on screen, and nothing was removed on the way to asking it.
    expect(main.state().customProviders).toHaveLength(1)
    expect(storeMethods(stub)).not.toContain('removeCustomProvider')

    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove provider' }))
    await waitFor(() => expect(storeMethods(stub)).toContain('removeCustomProvider'))
  })
})
