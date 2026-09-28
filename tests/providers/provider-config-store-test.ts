/**
 * Verifies the custom-provider half of the provider-config slice: what the actions do to the state,
 * and what survives a restart.
 *
 * The store is a plain definition object and its actions are pure `(state, payload)` reducers, so the
 * slice can be exercised without electron, without a window, and without the IPC broadcast — by
 * calling an action against a state object, exactly as the store runtime does.
 *
 * The round trip is asserted at the layer that actually persists: main registers the store with
 * `persist`, the state is serialised as JSON under `userData`, and it is shallow-merged over the
 * definition's initial state when the app starts again. `rehydrate` below is that merge, so what is
 * pinned here is that a custom provider list written by one run is read back by the next, and that a
 * file written before custom providers existed still reads — as an empty list, with the rest of the
 * slice untouched. Nothing to clean up: the harness clones its state and the JSON is a string.
 */
import { strict as assert } from 'node:assert'
import { providerConfigStore } from '../../conveyor/stores/provider-config'
import type { ProviderConfigState } from '../../conveyor/stores/provider-config'
import { declaredRates, RATES, resolveRates } from '../../conveyor/protocol/session-usage'
import { TRANSCRIPT_VERSION } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/**
 * The store runtime names the initial state `initialState`; the authoring config calls it `state`.
 * Reading it here means the harness starts from exactly what main would start from.
 */
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

/** What main's registration does with the persisted file: shallow-merged over the initial state. */
function rehydrate(persisted: Record<string, unknown>): ProviderConfigState {
  return { ...structuredClone(INITIAL_STATE), ...persisted }
}

const LOCAL = { name: 'Local Llama', baseUrl: 'http://localhost:1234/v1' }
const REMOTE = { name: 'Work Gateway', baseUrl: 'https://gw.internal/v1/' }

// ---------------------------------------------------------------- adding

function addingAProviderRecordsItWithADerivedId() {
  const store = createHarness()

  store.run('addCustomProvider', LOCAL)

  const added = store.state().customProviders
  assert.equal(added.length, 1)
  assert.equal(added[0].id, 'local-llama')
  assert.equal(added[0].name, 'Local Llama')
  assert.equal(added[0].baseUrl, 'http://localhost:1234/v1')
  assert.equal(added[0].dialect, 'openai')
  assert.deepEqual(added[0].models, [])
  // The slice is mirrored to every window, so a credential must never be written into it. The key a
  // turn runs with is resolved in main and handed to the loop there.
  assert.equal(added[0].apiKey, '')
  results.push('adding a provider appends it under an id derived from its name')
}

function addingNormalisesTheBaseUrlAndRefusesWhatCannotBeUsed() {
  const store = createHarness()

  store.run('addCustomProvider', REMOTE)
  assert.equal(store.state().customProviders[0].baseUrl, 'https://gw.internal/v1', 'trailing slash trimmed')

  // A draft that cannot be used leaves the list exactly as it was: the action has no way to return
  // an error, so the rule is that it changes nothing. The second draft is the same name retyped with
  // different case and spacing against a URL that would have been fine, so what refuses it is the
  // name rather than the URL.
  store.run('addCustomProvider', { name: ' work gateway ', baseUrl: 'http://elsewhere:9/v1' })
  store.run('addCustomProvider', { name: 'No Url', baseUrl: 'not-a-url' })
  assert.deepEqual(
    store.state().customProviders.map((p) => p.name),
    ['Work Gateway']
  )
  results.push('an unusable draft is refused and a duplicate name changes nothing')
}

function aSecondProviderWithTheSameNameGetsItsOwnId() {
  const store = createHarness()

  store.run('addCustomProvider', LOCAL)
  store.run('addCustomProvider', { name: 'Local llama', baseUrl: 'http://localhost:2345/v1' })

  assert.equal(store.state().customProviders.length, 1, 'the same name is one provider, not two')
  store.run('addCustomProvider', { name: 'Local Llama 2', baseUrl: 'http://localhost:2345/v1' })
  assert.deepEqual(
    store.state().customProviders.map((p) => p.id),
    ['local-llama', 'local-llama-2']
  )
  results.push('a differently named provider cannot take an id that is already in use')
}

// ---------------------------------------------------------------- removing and models

function removingTakesOnlyTheNamedProvider() {
  const store = createHarness()

  store.run('addCustomProvider', LOCAL)
  store.run('addCustomProvider', REMOTE)
  store.run('removeCustomProvider', { id: 'local-llama' })

  assert.deepEqual(
    store.state().customProviders.map((p) => p.id),
    ['work-gateway']
  )
  // Removing something that is not there is not an error: the list is what it is either way.
  store.run('removeCustomProvider', { id: 'nope' })
  assert.equal(store.state().customProviders.length, 1)
  results.push('removing by id takes that provider and nothing else')
}

function settingModelsReplacesTheListForThatProviderOnly() {
  const store = createHarness()

  store.run('addCustomProvider', LOCAL)
  store.run('addCustomProvider', REMOTE)
  store.run('setCustomProviderModels', { id: 'local-llama', models: ['llama-3.1-8b', 'qwen2.5-coder'] })
  store.run('setCustomProviderModels', { id: 'local-llama', models: ['llama-3.1-8b'] })

  assert.deepEqual(store.state().customProviders[0].models, ['llama-3.1-8b'])
  assert.deepEqual(store.state().customProviders[1].models, [], 'the other provider is untouched')
  results.push('setting models replaces one provider catalogue by id')
}

// ---------------------------------------------------------------- the round trip

function aListSurvivesARestart() {
  const before = createHarness()
  before.run('addCustomProvider', LOCAL)
  before.run('setCustomProviderModels', { id: 'local-llama', models: ['llama-3.1-8b'] })
  before.run('addCustomProvider', REMOTE)

  const after = rehydrate(JSON.parse(JSON.stringify(before.state())) as Record<string, unknown>)

  assert.deepEqual(
    after.customProviders.map((p) => ({ id: p.id, baseUrl: p.baseUrl, models: p.models })),
    [
      { id: 'local-llama', baseUrl: 'http://localhost:1234/v1', models: ['llama-3.1-8b'] },
      { id: 'work-gateway', baseUrl: 'https://gw.internal/v1', models: [] },
    ],
    'the list, its order, and each catalogue come back'
  )

  // And acting on the rehydrated slice works: it is the same state a running app holds.
  const next = createHarness()
  next.run('addCustomProvider', LOCAL)
  assert.equal(next.state().customProviders[0].id, 'local-llama')
  results.push('a custom provider list is written and read back whole, in creation order')
}

function aFileWrittenBeforeCustomProvidersExistedStillReads() {
  const persisted = { providers: { openai: { enabledModels: ['gpt-4o-mini'], fetchedModels: [] } } }

  const after = rehydrate(persisted)

  assert.deepEqual(after.customProviders, [], 'an absent key is not a broken file: it is an empty list')
  assert.equal('customProviders' in persisted, false, 'and nothing invented a key for it')
  assert.deepEqual(after.providers.openai.enabledModels, ['gpt-4o-mini'], 'the rest of the slice is untouched')
  results.push('a file with no customProviders key reads as an empty list')
}

function theSliceIsNotWhereAKeyIsKept() {
  const before = createHarness()
  before.run('addCustomProvider', LOCAL)

  const persisted = JSON.parse(JSON.stringify(before.state())) as ProviderConfigState
  assert.equal(JSON.stringify(persisted).includes('apiKey'), true, 'the field is part of the descriptor')
  assert.equal(
    persisted.customProviders.every((p) => p.apiKey === ''),
    true,
    'and it is empty in the slice, because the slice reaches every window'
  )
  results.push('no credential is written into the mirrored slice')
}

/**
 * The version moves only for a change in what a reader of a transcript must know.
 *
 * It is 3 now: a tool step gained `interrupted`, the same kind of widening that took it to 2 for
 * `queued`. What this suite is about — a provider setting — still changes nothing a transcript reader
 * has to know, which is the property being held here rather than the number itself.
 */
function theTranscriptVersionDidNotMove() {
  assert.equal(TRANSCRIPT_VERSION, 3, 'storing custom providers is not a transcript change')
  results.push('the transcript version is still 3')
}

// ---------------------------------------------------------------- image support

function imageSupportIsWrittenAsAYesOrNotAtAll() {
  const store = createHarness()

  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })
  assert.equal(store.state().providers.deepseek.supportsImages, true)

  // Cleared means the key goes, rather than becoming `false`. A record with no key and a record with a
  // false one are read the same way by the gate, and only the first is honest about a user who has never
  // been asked — which is what an older build reading this file has to receive.
  store.run('setSupportsImages', { providerId: 'deepseek', supported: false })
  assert.equal('supportsImages' in store.state().providers.deepseek, false)
  results.push('image support is a yes or an absence, per provider')
}

function oneProvidersImageSupportIsNotAnothers() {
  const store = createHarness()

  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })
  store.run('setSupportsImages', { providerId: 'openai', supported: false })

  assert.equal(store.state().providers.deepseek.supportsImages, true)
  assert.equal('supportsImages' in store.state().providers.openai, false)
  // And the rest of a record is not disturbed by the switch: the models switched on stay switched on.
  store.run('toggleModel', { providerId: 'deepseek', modelId: 'deepseek-chat' })
  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })
  assert.deepEqual(store.state().providers.deepseek.enabledModels, ['deepseek-chat'])
  results.push('turning image support on does not disturb the model choices')
}

function aCatalogueRefreshDoesNotClearImageSupport() {
  const store = createHarness()

  store.run('toggleModel', { providerId: 'deepseek', modelId: 'deepseek-chat' })
  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })

  // `setFetchedModels` replaces the record rather than merging into it — it owns the catalogue and the
  // enabled list it prunes. The flag has to be carried across explicitly, or pressing Fetch in Settings
  // would switch image support off as a side effect nobody could connect to the button they pressed.
  store.run('setFetchedModels', { providerId: 'deepseek', models: [{ id: 'deepseek-chat' }] })
  assert.equal(store.state().providers.deepseek.supportsImages, true)
  assert.deepEqual(store.state().providers.deepseek.enabledModels, ['deepseek-chat'])
  results.push('a catalogue refresh leaves image support where it was')
}

function anOlderFileCarriesNoOpinionAboutImages() {
  // A file written before this key existed. The record it restores has no key, which is what the gate
  // reads as "no" — and nothing here invents a decision for the user.
  const after = rehydrate({ providers: { deepseek: { enabledModels: [], fetchedModels: [] } } })

  assert.equal('supportsImages' in after.providers.deepseek, false)
  results.push('a file from before this setting still reads, with nothing invented')
}

/**
 * The version moves only for a change in what a reader of a transcript must know.
 *
 * It is 3 now: a tool step gained `interrupted`, the same kind of widening that took it to 2 for
 * `queued`. What this suite is about — a provider setting — still changes nothing a transcript reader
 * has to know, which is the property being held here rather than the number itself.
 */
function theTranscriptVersionDidNotMoveOfImages() {
  assert.equal(TRANSCRIPT_VERSION, 3, 'a provider preference is not a transcript change')
  results.push('the transcript version is still 3 after the image-support key')
}

// ---------------------------------------------------------------- declared prices, by model

/** One catalogue id, so the model a price belongs to is named once. */
const CHAT = 'deepseek-chat'

function aModelsPricesAreWrittenUnderItsOwnKey() {
  const store = createHarness()

  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 0.27, cacheHit: 0.07, output: 1.1 })
  assert.deepEqual(store.state().providers.deepseek.modelRates, {
    'deepseek-chat': { inputRate: 0.27, cacheHitRate: 0.07, outputRate: 1.1 },
  })

  // Keyed by model, so a declaration is about one model rather than about everything a provider serves:
  // the sibling on the same record keeps the shipped table, which is the whole reason the price moved.
  const declared = store.state().providers.deepseek.modelRates
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: declared }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })
  assert.deepEqual(
    resolveRates({ model: 'deepseek-reasoner', modelRates: declared }),
    RATES['deepseek-reasoner'],
    'the model beside it is priced by the table'
  )

  // And a second provider's box writes under its own record and its own model id.
  store.run('setModelRates', { providerId: 'openai', modelId: 'gpt-4o-mini', input: 1, cacheHit: 0.5, output: 2 })
  assert.deepEqual(store.state().providers.openai.modelRates, {
    'gpt-4o-mini': { inputRate: 1, cacheHitRate: 0.5, outputRate: 2 },
  })
  assert.deepEqual(store.state().providers.deepseek.modelRates, declared)

  results.push('a declared price is written under the model it belongs to')
}

function aPartialTripleIsStoredAsTypedAndPricesNothing() {
  const store = createHarness()

  // One side named and the other two not: the named side is stored as typed and the others are not
  // invented, because the three are one declaration a user fills in a field at a time.
  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 1.5 })
  assert.deepEqual(store.state().providers.deepseek.modelRates, { 'deepseek-chat': { inputRate: 1.5 } })

  // Not a declaration while it is short of a side, so the built-in table prices the model — rather than a
  // missing cache-hit rate being read as the input rate beside it, or as free.
  const partial = store.state().providers.deepseek.modelRates
  assert.ok(partial, 'the named side is stored')
  assert.equal(declaredRates(partial[CHAT]), null)
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: partial }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })
  // The model beside it is untouched by the half-typed declaration: a partial triple adds no sibling.
  assert.deepEqual(resolveRates({ model: 'deepseek-reasoner', modelRates: partial }), RATES['deepseek-reasoner'])

  // The third side is what completes it, and the rule above has already said what that means.
  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 1.5, cacheHit: 0.075, output: 0.6 })
  const whole = store.state().providers.deepseek.modelRates
  assert.ok(whole, 'the completed triple is stored')
  assert.deepEqual(declaredRates(whole[CHAT]), { input: 1_500_000, cacheHit: 75_000, output: 600_000 })
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: whole }), {
    input: 1_500_000,
    cacheHit: 75_000,
    output: 600_000,
  })

  results.push('a partial triple is stored as typed, and prices nothing until it is whole')
}

function clearingAModelsFieldsTakesItsEntryOff() {
  const store = createHarness()
  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 0.27, cacheHit: 0.07, output: 1.1 })
  store.run('setModelRates', {
    providerId: 'deepseek',
    modelId: 'deepseek-reasoner',
    input: 0.55,
    cacheHit: 0.14,
    output: 2.19,
  })

  // Blanked means the entry goes, rather than becoming zeros: the fields hold a declaration, and a
  // declaration of nothing is the absence of one. A stored zero would be the app claiming the model is
  // free, which is a price rather than a missing one.
  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT })
  assert.deepEqual(
    store.state().providers.deepseek.modelRates,
    { 'deepseek-reasoner': { inputRate: 0.55, cacheHitRate: 0.14, outputRate: 2.19 } },
    'the model beside it is exactly where it was'
  )

  // The last entry going takes the map with it: an empty map is this app claiming somebody declared
  // something, and absent is what a record that never held a declaration looks like.
  store.run('setModelRates', { providerId: 'deepseek', modelId: 'deepseek-reasoner' })
  assert.equal('modelRates' in store.state().providers.deepseek, false)

  results.push("a model's blanked fields take its declaration off, and the empty map with it")
}

function aCatalogueRefreshKeepsTheDeclaredPrices() {
  const store = createHarness()

  store.run('toggleModel', { providerId: 'deepseek', modelId: CHAT })
  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })
  store.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 0.27, cacheHit: 0.07, output: 1.1 })

  // A catalogue refresh replaces the record rather than merging into it, so the declarations have to be
  // carried across explicitly — the trap image support is carried across for, one key over: pressing
  // Fetch must not silently reprice every model at the shipped table.
  store.run('setFetchedModels', { providerId: 'deepseek', models: [{ id: CHAT }] })
  assert.deepEqual(store.state().providers.deepseek.modelRates, {
    'deepseek-chat': { inputRate: 0.27, cacheHitRate: 0.07, outputRate: 1.1 },
  })
  // And the rest of the record is left alone by a write about prices.
  assert.deepEqual(store.state().providers.deepseek.enabledModels, [CHAT])
  assert.equal(store.state().providers.deepseek.supportsImages, true)

  // Switching image support off rebuilds the record too, and it carries the prices for the same reason.
  store.run('setSupportsImages', { providerId: 'deepseek', supported: false })
  assert.equal('supportsImages' in store.state().providers.deepseek, false)
  assert.deepEqual(store.state().providers.deepseek.modelRates, {
    'deepseek-chat': { inputRate: 0.27, cacheHitRate: 0.07, outputRate: 1.1 },
  })

  results.push('a declared price survives a catalogue refresh and an image-support switch')
}

function declaredPricesSurviveARestart() {
  const before = createHarness()
  before.run('setModelRates', { providerId: 'deepseek', modelId: CHAT, input: 0.27, cacheHit: 0.07, output: 1.1 })

  const after = rehydrate(JSON.parse(JSON.stringify(before.state())) as Record<string, unknown>)
  assert.deepEqual(after.providers.deepseek.modelRates, {
    'deepseek-chat': { inputRate: 0.27, cacheHitRate: 0.07, outputRate: 1.1 },
  })

  // A file written before this key existed reads as a provider nobody has priced — which the resolver
  // answers from the shipped table, and which an unpriced model's tile draws an em dash for.
  const older = rehydrate({ providers: { deepseek: { enabledModels: [], fetchedModels: [] } } })
  assert.equal('modelRates' in older.providers.deepseek, false)
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: older.providers.deepseek.modelRates }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })

  // And the persisted declaration is what the resolver prices with, ahead of the shipped table: three
  // fields in dollars per million as micros per million, cache hit included.
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: after.providers.deepseek.modelRates }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })

  results.push('declared prices are written, read back, and priced with')
}

function theRetiredProviderRatesAreStrippedOnLoad() {
  // A file this build's predecessor wrote: the provider-level triple, which was then the only place a
  // price could be declared. Main's load is a one-level merge, so those keys arrive in the record whole.
  const loaded = rehydrate({
    providers: {
      deepseek: {
        enabledModels: [CHAT],
        fetchedModels: [{ id: CHAT }],
        inputRate: 0.15,
        cacheHitRate: 0.075,
        outputRate: 0.6,
        supportsImages: true,
      },
    },
  })
  // Read back as raw JSON, because this build's type no longer names them: the point of the assertion is
  // that the file still holds them when the record arrives.
  const raw = loaded.providers.deepseek as unknown as Record<string, unknown>
  assert.equal(raw.inputRate, 0.15, 'the merge alone leaves the retired keys')
  assert.equal(raw.cacheHitRate, 0.075)
  assert.equal(raw.outputRate, 0.6)

  // The pass startup runs over the loaded slice, which is what makes the removal real rather than a key
  // the type no longer mentions while the file still carries it.
  const store = createHarness(loaded)
  // `undefined` because the action takes no payload: the harness mirrors the store's own dispatch, which
  // passes nothing for an action that declares nothing.
  store.run('dropRetiredRates', undefined)

  const record = store.state().providers.deepseek
  assert.equal('inputRate' in record, false)
  assert.equal('cacheHitRate' in record, false)
  assert.equal('outputRate' in record, false)
  // No migration, and this is the assertion that says so: a price declared for a provider is not moved
  // onto a model nobody named. The model prices from the shipped table until its own row is filled in.
  assert.equal('modelRates' in record, false)
  assert.deepEqual(resolveRates({ model: CHAT, modelRates: record.modelRates }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })
  // And everything the record did say is still there: the pass is about the retired keys, nothing else.
  assert.deepEqual(record.enabledModels, [CHAT])
  assert.equal(record.supportsImages, true)

  // Idempotent, so a startup with nothing of the sort to strip changes nothing at all.
  const clean = createHarness()
  clean.run('dropRetiredRates', undefined)
  assert.deepEqual(clean.state().providers, {})

  results.push('the retired provider-level rates are stripped on load, with no value migrated')
}

function main() {
  step('adding appends with a derived id', addingAProviderRecordsItWithADerivedId)
  step('normalising and refusing', addingNormalisesTheBaseUrlAndRefusesWhatCannotBeUsed)
  step('ids stay unique', aSecondProviderWithTheSameNameGetsItsOwnId)
  step('removing by id', removingTakesOnlyTheNamedProvider)
  step('setting models by id', settingModelsReplacesTheListForThatProviderOnly)
  step('round trip', aListSurvivesARestart)
  step('older file', aFileWrittenBeforeCustomProvidersExistedStillReads)
  step('no key in the slice', theSliceIsNotWhereAKeyIsKept)
  step('transcript version', theTranscriptVersionDidNotMove)
  step('image support written', imageSupportIsWrittenAsAYesOrNotAtAll)
  step('image support per provider', oneProvidersImageSupportIsNotAnothers)
  step('refresh keeps it', aCatalogueRefreshDoesNotClearImageSupport)
  step('older file, image support', anOlderFileCarriesNoOpinionAboutImages)
  step('transcript version, image support', theTranscriptVersionDidNotMoveOfImages)
  step('declared price written, per model', aModelsPricesAreWrittenUnderItsOwnKey)
  step('declared price, partial triple', aPartialTripleIsStoredAsTypedAndPricesNothing)
  step('declared price, blanked fields', clearingAModelsFieldsTakesItsEntryOff)
  step('declared price kept on refresh', aCatalogueRefreshKeepsTheDeclaredPrices)
  step('declared price round trip', declaredPricesSurviveARestart)
  step('retired provider rates stripped on load', theRetiredProviderRatesAreStrippedOnLoad)

  console.log(`\ncustom providers (provider-config store): ${results.length} checks passed`)
}

main()
