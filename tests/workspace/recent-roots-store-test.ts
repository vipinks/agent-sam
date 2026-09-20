/**
 * Verifies the workspace store slice's recents behaviour against its own actions.
 *
 * The store is a plain definition object and its actions are pure `(state, payload)` reducers, so the
 * lifecycle can be exercised without electron, without a window, and without the IPC broadcast — by
 * calling the action directly against a state object, exactly as the store runtime does.
 *
 * This is the layer the rule tests cannot reach and the DOM tests deliberately do not: the menu asks
 * the store to act, and this is what acting *means*. The two things asserted here that the rules alone
 * do not cover are that opening and remembering are one event, and that forgetting the open root
 * leaves it open — the pair that decides whether a user can lose their place by tidying the menu.
 *
 * Nothing to clean up afterwards: the harness clones its state and never touches a disk.
 */
import { strict as assert } from 'node:assert'
import { workspaceStore } from '../../conveyor/stores/workspace'
import type { WorkspaceState } from '../../conveyor/stores/workspace'
import { MAX_RECENT_ROOTS } from '../../conveyor/protocol/recent-roots'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

/**
 * The store runtime names the initial state `initialState`; the authoring config calls it `state`.
 * Reading it here means the harness starts from exactly what main would start from.
 */
const INITIAL_STATE = (workspaceStore as unknown as { initialState: WorkspaceState }).initialState

type Actions = typeof workspaceStore.actions

interface Harness {
  state: () => WorkspaceState
  run: <K extends keyof Actions>(name: K, ...payload: DropFirst<Parameters<Actions[K]>>) => void
  seed: (patch: Partial<WorkspaceState>) => void
}

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never

/**
 * A fresh slice per test, cloned from the store definition's own initial state so a test cannot mutate
 * the definition and leak into the next one.
 */
function createHarness(): Harness {
  const state: WorkspaceState = structuredClone(INITIAL_STATE)

  return {
    state: () => state,
    seed(patch) {
      Object.assign(state, structuredClone(patch))
    },
    run(name, ...payload) {
      const action = workspaceStore.actions[name]
      if (!action) throw new Error(`no such action: ${String(name)}`)
      ;(action as (s: WorkspaceState, p?: unknown) => void)(state, payload[0])
    },
  }
}

const SAM = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'

// ---------------------------------------------------------------- opening

function openingAFolderMakesItTheMostRecentAndTheOpenOne() {
  const store = createHarness()

  store.run('setRootPath', NOTES)
  store.run('setRootPath', SAM)

  assert.equal(store.state().rootPath, SAM, 'the second folder is the open one')
  assert.deepEqual(store.state().recentRoots, [SAM, NOTES], 'and the most recent, with the first behind it')
  results.push('opening a folder sets the root and remembers it, most recent first')
}

function reopeningAFolderMovesItRatherThanDuplicatingIt() {
  const store = createHarness()

  store.run('setRootPath', SAM)
  store.run('setRootPath', NOTES)
  store.run('setRootPath', SAM)

  assert.deepEqual(store.state().recentRoots, [SAM, NOTES], 'a folder is listed once, in its newest place')
  results.push('reopening a folder moves it to the front instead of listing it twice')
}

function theCaseSpellingDoesNotCreateASecondEntry() {
  const store = createHarness()

  store.run('setRootPath', SAM)
  store.run('setRootPath', 'c:/WORK/sam-ai')

  assert.equal(store.state().recentRoots.length, 1, 'one folder, one row, whichever case it arrived in')
  assert.equal(store.state().rootPath, 'c:/WORK/sam-ai', 'and the spelling just opened is what is open')
  results.push('a differently-cased spelling is the same folder: one entry, moved to the front')
}

function theListIsCapped() {
  const store = createHarness()

  for (let i = 0; i < MAX_RECENT_ROOTS + 3; i += 1) store.run('setRootPath', `C:/work/p${i}`)

  const state = store.state()
  assert.equal(state.recentRoots.length, MAX_RECENT_ROOTS, 'the cap holds however many folders are opened')
  assert.equal(state.recentRoots[0], `C:/work/p${MAX_RECENT_ROOTS + 2}`, 'the newest is at the front')
  assert.ok(!state.recentRoots.includes('C:/work/p0'), 'and the oldest has been dropped')
  results.push(`the list holds at most ${MAX_RECENT_ROOTS} folders, dropping the oldest`)
}

function closingTheFolderLeavesTheListIntact() {
  const store = createHarness()

  store.run('setRootPath', SAM)
  store.run('setRootPath', NOTES)
  store.run('setRootPath', null)

  assert.equal(store.state().rootPath, null, 'no folder is open')
  // "No folder" is not a folder anyone wants offered back, so it is not remembered — and the folders
  // that were opened are still there to return to.
  assert.deepEqual(store.state().recentRoots, [NOTES, SAM])
  results.push('clearing the root remembers nothing and keeps the list')
}

// ---------------------------------------------------------------- forgetting

function forgettingRemovesOnlyThatEntry() {
  const store = createHarness()

  store.run('setRootPath', 'C:/work/archive')
  store.run('setRootPath', SAM)

  store.run('forgetRoot', 'C:/work/archive')

  assert.deepEqual(store.state().recentRoots, [SAM], 'the entry is gone and the rest kept their order')
  results.push('forgetting a folder removes it from the list')
}

function forgettingDoesNotSwitch() {
  const store = createHarness()

  store.run('setRootPath', NOTES)
  store.run('setRootPath', SAM)

  store.run('forgetRoot', NOTES)

  assert.equal(store.state().rootPath, SAM, 'forgetting is not a switch')
  results.push('forgetting a folder does not change which one is open')
}

function forgettingTheOpenFolderLeavesItOpen() {
  const store = createHarness()

  store.run('setRootPath', NOTES)
  store.run('setRootPath', SAM)

  // The case worth stating outright: the folder on screen stays browsable until another is opened, so
  // tidying the menu can never take the workspace away from under the tree that is showing it.
  store.run('forgetRoot', SAM)

  assert.equal(store.state().rootPath, SAM, 'the open folder stays open with no entry in the list')
  assert.deepEqual(store.state().recentRoots, [NOTES])
  results.push('forgetting the open folder leaves it open, and drops only its menu entry')
}

function forgettingComparesCaseInsensitively() {
  const store = createHarness()

  store.run('setRootPath', SAM)
  store.run('forgetRoot', 'c:/WORK/sam-ai')

  assert.deepEqual(store.state().recentRoots, [], 'the entry is removed however it is cased')
  results.push('a forget is matched the way a remember is: case-insensitively')
}

function forgettingSomethingAbsentChangesNothing() {
  const store = createHarness()

  store.run('setRootPath', SAM)
  store.run('forgetRoot', NOTES)

  assert.deepEqual(store.state().recentRoots, [SAM], 'an entry that was not listed costs nothing')
  results.push('forgetting a folder that is not listed leaves the list alone')
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('open: remembers', openingAFolderMakesItTheMostRecentAndTheOpenOne)
  await step('open: moves', reopeningAFolderMovesItRatherThanDuplicatingIt)
  await step('open: case', theCaseSpellingDoesNotCreateASecondEntry)
  await step('open: capped', theListIsCapped)
  await step('open: cleared', closingTheFolderLeavesTheListIntact)
  await step('forget: removes', forgettingRemovesOnlyThatEntry)
  await step('forget: no switch', forgettingDoesNotSwitch)
  await step('forget: open root', forgettingTheOpenFolderLeavesItOpen)
  await step('forget: case', forgettingComparesCaseInsensitively)
  await step('forget: absent', forgettingSomethingAbsentChangesNothing)

  console.log(`recent roots store: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('RECENT ROOTS STORE TEST FAILED:', err)
  process.exit(1)
})
