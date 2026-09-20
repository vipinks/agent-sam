/**
 * Audit of the version 1 → 2 transcript boundary, and the corruption floor beneath it.
 *
 * 2dc1aa6 bumped the persisted shape to version 2 by widening a tool step's status with `queued`.
 * That left one question this suite answers with a file rather than an argument: does a transcript
 * written by the version 1 build still load?
 *
 * It does, and the reason is structural rather than lucky. Version 1 wrote a subset of the statuses
 * version 2 accepts — `queued` was added to the enum, nothing was removed or renamed, no field
 * changed shape — and `version` is a bare integer that was never pinned to the current constant. So
 * a v1 file validates against the v2 schema exactly as it was written, with no migration, and
 * `loadTranscript` + `rehydrateTranscript` hand the reducer turns it can render. Nothing in the
 * product code is changed for this: the audit's finding is "already compatible".
 *
 * The other half is the part a lenient reader would erode: a genuinely corrupt file must still be
 * refused with SESSION_CORRUPT. Version tolerance must not become a blanket accept, so the corrupt
 * battery at the end is deliberately aggressive — unparseable JSON, valid JSON of the wrong shape,
 * an unknown status, a non-integer version, a turn whose role is not a role.
 *
 * No Electron runtime: `app.getPath` comes from the shared stub (see `tests/stubs/`).
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTranscriptFile } from '../../conveyor/modules/sessions'
import { rehydrateTranscript } from '../../app/components/workbench/session-transcript'

const results: string[] = []

const UUID = '11111111-2222-4333-8444-555555555555'

/**
 * A transcript exactly as the version 1 build wrote it.
 *
 * Hand-written rather than produced by current code, because the whole point is that it is *not*
 * the current writer's output: version 1, and only the five statuses that existed then. If this
 * fixture were built from `serializeTranscript` it would be a v2 file wearing a v1 label, and the
 * audit would prove nothing.
 */
function version1File() {
  return {
    version: 1,
    interrupted: true,
    turns: [
      { id: 'user-1', role: 'user', content: 'rename every variable in parser.ts', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Reading it first.',
        steps: [
          {
            callId: 'call_1',
            tool: 'read_file',
            args: { path: 'parser.ts' },
            status: 'ok',
            output: 'export function parse(input: string) {…}',
          },
          {
            callId: 'call_2',
            tool: 'run_command',
            args: { command: 'npm test' },
            status: 'failed',
            output: 'Command exited with code 1.',
            code: 'COMMAND_FAILED',
          },
          {
            callId: 'call_3',
            tool: 'run_command',
            args: { command: 'rm -rf dist' },
            status: 'denied',
            output: 'Denied by you.',
          },
        ],
      },
      {
        id: 'assistant-3',
        role: 'assistant',
        content: 'Halfway through the second rename…',
        steps: [
          {
            callId: 'call_4',
            tool: 'write_file',
            args: { path: 'parser.ts' },
            // The version 1 signature of an interruption: a step that was still running when the
            // process went away. `queued` did not exist yet, so this is how a cut-off turn looked.
            status: 'running',
          },
        ],
      },
    ],
  }
}

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- the v1 read

async function theFixtureIsGenuinelyVersion1() {
  // Guards the guard: a fixture that had drifted into v2 shape would make every assertion below
  // vacuous — it would be testing the current writer against the current reader.
  const fixture = version1File()
  assert.equal(fixture.version, 1, 'the fixture must declare version 1')
  const statuses = fixture.turns.flatMap((turn) => turn.steps.map((s) => s.status))
  assert.deepEqual(
    [...new Set(statuses)].sort(),
    ['denied', 'failed', 'ok', 'running'],
    'the fixture must only use statuses the version 1 build could write'
  )
  assert.ok(!statuses.includes('queued'), 'a version 1 file has no queued step')
  results.push('the seeded file is genuinely version 1: no queued status, version 1')
}

async function version1LoadsUnchanged() {
  const fixture = version1File()
  writeFileSync(join(sessionDir, `${UUID}.json`), JSON.stringify(fixture), 'utf8')

  const loaded = await loadTranscriptFile(UUID)

  // Not merely "parsed": identical. A migration that rewrote a v1 file on the way in would show up
  // here first, and it would mean the audit's premise (nothing to migrate) was wrong.
  assert.deepEqual(loaded, fixture, 'a version 1 transcript must load byte-for-byte as written')
  assert.equal(loaded?.version, 1, 'the version it was written with is preserved, not rewritten')
  assert.equal(loaded?.turns.length, 3, 'every turn survives')
  assert.equal(loaded?.turns[1].steps.length, 3, 'every tool card survives')
  results.push('a version 1 transcript loads as-is: same turns, same steps, same version')
}

async function version1Rehydrates() {
  const loaded = await loadTranscriptFile(UUID)
  const state = rehydrateTranscript(loaded)

  assert.equal(state.turns.length, 3, 'the reducer gets all three turns')
  assert.equal(state.interrupted, true, 'the recorded interruption survives the read')
  assert.deepEqual(
    state.turns[1].steps.map((s) => s.status),
    ['ok', 'failed', 'denied'],
    'each step keeps the status it was saved with — none is coerced to a settled default'
  )
  assert.equal(state.turns[1].steps[1].code, 'COMMAND_FAILED', 'a failure code survives')
  assert.equal(state.turns[1].steps[2].output, 'Denied by you.', 'a denial keeps its outcome text')
  assert.equal(state.turns[2].steps[0].status, 'running', 'the interrupted step is still running')
  assert.equal(state.turns[0].role, 'user', 'roles survive')
  results.push('rehydrate accepts it: the turns, statuses, code and interruption all survive')
}

async function anAbsentFileIsStillAbsent() {
  // A session whose transcript was never written must stay distinguishable from an unreadable one,
  // which is the invariant the corruption battery below depends on.
  const never = '99999999-8888-4777-8666-555555555555'
  assert.equal(await loadTranscriptFile(never), null, 'a missing file is null, not an error')
  results.push('a file that was never written still loads as null')
}

// ---------------------------------------------------------------- the floor under it

async function unparseableJsonIsRefused() {
  // A crash mid-write, or a hand edit that went wrong.
  writeFileSync(join(sessionDir, `${UUID}.json`), '{"version":1,"turns":[', 'utf8')
  await assert.rejects(
    loadTranscriptFile(UUID),
    (e: { code?: string }) => e.code === 'SESSION_CORRUPT',
    'unparseable JSON must still raise SESSION_CORRUPT'
  )
  results.push('unparseable JSON still raises SESSION_CORRUPT')
}

async function wrongShapeIsRefused() {
  const wrong = [
    // Not a transcript at all.
    { hello: 'world' },
    // A turn list that is not a list.
    { version: 1, interrupted: false, turns: 'nope' },
    // A role that is not a role.
    {
      version: 1,
      interrupted: false,
      turns: [{ id: 'a', role: 'system', content: '', steps: [] }],
    },
    // A status that never existed in either version — the one that must not slip through a
    // version-tolerant reader.
    {
      version: 1,
      interrupted: false,
      turns: [
        { id: 'a', role: 'assistant', content: '', steps: [{ callId: 'c', tool: 't', args: {}, status: 'zzz' }] },
      ],
    },
    // A step missing the fields every version has always required.
    {
      version: 2,
      interrupted: false,
      turns: [{ id: 'a', role: 'assistant', content: '', steps: [{ callId: 'c', status: 'ok' }] }],
    },
    // A version that is not an integer. Tolerating version 1 is not the same as tolerating any
    // version-shaped value.
    { version: 1.5, interrupted: false, turns: [] },
    { version: '1', interrupted: false, turns: [] },
  ]

  for (const [index, payload] of wrong.entries()) {
    writeFileSync(join(sessionDir, `${UUID}.json`), JSON.stringify(payload), 'utf8')
    await assert.rejects(
      loadTranscriptFile(UUID),
      (e: { code?: string }) => e.code === 'SESSION_CORRUPT',
      `case ${index} (${JSON.stringify(payload)}) must raise SESSION_CORRUPT`
    )
  }
  results.push(`${wrong.length} wrong-shape and unknown-status files all still raise SESSION_CORRUPT`)
}

async function theAcceptingIsBoundedToRealTranscripts() {
  // The complement of the battery: the same directory, now holding only the v1 file, loads again.
  // Together with the cases above this pins the boundary from both sides — v1 in, junk out — so a
  // future reader cannot pass this suite by accepting everything or by refusing everything.
  writeFileSync(join(sessionDir, `${UUID}.json`), JSON.stringify(version1File()), 'utf8')
  const loaded = await loadTranscriptFile(UUID)
  assert.notEqual(loaded, null, 'the genuine v1 file still loads after the corrupt cases')
  results.push('the boundary holds from both sides: version 1 in, corrupted files out')
}

// ---------------------------------------------------------------- the additive record

async function aTranscriptWithoutTheInstructionsRecordStillReads() {
  // The turn record added two optional fields and nothing else, so this file — a v2 transcript from
  // before the record existed — must load exactly as written. Asserted as an identity rather than as
  // "it parses": a reader that filled the fields in with nulls, or rewrote the file on the way in,
  // would still parse, and the whole point of an additive field is that it changes nothing for a
  // file that predates it.
  const before: {
    version: number
    interrupted: boolean
    turns: Array<{ id: string; role: string; content: string; steps: unknown[] }>
  } = {
    version: 2,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'rename the file', steps: [] },
      { id: 'assistant-2', role: 'assistant', content: 'Done.', steps: [] },
    ],
  }

  writeFileSync(join(sessionDir, `${UUID}.json`), JSON.stringify(before), 'utf8')
  const loaded = await loadTranscriptFile(UUID)

  assert.deepEqual(loaded, before, 'a transcript written before the record loads exactly as written')
  assert.equal('instructionsFile' in (loaded?.turns[0] ?? {}), false, 'and gains no key it was not written with')

  // The reducer receives turns it can render, and reports no record for them — which is what keeps an
  // export of an older conversation free of a note naming a file that was never recorded.
  const state = rehydrateTranscript(loaded)
  assert.equal(state.turns.length, 2, 'both turns survive')
  assert.equal(state.turns[0].instructionsFile, undefined, 'and none of them claims a record')
  results.push('a transcript from before the record loads unchanged, with no record invented for it')
}

// ---------------------------------------------------------------- harness

let sessionDir = ''

async function main() {
  const root = process.env.SAM_TEST_USER_DATA
  if (!root) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  sessionDir = join(root, 'sessions')
  mkdirSync(sessionDir, { recursive: true })

  try {
    await step('fixture is v1', theFixtureIsGenuinelyVersion1)
    await step('v1 loads unchanged', version1LoadsUnchanged)
    await step('v1 rehydrates', version1Rehydrates)
    await step('absent file', anAbsentFileIsStillAbsent)
    await step('corrupt json', unparseableJsonIsRefused)
    await step('wrong shape', wrongShapeIsRefused)
    await step('boundary', theAcceptingIsBoundedToRealTranscripts)
    await step('additive record', aTranscriptWithoutTheInstructionsRecordStillReads)

    console.log(`transcript v1 compatibility: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('TRANSCRIPT V1 TEST FAILED:', err)
  process.exit(1)
})
