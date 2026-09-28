/**
 * Verifies that a measured request lands on the conversation's metadata entry — no React, no disk.
 *
 * The key's rules are the ones `usage` beside it follows: absent until something is measured, written
 * as the shape a reader believes, and replaced rather than added up, because a snapshot is a
 * measurement of *this* request and not a total. Most of this suite is about the sessions that must
 * carry nothing: a conversation nobody has sent in, a record written before the key existed, and a key
 * of the wrong shape — each of which has to read as "nothing measured" rather than as zeros.
 */
import { strict as assert } from 'node:assert'
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import { contextSnapshotSchema, readContextSnapshot, snapshotRequest } from '../../conveyor/protocol/context-window'
import { createStoreHarness } from './chat-sessions-store-harness'

const results: string[] = []

function uuid(n: number): string {
  const tail = String(n).padStart(12, '0')
  return `11111111-2222-4333-8444-${tail}`
}

/** A store with one conversation in it, which is the state every rule below starts from. */
function storeWith(id: string) {
  const harness = createStoreHarness()
  harness.run('addSession', { id, title: 'A conversation', providerId: 'deepseek', model: 'deepseek-chat' })
  return harness
}

const AT = 1_700_000_000_000

/** A snapshot as the request build produces one: the categories, the total, and when it was measured. */
function measured() {
  return snapshotRequest(
    {
      tools: 'aaaaaaaa',
      systemPrompt: 'abcd',
      projectInstructions: 'efgh',
      skills: '',
      messages: 'abcdefghijklmnop',
      other: '',
    },
    1,
    AT
  )
}

// ---------------------------------------------------------------- the key's absence

function anUnsentSessionCarriesNoKey() {
  const harness = storeWith(uuid(1))

  const record = harness.state().sessions[0]
  assert.equal('contextSnapshot' in record, false, 'a conversation nobody has sent in says nothing')
  assert.equal(readContextSnapshot(record), undefined, 'and reads back as nothing measured')
  results.push('an unsent session carries no snapshot key')
}

function anOldRecordReadsBackWithoutOne() {
  // A record written before the key existed: the whole reading path, on the only shape that has to
  // keep working — a file this build is handed by an older one.
  const old = {
    id: uuid(2),
    title: 'Written before the snapshot',
    createdAt: 1,
    updatedAt: 2,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    usage: { prompt: 100, completion: 10, lastReportedAt: 3 },
  }

  assert.equal(readContextSnapshot(old), undefined, 'an old record loses the key rather than gaining zeros')
  const written = JSON.parse(JSON.stringify(old)) as Record<string, unknown>
  assert.equal('contextSnapshot' in written, false, 'and nothing writes one on the way out')

  const corrupt = { ...old, contextSnapshot: { tools: 1, used: 1 } }
  assert.equal(readContextSnapshot(corrupt), undefined, 'a key that is not the shape is stripped, not guessed at')
  assert.equal(readContextSnapshot(null), undefined, 'and neither a null nor a string is a record')
  results.push('an old record reads back with no snapshot key')
}

// ---------------------------------------------------------------- the write

function theSnapshotLandsOnTheEntry() {
  const id = uuid(3)
  const harness = storeWith(id)

  harness.run('recordContextSnapshot', { id, snapshot: measured() })

  const stored = harness.state().sessions[0].contextSnapshot
  assert.deepEqual(stored, measured(), 'what was measured is what the entry carries')
  assert.equal(
    stored?.used,
    stored
      ? stored.tools + stored.systemPrompt + stored.projectInstructions + stored.skills + stored.messages + stored.other
      : 0
  )
  results.push('a measured request lands on the session entry')
}

function aSecondMeasureReplacesTheFirst() {
  // Replaced rather than added up: this is a measurement of the request about to be sent, where the
  // running usage total beside it is a measurement of everything already billed. A snapshot that
  // accumulated would claim the conversation had spent both requests at once.
  const id = uuid(4)
  const harness = storeWith(id)

  harness.run('recordContextSnapshot', { id, snapshot: measured() })
  const second = snapshotRequest(
    {
      tools: 'aaaaaaaaaaaa',
      systemPrompt: 'abcd',
      projectInstructions: '',
      skills: '',
      messages: 'abcdefgh',
      other: '',
    },
    0,
    AT + 1000
  )
  harness.run('recordContextSnapshot', { id, snapshot: second })

  assert.deepEqual(harness.state().sessions[0].contextSnapshot, second, 'the newer measurement is the one stored')
  assert.notEqual(harness.state().sessions[0].contextSnapshot?.tools, measured().tools, 'and it is not the older one')
  results.push('a second measurement replaces the first')
}

function measuringIsNotUsingTheSession() {
  // A snapshot is a fact about a request, not about the conversation being used, so the list's order
  // and its clock are untouched — the rule the other background writes follow.
  const id = uuid(5)
  const harness = storeWith(id)
  const before = harness.state().sessions[0].updatedAt

  harness.run('recordContextSnapshot', { id, snapshot: measured() })

  assert.equal(harness.state().sessions[0].updatedAt, before, 'measuring does not stamp the session as used')
  results.push('measuring does not reorder the list')
}

function anUnknownSessionIsLeftAlone() {
  const id = uuid(6)
  const harness = storeWith(id)
  const settled = structuredClone(harness.state())

  harness.run('recordContextSnapshot', { id: uuid(7), snapshot: measured() })

  assert.deepEqual(harness.state(), settled, 'a measurement for an id that is not there changes nothing')
  results.push('a measurement for an unknown id changes nothing')
}

// ---------------------------------------------------------------- the persisted key

function theKeySurvivesJson() {
  const id = uuid(8)
  const harness = storeWith(id)
  harness.run('recordContextSnapshot', { id, snapshot: measured() })

  const record = harness.state().sessions[0]
  const readBack = JSON.parse(JSON.stringify(record)) as unknown

  assert.deepEqual(
    readContextSnapshot(readBack),
    record.contextSnapshot,
    'the key round trips through the file it is written to'
  )
  results.push('the snapshot key round trips through JSON')
}

function theKeyShapeIsClosed() {
  const written = measured()
  assert.equal(contextSnapshotSchema.safeParse(written).success, true, 'what the store writes is accepted')
  assert.equal(
    contextSnapshotSchema.safeParse({ ...written, tools: -1 }).success,
    false,
    'a negative category is refused'
  )
  assert.equal(contextSnapshotSchema.safeParse({ ...written, messages: 1.5 }).success, false, 'a token count is whole')
  assert.equal(contextSnapshotSchema.safeParse({ ...written, at: undefined }).success, false, 'a stamp is required')
  assert.equal(
    contextSnapshotSchema.safeParse({ used: 10, at: 1 }).success,
    false,
    'a total without its categories is not a snapshot'
  )

  // Cast the way the terminal-preferences suite does: the store runtime types a payload schema as its
  // generic StandardSchema, and this is the one shape both zod and that alias agree on.
  const payload = (
    chatSessionsStore.schemas as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>
  ).recordContextSnapshot
  assert.equal(
    payload.safeParse({ id: uuid(9), snapshot: written }).success,
    true,
    'the action accepts what the request build measures'
  )
  assert.equal(
    payload.safeParse({ id: 'not-a-uuid', snapshot: written }).success,
    false,
    'and refuses an id that could escape the sessions folder'
  )
  assert.equal(
    payload.safeParse({ id: uuid(9), snapshot: { ...written, other: -1 } }).success,
    false,
    'and a category that is not a count'
  )
  results.push('the snapshot key and the action payload are closed shapes')
}

// ---------------------------------------------------------------- main

async function main() {
  anUnsentSessionCarriesNoKey()
  anOldRecordReadsBackWithoutOne()
  theSnapshotLandsOnTheEntry()
  aSecondMeasureReplacesTheFirst()
  measuringIsNotUsingTheSession()
  anUnknownSessionIsLeftAlone()
  theKeySurvivesJson()
  theKeyShapeIsClosed()

  console.log(`context snapshot store: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CONTEXT SNAPSHOT STORE TEST FAILED:', err)
  process.exit(1)
})
