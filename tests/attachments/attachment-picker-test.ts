/**
 * Verifies the composer's file picker at the boundary the renderer actually reaches.
 *
 * The command is invoked the way the router invokes it, over the shared Electron stub, so what is
 * under test is the handler and its schema rather than a helper beside them. The dialog's own answer
 * comes from `SAM_TEST_OPEN_PATHS` (see `tests/stubs/`), which is what lets one suite exercise both
 * endings without a dialog existing anywhere.
 *
 * The paths are real files in a temp directory, and outside the workspace on purpose: the dialog is
 * the one gesture that can reach a file the tree does not list, and the command must hand back exactly
 * what it was given rather than resolving, filtering or re-spelling it.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageAttachmentsModule } from '../../conveyor/modules/image-attachments'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-attach-picker-'))
  roots.push(root)
  return root
}

/** The registered command, as the router reaches it. */
function pickCommand(): {
  kind?: string
  input?: unknown
  resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown>
} {
  const member = imageAttachmentsModule.record['pick'] as unknown as {
    kind?: string
    input?: unknown
    resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown>
  }
  assert.ok(member?.resolver, 'pick must have a resolver')
  return member
}

/** Run the command the way a window-less caller does, which is also the shape a test can state. */
function pick(): Promise<unknown> {
  return pickCommand().resolver({ input: undefined, ctx: { window: undefined } })
}

/** The options the dialog was last asked with, recorded by the stub. */
function lastDialogOptions(): { properties?: string[]; filters?: unknown } {
  const recorded = (globalThis as { __samLastOpenDialogOptions?: unknown }).__samLastOpenDialogOptions
  assert.ok(recorded && typeof recorded === 'object', 'the dialog must have been asked at all')
  return recorded as { properties?: string[]; filters?: unknown }
}

async function theSelectionComesBackUnchanged() {
  const root = makeRoot()
  const notes = join(root, 'notes.txt')
  const data = join(root, 'data.csv')
  writeFileSync(notes, 'notes\n', 'utf8')
  writeFileSync(data, 'a,b\n', 'utf8')

  process.env.SAM_TEST_OPEN_PATHS = JSON.stringify([notes, data])
  try {
    const picked = await pick()
    // Exactly what the dialog returned, in its order: the paths are the draft's to own, and a command
    // that resolved or filtered them would disagree with the dialog the user just answered.
    assert.deepEqual(picked, [notes, data], `expected the dialog's paths back, got ${JSON.stringify(picked)}`)
  } finally {
    delete process.env.SAM_TEST_OPEN_PATHS
  }
  results.push('the picker returns the dialog selection, in the order it was given')
}

async function aCancelledDialogIsAnEmptyList() {
  delete process.env.SAM_TEST_OPEN_PATHS

  const picked = await pick()

  // Not null and not a throw: a dismissed dialog is an ordinary outcome, and the composer adds nothing
  // to the draft and says nothing about it.
  assert.deepEqual(picked, [], `a cancelled dialog must be an empty list, got ${JSON.stringify(picked)}`)
  results.push('a cancelled dialog is an empty list rather than an error')
}

async function thePickerAsksForManyFilesAndFiltersNothing() {
  const root = makeRoot()
  process.env.SAM_TEST_OPEN_PATHS = JSON.stringify([join(root, 'a.md')])
  try {
    await pick()
  } finally {
    delete process.env.SAM_TEST_OPEN_PATHS
  }

  const options = lastDialogOptions()
  // Multi-select, because a composer message carries many files and asking once per file would be a
  // dialog per chip. `openFile` rather than both, so the dialog cannot hand back a directory the send
  // would then fail to read.
  assert.deepEqual(options.properties, ['openFile', 'multiSelections'], `got ${JSON.stringify(options.properties)}`)
  // And no type filter at all: any file may be a mention, so a filter here would be the picker
  // refusing before the user had chosen.
  assert.equal(options.filters, undefined, 'the picker must not narrow the dialog to a file type')
  results.push('the picker is a multi-select open dialog with no type filter')
}

async function thePickerIsACommandWithNoInput() {
  const member = pickCommand()

  // A command rather than a query: it opens a window, which is a write side-effect even though the
  // answer is only a list of paths.
  assert.equal(member.kind, 'command', 'pick must be registered as a command')
  // And it takes no input, so a renderer cannot aim the dialog or seed it with paths of its own.
  assert.equal(member.input, undefined, 'pick must declare no input schema, so the renderer cannot aim it')
  results.push('pick is an inputless command')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('pick: selection', theSelectionComesBackUnchanged)
    await step('pick: cancel', aCancelledDialogIsAnEmptyList)
    await step('pick: dialog options', thePickerAsksForManyFilesAndFiltersNothing)
    await step('pick: registered', thePickerIsACommandWithNoInput)

    console.log(`attachment picker: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('ATTACHMENT PICKER TEST FAILED:', err)
  process.exit(1)
})
