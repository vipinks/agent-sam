/**
 * The consent setting, all the way through the storage layer.
 *
 * `auto-approve-rules.test.ts` owns what the record does with the field in isolation, and the wiring
 * suites own what the pane does with it on screen. Neither of them answers the question this file
 * exists for: does a conversation the user turned auto-approve on in still read as on when the file is
 * read back by a later process?
 *
 * So nothing here is hand-written. The snapshot is what the renderer's own writer produces from a live
 * transcript, it goes through the real `saveTranscriptFile`/`loadTranscriptFile` pair, and the flag is
 * read back through the renderer's own reader — the whole path, with no fixture standing in for a
 * record. A test that fed `loadTranscriptFile` a snapshot it had built by hand would pass on a build
 * whose writer had dropped the key, which is precisely the defect this phase is about.
 *
 * The two absences are asserted as well as the presence, and that is not symmetry for its own sake: the
 * fail-closed default has to keep meaning "no preference was ever stored". A conversation whose user
 * never touched the toggle writes no key, and one whose user turned it back off writes no key either —
 * so an absent key only ever means the session has decided nothing.
 *
 * No Electron runtime: `app.getPath` comes from the shared stub (see `tests/stubs/`).
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadTranscriptFile, saveTranscriptFile, sessionsModule } from '../../conveyor/modules/sessions'
import { memoryRoot, setEpisodesEnabledSource, setSessionRootSource } from '../../conveyor/modules/memory'
import { TRANSCRIPT_VERSION, transcriptSnapshotSchema } from '../../conveyor/protocol/transcript'
import {
  rehydrateTranscript,
  serializeTranscript,
  type TranscriptState,
} from '../../app/components/workbench/session-transcript'

const results: string[] = []

const UUID = '11111111-2222-4333-8444-555555555555'

/**
 * A live transcript as the pane holds it after a completed turn — the state the turn-boundary save is
 * asked to write, not a snapshot with the flag bolted on.
 */
function afterATurn(autoApprove?: boolean): TranscriptState {
  return {
    turns: [
      { id: 'user-1', role: 'user', content: 'delete the build folder', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Removing it now.',
        steps: [
          {
            callId: 'call_1',
            tool: 'run_command',
            args: { command: 'rm -rf build' },
            status: 'ok',
            output: 'Removed 41 files.',
          },
        ],
      },
    ],
    interrupted: false,
    ...(autoApprove === undefined ? {} : { autoApprove }),
  }
}

/** The file as it sits on disk, which is the only place a dropped key is visible. */
function storedFile(): string {
  return readFileSync(join(sessionsDir(), `${UUID}.json`), 'utf8')
}

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- the round trip

async function anOnFlagSurvivesATurnBoundarySave() {
  const written = serializeTranscript(afterATurn(true))
  await saveTranscriptFile(UUID, written)

  // The key is in the bytes. A reader that reconstructed it from something else would still pass a
  // check made only on the loaded object, so the file itself is read first.
  assert.match(storedFile(), /"autoApprove":true/, 'the stored file carries the flag')

  const loaded = await loadTranscriptFile(UUID)
  assert.ok(loaded, 'the transcript loads')
  assert.equal(loaded?.autoApprove, true, 'the record hands the flag back')
  assert.equal(rehydrateTranscript(loaded).autoApprove, true, 'and a launch reads the toggle as on')
  results.push('a flag turned on survives a turn boundary save and a re-read, in the file and in the reader')
}

async function aConversationNeverToggledStoresNothing() {
  await saveTranscriptFile(UUID, serializeTranscript(afterATurn()))

  assert.doesNotMatch(storedFile(), /autoApprove/, 'no key is written for a session with no preference')
  assert.equal(rehydrateTranscript(await loadTranscriptFile(UUID)).autoApprove, false, 'which reads as off')
  results.push('a conversation whose toggle was never touched stores no key and opens off')
}

async function turningItBackOffStoresNothing() {
  await saveTranscriptFile(UUID, serializeTranscript(afterATurn(false)))

  // Off is written as absence, so it is indistinguishable from never having been set — which is what
  // keeps an older build's file and a current one's identical for a session that decided nothing.
  assert.doesNotMatch(storedFile(), /autoApprove/, 'turning it back off leaves no key')
  assert.equal(rehydrateTranscript(await loadTranscriptFile(UUID)).autoApprove, false, 'and reads as off')
  results.push('a session turned back off leaves no key, so absence keeps meaning "never stored"')
}

/**
 * The turn-boundary capture riding on the same save must not disturb the flag.
 *
 * The save command is the exact call the pane makes, with the capture switched on through the sources
 * main installs. What is asserted is the pairing: an episode lands for the completed turn, the stored
 * bytes still carry the consent key, and a later save with no turns writes no further block — an
 * empty conversation is not an episode, which is the same gate that keeps the flag-only save silent.
 */
async function aCaptureAlongsideTheSaveLeavesTheFlagAlone() {
  const userData = process.env.SAM_TEST_USER_DATA
  if (!userData) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  const root = join(userData, 'workspace')
  mkdirSync(root, { recursive: true })

  setEpisodesEnabledSource(() => true)
  setSessionRootSource((id) => (id === UUID ? root : null))
  try {
    const record = sessionsModule.record.saveTranscript as unknown as {
      resolver: (opts: { input: unknown }) => Promise<void>
    }
    await record.resolver({ input: { id: UUID, snapshot: serializeTranscript(afterATurn(true)) } })

    const page = join(memoryRoot(userData, root), 'episodes', `${UUID}.md`)
    for (let attempt = 0; attempt < 200 && !existsSync(page); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(existsSync(page), 'the completed turn was captured beside the save')
    assert.match(storedFile(), /"autoApprove":true/, 'the flag is still in the bytes the save wrote')
    assert.equal((await loadTranscriptFile(UUID))?.autoApprove, true, 'and reads back on')

    const emptySave = { version: TRANSCRIPT_VERSION, interrupted: false, turns: [], autoApprove: true }
    await record.resolver({ input: { id: UUID, snapshot: emptySave } })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(
      (readFileSync(page, 'utf8').match(/<!-- episode turn=/g) ?? []).length,
      1,
      'a flag-only save with no completed turn writes no second block'
    )

    results.push('capturing beside a turn-boundary save leaves the stored consent flag untouched')
  } finally {
    setEpisodesEnabledSource(null)
    setSessionRootSource(null)
  }
}

// ---------------------------------------------------------------- agreement with the schema

function whatWeWriteIsWhatTheReaderAccepts() {
  const written = serializeTranscript(afterATurn(true))
  const parsed = transcriptSnapshotSchema.safeParse(written)

  assert.ok(parsed.success, 'the writer produces a snapshot the reader accepts')
  assert.equal(parsed.data.autoApprove, true, 'with the flag intact through the parse')
  results.push('the writer and the schema agree about the stored flag')
}

// ---------------------------------------------------------------- harness

let sessionDir = ''

function sessionsDir(): string {
  return sessionDir
}

async function main() {
  const root = process.env.SAM_TEST_USER_DATA
  if (!root) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  sessionDir = join(root, 'sessions')
  mkdirSync(sessionDir, { recursive: true })

  try {
    await step('schema agreement', whatWeWriteIsWhatTheReaderAccepts)
    await step('on survives', anOnFlagSurvivesATurnBoundarySave)
    await step('never toggled', aConversationNeverToggledStoresNothing)
    await step('turned back off', turningItBackOffStoresNothing)
    await step('capture beside the save', aCaptureAlongsideTheSaveLeavesTheFlagAlone)

    console.log(`auto-approve persistence: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('AUTO-APPROVE PERSISTENCE TEST FAILED:', err)
  process.exit(1)
})
