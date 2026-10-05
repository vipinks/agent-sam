/**
 * Verifies the two appearance preferences: their defaults, the sizes the control offers, and the store
 * that holds them.
 *
 * The defaults are the whole subject here, and asserted the hard way. A display preference that ships on
 * anything other than today's rendering is a redesign smuggled in behind a settings section, so the class
 * the default preset paints with is held against the class a message body carries today — spelled as a
 * literal in this file on purpose, because it is the one fact here that must not be derived from the code
 * it is checking.
 *
 * The refusals are asserted twice, the way `context-preferences` asserts its percent: once through the pure
 * check the Settings control narrows its value with, and once through the action's schema, which is the
 * boundary a payload actually crosses. A store whose schema accepted an id the check refuses would make the
 * control's own option list a lie.
 *
 * The last case is the mirror's half: what main would write to the store's file and what a window receives
 * is the state after a JSON round trip, so a prefixed or folded id would be a preference that survived a
 * launch and no longer parsed.
 */
import { strict as assert } from 'node:assert'
import {
  BUBBLE_ALIGNMENTS,
  BUBBLE_ALIGNMENT_LABELS,
  checkAppearance,
  DEFAULT_BUBBLE_ALIGNMENT,
  DEFAULT_FONT_PRESET,
  FONT_PRESET_IDS,
  FONT_PRESETS,
  type BubbleAlignment,
  type FontPresetId,
} from '../../conveyor/protocol/appearance'
import {
  appearancePreferencesStore,
  type AppearancePreferencesState,
} from '../../conveyor/stores/appearance-preferences'

const results: string[] = []

/** The size a message body has always been drawn at, as the class the bubble carries. */
const TODAYS_BODY_CLASS = 'text-[13px]'

/** The four sizes the control offers, in the order it offers them. */
const DECLARED_SIZES = [12.5, 13, 15, 17]

/** The state the store starts from, exactly as the store runtime hands it to main. */
const INITIAL_STATE = (appearancePreferencesStore as unknown as { initialState: AppearancePreferencesState })
  .initialState

/** The pixel size a preset's class spells, read back off the class rather than taken on trust. */
function pixelsIn(sizeClass: string): number {
  const spelled = /^text-\[([\d.]+)px\]$/.exec(sizeClass)
  assert.notEqual(spelled, null, `${sizeClass} is not a fixed pixel size class`)
  return Number(spelled?.[1])
}

/** A store of its own, so one case cannot leak a choice into the next. */
function store() {
  const state: AppearancePreferencesState = structuredClone(INITIAL_STATE)
  return {
    state: () => state,
    alignment: (alignment: BubbleAlignment) => {
      appearancePreferencesStore.actions.setAlignment(state, { alignment })
    },
    fontPreset: (preset: FontPresetId) => {
      appearancePreferencesStore.actions.setFontPreset(state, { preset })
    },
  }
}

// ---------------------------------------------------------------- the defaults

function theDefaultsAreTodaysRendering() {
  assert.equal(DEFAULT_BUBBLE_ALIGNMENT, 'split', 'a launch splits the two sides')
  assert.equal(INITIAL_STATE.alignment, DEFAULT_BUBBLE_ALIGNMENT, 'and the store starts there')
  assert.equal(DEFAULT_FONT_PRESET, 'default')
  assert.equal(INITIAL_STATE.fontPreset, DEFAULT_FONT_PRESET, 'a launch paints at the default preset')

  // The one assertion this phase exists for: the default preset is the size the chat body has always
  // been drawn at, class for class, so a user who never opens Settings reads an unchanged transcript.
  assert.equal(
    FONT_PRESETS[DEFAULT_FONT_PRESET].sizeClass,
    TODAYS_BODY_CLASS,
    'the default preset is the message size a conversation already has'
  )
  assert.equal(pixelsIn(FONT_PRESETS[DEFAULT_FONT_PRESET].sizeClass), 13, 'which is thirteen pixels')

  // And both defaults are a pair the check accepts, so a launch is never running on a state the control
  // would refuse to save back.
  const checked = checkAppearance({ alignment: DEFAULT_BUBBLE_ALIGNMENT, fontPreset: DEFAULT_FONT_PRESET })
  assert.equal(checked.ok, true)
  results.push('the defaults are split alignment at the message size already in use')
}

// ---------------------------------------------------------------- the ladder

function thePresetsAreTheDeclaredSizes() {
  assert.deepEqual([...FONT_PRESET_IDS], ['small', 'default', 'large', 'largest'], 'four presets, smallest first')
  assert.deepEqual(
    FONT_PRESET_IDS.map((id) => FONT_PRESETS[id].pixels),
    DECLARED_SIZES,
    'at the four declared sizes'
  )

  const labels = FONT_PRESET_IDS.map((id) => FONT_PRESETS[id].label)
  assert.equal(new Set(labels).size, labels.length, 'two presets cannot share one name')
  assert.equal(
    labels.every((label) => label.trim() !== ''),
    true
  )

  // Each class spells its own preset's size, so the two declarations of one number cannot drift: a preset
  // whose class says a different size than its pixels would paint something the control does not name.
  for (const id of FONT_PRESET_IDS) {
    assert.equal(pixelsIn(FONT_PRESETS[id].sizeClass), FONT_PRESETS[id].pixels, `${id} paints the size it declares`)
  }
  results.push('the four presets are the declared sizes, each class spelling its own')
}

// ---------------------------------------------------------------- the check

function theCheckRefusesUnknownIdsByField() {
  for (const alignment of BUBBLE_ALIGNMENTS) {
    for (const fontPreset of FONT_PRESET_IDS) {
      const checked = checkAppearance({ alignment, fontPreset })
      assert.equal(checked.ok, true)
      assert.equal(checked.ok === true ? checked.alignment : null, alignment)
      assert.equal(checked.ok === true ? checked.fontPreset : null, fontPreset)
    }
  }

  const badAlignment = checkAppearance({ alignment: 'left', fontPreset: DEFAULT_FONT_PRESET })
  assert.equal(badAlignment.ok, false)
  assert.equal(badAlignment.ok === false ? badAlignment.field : null, 'alignment')
  assert.equal(badAlignment.ok === false ? badAlignment.message.includes('Same side') : false, true)

  // An absent id is refused as its own field rather than as a default: a state that named no alignment is
  // not a state this app will paint, and the field is what the control is told.
  const missingAlignment = checkAppearance({ fontPreset: DEFAULT_FONT_PRESET })
  assert.equal(missingAlignment.ok, false)
  assert.equal(missingAlignment.ok === false ? missingAlignment.field : null, 'alignment')

  const badPreset = checkAppearance({ alignment: 'same-side', fontPreset: 'huge' })
  assert.equal(badPreset.ok, false)
  assert.equal(badPreset.ok === false ? badPreset.field : null, 'fontPreset')
  assert.equal(badPreset.ok === false ? badPreset.message.includes('Largest') : false, true)

  // A bad preset is refused after a good alignment, so the two fields are checked in one order whatever
  // else is wrong with the pair.
  const bothBad = checkAppearance({ alignment: 'right', fontPreset: 'huge' })
  assert.equal(bothBad.ok === false ? bothBad.field : null, 'alignment', 'the first refusal is the first field')

  assert.equal(BUBBLE_ALIGNMENT_LABELS[BUBBLE_ALIGNMENTS[0]], 'Split', 'the offered words are declared beside the ids')
  results.push('the check refuses an unknown id by field, absent ids included')
}

// ---------------------------------------------------------------- the store

function theActionsStoreEachChoice() {
  const harness = store()

  harness.alignment('same-side')
  assert.equal(harness.state().alignment, 'same-side')

  harness.fontPreset('largest')
  assert.equal(harness.state().fontPreset, 'largest')

  harness.alignment('split')
  harness.fontPreset('small')
  assert.equal(harness.state().alignment, 'split')
  assert.equal(harness.state().fontPreset, 'small')
  results.push('each action stores the choice it is handed')
}

function theSchemasAreTheSameIds() {
  const schemas = appearancePreferencesStore.schemas as unknown as Record<
    string,
    { safeParse: (value: unknown) => { success: boolean } }
  >

  for (const alignment of BUBBLE_ALIGNMENTS) {
    assert.equal(schemas.setAlignment.safeParse({ alignment }).success, true)
  }
  assert.equal(schemas.setAlignment.safeParse({ alignment: 'left' }).success, false, 'an id nobody offers is refused')
  assert.equal(schemas.setAlignment.safeParse({}).success, false, 'an absent alignment is refused')

  for (const preset of FONT_PRESET_IDS) {
    assert.equal(schemas.setFontPreset.safeParse({ preset }).success, true)
  }
  assert.equal(schemas.setFontPreset.safeParse({ preset: 'huge' }).success, false)
  assert.equal(schemas.setFontPreset.safeParse({ preset: 15 }).success, false, 'a size is not an id')

  assert.equal(appearancePreferencesStore.id, 'appearance-preferences')
  assert.equal(appearancePreferencesStore.persist, true, 'a preference is written to the store own file')
  assert.deepEqual(Object.keys(INITIAL_STATE), ['alignment', 'fontPreset'], 'two keys, both named here')
  results.push('the action schemas enforce the same ids the control offers')
}

function theChoiceSurvivesAMirrorRoundTrip() {
  const harness = store()
  harness.alignment('same-side')
  harness.fontPreset('large')

  // What main writes and what a window receives: the same state, through JSON and no longer carrying the
  // definition's own objects. A preference is only a preference if it comes back as itself.
  const mirrored = JSON.parse(JSON.stringify(harness.state())) as AppearancePreferencesState
  assert.deepEqual(mirrored, { alignment: 'same-side', fontPreset: 'large' })

  const checked = checkAppearance({ alignment: mirrored.alignment, fontPreset: mirrored.fontPreset })
  assert.equal(checked.ok, true, 'and the round-tripped pair is still one the check accepts')
  assert.equal(checked.ok === true ? checked.alignment : null, 'same-side')
  assert.equal(checked.ok === true ? checked.fontPreset : null, 'large')
  results.push('a stored choice survives the mirror as the ids it was written as')
}

// ---------------------------------------------------------------- main

async function main() {
  theDefaultsAreTodaysRendering()
  thePresetsAreTheDeclaredSizes()
  theCheckRefusesUnknownIdsByField()
  theActionsStoreEachChoice()
  theSchemasAreTheSameIds()
  theChoiceSurvivesAMirrorRoundTrip()

  console.log(`appearance preferences: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('APPEARANCE PREFERENCES TEST FAILED:', err)
  process.exit(1)
})
