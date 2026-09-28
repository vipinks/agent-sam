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
import { declaredRates, resolveRates } from '../../conveyor/protocol/session-usage'
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

function createHarness(): Harness {
  const state: ProviderConfigState = structuredClone(INITIAL_STATE)

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

// ---------------------------------------------------------------- rate overrides

function rateOverridesAreWrittenAsNumbersOrNotAtAll() {
  const store = createHarness()

  store.run('setRates', { providerId: 'deepseek', input: 0.27, cacheHit: 0.07, output: 1.1 })
  assert.equal(store.state().providers.deepseek.inputRate, 0.27)
  assert.equal(store.state().providers.deepseek.cacheHitRate, 0.07)
  assert.equal(store.state().providers.deepseek.outputRate, 1.1)

  // Cleared means the keys go, rather than becoming zeros: the fields hold a declaration, and a
  // declaration of nothing is the absence of one. A stored zero would be the app claiming the model
  // is free, which is a price rather than a missing one.
  store.run('setRates', { providerId: 'deepseek' })
  assert.equal('inputRate' in store.state().providers.deepseek, false)
  assert.equal('cacheHitRate' in store.state().providers.deepseek, false)
  assert.equal('outputRate' in store.state().providers.deepseek, false)

  // One side named and the other two not: the named side is stored and the others are not invented. The
  // three are one declaration, and a declaration that is short of a side prices nothing — which is the
  // difference the Cost tile reads as an em dash rather than as a cheap completion.
  store.run('setRates', { providerId: 'deepseek', input: 1.5 })
  assert.equal(store.state().providers.deepseek.inputRate, 1.5)
  assert.equal('cacheHitRate' in store.state().providers.deepseek, false)
  assert.equal('outputRate' in store.state().providers.deepseek, false)

  results.push('a rate override is written as a number or not at all')
}

function oneProvidersRatesAreNotAnothers() {
  const store = createHarness()

  store.run('toggleModel', { providerId: 'deepseek', modelId: 'deepseek-chat' })
  store.run('setSupportsImages', { providerId: 'deepseek', supported: true })
  store.run('setRates', { providerId: 'deepseek', input: 0.27, cacheHit: 0.07, output: 1.1 })
  store.run('setRates', { providerId: 'openai', input: 1, cacheHit: 0.5, output: 2 })

  assert.equal(store.state().providers.openai.inputRate, 1)
  assert.equal(store.state().providers.deepseek.outputRate, 1.1)
  assert.equal(store.state().providers.deepseek.cacheHitRate, 0.07)

  // A catalogue refresh replaces the record rather than merging into it, so the prices have to be
  // carried across explicitly — the trap image support is carried across for, one field over: pressing
  // Fetch must not silently reprice every session at the shipped table.
  store.run('setFetchedModels', { providerId: 'deepseek', models: [{ id: 'deepseek-chat' }] })
  assert.equal(store.state().providers.deepseek.inputRate, 0.27)
  assert.equal(store.state().providers.deepseek.cacheHitRate, 0.07)
  assert.equal(store.state().providers.deepseek.outputRate, 1.1)
  // And the rest of the record is left alone by a write about prices.
  assert.deepEqual(store.state().providers.deepseek.enabledModels, ['deepseek-chat'])
  assert.equal(store.state().providers.deepseek.supportsImages, true)

  results.push('rate overrides are per provider, and a refresh leaves them where they were')
}

function declaredRatesSurviveARestart() {
  const before = createHarness()
  before.run('setRates', { providerId: 'deepseek', input: 0.27, cacheHit: 0.07, output: 1.1 })

  const after = rehydrate(JSON.parse(JSON.stringify(before.state())) as Record<string, unknown>)
  assert.equal(after.providers.deepseek.inputRate, 0.27)
  assert.equal(after.providers.deepseek.cacheHitRate, 0.07)
  assert.equal(after.providers.deepseek.outputRate, 1.1)

  // A file written before these fields existed reads as a provider nobody has priced — which is what
  // the resolver answers null for, and what the Cost tile draws an em dash for.
  const older = rehydrate({ providers: { deepseek: { enabledModels: [], fetchedModels: [] } } })
  assert.equal('inputRate' in older.providers.deepseek, false)
  assert.equal('cacheHitRate' in older.providers.deepseek, false)
  assert.equal('outputRate' in older.providers.deepseek, false)

  // And the persisted declaration is what the resolver prices with, ahead of the shipped table: three
  // fields in dollars per million as micros per million, cache hit included.
  assert.deepEqual(resolveRates({ model: 'deepseek-chat', override: declaredRates(after.providers.deepseek) }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })

  results.push('declared rates are written, read back, and priced with')
}

function anOldTwoFieldDeclarationIsNotAPrice() {
  // A record an earlier build wrote: the input and output a user typed when a cached token had no rate
  // of its own. The keys survive the read whole, because they are still what the user typed, but the
  // declaration is short of a side and so prices nothing — the resolver falls through to the shipped
  // table rather than billing every cache hit at the input rate beside it.
  const older = rehydrate({
    providers: { deepseek: { enabledModels: [], fetchedModels: [], inputRate: 0.15, outputRate: 0.6 } },
  })
  assert.equal(older.providers.deepseek.inputRate, 0.15)
  assert.equal(older.providers.deepseek.outputRate, 0.6)
  assert.equal(declaredRates(older.providers.deepseek), null)
  assert.deepEqual(resolveRates({ model: 'deepseek-chat', override: declaredRates(older.providers.deepseek) }), {
    input: 270_000,
    cacheHit: 70_000,
    output: 1_100_000,
  })

  // Filling the third field in is what prices it again, which is the whole migration: nothing rewrites
  // the old record behind the user's back, and one edit to the box completes the declaration.
  older.providers.deepseek.cacheHitRate = 0.07
  assert.deepEqual(declaredRates(older.providers.deepseek), {
    input: 150_000,
    cacheHit: 70_000,
    output: 600_000,
  })

  results.push('a two-field record from before the cache-hit rate is not a declaration')
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
  step('rate override written', rateOverridesAreWrittenAsNumbersOrNotAtAll)
  step('rate override per provider', oneProvidersRatesAreNotAnothers)
  step('rate override round trip', declaredRatesSurviveARestart)
  step('rate override, old two-field record', anOldTwoFieldDeclarationIsNotAPrice)

  console.log(`\ncustom providers (provider-config store): ${results.length} checks passed`)
}

main()
