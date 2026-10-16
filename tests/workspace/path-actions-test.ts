/**
 * The two acts an explorer row offers beyond opening it: removing a path, and showing it in the OS's
 * own file manager.
 *
 * A real temp directory rather than a mocked `fs`, because the claims are about the filesystem: that a
 * folder goes with everything inside it, that a refusal leaves the disk exactly as it was, and that the
 * event main raises is the one the renderer turns into a re-read. The procedures are invoked the way
 * the router invokes them — the registered record, with its own input — so what is exercised is the
 * shipped handler body rather than a copy of it.
 *
 * `electron` is stubbed for the whole node run (see `tests/stubs/`), and the stub records the
 * file-manager hand-off rather than performing it, which is what makes "the OS was handed this path" a
 * checkable claim instead of a claim about intent.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { ConveyorError } from 'electron-conveyor/main'
import { createChangeCoalescer, type ChangeHandlers } from '../../app/components/workbench/workspace-changes'
import { setWorkspaceChangeSink, type WorkspaceChanged } from '../../conveyor/events'
import { workspaceModule } from '../../conveyor/modules/workspace'
import { PATH_GONE, ROOT_UNREMOVABLE } from '../../conveyor/protocol/path-actions'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-path-actions-'))
  roots.push(root)
  return root
}

/** Everything main would push to the windows, in order. */
class Sink {
  received: WorkspaceChanged[] = []

  install() {
    setWorkspaceChangeSink((payload) => this.received.push(payload))
  }
}

/**
 * The registered removal, as the router reaches it.
 *
 * The registration is asserted rather than assumed. A command reached through a name main does not
 * register is not a passing suite, it is a suite exercising nothing — and asking for it here is what
 * makes "this path is removed" fail as a claim, on a tree that has no such command.
 */
function remove(): { resolver: (opts: { input: unknown }) => Promise<{ path: string }> } {
  const command = workspaceModule.record.deletePath
  assert.ok(command, 'main registers a deletePath command on the workspace module')

  return command as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ path: string }>
  }
}

/** The registered reveal, as the router reaches it. Asserted for the reason the removal is. */
function reveal(): { resolver: (opts: { input: unknown }) => Promise<{ path: string }> } {
  const command = workspaceModule.record.revealPath
  assert.ok(command, 'main registers a revealPath command on the workspace module')

  return command as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ path: string }>
  }
}

/** Run a call expected to fail, and hand back the error it failed with. */
async function errorOf(fn: () => Promise<unknown>): Promise<ConveyorError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ConveyorError) return err
    throw new Error(`expected a ConveyorError, got ${String(err)}`)
  }
  throw new Error('expected the call to fail, but it resolved')
}

/** What the file manager was handed, in order. The stub's own record, not an Electron API. */
function shownInFolder(): string[] {
  return (shell as unknown as { __shownInFolder: () => string[] }).__shownInFolder()
}

// ---------------------------------------------------------------- removing

async function aFileIsRemovedAndTheTreeIsToldToReadAgain() {
  const sink = new Sink()
  sink.install()
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'plain text')

  const removed = await remove().resolver({ input: { path: file, rootPath: root } })

  assert.equal(existsSync(file), false, 'the file is gone from disk')
  assert.equal(removed.path, file, 'and the removal answers with what it removed')

  // One event, and its own kind: a removal is not a write, and the renderer has to be able to tell the
  // two apart without being told twice.
  assert.equal(sink.received.length, 1, `expected exactly one change, got ${sink.received.length}`)
  assert.equal(sink.received[0].kind, 'removed', 'a removal announces itself as one')
  assert.equal(sink.received[0].path, removed.path, 'with the absolute path it removed')
  results.push('removing a file leaves it gone, and main announces the removal with its path')
}

async function aFolderIsRemovedWithEverythingInsideIt() {
  const root = makeRoot()
  const folder = join(root, 'src')
  mkdirSync(join(folder, 'nested'), { recursive: true })
  writeFileSync(join(folder, 'nested', 'deep.txt'), 'x')

  await remove().resolver({ input: { path: folder, rootPath: root } })

  assert.equal(existsSync(folder), false, 'a folder goes as the row named it, with its contents')
  results.push('removing a folder takes what is inside it')
}

async function theRemovalIsWhatRefetchesTheTree() {
  const sink = new Sink()
  sink.install()
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'plain text')

  await remove().resolver({ input: { path: file, rootPath: root } })

  // The renderer's own half, driven with exactly what main sent: any change in a burst refetches the
  // listings, which is how the row that was just removed stops being drawn by a tree that still holds it.
  const asked = { listings: 0, git: 0 }
  const handlers: ChangeHandlers = {
    invalidateListings: () => {
      asked.listings += 1
    },
    invalidateGit: () => {
      asked.git += 1
    },
    onWrites: () => undefined,
  }
  const coalescer = createChangeCoalescer(handlers, {
    delayMs: 60_000,
    schedule: (() => 0) as unknown as typeof setTimeout,
    cancel: () => undefined,
  })
  for (const payload of sink.received) coalescer.handle(payload)
  coalescer.flush()

  assert.equal(asked.listings, 1, 'the removal asks for the listings once, not per row')
  assert.equal(asked.git, 1, 'and for git, as every change in the workspace does')
  results.push('the removal event is what makes the explorer read the folder again')
}

async function aRemoveOfSomethingAlreadyGoneIsRefusedByItsOwnCode() {
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'plain text')
  rmSync(file)

  const error = await errorOf(() => remove().resolver({ input: { path: file, rootPath: root } }))

  assert.equal(error.code, PATH_GONE, 'a path deleted outside the app is refused under its own code')
  assert.ok(error.message.includes('notes.txt'), 'and names the file')
  results.push('a removal of a path that is already gone is refused by code')
}

async function theOpenFolderItselfIsNeverRemoved() {
  const sink = new Sink()
  sink.install()
  const root = makeRoot()
  writeFileSync(join(root, 'notes.txt'), 'plain text')

  const error = await errorOf(() => remove().resolver({ input: { path: root, rootPath: root } }))

  assert.equal(error.code, ROOT_UNREMOVABLE, 'the open folder is refused by its own code')
  assert.equal(existsSync(root), true, 'and it is still on disk')
  assert.equal(sink.received.length, 0, 'a refusal announces nothing')
  results.push('the open folder itself is never removed, and a refusal says nothing')
}

async function aPathOutsideTheWorkspaceIsRefused() {
  const root = makeRoot()
  const outside = join(root, '..', 'escaped.txt')
  writeFileSync(outside, 'x')

  const error = await errorOf(() => remove().resolver({ input: { path: '../../escaped.txt', rootPath: root } }))

  assert.equal(error.code, 'PATH_TRAVERSAL', 'containment is unchanged from every other write-side act')
  assert.equal(existsSync(outside), true, 'so nothing outside the open folder is touched')
  rmSync(outside, { force: true })
  results.push('a removal that names a path outside the open folder is refused')
}

async function aRefusedRemovalLeavesTheDiskAlone() {
  const sink = new Sink()
  sink.install()
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'plain text')
  rmSync(file)

  await errorOf(() => remove().resolver({ input: { path: file, rootPath: root } }))

  assert.equal(existsSync(file), false, 'the refused removal created nothing')
  assert.equal(sink.received.length, 0, 'and announced nothing')
  results.push('a refused removal leaves the disk, and the renderer, exactly as they were')
}

// ---------------------------------------------------------------- showing in the file manager

async function theFileManagerIsHandedThePath() {
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'plain text')
  const before = shownInFolder().length

  const shown = await reveal().resolver({ input: { path: file } })

  assert.deepEqual(shownInFolder().slice(before), [file], 'the OS file manager was handed this path, and only this one')
  assert.equal(shown.path, file, 'and the reveal answers with the path it showed')
  results.push('showing a path hands it to the OS file manager')
}

async function aRevealOfSomethingGoneIsRefusedByItsOwnCode() {
  const root = makeRoot()
  const before = shownInFolder().length

  const error = await errorOf(() => reveal().resolver({ input: { path: join(root, 'gone.txt') } }))

  assert.equal(error.code, PATH_GONE, 'there is nothing to show, and the refusal says which code')
  assert.equal(shownInFolder().length, before, 'nothing was handed to the file manager')
  results.push('showing a path that is gone is refused rather than opening the wrong folder')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('remove: file', aFileIsRemovedAndTheTreeIsToldToReadAgain)
    await step('remove: folder', aFolderIsRemovedWithEverythingInsideIt)
    await step('remove: re-read', theRemovalIsWhatRefetchesTheTree)
    await step('remove: gone', aRemoveOfSomethingAlreadyGoneIsRefusedByItsOwnCode)
    await step('remove: the open folder', theOpenFolderItselfIsNeverRemoved)
    await step('remove: outside the workspace', aPathOutsideTheWorkspaceIsRefused)
    await step('remove: refused', aRefusedRemovalLeavesTheDiskAlone)
    await step('reveal: the path', theFileManagerIsHandedThePath)
    await step('reveal: gone', aRevealOfSomethingGoneIsRefusedByItsOwnCode)

    console.log(`path actions: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('PATH ACTIONS TEST FAILED:', err)
  process.exit(1)
})
