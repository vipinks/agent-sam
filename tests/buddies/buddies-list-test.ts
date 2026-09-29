/**
 * Verifies the two rules the Buddies screen is drawn from: the rows a list offers, and what a
 * conversation's Buddy is called when the record behind it is gone.
 *
 * Both are pure and both are read by a surface that arrives after them, which is why they are asserted
 * here rather than through a screen: what a settings list shows and what a session badge says have to be
 * right before either exists. The rules are the whole subject — no electron, no disk, no window.
 *
 * Three laws this suite exists to hold, each one a thing a later turn could quietly break:
 *
 * - the built-ins are always the first three, in their own fixed order, and a custom record can never
 *   displace one;
 * - the SamAi default is *not* a row, because it is the app's own behavior rather than one choice among
 *   several — while an absent id still has to be *called* something, which is what the label rule is for;
 * - switching a Buddy off takes it out of the offerable set without taking it out of the list, because the
 *   settings screen has to be able to switch it back on.
 */
import { strict as assert } from 'node:assert'
import {
  buddyLabel,
  BUILTIN_BUDDIES,
  checkBuddy,
  listBuddies,
  MAX_BUDDY_NAME_CHARS,
  MAX_BUDDY_ROLE_PROMPT_CHARS,
  MAX_BUDDY_STARTERS,
  REMOVED_BUDDY_LABEL,
  SAMAI_BUDDY_ID,
  SAMAI_BUDDY_NAME,
  type BuddyRecord,
} from '../../conveyor/protocol/buddies'

const results: string[] = []

// ---------------------------------------------------------------- fixtures

/** A custom record that declares everything a record may declare. */
function custom(overrides: Partial<BuddyRecord> = {}): BuddyRecord {
  return {
    id: 'release-captain',
    name: 'Release Captain',
    glyph: 'R',
    description: 'Ships the thing and says what shipped.',
    rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
    skillIds: ['release-notes'],
    mcpIds: ['github'],
    starters: ['Cut a release', 'What changed since the last tag?'],
    builtin: false,
    ...overrides,
  }
}

/** A second custom record, so "by creation order" has two orders to tell apart. */
function secondCustom(): BuddyRecord {
  return custom({ id: 'pair-reviewer', name: 'Pair Reviewer', glyph: 'P' })
}

/** The store state the list rule reads, as `conveyor/stores/buddies.ts` holds it. */
function storeState(customs: readonly BuddyRecord[], disabledIds: readonly string[] = []) {
  return { custom: [...customs], disabledIds: [...disabledIds] }
}

// ---------------------------------------------------------------- rows

/**
 * The built-ins are the first three, in the order the module declares them.
 *
 * Asserted as the sequence of ids rather than as a count, because the order is what the screen draws and
 * a fourth built-in added later has to be a deliberate edit here rather than a row that quietly moved.
 */
function theBuiltInsComeFirstInTheirOwnOrder() {
  const rows = listBuddies(storeState([custom(), secondCustom()]))

  assert.deepEqual(
    rows.map((row) => row.id),
    [...BUILTIN_BUDDIES.map((buddy) => buddy.id), 'release-captain', 'pair-reviewer'],
    'the three built-ins lead, and the customs follow'
  )
  assert.equal(rows.length, BUILTIN_BUDDIES.length + 2, 'every record is a row')
  results.push('the list leads with the three built-ins in their fixed order, then the customs')
}

/** A row carries what a row is drawn from, and says which kind of record it is. */
function aRowCarriesTheRecordsOwnFields() {
  const rows = listBuddies(storeState([custom()]))
  const writer = rows[0]
  const mine = rows[rows.length - 1]

  assert.equal(writer.id, 'writer-editor', 'a built-in row is the record the module holds')
  assert.equal(writer.name, BUILTIN_BUDDIES[0].name, 'the row states the record’s name')
  assert.equal(writer.glyph, BUILTIN_BUDDIES[0].glyph, 'and the mark beside it')
  assert.equal(writer.builtin, true, 'a built-in row says it is one')

  assert.equal(mine.name, 'Release Captain', 'a custom row states its own name')
  assert.equal(mine.glyph, 'R', 'and its own mark')
  assert.equal(mine.builtin, false, 'and does not claim to be the app’s')

  // The default is absent by design: it is the app's own behavior, not a choice to be listed, disabled or
  // deleted beside the others.
  assert.equal(
    rows.some((row) => row.id === SAMAI_BUDDY_ID),
    false,
    'the SamAi default is not a row'
  )
  results.push('each row carries its id, name, glyph and built-in flag, and the default is not a row')
}

/** A custom record's creation order is the store's array order, and the list keeps it. */
function theCustomsFollowInCreationOrder() {
  const first = custom()
  const second = secondCustom()
  // The store holds them in the order they were added; the list reads that order rather than sorting by
  // name or by id, because "where the one I just made went" is the row a user looks for.
  const rows = listBuddies(storeState([first, second]))
  assert.deepEqual(
    rows.slice(BUILTIN_BUDDIES.length).map((row) => row.id),
    [first.id, second.id],
    'the customs keep the order they were created in'
  )

  const reversed = listBuddies(storeState([second, first]))
  assert.deepEqual(
    reversed.slice(BUILTIN_BUDDIES.length).map((row) => row.id),
    [second.id, first.id],
    'and that order is the store’s, not the module’s'
  )
  results.push('custom rows follow the creation order the store holds, not a sort')
}

// ---------------------------------------------------------------- switches

/**
 * A switched-off Buddy stays in the list with `enabled: false`, and is not offerable.
 *
 * The two halves are the whole point of keeping the switches as ids: the list has to show the row so it
 * can be switched back on, and a picker reading only the enabled rows has to leave it out. Both are
 * asserted off the one rule, so neither can drift from the other.
 */
function switchedOffRowsStayListedAndStopBeingOfferable() {
  const mine = custom()
  const rows = listBuddies(storeState([mine], [BUILTIN_BUDDIES[1].id, mine.id]))

  assert.equal(rows.length, BUILTIN_BUDDIES.length + 1, 'switching a Buddy off does not remove its row')

  const tutor = rows.find((row) => row.id === BUILTIN_BUDDIES[1].id)
  const customRow = rows.find((row) => row.id === mine.id)
  assert.equal(tutor?.enabled, false, 'a built-in can be switched off')
  assert.equal(customRow?.enabled, false, 'and so can a custom record')

  const on = rows.filter((row) => row.enabled).map((row) => row.id)
  assert.deepEqual(
    on,
    [BUILTIN_BUDDIES[0].id, BUILTIN_BUDDIES[2].id],
    'the offerable rows are the enabled ones, and the two switched off are not among them'
  )

  // An id nobody knows is not an entry that switches anything off: a stale id in the set cannot hide a
  // row that exists.
  const withStale = listBuddies(storeState([mine], ['nobody-by-this-name']))
  assert.equal(
    withStale.every((row) => row.enabled),
    true,
    'a disabled id with no record behind it switches nothing off'
  )
  results.push('a disabled Buddy keeps its row with enabled false and leaves the offerable set')
}

// ---------------------------------------------------------------- labels

/** A name is the record's own, for built-ins and custom records both. */
function aLabelIsTheRecordsName() {
  assert.equal(buddyLabel(BUILTIN_BUDDIES[0].id, []), BUILTIN_BUDDIES[0].name, 'a built-in labels as its name')
  assert.equal(buddyLabel(custom().id, [custom()]), 'Release Captain', 'and so does a custom record')
  results.push('a Buddy id labels as the record’s name, built-in or custom')
}

/** Absent ids, and the default's own id, label as the SamAi default. */
function theDefaultLabelsAsSamAi() {
  assert.equal(SAMAI_BUDDY_NAME, 'SamAi', 'the default is named SamAi')

  for (const absent of [null, undefined, '', SAMAI_BUDDY_ID]) {
    assert.equal(
      buddyLabel(absent, [custom()]),
      SAMAI_BUDDY_NAME,
      `an absent Buddy (${String(absent)}) labels as the default`
    )
  }
  results.push('an absent Buddy and the default’s own id both label as SamAi')
}

/** An id whose custom record is gone labels as removed, and never as the default. */
function aVanishedRecordLabelsAsRemoved() {
  const label = buddyLabel(custom().id, [])

  assert.equal(label, REMOVED_BUDDY_LABEL, 'a custom id with no record behind it labels as removed')
  assert.notEqual(label, SAMAI_BUDDY_NAME, 'which is not the default: the conversation had a Buddy')

  // A built-in is never removed — it is not in the store to delete — so its id still resolves to its name
  // even when the custom list is empty or holds something else entirely.
  assert.equal(
    buddyLabel(BUILTIN_BUDDIES[2].id, [custom()]),
    BUILTIN_BUDDIES[2].name,
    'a built-in resolves whoever else is in the store'
  )
  results.push('an id whose custom record no longer exists labels as removed, not as the default')
}

// ---------------------------------------------------------------- editor drafts

/** The payload the editor hands the rule, as its fields read at the moment Save is pressed. */
function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'release-captain',
    name: 'Release Captain',
    glyph: 'R',
    description: 'Ships the thing and says what shipped.',
    rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
    skillIds: [],
    mcpIds: [],
    starters: [],
    builtin: false,
    ...overrides,
  }
}

/**
 * A draft the editor would refuse is refused *by field*, which is what the editor surfaces.
 *
 * The three refusals asserted here are the three a control answers for: an empty name is the box the user
 * typed in, a role prompt past its cap is the box that has to be shortened rather than truncated, and a
 * draft carrying one starter too many is the list that stops growing. The editor shows the rule's own
 * sentence beside the control the field names, so no word is invented here — what is asserted is the
 * field, which is the thing the screen branches on.
 */
function anEditorDraftIsRefusedByField() {
  const noName = checkBuddy(draft({ name: '' }))
  assert.equal(noName.ok, false, 'an empty name is refused')
  assert.equal(noName.ok === false && noName.field, 'name', 'and the refusal names the name field')

  const longName = checkBuddy(draft({ name: 'n'.repeat(MAX_BUDDY_NAME_CHARS + 1) }))
  assert.equal(longName.ok === false && longName.field, 'name', 'and so does a name past its cap')

  const longRole = checkBuddy(draft({ rolePrompt: 'x'.repeat(MAX_BUDDY_ROLE_PROMPT_CHARS + 1) }))
  assert.equal(longRole.ok, false, 'a role prompt past the cap is refused')
  assert.equal(longRole.ok === false && longRole.field, 'rolePrompt', 'and names the role field')

  // The cap the rule states is `MAX_BUDDY_STARTERS`, so the editor offers that many slots; a draft with a
  // sixth start is the shape the screen cannot produce, and it is refused on the starters field rather
  // than silently trimmed to the four that fit.
  const sixStarters = checkBuddy(draft({ starters: ['one', 'two', 'three', 'four', 'five', 'six'] }))
  assert.equal(MAX_BUDDY_STARTERS, 4, 'the rule’s own cap is four starters')
  assert.equal(sixStarters.ok, false, 'a sixth starter is refused')
  assert.equal(sixStarters.ok === false && sixStarters.field, 'starters', 'and names the starters field')

  // Every refusal carries a sentence, because the editor shows it: a field with nothing to say would leave
  // the user looking at a control they cannot get past and no reason why.
  for (const refused of [noName, longName, longRole, sixStarters]) {
    assert.equal(
      refused.ok === false && refused.message.trim().length > 0,
      true,
      'a refusal says something beside the field'
    )
  }
  results.push('an editor draft is refused by field: empty name, over-long role, too many starters')
}

// ---------------------------------------------------------------- main

async function main() {
  theBuiltInsComeFirstInTheirOwnOrder()
  aRowCarriesTheRecordsOwnFields()
  theCustomsFollowInCreationOrder()
  switchedOffRowsStayListedAndStopBeingOfferable()
  aLabelIsTheRecordsName()
  theDefaultLabelsAsSamAi()
  aVanishedRecordLabelsAsRemoved()
  anEditorDraftIsRefusedByField()

  console.log(`buddy list: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('BUDDY LIST TEST FAILED:', err)
  process.exit(1)
})
