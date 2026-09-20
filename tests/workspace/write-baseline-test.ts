/**
 * Verifies the write baseline against a real filesystem.
 *
 * The mtime is the whole mechanism, so a mocked `fs` would test the mock: what has to hold is that a
 * `stat` before the write sees the same number a `stat` at read time did, that writing actually moves
 * it, and that a file someone else has changed is refused rather than overwritten. Those are
 * properties of the disk, so this drives a real temp directory.
 *
 * Both directions matter. A guard that refused a legitimate save would make the editor unusable — the
 * user could never save twice — so "a matching baseline succeeds and hands back the new mtime" is
 * asserted as carefully as the refusal is.
 *
 * No electron: the helpers take a root path, and the registered command is invoked the way the router
 * invokes it, so the tested path is the one the app uses rather than a reimplementation of it.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { workspaceModule, writeWorkspaceFile } from '../../conveyor/modules/workspace'
import { setWorkspaceChangeSink } from '../../conveyor/events'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-write-'))
  roots.push(root)
  return root
}

/**
 * Two fixed mtimes, far enough apart to be unmistakable.
 *
 * Stamped explicitly rather than left to the clock. Two writes in quick succession can land inside the
 * filesystem's mtime granularity, in which case a "stale" baseline is not actually stale and the guard
 * rightly allows the write — a test that depended on the wall clock would pass alone and fail under
 * load, which is exactly what happened before this was pinned.
 */
const T1 = 1_700_000_000
const T2 = 1_700_000_100

/**
 * Write a file directly, as another program would — the external edit this guard is about — and stamp
 * its mtime so the guard's comparison is deterministic.
 */
function externalWrite(root: string, name: string, content: string, mtimeSeconds: number): number {
  const path = join(root, name)
  writeFileSync(path, content, 'utf8')
  utimesSync(path, mtimeSeconds, mtimeSeconds)
  return statSync(path).mtimeMs
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
function writeFileCommand(): {
  resolver: (opts: { input: unknown }) => Promise<{ path: string; bytes: number; mtimeMs: number | null }>
} {
  return workspaceModule.record.writeFile as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ path: string; bytes: number; mtimeMs: number | null }>
  }
}

function readFileQuery(): {
  resolver: (opts: { input: unknown }) => Promise<{ content: string; path: string; baselineMtime?: number }>
} {
  return workspaceModule.record.readFile as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ content: string; path: string; baselineMtime?: number }>
  }
}

// ---------------------------------------------------------------- the read

async function aReadReportsTheMtimeItRead() {
  const root = makeRoot()
  const mtime = externalWrite(root, 'a.txt', 'one\n', T1)

  const read = await readFileQuery().resolver({ input: { path: join(root, 'a.txt') } })

  assert.equal(read.content, 'one\n', 'the read still returns the contents')
  assert.equal(read.baselineMtime, mtime, 'and the mtime of the bytes it just read')
  results.push('readFile reports the mtime alongside the content')
}

// ---------------------------------------------------------------- the guard

async function aMatchingBaselineSucceedsAndReturnsTheNewMtime() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)

  const written = await writeWorkspaceFile(root, 'a.txt', 'two\n', { baselineMtime: baseline })

  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'two\n', 'the write happened')
  // The caller needs the new mtime to guard its *next* save; without it the second save would be
  // refused against a baseline nothing had updated.
  assert.ok(written.mtimeMs !== null, 'a new mtime is returned')
  assert.notEqual(written.mtimeMs, baseline, 'and it is not the old one')
  assert.equal(written.mtimeMs, statSync(join(root, 'a.txt')).mtimeMs, 'it is what a fresh stat reports')

  // The value returned is exactly what the next guarded write compares against.
  const again = await writeWorkspaceFile(root, 'a.txt', 'three\n', { baselineMtime: written.mtimeMs })
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'three\n', 'so a second save in a row works')
  assert.ok(again.mtimeMs !== written.mtimeMs, 'and it moves on again')

  results.push('a write guarded by the mtime it just read succeeds and returns the new mtime')
}

async function aStaleBaselineIsRefusedAndTouchesNothing() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)
  // Someone else writes the file after we read it — the silent-overwrite case.
  externalWrite(root, 'a.txt', 'theirs\n', T2)

  const code = await codeOf(() => writeWorkspaceFile(root, 'a.txt', 'mine\n', { baselineMtime: baseline }))

  assert.equal(code, 'WRITE_CONFLICT', 'the refusal is reported under its own code')
  // The assertion that matters most: the other writer's bytes are still there.
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'theirs\n', 'and the disk was left exactly as it was')
  results.push('a stale baseline refuses the write and leaves the other writer’s bytes in place')
}

async function forceOverwritesAStaleBaseline() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)
  externalWrite(root, 'a.txt', 'theirs\n', T2)

  const written = await writeWorkspaceFile(root, 'a.txt', 'mine\n', { baselineMtime: baseline, force: true })

  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'mine\n', 'the forced write wins')
  assert.equal(written.mtimeMs, statSync(join(root, 'a.txt')).mtimeMs, 'and reports the mtime it left behind')
  results.push('an explicit force overwrites a stale baseline')
}

async function noBaselineIsExactlyTheOldBehaviour() {
  const root = makeRoot()
  externalWrite(root, 'a.txt', 'one\n', T1)
  externalWrite(root, 'a.txt', 'theirs\n', T2)

  // No baseline at all: the agent's write path and the terminal. Unguarded, as before this phase.
  const written = await writeWorkspaceFile(root, 'a.txt', 'agent\n')

  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'agent\n', 'an unguarded write still just writes')
  assert.ok(written.mtimeMs !== null, 'and still reports the mtime, for a caller that wants it')
  results.push('a write with no baseline behaves exactly as it did before the guard existed')
}

async function aDeletedFileIsAConflictAndForceRecreatesIt() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)
  unlinkSync(join(root, 'a.txt'))

  // The file the user had open is gone. Writing would silently recreate it over a deletion they may
  // have made on purpose, so it is a conflict rather than a fresh write.
  assert.equal(
    await codeOf(() => writeWorkspaceFile(root, 'a.txt', 'mine\n', { baselineMtime: baseline })),
    'WRITE_CONFLICT'
  )
  assert.throws(() => readFileSync(join(root, 'a.txt'), 'utf8'), 'nothing was recreated')

  await writeWorkspaceFile(root, 'a.txt', 'mine\n', { baselineMtime: baseline, force: true })
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'mine\n', 'and force brings it back')
  results.push('a file deleted underneath the editor is a conflict, and force recreates it')
}

async function aRefusedWriteAnnouncesNothing() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)
  externalWrite(root, 'a.txt', 'theirs\n', T2)

  // The events module holds the fan-out main installs, so a suite can install its own and watch what
  // actually crosses it. A refused write must announce nothing: nothing changed on disk, and an
  // invalidation raised for it would have the renderer refetch as though the write had happened.
  const seen: unknown[] = []
  setWorkspaceChangeSink((payload) => seen.push(payload))
  try {
    assert.equal(
      await codeOf(() => writeWorkspaceFile(root, 'a.txt', 'mine\n', { baselineMtime: baseline })),
      'WRITE_CONFLICT'
    )
    assert.deepEqual(seen, [], 'a refused write announces nothing')

    // The instrument engaged: an unguarded write through the same sink does announce, so the empty
    // array above is the guard being quiet rather than the sink being disconnected.
    await writeWorkspaceFile(root, 'a.txt', 'mine\n')
    assert.equal(seen.length, 1, 'while a write that does happen announces exactly once')
  } finally {
    setWorkspaceChangeSink(null)
  }

  results.push('a refused write announces no change, and a real one still does')
}

// ---------------------------------------------------------------- the registered command

async function theCommandForwardsBaselineAndForce() {
  const root = makeRoot()
  const baseline = externalWrite(root, 'a.txt', 'one\n', T1)
  const path = join(root, 'a.txt')
  const command = writeFileCommand()

  const ok = await command.resolver({ input: { path, content: 'two\n', rootPath: root, baselineMtime: baseline } })
  assert.equal(ok.mtimeMs, statSync(path).mtimeMs, 'the command returns the new mtime it wrote')

  // Stale now, because someone else has written the file since that mtime was taken. Stamped rather
  // than left to the clock, so "stale" is a fact rather than a hope about timing.
  externalWrite(root, 'a.txt', 'theirs\n', T2)
  assert.equal(
    await codeOf(() =>
      command.resolver({ input: { path, content: 'mine\n', rootPath: root, baselineMtime: ok.mtimeMs } })
    ),
    'WRITE_CONFLICT'
  )

  // And the same call with force goes through, which is what the editor's second deliberate click
  // sends.
  const forced = await command.resolver({
    input: { path, content: 'mine\n', rootPath: root, baselineMtime: ok.mtimeMs, force: true },
  })
  assert.equal(readFileSync(path, 'utf8'), 'mine\n', 'force through the command overwrites')
  assert.equal(forced.bytes, Buffer.byteLength('mine\n', 'utf8'), 'and the byte count is still reported')
  results.push('the registered command forwards the baseline and the force flag')
}

async function theCommandStillAcceptsAnInputWithNoBaseline() {
  const root = makeRoot()
  const path = join(root, 'fresh.txt')

  // The schema must keep accepting the shape the agent and the terminal use, or their writes would
  // start failing validation the moment this field was added.
  const written = await writeFileCommand().resolver({ input: { path, content: 'x\n', rootPath: root } })
  assert.equal(readFileSync(path, 'utf8'), 'x\n', 'a write with no baseline field still works')
  assert.ok(written.mtimeMs !== null, 'and reports an mtime for whatever comes next')
  results.push('the command still accepts an input with no baseline, so existing callers are unaffected')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('read: mtime', aReadReportsTheMtimeItRead)
    await step('guard: match', aMatchingBaselineSucceedsAndReturnsTheNewMtime)
    await step('guard: stale', aStaleBaselineIsRefusedAndTouchesNothing)
    await step('guard: force', forceOverwritesAStaleBaseline)
    await step('guard: absent', noBaselineIsExactlyTheOldBehaviour)
    await step('guard: deleted', aDeletedFileIsAConflictAndForceRecreatesIt)
    await step('guard: silent', aRefusedWriteAnnouncesNothing)
    await step('command: forwards', theCommandForwardsBaselineAndForce)
    await step('command: no baseline', theCommandStillAcceptsAnInputWithNoBaseline)

    console.log(`write baseline: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('WRITE BASELINE TEST FAILED:', err)
  process.exit(1)
})
