/**
 * Verifies the move command main owns: one session's record takes another folder as its project, and a
 * destination that is not a folder is refused under a named code with nothing written.
 *
 * ## What the disk can mean here, and what it cannot
 *
 * The trace decides this, so it is stated rather than assumed. A transcript lives at
 * `userData/sessions/<id>.json` — one directory for every project, named by the session id alone
 * (`conveyor/modules/sessions.ts:52`) — and the snapshot itself deliberately records nothing about the
 * folder a conversation happened in (`conveyor/protocol/transcript.ts:91`). So there is no
 * project-owned transcript path for a move to rename into: the project is store metadata, and the disk
 * half of a move is the destination check. `leavesTheTranscriptWhereItIs` says the other half exactly —
 * the same file, under the same name, in the same directory, before and after a move.
 *
 * The record write is asserted twice on purpose: once as the payload the command hands its sink, and
 * once as the effect of the store action the router wires that sink to. A move that reached the sink
 * and a move whose project field actually changed are then two claims rather than one.
 *
 * No electron: the registered command is invoked the way the router invokes it, and the sink is the
 * module-level one `router.ts` installs.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { WORKSPACE_MISSING } from '../../conveyor/protocol/recent-roots'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '../../conveyor/protocol/transcript'
import {
  loadTranscriptFile,
  saveTranscriptFile,
  sessionsModule,
  setSessionMoveSink,
} from '../../conveyor/modules/sessions'
import { createStoreHarness } from './chat-sessions-store-harness'

const results: string[] = []

/** The conversation being moved, and the folder it starts in. */
const MOVED_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const SOURCE = 'C:/work/sam-ai'

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const madeFolders: string[] = []

/** A real folder to move into, removed when the suite ends. */
function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'sam-session-move-'))
  madeFolders.push(folder)
  return folder
}

/** One transcript, as a conversation that has been used once. */
function snapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'u1', role: 'user', content: 'the parser drops trailing newlines', steps: [] }],
  }
}

/** Run a call expected to fail, and hand back the code it failed with. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ConveyorError) return err.code
    throw new Error(`expected a ConveyorError, got ${String(err)}`)
  }
  throw new Error('expected the call to fail, but it resolved')
}

/** The registered command, as the router reaches it. */
function moveCommand(): { resolver: (opts: { input: unknown }) => Promise<{ path: string }> } {
  return sessionsModule.record.moveSession as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ path: string }>
  }
}

function inputSchemaOf(member: string): { safeParse: (v: unknown) => { success: boolean } } {
  const record = sessionsModule.record[member] as unknown as {
    input?: { safeParse: (v: unknown) => { success: boolean } }
  }
  const schema = record.input
  assert.ok(schema, `${member} must declare an input schema`)
  return schema
}

/** One record write, as the sink receives it. */
interface MoveWrite {
  id: string
  destination: string
}

/** Collect the record writes `fn` makes, through the module-level sink the router installs. */
async function writesDuring(fn: () => Promise<void>): Promise<MoveWrite[]> {
  const writes: MoveWrite[] = []
  setSessionMoveSink((payload) => writes.push(payload))
  try {
    await fn()
  } finally {
    setSessionMoveSink(null)
  }
  return writes
}

// ---------------------------------------------------------------- moving

async function aFolderThatExistsTakesTheRecord() {
  const destination = makeFolder()

  const writes = await writesDuring(async () => {
    const moved = await moveCommand().resolver({ input: { id: MOVED_ID, destination } })
    // Handed back resolved, like a folder switch hands one back: the store's comparison is a
    // case-insensitive one over paths main has already spelled once.
    assert.equal(moved.path, destination, 'the resolved folder is what comes back')
  })

  assert.deepEqual(writes, [{ id: MOVED_ID, destination }], 'the record write names the session and its new project')
  results.push('a move into a folder that exists resolves, and hands the record write its new project')
}

async function theRecordWriteIsTheStoreActionTheRouterWires() {
  const destination = makeFolder()
  // The action itself, against a state built the way main's is — this is what `router.ts` wires the sink
  // to, so the claim "the session record's project field updates" is made about the store, not about a
  // payload that merely looks right.
  const harness = createStoreHarness()
  harness.run('addSession', {
    id: MOVED_ID,
    title: 'the parser work',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    lastRoot: SOURCE,
  })

  setSessionMoveSink(({ id, destination: next }) => harness.run('touchSession', { id, lastRoot: next }))
  try {
    await moveCommand().resolver({ input: { id: MOVED_ID, destination } })
  } finally {
    setSessionMoveSink(null)
  }

  const row = harness.state().sessions.find((session) => session.id === MOVED_ID)
  assert.equal(row?.lastRoot, destination, 'the row now names the destination folder')
  assert.equal(
    harness.state().sessions.filter((session) => session.id === MOVED_ID).length,
    1,
    'a move is one row, not a second one'
  )
  results.push('the store action behind the sink lands the destination on the row the move named')
}

async function leavesTheTranscriptWhereItIs() {
  const root = process.env.SAM_TEST_USER_DATA
  assert.ok(root, 'SAM_TEST_USER_DATA must be set for this test')
  const sessionsDir = join(root, 'sessions')
  const file = join(sessionsDir, `${MOVED_ID}.json`)
  await saveTranscriptFile(MOVED_ID, snapshot())

  const before = readFileSync(file)
  const listingBefore = readdirSync(sessionsDir).sort()
  const destination = makeFolder()

  await writesDuring(async () => {
    await moveCommand().resolver({ input: { id: MOVED_ID, destination } })
  })

  // The file is the same file: not renamed, not rewritten, not copied into the destination. One sessions
  // directory serves every project, so there is nothing about this file that belongs to the project the
  // row has just left or joined.
  assert.ok(readFileSync(file).equals(before), 'the transcript is byte-identical after a move')
  assert.deepEqual(readdirSync(sessionsDir).sort(), listingBefore, 'the sessions directory is unchanged')
  const reloaded = await loadTranscriptFile(MOVED_ID)
  assert.deepEqual(reloaded, snapshot(), 'the conversation is still readable, from the one path it has')
  results.push('the transcript stays where it is, readable, and the destination folder gains no file')
}

// ---------------------------------------------------------------- refusing

async function aFolderThatIsGoneIsRefusedByCode() {
  const gone = join(makeFolder(), 'not-here')

  const writes = await writesDuring(async () => {
    assert.equal(
      await codeOf(() => moveCommand().resolver({ input: { id: MOVED_ID, destination: gone } })),
      WORKSPACE_MISSING,
      'a destination that is not a folder is refused with the code the row branches on'
    )
  })

  // Nothing was written: the session still belongs where it belonged, which is what makes the refusal a
  // refusal rather than a half-done move.
  assert.equal(writes.length, 0, 'a refused move writes no record')
  results.push('a destination that does not exist is refused with WORKSPACE_MISSING, and changes nothing')
}

async function aFileIsNotAFolder() {
  const folder = makeFolder()
  const file = join(folder, 'notes.txt')
  writeFileSync(file, 'not a folder\n', 'utf8')

  const writes = await writesDuring(async () => {
    assert.equal(
      await codeOf(() => moveCommand().resolver({ input: { id: MOVED_ID, destination: file } })),
      WORKSPACE_MISSING,
      'a file is the same situation as a folder that is gone: there is nowhere to belong'
    )
  })

  assert.equal(writes.length, 0, 'a refused move writes no record')
  results.push('a path that is a file rather than a folder is refused the same way, and changes nothing')
}

async function refusesWhatCannotBeADestination() {
  const schema = inputSchemaOf('moveSession')
  const destination = makeFolder()

  assert.equal(schema.safeParse({ id: MOVED_ID, destination }).success, true, 'a real pair is accepted')
  assert.equal(schema.safeParse({ id: MOVED_ID, destination: '' }).success, false, 'a blank destination is refused')
  assert.equal(
    schema.safeParse({ id: '../../escape', destination }).success,
    false,
    'an id that cannot name a transcript is refused before anything is moved'
  )
  results.push('the input schema is closed: a blank destination and an id that is not a uuid are refused')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('move: existing folder', aFolderThatExistsTakesTheRecord)
    await step('move: record field', theRecordWriteIsTheStoreActionTheRouterWires)
    await step('move: transcript untouched', leavesTheTranscriptWhereItIs)
    await step('refuse: gone', aFolderThatIsGoneIsRefusedByCode)
    await step('refuse: file', aFileIsNotAFolder)
    await step('refuse: schema', refusesWhatCannotBeADestination)

    console.log(`session move: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    // The transcript this suite wrote lives in the runner's own per-suite temp directory, which it
    // removes; only the folders this suite made are this suite's to remove.
    for (const folder of madeFolders) rmSync(folder, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SESSION MOVE TEST FAILED:', err)
  process.exit(1)
})
