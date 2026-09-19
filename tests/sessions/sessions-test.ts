/**
 * Verifies transcript storage: the round trip, atomicity, idempotent delete, corruption, and id
 * containment. No Electron — `app.getPath` is stubbed via the module's own directory resolution.
 *
 * The scenario the phases actually produce is covered too: a turn with tool cards, and one with a
 * denied approval, survive a save/load round trip with their steps intact.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTranscriptFile, saveTranscriptFile, sessionsModule } from '../../conveyor/modules/sessions'
import {
  transcriptSnapshotSchema,
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
} from '../../conveyor/protocol/transcript'

const results: string[] = []

const UUID = '11111111-2222-4333-8444-555555555555'

/** A snapshot shaped like a real conversation: prose, tool cards, and a denial. */
function realisticSnapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'Create new_fibonacci.py and run it', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: "I'll write the file first.",
        steps: [
          {
            callId: 'call_1',
            tool: 'write_file',
            args: { path: 'new_fibonacci.py', content: 'def fib(n):\n    return n\n' },
            status: 'ok',
            output: 'Wrote 31 bytes to new_fibonacci.py.',
          },
          {
            callId: 'call_2',
            tool: 'run_command',
            args: { command: 'python new_fibonacci.py' },
            status: 'failed',
            output: 'Traceback…\nCommand exited with code 1.',
            code: 'COMMAND_FAILED',
          },
        ],
      },
      { id: 'user-3', role: 'user', content: 'Try again', steps: [] },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'I will not do that.',
        steps: [
          {
            callId: 'call_3',
            tool: 'run_command',
            args: { command: 'rm -rf /' },
            status: 'denied',
            output: 'Denied by you.',
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

// ---------------------------------------------------------------- the round trip

async function roundTrip() {
  const snapshot = realisticSnapshot()
  await saveTranscriptFile(UUID, snapshot)
  const loaded = await loadTranscriptFile(UUID)

  assert.deepEqual(loaded, snapshot, 'a saved transcript must come back identical')
  // The parts that would be easiest to lose silently.
  assert.equal(loaded?.turns[1].steps.length, 2, 'both tool cards survive')
  assert.equal(loaded?.turns[3].steps[0].status, 'denied', 'a denied approval survives as denied')
  assert.equal(loaded?.turns[1].steps[1].code, 'COMMAND_FAILED', 'a failure code survives')
  assert.deepEqual(loaded?.turns[1].steps[0].args, snapshot.turns[1].steps[0].args, 'tool args survive')

  results.push('a transcript with tool cards and a denial round-trips exactly')
}

async function absentIsNull() {
  // A session that exists but has never been used has no file; that is not corruption.
  const missing = '99999999-8888-4777-8666-555555555555'
  assert.equal(await loadTranscriptFile(missing), null)
  results.push('a session with no file loads as null')
}

// ---------------------------------------------------------------- atomicity

async function noTempFilesAreLeftBehind() {
  await saveTranscriptFile(UUID, realisticSnapshot())

  const leftover = readdirSync(sessionDir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftover, [], `a completed save must leave no temp files, found ${leftover.join(', ')}`)
  // And exactly the one transcript, not a stray copy.
  const transcripts = readdirSync(sessionDir).filter((name) => name.endsWith('.json'))
  assert.ok(transcripts.includes(`${UUID}.json`), 'the transcript exists under its id')
  results.push('a completed save leaves no temp file behind')
}

async function overwriteReplacesInPlace() {
  await saveTranscriptFile(UUID, realisticSnapshot())
  const second: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'user-1', role: 'user', content: 'replaced', steps: [] }],
  }
  await saveTranscriptFile(UUID, second)

  const loaded = await loadTranscriptFile(UUID)
  assert.deepEqual(loaded, second, 'a re-save must replace the transcript, not append to it')
  assert.deepEqual(
    readdirSync(sessionDir).filter((n) => n.endsWith('.tmp')),
    []
  )
  results.push('re-saving replaces the transcript in place')
}

// ---------------------------------------------------------------- corruption

async function corruptJsonIsReported() {
  // Truncated JSON: what a crash mid-write would once have produced, and what hand-editing looks like.
  writeFileSync(join(sessionDir, `${UUID}.json`), '{"version":1,"turns":[', 'utf8')
  await assert.rejects(
    loadTranscriptFile(UUID),
    (e: { code?: string }) => e.code === 'SESSION_CORRUPT',
    'unparseable JSON must raise SESSION_CORRUPT'
  )

  results.push('unparseable JSON raises SESSION_CORRUPT')
}

async function validJsonButWrongShapeIsReported() {
  // Valid JSON, but not a transcript — the case a JSON.parse-only check would let through and then
  // hand the reducer something it cannot render.
  writeFileSync(join(sessionDir, `${UUID}.json`), JSON.stringify({ hello: 'world' }), 'utf8')
  await assert.rejects(
    loadTranscriptFile(UUID),
    (e: { code?: string }) => e.code === 'SESSION_CORRUPT',
    'valid JSON of the wrong shape must raise SESSION_CORRUPT'
  )

  // A turn with an unknown status is also not a transcript.
  writeFileSync(
    join(sessionDir, `${UUID}.json`),
    JSON.stringify({
      version: 1,
      interrupted: false,
      turns: [
        { id: 'a', role: 'assistant', content: '', steps: [{ callId: 'c', tool: 't', args: {}, status: 'zzz' }] },
      ],
    }),
    'utf8'
  )
  await assert.rejects(
    loadTranscriptFile(UUID),
    (e: { code?: string }) => e.code === 'SESSION_CORRUPT',
    'an unknown step status must raise SESSION_CORRUPT'
  )

  results.push('valid JSON of the wrong shape raises SESSION_CORRUPT')
}

function theSchemaAcceptsWhatWeWrite() {
  // The module validates on read, so a snapshot the schema rejects could never be read back. If this
  // fails, every save would produce a file that looks corrupt on the next load.
  const parsed = transcriptSnapshotSchema.safeParse(realisticSnapshot())
  assert.equal(
    parsed.success,
    true,
    `the written shape must satisfy the read schema: ${JSON.stringify(parsed.error?.issues)}`
  )
  results.push('the snapshot we write satisfies the schema we read with')
}

// ---------------------------------------------------------------- delete

async function deleteIsIdempotent() {
  await saveTranscriptFile(UUID, realisticSnapshot())
  assert.equal(existsSync(join(sessionDir, `${UUID}.json`)), true, 'saved first')

  const record = sessionsModule.record.deleteTranscript as unknown as {
    resolver: (opts: { input: unknown }) => Promise<void>
  }
  await record.resolver({ input: { id: UUID } })
  assert.equal(existsSync(join(sessionDir, `${UUID}.json`)), false, 'the file is gone')

  // Deleting again is the same end state, not an error.
  await record.resolver({ input: { id: UUID } })
  await record.resolver({ input: { id: '77777777-6666-4555-8444-333333333333' } })

  results.push('deleting a transcript is idempotent, including one that never existed')
}

async function deletingOneSessionLeavesTheOthers() {
  const other = '22222222-3333-4444-8555-666666666666'
  await saveTranscriptFile(UUID, realisticSnapshot())
  await saveTranscriptFile(other, realisticSnapshot())

  const record = sessionsModule.record.deleteTranscript as unknown as {
    resolver: (opts: { input: unknown }) => Promise<void>
  }
  await record.resolver({ input: { id: UUID } })

  assert.equal(existsSync(join(sessionDir, `${UUID}.json`)), false)
  assert.equal(existsSync(join(sessionDir, `${other}.json`)), true, 'the other transcript survives')
  results.push('deleting one session leaves the rest alone')
}

// ---------------------------------------------------------------- id containment

function pathSeparatorIdsAreRejected() {
  // The ids the module must never turn into a filename. `..` and separators are the ones that would
  // escape `userData/sessions` if the id were interpolated unchecked.
  const dangerous = [
    '../escape',
    '..',
    '../../etc/passwd',
    'a/b',
    'a\\b',
    'C:\\Windows\\system32',
    `${UUID}/../../evil`,
    '..\\..\\evil',
    '',
    'not-a-uuid',
  ]

  for (const id of dangerous) {
    const result = transcriptSnapshotSchema && idInput(id)
    assert.equal(result, false, `id ${JSON.stringify(id)} must be rejected before it becomes a path`)
  }
  results.push('traversal, separator, and non-uuid ids are all rejected')
}

/** Whether the module's own input schema accepts this id. */
function idInput(id: string): boolean {
  const record = sessionsModule.record.loadTranscript as unknown as {
    input?: { safeParse: (v: unknown) => { success: boolean } }
  }
  return record.input?.safeParse({ id })?.success ?? false
}

function aValidUuidIsAccepted() {
  assert.equal(idInput(UUID), true, 'a real uuid must be accepted')
  results.push('a valid uuid is accepted')
}

// ---------------------------------------------------------------- the module surface

function theModuleSurfaceIsShaped() {
  assert.equal((sessionsModule.record.saveTranscript as { kind?: string }).kind, 'command', 'save is a command')
  assert.equal((sessionsModule.record.deleteTranscript as { kind?: string }).kind, 'command', 'delete is a command')
  assert.equal((sessionsModule.record.loadTranscript as { kind?: string }).kind, 'query', 'load is a query')
  results.push('save and delete are commands; load is a query')
}

// ---------------------------------------------------------------- harness

let sessionDir = ''

/**
 * Point the module and the test at the same directory.
 *
 * The module resolves `userData/sessions` through electron's `app.getPath`, which the stub points at
 * `SAM_TEST_USER_DATA`. Reading that from the environment rather than guessing is what keeps the
 * assertions on the real output directory.
 */
function setSessionDir(): void {
  const userData = process.env.SAM_TEST_USER_DATA
  if (!userData) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  sessionDir = join(userData, 'sessions')
}

async function main() {
  // The stub and the test read the same environment variable, so both agree on the directory.
  const root = process.env.SAM_TEST_USER_DATA
  if (!root) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  setSessionDir()
  mkdirSync(sessionDir, { recursive: true })

  try {
    await step('module surface', theModuleSurfaceIsShaped)
    await step('id containment', pathSeparatorIdsAreRejected)
    await step('valid uuid', aValidUuidIsAccepted)
    await step('schema agreement', theSchemaAcceptsWhatWeWrite)
    await step('round trip', roundTrip)
    await step('absent file', absentIsNull)
    await step('no temp files', noTempFilesAreLeftBehind)
    await step('overwrite', overwriteReplacesInPlace)
    await step('corrupt json', corruptJsonIsReported)
    await step('wrong shape', validJsonButWrongShapeIsReported)
    await step('delete idempotence', deleteIsIdempotent)
    await step('delete isolation', deletingOneSessionLeavesTheOthers)

    console.log(`transcript storage: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SESSIONS TEST FAILED:', err)
  process.exit(1)
})
