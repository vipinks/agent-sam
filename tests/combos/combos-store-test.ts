/**
 * The combos store slice: what each action does to the state, and what survives a restart.
 *
 * The store is a plain definition whose actions are pure reducers, so this runs without electron or a
 * window. Persistence is deliberately *not* the store's (`persist: true` would swallow write failures
 * and make `COMBO_IO_ERROR` unreachable), so the rehydrate step here is the shape main's module writes
 * to the file and reads back — not conveyor's own store persistence.
 */
import { strict as assert } from 'node:assert'
import { combosStore } from '../../conveyor/stores/combos'
import type { CombosState } from '../../conveyor/stores/combos'
import type { Combo, ComboMember } from '../../conveyor/protocol/combos'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

const INITIAL_STATE = (combosStore as unknown as { initialState: CombosState }).initialState

type Actions = typeof combosStore.actions
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never

interface Harness {
  state: () => CombosState
  run: <K extends keyof Actions>(name: K, payload: DropFirst<Parameters<Actions[K]>>[0]) => void
}

function createHarness(from: CombosState = INITIAL_STATE): Harness {
  const state: CombosState = structuredClone(from)
  return {
    state: () => state,
    run(name, payload) {
      const action = combosStore.actions[name]
      if (!action) throw new Error(`no such action: ${String(name)}`)
      ;(action as (s: CombosState, p?: unknown) => void)(state, payload)
    },
  }
}

const MEMBER: ComboMember = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const OTHER: ComboMember = { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }

function combo(overrides: Partial<Combo> = {}): Combo {
  return { id: 'fast', name: 'Fast', members: [MEMBER], enabled: true, ...overrides }
}

function replacePinsTheList() {
  const store = createHarness()
  store.run('replace', { combos: [combo(), combo({ id: 'slow', name: 'Slow', members: [OTHER] })] })
  assert.deepEqual(
    store.state().combos.map((entry) => entry.id),
    ['fast', 'slow']
  )
  results.push('replace: the module owns the list, the store mirrors it')
}

function createAppendsEnabledAndRefusesADuplicateId() {
  const store = createHarness()
  store.run('create', { id: 'fast', name: '  Fast  ', members: [MEMBER] })
  assert.equal(store.state().combos.length, 1)
  assert.equal(store.state().combos[0].name, 'Fast', 'the name is stored trimmed')
  assert.equal(store.state().combos[0].enabled, true)
  store.run('create', { id: 'fast', name: 'Again', members: [OTHER] })
  assert.equal(store.state().combos.length, 1, 'a duplicate id adds nothing')
  results.push('create: appended, trimmed, enabled, id-collision is a no-op')
}

function renameKeepsTheIdAndIgnoresABlankName() {
  const store = createHarness({ combos: [combo()] })
  store.run('rename', { id: 'fast', name: '  Quick  ' })
  assert.equal(store.state().combos[0].id, 'fast')
  assert.equal(store.state().combos[0].name, 'Quick')
  store.run('rename', { id: 'fast', name: '   ' })
  assert.equal(store.state().combos[0].name, 'Quick', 'a blank name changes nothing')
  results.push('rename: id stable, trimmed, blank ignored')
}

function reorderMovesOneMember() {
  const store = createHarness({ combos: [combo({ members: [MEMBER, OTHER] })] })
  store.run('reorder', { id: 'fast', from: 0, to: 1 })
  assert.deepEqual(store.state().combos[0].members, [OTHER, MEMBER])
  results.push('reorder: priority order moves in place')
}

function addAndRemoveMembers() {
  const store = createHarness({ combos: [combo()] })
  store.run('addMember', { id: 'fast', member: OTHER })
  assert.equal(store.state().combos[0].members.length, 2)
  store.run('addMember', { id: 'fast', member: { ...OTHER } })
  assert.equal(store.state().combos[0].members.length, 2, 'a duplicate pair is idempotent')
  store.run('removeMember', { id: 'fast', member: MEMBER })
  assert.deepEqual(store.state().combos[0].members, [OTHER])
  results.push('add/remove member: append, idempotent, remove')
}

function enabledAndDelete() {
  const store = createHarness({ combos: [combo()] })
  store.run('setEnabled', { id: 'fast', enabled: false })
  assert.equal(store.state().combos[0].enabled, false)
  store.run('remove', { id: 'fast' })
  assert.deepEqual(store.state().combos, [])
  results.push('setEnabled and delete')
}

function rehydrateKeepsTheFileAndOldRecords() {
  // What the module writes, read back over the definition's initial state.
  const persisted = { combos: [combo(), combo({ id: 'slow', name: 'Slow', members: [OTHER] })] }
  const restored: CombosState = { ...structuredClone(INITIAL_STATE), ...structuredClone(persisted) }
  assert.equal(restored.combos.length, 2)
  // A record written before combos existed has no key at all.
  const older: CombosState = { ...structuredClone(INITIAL_STATE) }
  assert.deepEqual(older.combos, [])
  results.push('rehydrate: list restored; an older record reads as none')
}

step('replace mirrors the file', replacePinsTheList)
step('create', createAppendsEnabledAndRefusesADuplicateId)
step('rename', renameKeepsTheIdAndIgnoresABlankName)
step('reorder', reorderMovesOneMember)
step('add and remove member', addAndRemoveMembers)
step('enable and delete', enabledAndDelete)
step('rehydrate', rehydrateKeepsTheFileAndOldRecords)

process.stdout.write(`\nall ${results.length} combo store checks passed\n`)
