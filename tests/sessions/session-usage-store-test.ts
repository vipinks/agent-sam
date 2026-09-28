/**
 * Verifies that a session's spend lands on its metadata entry — no React, no disk.
 *
 * Most of this suite is about what a session that never reported must *not* carry: no key at all,
 * no zeros, and nothing a reader could mistake for a measurement. The rest is the arithmetic of two
 * reports against one record, and the round trip a persisted record takes through JSON.
 */
import { strict as assert } from 'node:assert'
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import { readSessionUsage, sessionUsageSchema } from '../../conveyor/protocol/session-usage'
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

// ---------------------------------------------------------------- the key's absence

function anUntouchedSessionCarriesNoKey() {
  const id = uuid(1)
  const harness = storeWith(id)

  const record = harness.state().sessions[0]
  assert.equal('usage' in record, false, 'a session that never reported says nothing, rather than zero')
  assert.equal(readSessionUsage(record), undefined, 'and reads back as no measurement')
  results.push('an untouched session carries no usage key')
}

function anOldRecordReadsBackWithoutOne() {
  // A record written before the key existed: the whole reading path, on the only shape that has to
  // keep working — a file this build is handed by an older one.
  const old = {
    id: uuid(2),
    title: 'Written before usage',
    createdAt: 1,
    updatedAt: 2,
    providerId: 'deepseek',
    model: 'deepseek-chat',
  }

  assert.equal(readSessionUsage(old), undefined, 'an old record loses the key rather than gaining a zero')
  assert.equal('usage' in (JSON.parse(JSON.stringify(old)) as object), false, 'and nothing writes one on the way out')

  const corrupt = { ...old, usage: { prompt: 'many', completion: 1, lastReportedAt: 0 } }
  assert.equal(readSessionUsage(corrupt), undefined, 'a key that is not the shape is stripped, not guessed at')
  results.push('an old record reads back with no usage key')
}

// ---------------------------------------------------------------- accumulation

function twoReportsAccumulate() {
  const id = uuid(3)
  const harness = storeWith(id)

  harness.run('recordUsage', { id, prompt: 1200, completion: 340, cached: 900 })
  const first = harness.state().sessions[0].usage
  assert.equal(first?.prompt, 1200)
  assert.equal(first?.completion, 340)
  assert.equal(first?.cached, 900)
  assert.ok(typeof first?.lastReportedAt === 'number' && first.lastReportedAt > 0, 'the report is stamped')

  harness.run('recordUsage', { id, prompt: 300, completion: 60, cached: 200 })
  const second = harness.state().sessions[0].usage
  assert.deepEqual(
    { prompt: second?.prompt, completion: second?.completion, cached: second?.cached },
    { prompt: 1500, completion: 400, cached: 1100 },
    'a second turn adds to the running total rather than replacing it'
  )

  // A turn whose provider said nothing about caching must not erase what an earlier turn reported.
  harness.run('recordUsage', { id, prompt: 10, completion: 5 })
  const third = harness.state().sessions[0].usage
  assert.deepEqual(
    { prompt: third?.prompt, completion: third?.completion, cached: third?.cached },
    { prompt: 1510, completion: 405, cached: 1100 },
    'counters nobody reported are left as they were'
  )
  results.push('two reports accumulate on one record')
}

function aReportWithoutCachingLeavesItAbsent() {
  const id = uuid(4)
  const harness = storeWith(id)

  harness.run('recordUsage', { id, prompt: 800, completion: 20 })
  const usage = harness.state().sessions[0].usage
  assert.equal(usage?.prompt, 800)
  assert.equal('cached' in (usage as object), false, 'no cache detail is absence, never a zero')
  results.push('a report without cache detail leaves cached absent')
}

function reportingIsNotUsingTheSession() {
  // Usage is a fact about a reply, not about the conversation being used, so the list's order and its
  // clock are untouched — the same rule the other background writes follow.
  const id = uuid(5)
  const harness = storeWith(id)
  const before = harness.state().sessions[0].updatedAt

  harness.run('recordUsage', { id, prompt: 5, completion: 1 })

  assert.equal(harness.state().sessions[0].updatedAt, before, 'reporting does not stamp the session as used')
  results.push('reporting does not reorder the list')
}

function anUnknownSessionIsLeftAlone() {
  const id = uuid(6)
  const harness = storeWith(id)
  const settled = structuredClone(harness.state())

  harness.run('recordUsage', { id: uuid(7), prompt: 5000, completion: 900 })

  assert.deepEqual(harness.state(), settled, 'a report against an id that is not there changes nothing')
  results.push('a report against an unknown id changes nothing')
}

// ---------------------------------------------------------------- the persisted key

function theKeySurvivesJson() {
  const id = uuid(8)
  const harness = storeWith(id)
  harness.run('recordUsage', { id, prompt: 1200, completion: 340, cached: 900 })

  const record = harness.state().sessions[0]
  const readBack = JSON.parse(JSON.stringify(record)) as unknown

  assert.deepEqual(readSessionUsage(readBack), record.usage, 'the key round trips through the file it is written to')
  results.push('the usage key round trips through JSON')
}

function theKeyShapeIsClosed() {
  const written = { prompt: 1200, completion: 340, cached: 900, lastReportedAt: 1_700_000_000_000 }
  assert.equal(sessionUsageSchema.safeParse(written).success, true, 'what the store writes is accepted')
  assert.equal(
    sessionUsageSchema.safeParse({ ...written, cached: undefined }).success,
    true,
    'cache detail is optional'
  )
  assert.equal(sessionUsageSchema.safeParse({ ...written, prompt: -1 }).success, false, 'a negative count is refused')
  assert.equal(sessionUsageSchema.safeParse({ ...written, prompt: 1.5 }).success, false, 'a token count is whole')
  assert.equal(
    sessionUsageSchema.safeParse({ prompt: '1200', completion: 340, lastReportedAt: 0 }).success,
    false,
    'a count that is not a number is refused'
  )

  // Cast the way the terminal-preferences suite does: the store runtime types a payload schema as its
  // generic StandardSchema, and this is the one shape both zod and that alias agree on.
  const payload = (
    chatSessionsStore.schemas as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>
  ).recordUsage
  assert.equal(
    payload.safeParse({ id: uuid(9), prompt: 10, completion: 4 }).success,
    true,
    'the action accepts a report with no cache detail'
  )
  assert.equal(
    payload.safeParse({ id: uuid(9), prompt: -10, completion: 4 }).success,
    false,
    'and refuses a negative count at the boundary rather than storing it'
  )
  results.push('the usage key and the action payload are closed shapes')
}

// ---------------------------------------------------------------- main

async function main() {
  anUntouchedSessionCarriesNoKey()
  anOldRecordReadsBackWithoutOne()
  twoReportsAccumulate()
  aReportWithoutCachingLeavesItAbsent()
  reportingIsNotUsingTheSession()
  anUnknownSessionIsLeftAlone()
  theKeySurvivesJson()
  theKeyShapeIsClosed()

  console.log(`session usage store: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('SESSION USAGE STORE TEST FAILED:', err)
  process.exit(1)
})
