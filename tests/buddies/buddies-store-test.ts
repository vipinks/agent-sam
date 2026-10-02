/**
 * Verifies the persisted store of custom Buddies, and the write a conversation gets at creation.
 *
 * The store is the app's own data beside the protocol's built-ins, and the whole point of the split is
 * that the built-ins are never in it: a store that could hold one would let an update rewrite the
 * Writer/Editor for every user, and a reset would have nowhere to restore it from. So the refusals are
 * the subject here as much as the writes are.
 *
 * The second half is the creation path itself. `ensureSession` in the renderer takes an optional Buddy
 * id and does exactly three things with it — resolve it, take the seed it declares, write that seed
 * onto the new record — and those three are what this suite drives, because the store action is the
 * boundary the fields actually cross and the renderer is a caller of it rather than a second rule.
 *
 * Pure: the store definition is `(state, payload)` functions, so no electron, no window, no disk.
 */
import { strict as assert } from 'node:assert'
import { buddiesStore, type BuddiesState } from '../../conveyor/stores/buddies'
import { buddySessionSeed, resolveBuddy, type BuddyRecord } from '../../conveyor/protocol/buddies'
import { createStoreHarness } from '../sessions/chat-sessions-store-harness'

const results: string[] = []

type Actions = typeof buddiesStore.actions

/**
 * The store's initial state as main would start from, cloned so a case cannot leak into the next.
 *
 * Read off the definition rather than written out here, for the reason the chat-sessions harness reads
 * its own: a state assembled by the test would pass while the shipped initial state disagreed with it.
 */
function createBuddyHarness() {
  const state: BuddiesState = structuredClone((buddiesStore as unknown as { initialState: BuddiesState }).initialState)
  const run = <K extends keyof Actions>(
    name: K,
    ...payload: Parameters<Actions[K]> extends [unknown, ...infer Rest] ? Rest : []
  ): void => {
    const action = buddiesStore.actions[name]
    if (!action) throw new Error(`no such action: ${String(name)}`)
    ;(action as (s: BuddiesState, ...p: unknown[]) => void)(state, ...payload)
  }
  return { state: () => state, run }
}

function uuid(n: number): string {
  const tail = String(n).padStart(12, '0')
  return `11111111-2222-4333-8444-${tail}`
}

/**
 * The payload a write actually carries, derived from the action rather than written out again.
 *
 * Spelled this way on purpose: the store's boundary requires `builtin: false`, so a helper typed as
 * `BuddyRecord` would be a helper that can hand the action something the action does not accept. Taking
 * the type from the action means a change to that boundary fails here rather than being papered over.
 */
type CustomBuddy = Parameters<Actions['addBuddy']>[1]

/** A custom record, as the editor a later turn adds will hand one over. */
function custom(overrides: Partial<CustomBuddy> = {}): CustomBuddy {
  return {
    id: 'release-captain',
    name: 'Release Captain',
    glyph: 'R',
    description: 'Ships the thing and says what shipped.',
    rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
    skillIds: ['release-notes'],
    mcpIds: ['github'],
    starters: ['Cut a release'],
    builtin: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------- the store

function aCustomRecordIsStored() {
  const harness = createBuddyHarness()
  assert.deepEqual(harness.state(), { custom: [], disabledIds: [] }, 'a fresh install holds nothing')

  harness.run('addBuddy', custom())

  assert.deepEqual(harness.state().custom, [custom()], 'the record is stored as it was handed over')
  results.push('a custom record lands in the store')
}

function theBuiltInsAreNeverWritten() {
  const harness = createBuddyHarness()

  // A payload claiming to be built-in is refused at the boundary, which is the only shape of write that
  // could put one in the file. The payload schema is the boundary the renderer actually crosses.
  const payload = (
    buddiesStore.schemas as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>
  ).addBuddy
  assert.equal(payload.safeParse({ ...custom(), builtin: true }).success, false, 'a built-in record is refused')

  // And so is a record claiming a built-in's id: that is the same write by another route, and the
  // built-in is the app's own data rather than one user's copy of it.
  assert.equal(
    payload.safeParse(custom({ id: 'analyst' })).success,
    false,
    "a record claiming a built-in's id is refused"
  )
  assert.equal(
    payload.safeParse(custom({ id: 'samai' })).success,
    false,
    'and one claiming the default, which is not a Buddy at all'
  )

  // Neither refusal is a write, so the store is exactly as it was.
  assert.deepEqual(harness.state(), { custom: [], disabledIds: [] }, 'and neither one is stored')
  results.push('a built-in can never be written to the store')
}

function updatingReplacesTheRecordItNames() {
  const harness = createBuddyHarness()
  harness.run('addBuddy', custom())
  harness.run('addBuddy', custom({ id: 'night-shift', name: 'Night Shift', mcpIds: [] }))

  harness.run('updateBuddy', custom({ name: 'Release Captain (strict)', glyph: 'S' }))

  const stored = harness.state().custom
  assert.equal(stored.length, 2, 'a re-add of a different id adds a row')
  assert.equal(stored[0].name, 'Release Captain (strict)', 'the update replaces the record it names')
  assert.equal(stored[0].glyph, 'S', 'in every field')
  assert.equal(stored[1].name, 'Night Shift', 'and leaves the others alone')

  // An update for an id that is not there changes nothing, which is the shape a stale editor leaves
  // behind: a record deleted in another window while this one was still typing into it.
  const settled = structuredClone(harness.state())
  harness.run('updateBuddy', custom({ id: 'nobody' }))
  assert.deepEqual(harness.state(), settled, 'an update for an unknown id changes nothing')
  results.push('an update replaces the record it names, and only that one')
}

function removingTakesTheRecordAndItsSwitch() {
  const harness = createBuddyHarness()
  harness.run('addBuddy', custom())
  harness.run('addBuddy', custom({ id: 'night-shift', name: 'Night Shift' }))
  harness.run('setBuddyEnabled', { id: 'night-shift', enabled: false })
  assert.deepEqual(harness.state().disabledIds, ['night-shift'], 'the switch is recorded')

  harness.run('removeBuddy', { id: 'night-shift' })

  assert.deepEqual(
    harness.state().custom.map((buddy) => buddy.id),
    ['release-captain'],
    'the record is gone'
  )
  assert.deepEqual(harness.state().disabledIds, [], 'and its switch goes with it rather than outliving it')

  // Removing one that is not there is a no-op rather than an error: a delete reaching main twice is a
  // second click, not a defect.
  const settled = structuredClone(harness.state())
  harness.run('removeBuddy', { id: 'nobody' })
  assert.deepEqual(harness.state(), settled, 'removing an unknown id changes nothing')
  results.push('removing a record takes its disabled mark with it')
}

function switchingABuddyOffAndOn() {
  const harness = createBuddyHarness()
  harness.run('addBuddy', custom())

  // A built-in is switched off by id, with no record anywhere to hold the flag: that is why the switch
  // is a set of ids rather than a field on a record.
  harness.run('setBuddyEnabled', { id: 'study-tutor', enabled: false })
  assert.deepEqual(harness.state().disabledIds, ['study-tutor'], 'a built-in is switched off by id alone')

  harness.run('setBuddyEnabled', { id: 'study-tutor', enabled: false })
  assert.deepEqual(harness.state().disabledIds, ['study-tutor'], 'switching it off twice is one entry')

  harness.run('setBuddyEnabled', { id: 'release-captain', enabled: false })
  assert.deepEqual(harness.state().disabledIds, ['study-tutor', 'release-captain'], 'and custom ids join it')

  harness.run('setBuddyEnabled', { id: 'study-tutor', enabled: true })
  assert.deepEqual(harness.state().disabledIds, ['release-captain'], 'switching one back on takes it out')
  results.push('a Buddy is switched off and on by id, built-in or custom')
}

function theStateRoundTrips() {
  const harness = createBuddyHarness()
  harness.run('addBuddy', custom())
  harness.run('setBuddyEnabled', { id: 'analyst', enabled: false })

  const written = JSON.parse(JSON.stringify(harness.state())) as BuddiesState
  assert.deepEqual(written, harness.state(), 'what the file holds is what the store reads back')
  results.push('the store state round trips through JSON')
}

// ---------------------------------------------------------------- the creation write

/**
 * The three steps `ensureSession` takes when a Buddy id is in hand: resolve it, take the seed it
 * declares, and write that seed onto the new record.
 *
 * Driven here against the real store action rather than a copy of it, because the write is the part a
 * later reader depends on: the renderer decides *which* fields, and the store decides how a field it is
 * handed becomes a key on the record.
 */
function createSessionWith(buddyId: string | null, customs: readonly BuddyRecord[] = []) {
  const sessions = createStoreHarness()
  const buddy = resolveBuddy(buddyId, customs)
  const seed = buddy ? buddySessionSeed(buddy) : null

  sessions.run('addSession', {
    id: uuid(1),
    title: 'Untitled conversation',
    providerId: seed?.providerId ?? 'deepseek',
    model: seed?.model ?? 'deepseek-chat',
    ...(seed
      ? {
          buddyId: seed.buddyId,
          rolePrompt: seed.rolePrompt,
          ...(seed.mcpSubset ? { mcpSubset: seed.mcpSubset } : {}),
          ...(seed.activeSkillIds ? { activeSkillIds: seed.activeSkillIds } : {}),
        }
      : {}),
  })
  return sessions.state().sessions[0]
}

function aBuddyIdSeedsTheNewConversation() {
  // The Analyst: a role, and nothing else declared.
  const record = createSessionWith('analyst')

  assert.equal(record.buddyId, 'analyst', 'the conversation names the Buddy it was created as')
  assert.equal(
    record.rolePrompt,
    resolveBuddy('analyst')?.rolePrompt,
    'and carries the role its record declared, snapshotted rather than looked up later'
  )
  assert.equal('mcpSubset' in record, false, 'the Analyst limits no servers, so no key claims it did')
  assert.equal('activeSkillIds' in record, false, 'and it chose no skills')
  assert.equal(record.providerId, 'deepseek', 'so the window own model choice stands')

  // A custom Buddy from the store, declaring a subset: the snapshot is the servers it named, and the
  // trust that decides whether any of them may run is applied at assembly rather than here.
  const customSession = createSessionWith('release-captain', [custom()])
  assert.equal(customSession.buddyId, 'release-captain', 'a custom Buddy is resolvable beside the built-ins')
  assert.deepEqual(customSession.mcpSubset, ['github'], 'and its declared servers are snapshotted')
  assert.deepEqual(customSession.activeSkillIds, ['release-notes'], 'with the skills it declared')
  results.push('a buddyId sets buddyId, rolePrompt and mcpSubset from the resolved record')
}

function noBuddyIdLeavesTheAgentSamDefault() {
  // Both spellings: a caller that says nothing, and one that says the default by name. Neither is a
  // Buddy, so neither writes a key — the Agent Sam case is the absence of the keys rather than a record
  // describing Agent Sam.
  for (const absent of [null, 'samai'] as const) {
    const record = createSessionWith(absent)
    assert.equal('buddyId' in record, false, `${String(absent)}: no Buddy is named`)
    assert.equal('rolePrompt' in record, false, 'no role is injected')
    assert.equal('mcpSubset' in record, false, 'and no server is limited')
    assert.equal(record.title, 'Untitled conversation', 'the conversation is otherwise the ordinary one')
  }
  results.push('ensureSession without a buddyId sets none of the three keys')
}

function anUnknownBuddyIdIsTheDefault() {
  // An id that resolves to nothing — a custom Buddy deleted since, a record from a build that never
  // had one — is the Agent Sam default rather than an error: the user asked for a conversation, and a
  // missing Buddy is not a reason to refuse one.
  const record = createSessionWith('deleted-buddy', [custom()])
  assert.equal('buddyId' in record, false, 'an id that resolves to nothing writes nothing')
  assert.equal('rolePrompt' in record, false, 'and injects no role')
  results.push('a buddyId nothing resolves to is the Agent Sam default')
}

// ---------------------------------------------------------------- main

async function main() {
  aCustomRecordIsStored()
  theBuiltInsAreNeverWritten()
  updatingReplacesTheRecordItNames()
  removingTakesTheRecordAndItsSwitch()
  switchingABuddyOffAndOn()
  theStateRoundTrips()
  aBuddyIdSeedsTheNewConversation()
  noBuddyIdLeavesTheAgentSamDefault()
  anUnknownBuddyIdIsTheDefault()

  console.log(`buddy store: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('BUDDY STORE TEST FAILED:', err)
  process.exit(1)
})
