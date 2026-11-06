/**
 * Verifies the edit half of the custom-provider slice: renaming one, and moving it to another base URL.
 *
 * The store is a plain definition object and its actions are pure `(state, payload)` reducers, so the
 * slice is exercised the way `provider-config-store-test.ts` exercises the create half — by calling an
 * action against a state object, with no electron, no window and no IPC broadcast.
 *
 * What an edit must not do is as much of the contract as what it must: the id stays, because saved model
 * choices, combo members and conversations name it; the per-model declarations stay, because a rename is
 * not a price; and the key store is never opened, because the credential is per id and the id did not
 * move. That last one is asserted against the real file, under the private `userData` directory the node
 * runner gives every suite.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { providerConfigStore } from '../../conveyor/stores/provider-config'
import type { ProviderConfigState } from '../../conveyor/stores/provider-config'
import { resolveProviderEdit } from '../../conveyor/protocol/custom-provider'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** The store runtime names the initial state `initialState`; the authoring config calls it `state`. */
const INITIAL_STATE = (providerConfigStore as unknown as { initialState: ProviderConfigState }).initialState

type Actions = typeof providerConfigStore.actions

interface Harness {
  state: () => ProviderConfigState
  run: <K extends keyof Actions>(name: K, payload: DropFirst<Parameters<Actions[K]>>[0]) => void
}

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never

function createHarness(from: ProviderConfigState = INITIAL_STATE): Harness {
  const state: ProviderConfigState = structuredClone(from)

  return {
    state: () => state,
    run(name, payload) {
      const action = providerConfigStore.actions[name]
      if (!action) throw new Error(`no such action: ${String(name)}`)
      ;(action as (s: ProviderConfigState, p?: unknown) => void)(state, payload)
    },
  }
}

/** The provider being edited: a local server whose catalogue was fetched and whose models are switched on. */
const LLAMA = {
  id: 'local-llama',
  name: 'Local Llama',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: ['llama-3.1-8b', 'qwen2.5-coder-7b'],
}

/** A second provider, so a name that is taken is taken by something that is not the one being edited. */
const GATEWAY = {
  id: 'work-gateway',
  name: 'Work Gateway',
  baseUrl: 'https://gw.internal/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: [],
}

/**
 * What the record beside the descriptor holds: the enable list, an image declaration, a price and a
 * window. Every one of them is keyed by provider id or model id, so an edit has no business in here.
 */
const RECORD: ProviderConfigState['providers'][string] = {
  enabledModels: ['llama-3.1-8b', 'qwen2.5-coder-7b'],
  fetchedModels: [],
  supportsImages: true,
  modelRates: { 'llama-3.1-8b': { inputRate: 0.1, cacheHitRate: 0.05, outputRate: 0.2 } },
  modelWindows: { 'llama-3.1-8b': { contextWindow: 32_000 } },
}

/** One provider, with the record a user who has configured it would have. */
function seeded(): ProviderConfigState {
  return { providers: { [LLAMA.id]: structuredClone(RECORD) }, customProviders: [structuredClone(LLAMA)] }
}

/** Two providers, both with a descriptor and nothing configured: the list a name is unique against. */
function twoProviders(): ProviderConfigState {
  return { providers: {}, customProviders: [structuredClone(LLAMA), structuredClone(GATEWAY)] }
}

// ---------------------------------------------------------------- the edit itself

function aRenameKeepsTheIdAndTheWholeDescriptor() {
  const store = createHarness(seeded())
  const catalogue = store.state().customProviders[0].models
  const record = store.state().providers[LLAMA.id]

  store.run('updateCustomProvider', { id: LLAMA.id, name: 'Local Mistral' })

  const edited = store.state().customProviders[0]
  // The cosmetic consequence, stated as the contract: the slug was derived from the old name and stays.
  assert.equal(edited.id, LLAMA.id, 'the id is not re-derived from the new name')
  assert.equal(edited.name, 'Local Mistral')
  assert.equal(edited.baseUrl, LLAMA.baseUrl, 'a rename leaves the URL')
  assert.equal(edited.apiKey, '', 'and the descriptor still carries no credential')
  assert.equal(edited.dialect, 'openai')
  assert.equal(edited.models, catalogue, 'the catalogue is the same array, untouched')
  // The record is not rebuilt: a name is not a model choice, a price, a window or an image declaration.
  assert.equal(store.state().providers[LLAMA.id], record)
  assert.deepEqual(store.state().providers[LLAMA.id], RECORD)

  results.push('a rename keeps the id, the URL, the catalogue and the whole provider record')
}

function aUrlEditSavesTheUrlFirstAndLeavesTheCatalogueAlone() {
  const store = createHarness(seeded())

  store.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'http://localhost:4321/v1/' })

  const edited = store.state().customProviders[0]
  assert.equal(edited.baseUrl, 'http://localhost:4321/v1', 'the trailing slash a user types is trimmed')
  assert.equal(edited.id, LLAMA.id)
  assert.equal(edited.name, 'Local Llama', 'a URL edit leaves the name')
  // The catalogue belongs to the endpoint that answered it, so it is the *old* endpoint's until the box
  // has asked the new one. Saving the URL and fetching its catalogue are two facts, in that order.
  assert.deepEqual(edited.models, LLAMA.models)
  assert.deepEqual(store.state().providers[LLAMA.id], RECORD, 'the enable list and declarations are untouched')

  results.push('a URL edit saves the normalised URL and leaves the catalogue for the fetch to decide')
}

function aFetchForANewUrlReconcilesTheModelSets() {
  // The writes the box performs once the new endpoint has answered: the catalogue, then the enabled set
  // pruned to it — the rule `setFetchedModels` applies to a shipped provider. What the box *dispatches*
  // is the DOM suite's; what those writes leave behind is this.
  const store = createHarness(seeded())
  store.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'http://localhost:4321/v1' })

  const fetched = ['qwen2.5-coder-7b']
  store.run('setCustomProviderModels', { id: LLAMA.id, models: fetched })
  store.run('setEnabledModels', { providerId: LLAMA.id, modelIds: ['qwen2.5-coder-7b'] })

  assert.deepEqual(store.state().customProviders[0].models, fetched)
  assert.deepEqual(store.state().providers[LLAMA.id].enabledModels, ['qwen2.5-coder-7b'])
  // The declarations are kept, as a built-in refresh keeps them: they are keyed by model id and harmless
  // until that id reappears, and an edit is not the moment to forget a price somebody entered.
  assert.deepEqual(store.state().providers[LLAMA.id].modelRates, RECORD.modelRates)
  assert.deepEqual(store.state().providers[LLAMA.id].modelWindows, RECORD.modelWindows)

  results.push('a URL edit whose fetch answers replaces the catalogue and prunes the enabled set')

  // And the failure path: the URL the user asked for stays, both model sets go — they name models of an
  // endpoint that is no longer there — and the declarations stay with them.
  const failed = createHarness(seeded())
  failed.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'http://localhost:9999/v1' })
  failed.run('setCustomProviderModels', { id: LLAMA.id, models: [] })
  failed.run('setEnabledModels', { providerId: LLAMA.id, modelIds: [] })

  assert.equal(failed.state().customProviders[0].baseUrl, 'http://localhost:9999/v1')
  assert.deepEqual(failed.state().customProviders[0].models, [], 'the catalogue named the old endpoint')
  assert.deepEqual(failed.state().providers[LLAMA.id].enabledModels, [], 'so did the enable list')
  assert.deepEqual(failed.state().providers[LLAMA.id].modelRates, RECORD.modelRates)

  results.push('a URL whose fetch fails keeps the URL and clears both model sets')
}

function bothFieldsOfOneEditLandTogether() {
  const store = createHarness(seeded())

  store.run('updateCustomProvider', { id: LLAMA.id, name: 'Local Mistral', baseUrl: 'http://localhost:4321/v1/' })

  const edited = store.state().customProviders[0]
  assert.equal(edited.name, 'Local Mistral')
  assert.equal(edited.baseUrl, 'http://localhost:4321/v1')
  assert.equal(edited.id, LLAMA.id, 'and the id is still the one it was created under')

  results.push('a rename and a URL move in one edit both land, under the same id')
}

// ---------------------------------------------------------------- refusals

function anUnchangedNameIsNotARefusalByItself() {
  const providers = twoProviders().customProviders

  assert.deepEqual(resolveProviderEdit(providers, LLAMA.id, { name: 'Local Llama' }), {
    ok: true,
    edit: { name: 'Local Llama' },
  })
  // Case and space are how the same name gets retyped; the provider being edited is excluded from the
  // list it is compared against, so retyping its own name is not a collision with itself.
  assert.deepEqual(resolveProviderEdit(providers, LLAMA.id, { name: ' local llama ' }), {
    ok: true,
    edit: { name: 'Local Llama' },
  })

  results.push('an unchanged name is allowed: the edited provider is excluded from the taken list')
}

function aNameAnotherProviderHoldsIsRefused() {
  const store = createHarness(twoProviders())
  const before = structuredClone(store.state().customProviders)

  store.run('updateCustomProvider', { id: LLAMA.id, name: ' work gateway ' })

  assert.deepEqual(store.state().customProviders, before, 'a refused edit changes nothing')
  assert.deepEqual(resolveProviderEdit(twoProviders().customProviders, LLAMA.id, { name: 'work gateway' }), {
    ok: false,
    code: 'NAME_TAKEN',
  })

  results.push('a name another provider holds is refused, and nothing is written')
}

function theDraftRulesRefuseTheSameDraftsTheyRefuseOnCreate() {
  const store = createHarness(seeded())
  const before = structuredClone(store.state().customProviders)

  // Blank, and not an http address: the two refusals the form already explains, applied here again
  // because an action cannot answer with an error and this is the side that owns the list.
  store.run('updateCustomProvider', { id: LLAMA.id, name: '   ' })
  store.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'localhost:1234' })
  store.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'ftp://example.com/v1' })
  assert.deepEqual(store.state().customProviders, before)

  const providers = twoProviders().customProviders
  assert.deepEqual(resolveProviderEdit(providers, LLAMA.id, { name: '   ' }), { ok: false, code: 'NAME_REQUIRED' })
  assert.deepEqual(resolveProviderEdit(providers, LLAMA.id, { baseUrl: 'localhost:1234' }), {
    ok: false,
    code: 'BASE_URL_INVALID',
  })

  results.push('a blank name and a base URL that is not http(s) are refused by the draft rules')
}

function anEditNamingNoFieldWritesNothing() {
  const store = createHarness(seeded())
  const before = structuredClone(store.state().customProviders)

  store.run('updateCustomProvider', { id: LLAMA.id })

  assert.deepEqual(store.state().customProviders, before)
  assert.deepEqual(resolveProviderEdit(twoProviders().customProviders, LLAMA.id, {}), {
    ok: false,
    code: 'NO_FIELDS',
  })

  results.push('an edit that names no field is refused and writes nothing')
}

function anEditToAProviderThatIsNotThereIsRefused() {
  const store = createHarness(twoProviders())
  const before = structuredClone(store.state().customProviders)

  store.run('updateCustomProvider', { id: 'nope', name: 'Nothing' })
  store.run('updateCustomProvider', { id: 'nope', baseUrl: 'http://elsewhere:1234/v1' })
  assert.deepEqual(store.state().customProviders, before)

  // A rename and a URL move share the lookup, so the not-found fact — and the id it was asked about — is
  // the same for both.
  const providers = twoProviders().customProviders
  assert.deepEqual(resolveProviderEdit(providers, 'nope', { name: 'Nothing' }), { ok: false, code: 'NOT_FOUND' })
  assert.deepEqual(resolveProviderEdit(providers, 'nope', { baseUrl: 'http://elsewhere:1234/v1' }), {
    ok: false,
    code: 'NOT_FOUND',
  })

  results.push('an edit naming an id that is not there changes nothing, and answers NOT_FOUND')
}

// ---------------------------------------------------------------- the key store

function anEditNeverOpensTheKeyStore() {
  const userData = process.env.SAM_TEST_USER_DATA
  assert.ok(userData, 'the suite runs with a private userData directory, as the node runner sets it')

  const dir = join(userData, 'settings')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'api-keys.json')
  // Ciphertext shaped like what main writes: base64 under the provider id. Nothing in this suite decrypts
  // it — the claim is about the bytes, not about the key.
  const ciphertext = JSON.stringify({ [LLAMA.id]: 'c29tZS1jaXBoZXJ0ZXh0' })
  writeFileSync(file, ciphertext)

  const before = readFileSync(file)
  const store = createHarness(seeded())
  store.run('updateCustomProvider', { id: LLAMA.id, name: 'Local Mistral' })
  store.run('updateCustomProvider', { id: LLAMA.id, baseUrl: 'http://localhost:4321/v1' })
  const after = readFileSync(file)

  // Byte for byte: the key is kept per id, the id did not move, and nothing on this path imports the
  // settings module that owns the file. An edit that rewrote it could only lose a credential.
  assert.equal(Buffer.compare(before, after), 0, 'the key file is untouched')
  assert.equal(after.toString('utf8'), ciphertext)

  results.push('the key file is byte-identical across a rename and a URL edit')
}

function main() {
  step('rename keeps the identity', aRenameKeepsTheIdAndTheWholeDescriptor)
  step('url edit saves first', aUrlEditSavesTheUrlFirstAndLeavesTheCatalogueAlone)
  step('url edit, catalogue reconciled', aFetchForANewUrlReconcilesTheModelSets)
  step('both fields in one edit', bothFieldsOfOneEditLandTogether)
  step('unchanged name allowed', anUnchangedNameIsNotARefusalByItself)
  step('name taken', aNameAnotherProviderHoldsIsRefused)
  step('draft rules', theDraftRulesRefuseTheSameDraftsTheyRefuseOnCreate)
  step('no fields', anEditNamingNoFieldWritesNothing)
  step('not found', anEditToAProviderThatIsNotThereIsRefused)
  step('key file untouched', anEditNeverOpensTheKeyStore)

  console.log(`\ncustom providers (inline edit): ${results.length} checks passed`)
}

main()
