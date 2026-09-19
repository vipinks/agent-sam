/**
 * Verifies the startup sweep for orphaned transcript files.
 *
 * The gap it closes: deleting a session removes metadata first and the file second, so a failed file
 * delete strands the bytes forever — nothing references them, and nothing would ever look at them
 * again. The sweep runs on startup and removes files whose session metadata is gone.
 *
 * Covers the rule on its own (both the sweep and the non-sweep cases), and the filesystem path end to
 * end: two orphans seeded on disk are both removed, and a live session's transcript is untouched.
 * The live case is the one that matters — a sweep that is too eager would delete a real conversation,
 * which is far worse than the leak it is fixing.
 *
 * No Electron: `app.getPath` is stubbed through the shared electron stub, so this can never touch the
 * real user's app data.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orphanedTranscriptFiles, sweepOrphanedTranscripts } from '../../conveyor/modules/sessions'
import { emptySnapshot } from '../../conveyor/protocol/transcript'

const results: string[] = []

function check(name: string, condition: boolean, detail?: string): void {
  results.push(name)
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
}

const LIVE_ID = '11111111-2222-4333-8444-555555555555'
const ORPHAN_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const ORPHAN_B = 'bbbbbbbb-2222-4222-8222-222222222222'

/** Point the module at a private directory for this run. */
function setUserData(dir: string): void {
  process.env.SAM_TEST_USER_DATA = dir
}

// ---------------------------------------------------------------------------------------------
// The rule, without a filesystem.
// ---------------------------------------------------------------------------------------------

function testRule(): void {
  // Two orphaned files and one live one: only the orphans are selected.
  const picked = orphanedTranscriptFiles([`${ORPHAN_A}.json`, `${ORPHAN_B}.json`, `${LIVE_ID}.json`], [LIVE_ID])
  check(
    'the rule selects exactly the files with no metadata',
    picked.length === 2 && picked.includes(ORPHAN_A) && picked.includes(ORPHAN_B),
    JSON.stringify(picked)
  )

  // A file that is not a transcript at all is none of the sweep's business.
  check(
    'the rule ignores files that are not transcript-shaped',
    orphanedTranscriptFiles(['notes.json', 'README.md', `${LIVE_ID}.json.txt`], []).length === 0
  )

  // Nothing on disk, nothing to do.
  check('the rule is empty for an empty directory', orphanedTranscriptFiles([], [LIVE_ID]).length === 0)

  // Everything on disk is live: nothing swept. This is the dangerous direction, asserted directly.
  check(
    'a fully live directory yields no orphans',
    orphanedTranscriptFiles([`${LIVE_ID}.json`], [LIVE_ID]).length === 0
  )

  // An interrupted atomic write's temp file is not a session and must not be swept: its rename may
  // still be in flight. It fails the uuid shape check, which is what keeps it safe.
  check(
    'a leftover temp file from an atomic write is not treated as an orphan',
    orphanedTranscriptFiles([`${LIVE_ID}.json.1234.tmp`], []).length === 0
  )
}

// ---------------------------------------------------------------------------------------------
// The sweep, against real files.
// ---------------------------------------------------------------------------------------------

async function testSweep(): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'sam-ai-sweep-'))
  setUserData(userData)

  const dir = join(userData, 'sessions')
  mkdirSync(dir, { recursive: true })

  // Two orphans, and one live session with a real transcript.
  writeFileSync(join(dir, `${ORPHAN_A}.json`), JSON.stringify(emptySnapshot()), 'utf8')
  writeFileSync(join(dir, `${ORPHAN_B}.json`), JSON.stringify(emptySnapshot()), 'utf8')
  writeFileSync(join(dir, `${LIVE_ID}.json`), JSON.stringify(emptySnapshot()), 'utf8')

  const swept = await sweepOrphanedTranscripts([LIVE_ID])

  check('both orphans are swept', swept === 2, `swept ${swept}`)
  check('the first orphan file is gone', !existsSync(join(dir, `${ORPHAN_A}.json`)))
  check('the second orphan file is gone', !existsSync(join(dir, `${ORPHAN_B}.json`)))
  check('the live session file is untouched', existsSync(join(dir, `${LIVE_ID}.json`)))

  // Idempotent: a second startup finds nothing to do.
  const again = await sweepOrphanedTranscripts([LIVE_ID])
  check('a second sweep finds nothing to remove', again === 0, `swept ${again}`)
  check('the live session survives a second sweep', existsSync(join(dir, `${LIVE_ID}.json`)))

  // An empty store must NOT be read as "everything is an orphan" by the sweep itself — the caller
  // passes the ids, so an empty list means an empty store means every file is genuinely orphaned.
  // Asserted explicitly because this is the direction that deletes user data if the caller is wrong.
  writeFileSync(join(dir, `${ORPHAN_A}.json`), JSON.stringify(emptySnapshot()), 'utf8')
  const withEverythingLive = await sweepOrphanedTranscripts([LIVE_ID, ORPHAN_A])
  check('files whose metadata still exists are never swept', withEverythingLive === 0)
  check('the newly live file is still present', existsSync(join(dir, `${ORPHAN_A}.json`)))

  rmSync(userData, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  testRule()
  console.log(`sweep rule: ${results.length} checks passed`)

  const before = results.length
  await testSweep()
  console.log(`sweep filesystem: ${results.length - before} checks passed`)

  console.log(`ORPHAN SWEEP PASSED: ${results.length} checks`)
}

main().catch((err) => {
  console.error('ORPHAN SWEEP FAILED:', err)
  process.exit(1)
})
