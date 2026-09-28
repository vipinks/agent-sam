/**
 * Verifies the compact-point preference: its default, its bounds, and the store that holds it.
 *
 * The bounds are asserted twice on purpose — once through the pure rule the Settings field will read,
 * and once through the action's schema, which is the boundary a payload actually crosses. A store whose
 * schema accepted a percent the rule refuses would make the field's sentence a lie, and this is the only
 * suite where the two are held together before any UI exists to paper over the difference.
 *
 * The persisted shape is asserted last, in the form the file is written in: the store's own initial
 * state, read the way main reads it, so a launch with no saved file comes up on the documented default
 * rather than on whatever the definition's literal happened to be.
 */
import { strict as assert } from 'node:assert'
import { contextPreferencesStore, type ContextPreferencesState } from '../../conveyor/stores/context-preferences'
import {
  checkCompactPoint,
  DEFAULT_COMPACT_PERCENT,
  MAX_COMPACT_PERCENT,
  MIN_COMPACT_PERCENT,
} from '../../conveyor/protocol/context-window'

const results: string[] = []

/** The state the store starts from, exactly as the store runtime hands it to main. */
const INITIAL_STATE = (contextPreferencesStore as unknown as { initialState: ContextPreferencesState }).initialState

/** A store of its own, so one case cannot leak a percent into the next. */
function store() {
  const state: ContextPreferencesState = structuredClone(INITIAL_STATE)
  return {
    state: () => state,
    run: (payload: { percent: number }) => {
      contextPreferencesStore.actions.setCompactPoint(state, payload)
    },
  }
}

// ---------------------------------------------------------------- the default

function theDefaultIsInsideItsOwnBounds() {
  assert.equal(DEFAULT_COMPACT_PERCENT, 70, 'the documented default is seventy percent')
  assert.equal(INITIAL_STATE.compactPoint, DEFAULT_COMPACT_PERCENT, 'a launch with no saved file starts there')

  // And it is a percent the rule would accept, so a user who never opens Settings is not running with a
  // value the field would refuse to save back.
  const checked = checkCompactPoint(String(DEFAULT_COMPACT_PERCENT))
  assert.equal(checked.ok, true)
  assert.equal(checked.ok === true ? checked.value : -1, DEFAULT_COMPACT_PERCENT)
  results.push('the default sits inside its own bounds')
}

// ---------------------------------------------------------------- the action

function thePercentIsStored() {
  const harness = store()

  harness.run({ percent: MIN_COMPACT_PERCENT })
  assert.equal(harness.state().compactPoint, 50)

  harness.run({ percent: MAX_COMPACT_PERCENT })
  assert.equal(harness.state().compactPoint, 95, 'the ceiling is a percent the action accepts')

  harness.run({ percent: 70 })
  assert.equal(harness.state().compactPoint, 70)
  results.push('the action stores the percent it is handed')
}

function theSchemaIsTheSameBound() {
  // The payload schema is the boundary a renderer's value crosses, so it carries the same two numbers
  // the field rule carries — a caller that skipped the field must not be able to store 96.
  const schema = (
    contextPreferencesStore.schemas as unknown as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } }
    >
  ).setCompactPoint

  assert.equal(schema.safeParse({ percent: MIN_COMPACT_PERCENT }).success, true)
  assert.equal(schema.safeParse({ percent: MAX_COMPACT_PERCENT }).success, true)
  assert.equal(schema.safeParse({ percent: MIN_COMPACT_PERCENT - 1 }).success, false, '49 is below the floor')
  assert.equal(schema.safeParse({ percent: MAX_COMPACT_PERCENT + 1 }).success, false, '96 is above the ceiling')
  assert.equal(schema.safeParse({ percent: 70.5 }).success, false, 'a percent is a whole number')
  assert.equal(schema.safeParse({ percent: '70' }).success, false, 'a percent that is not a number is refused')
  results.push('the action schema enforces the same bounds as the field rule')
}

// ---------------------------------------------------------------- persistence

function theStoreIsThePreferencesOne() {
  // A name, a persisted slice and no payload-free escape: the shape `terminal-preferences` has, which is
  // what the Settings section will read next turn.
  assert.equal(contextPreferencesStore.id, 'context-preferences')
  assert.equal(contextPreferencesStore.persist, true, 'a preference is written to the store own file')

  // One key and one key only: a preference added here has to be named in the state type both processes
  // share, and a suite that asserted the whole object would resist exactly that.
  assert.deepEqual(Object.keys(INITIAL_STATE), ['compactPoint'])
  results.push('the preferences store holds one persisted, bounded percent')
}

// ---------------------------------------------------------------- main

async function main() {
  theDefaultIsInsideItsOwnBounds()
  thePercentIsStored()
  theSchemaIsTheSameBound()
  theStoreIsThePreferencesOne()

  console.log(`context preferences store: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CONTEXT PREFERENCES STORE TEST FAILED:', err)
  process.exit(1)
})
