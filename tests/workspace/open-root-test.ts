/**
 * Verifies the root check against a real filesystem.
 *
 * The whole behaviour is a `stat`, so a mocked one would test the mock: what has to hold is that a
 * folder that exists opens, that one that does not is refused with a code rather than an errno, that a
 * *file* is refused the same way, and that a refusal changes nothing — no event, no path handed back.
 * Those are properties of the disk, so this drives real temp directories.
 *
 * The resolve is asserted here too, because it is the property the recents list's comparison rests on:
 * every root that reaches the store has been spelled once, by main, before the store sees it.
 *
 * No electron: the registered command is invoked the way the router invokes it, and the event sink is
 * the module-level one main installs in `router.ts`.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { workspaceModule } from '../../conveyor/modules/workspace'
import { setWorkspaceChangeSink, type WorkspaceChanged } from '../../conveyor/events'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-open-root-'))
  roots.push(root)
  return root
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
function openRootCommand(): { resolver: (opts: { input: unknown }) => Promise<{ path: string }> } {
  return workspaceModule.record.openRoot as unknown as {
    resolver: (opts: { input: unknown }) => Promise<{ path: string }>
  }
}

/** Every event raised while `fn` runs, as the windows would receive them. */
async function eventsDuring(fn: () => Promise<void>): Promise<WorkspaceChanged[]> {
  const received: WorkspaceChanged[] = []
  setWorkspaceChangeSink((payload) => received.push(payload))
  try {
    await fn()
  } finally {
    setWorkspaceChangeSink(null)
  }
  return received
}

// ---------------------------------------------------------------- opening

async function anExistingFolderOpens() {
  const root = makeRoot()

  const opened = await openRootCommand().resolver({ input: { path: root } })

  assert.equal(opened.path, root, 'the folder is reported back')
  results.push('a folder that exists opens, and is reported back')
}

async function thePathThatComesBackIsResolved() {
  const root = makeRoot()
  // The same folder spelled with a trailing separator — the spelling the recents comparison depends on
  // main having removed before the store ever holds two of them.
  const opened = await openRootCommand().resolver({
    input: { path: `${root}${process.platform === 'win32' ? '\\' : '/'}` },
  })

  assert.equal(opened.path, root, 'the resolved path is what is handed back, not what was sent')
  results.push('the path handed back is resolved, so one folder has one spelling in the store')
}

async function switchingAnnouncesItself() {
  const root = makeRoot()

  const received = await eventsDuring(async () => {
    await openRootCommand().resolver({ input: { path: root } })
  })

  // The renderer cannot see a switch by itself, so the tree, the git panel and the viewer hear about it
  // through the same channel every other change travels on.
  assert.equal(received.length, 1, `expected exactly one workspace change, got ${received.length}`)
  results.push('a successful switch raises exactly one workspace-changed event')
}

// ---------------------------------------------------------------- refusing

async function aFolderThatIsGoneIsRefusedByCode() {
  const root = makeRoot()
  const gone = join(root, 'not-here')

  assert.equal(
    await codeOf(() => openRootCommand().resolver({ input: { path: gone } })),
    'WORKSPACE_MISSING',
    'a missing folder is refused with the code the UI branches on'
  )
  results.push('a folder that does not exist is refused with WORKSPACE_MISSING')
}

async function aFileIsNotAFolder() {
  const root = makeRoot()
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'not a folder\n', 'utf8')

  // The same code, because it is the same situation as far as the explorer is concerned: there is
  // nothing here to browse.
  assert.equal(await codeOf(() => openRootCommand().resolver({ input: { path: file } })), 'WORKSPACE_MISSING')
  results.push('a path that is a file rather than a folder is refused the same way')
}

async function aRefusedSwitchChangesNothing() {
  const root = makeRoot()
  const gone = join(root, 'not-here')

  const received = await eventsDuring(async () => {
    await codeOf(() => openRootCommand().resolver({ input: { path: gone } }))
  })

  // No event: the tree the windows are showing is still correct, and invalidating it would ask for a
  // refetch of a folder nothing moved in — and, worse, would read as a switch having happened.
  assert.equal(received.length, 0, 'a refused switch announces nothing')
  results.push('a refused switch raises no event, so nothing on screen is invalidated')
}

async function aNestedFolderOpens() {
  const root = makeRoot()
  const nested = join(root, 'packages', 'app')
  mkdirSync(nested, { recursive: true })

  const opened = await openRootCommand().resolver({ input: { path: nested } })

  assert.equal(opened.path, nested, 'any folder is a workspace, not just a drive root')
  results.push('a nested folder opens')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('open: existing', anExistingFolderOpens)
    await step('open: resolved', thePathThatComesBackIsResolved)
    await step('open: announces', switchingAnnouncesItself)
    await step('open: nested', aNestedFolderOpens)
    await step('refuse: gone', aFolderThatIsGoneIsRefusedByCode)
    await step('refuse: file', aFileIsNotAFolder)
    await step('refuse: silent', aRefusedSwitchChangesNothing)

    console.log(`open root: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('OPEN ROOT TEST FAILED:', err)
  process.exit(1)
})
