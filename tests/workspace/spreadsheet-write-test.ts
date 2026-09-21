/**
 * The workbook write path, against real bytes on a real disk.
 *
 * Three things have to be true of this suite or it is not evidence of anything. The fixtures must be real
 * workbooks, written by the library the app actually parses and writes with, because the claims here are
 * about a file a spreadsheet program could have produced. The edits must go through the registered
 * command, invoked the way the router invokes it, so what is exercised is the app's own path rather than a
 * reimplementation of it. And the file must be *re-read* afterwards — from the bytes, not from anything
 * the write returned — because a write that reported the edit it made proves nothing about the file.
 *
 * What this suite is the second half of: `conveyor/protocol/spreadsheet-edit.ts` and the pane's edit list
 * are decided on plain values in `testing/spreadsheet-edit-rules.test.ts`, and the wiring that reaches
 * this command is the DOM suite's. Here is the part neither of those can see — whether a value edit
 * survives a round trip through the library, and whether the guard refuses a save that would overwrite
 * somebody else's.
 *
 * The survival profile asserted below is the probe's, not a hope: everything the round-trip probe measured
 * (`.preview/phase20-probe/`) that comes back intact is asserted to come back intact, and the one thing an
 * edit is *expected* to destroy — the formula in the cell it lands on — is asserted to be destroyed
 * exactly as measured, with the cells around it asserting the other half.
 *
 * No electron: `electron` is stubbed for the whole node run (see `tests/stubs/`).
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import * as ExcelJS from 'exceljs'
import { MAX_SHEET_ROWS } from '../../conveyor/protocol/spreadsheet'
import type { WorkbookBytes } from '../../conveyor/modules/spreadsheet-parse'
import { workspaceModule } from '../../conveyor/modules/workspace'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-sheet-write-'))
  roots.push(root)
  return root
}

/** What the write command returns. */
interface WriteResult {
  path: string
  mtimeMs: number | null
  replacedFormulas: number
}

/** The registered commands, as the router reaches them. */
function writeCommand(): { resolver: (opts: { input: unknown }) => Promise<WriteResult> } {
  return workspaceModule.record.writeSpreadsheet as unknown as {
    resolver: (opts: { input: unknown }) => Promise<WriteResult>
  }
}

interface ReadResult {
  sheets?: { name: string; rows: string[][] }[]
  path: string
  baselineMtime?: number
}

function readFilePath(): { resolver: (opts: { input: unknown }) => Promise<ReadResult> } {
  return workspaceModule.record.readFile as unknown as {
    resolver: (opts: { input: unknown }) => Promise<ReadResult>
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

/** Parse a file the way the app parses one, for claims about types rather than about strings. */
async function parse(path: string) {
  const workbook = new ExcelJS.Workbook()
  // The cast, and the dependency's shadowed `Buffer` declaration, are `spreadsheet-parse.ts`'s: see the
  // `WorkbookBytes` alias there, which is exported for exactly this — a second caller that loads bytes.
  await workbook.xlsx.load(readFileSync(path) as unknown as WorkbookBytes)
  return workbook
}

// ---------------------------------------------------------------- the fixtures, written for real

/** Two sheets: a header, a text column and two numeric columns. */
async function writePlain(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('One')
  sheet.addRow(['name', 'qty', 'price'])
  sheet.addRow(['alpha', 2, 1.5])
  sheet.addRow(['beta', 10, 0.25])

  workbook.addWorksheet('Two').addRow(['second sheet'])

  await workbook.xlsx.writeFile(path)
}

/**
 * Formulas, a styled cell, a conditional-formatting rule, and a second sheet.
 *
 * The two formulas differ deliberately: one was written without a cached result and one with, which is the
 * pair the read's display rule depends on and the pair that proves a save keeps cached values. The styled
 * cell is deliberately *not* the cell an edit lands on in the suite's own edits, so that "styles survive"
 * is measured on a cell nobody touched, and the rule's range is the formula cell an edit does land on, so
 * that the rule surviving its subject changing is measured too.
 */
async function writeRich(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('One')
  sheet.addRow(['label', 'value'])
  sheet.getRow(1).font = { bold: true }
  sheet.addRow(['a', 2])
  sheet.addRow(['b', 3])
  sheet.addRow(['sum', { formula: 'B2+B3' }])
  sheet.addRow(['prod', { formula: 'B2*B3', result: 6 }])
  sheet.getCell('B3').numFmt = '0.00'
  sheet.getCell('B3').font = { italic: true }
  sheet.addConditionalFormatting({
    ref: 'B4:B4',
    rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['3'], style: { font: { bold: true } } }],
  })

  workbook.addWorksheet('Two').addRow(['second sheet'])

  await workbook.xlsx.writeFile(path)
}

/** The eight bytes every OLE2 compound-file container starts with. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** `name` as a compound file stores a directory entry's name: UTF-16LE, no terminator. */
function utf16le(name: string): number[] {
  return [...name].flatMap((character) => {
    const code = character.charCodeAt(0)
    return [code & 0xff, (code >> 8) & 0xff]
  })
}

/**
 * A password-protected workbook's container: the OLE2 magic and the stream names that say so.
 *
 * Assembled here rather than produced by a library, because no library in the tree can encrypt — and it is
 * enough to be real evidence for the same reason it is in the read suite: the sniff reads exactly the magic
 * and the UTF-16LE stream name, and both are here in their real form.
 */
function encryptedContainer(): Buffer {
  return Buffer.concat([
    Buffer.from(CFB_MAGIC),
    Buffer.from(utf16le('Root Entry')),
    Buffer.from(utf16le('EncryptionInfo')),
    Buffer.from(utf16le('EncryptedPackage')),
    Buffer.alloc(2048, 0x11),
  ])
}

/**
 * A legacy binary workbook's container: the same magic, no encryption stream, no zip.
 *
 * This is the `.xls` case, and the point of the test below is that it needs no handling of its own. The
 * read refuses these bytes as unparseable, so an `.xls` never reaches the pane as a spreadsheet and there
 * is no grid to edit — the write refuses the same bytes with the same code, and inventing a second,
 * `.xls`-specific refusal would be a second answer to a question already answered.
 */
function legacyXlsContainer(): Buffer {
  return Buffer.concat([
    Buffer.from(CFB_MAGIC),
    Buffer.from(utf16le('Workbook')),
    Buffer.from(utf16le('SummaryInformation')),
    Buffer.alloc(1024, 0x42),
  ])
}

// ---------------------------------------------------------------- a value edit, round-tripped

async function aValueEditRoundTrips() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  const read = await readFilePath().resolver({ input: { path } })
  assert.equal(typeof read.baselineMtime, 'number', 'the read hands the editor its baseline')

  // Two edits in one save, and the pair is the typing rule stated end to end: the text cell keeps the
  // characters typed into it and the numeric cell takes the number.
  const written = await writeCommand().resolver({
    input: {
      path,
      edits: [
        { sheet: 0, row: 1, col: 0, value: '77' },
        { sheet: 0, row: 1, col: 1, value: '99' },
      ],
      baselineMtime: read.baselineMtime,
    },
  })

  assert.equal(written.replacedFormulas, 0, 'no formula was replaced by these edits')
  assert.equal(written.mtimeMs, statSync(path).mtimeMs, 'it reports the mtime the write left')

  // Visible on a re-read, through the app's own read path rather than through the library directly.
  const again = await readFilePath().resolver({ input: { path } })
  assert.deepEqual(
    again.sheets?.[0].rows,
    [
      ['name', 'qty', 'price'],
      ['77', '99', '1.5'],
      ['beta', '10', '0.25'],
    ],
    'the edited cells show the new values and the untouched rows are exactly as they were'
  )
  assert.equal(again.sheets?.[1].name, 'Two', 'and the second sheet is still there, still second')

  // And what the grid cannot show: the text cell holds text and the numeric cell holds a number.
  const workbook = await parse(path)
  const sheet = workbook.getWorksheet('One')
  assert.equal(sheet?.getCell('A2').value, '77', 'a typed value in a text cell stays text')
  assert.equal(sheet?.getCell('B2').value, 99, 'and in a numeric cell it becomes a number')

  results.push('a value edit round-trips, is visible on a re-read, and takes the type its cell had')
}

// ---------------------------------------------------------------- the rest of the file, measured

async function anEditReplacesItsFormulaAndNothingElse() {
  const root = makeRoot()
  const path = join(root, 'rich.xlsx')
  await writeRich(path)

  const read = await readFilePath().resolver({ input: { path } })
  // The grid's row 3 is the sheet's row 4, which is the formula written without a cached result: it
  // displayed nothing, so the value typed into it stays text.
  const written = await writeCommand().resolver({
    input: { path, edits: [{ sheet: 0, row: 3, col: 1, value: '5' }], baselineMtime: read.baselineMtime },
  })
  assert.equal(written.replacedFormulas, 1, 'one edit landed on a formula, and the write counted it')

  const workbook = await parse(path)
  const sheet = workbook.getWorksheet('One')

  // The cell the edit landed on: a literal, and the formula is gone. That is what editing a formula cell
  // means here, and it is the one loss a value edit is expected to cause.
  assert.equal(sheet?.getCell('B4').value, '5', 'the edited formula cell holds the literal that was typed')
  assert.equal(typeof sheet?.getCell('B4').value, 'string', 'and it holds it in the type the cell displayed')

  // The formula nobody edited: still a formula, still with its cached result.
  assert.deepEqual(sheet?.getCell('B5').value, { formula: 'B2*B3', result: 6 }, 'another formula survives as a formula')

  // Styles, including on a cell that was not edited.
  assert.equal(sheet?.getCell('A1').font?.bold, true, 'the styled header keeps its weight')
  assert.equal(sheet?.getCell('B3').numFmt, '0.00', 'the edited sheet keeps its number formats')
  assert.equal(sheet?.getCell('B3').font?.italic, true, 'and its fonts')

  // Conditional formatting, including the rule that watches the very cell the edit changed.
  const rules = (sheet as unknown as { conditionalFormattings?: { ref?: string; rules?: { type?: string }[] }[] })
    .conditionalFormattings
  assert.equal(rules?.length, 1, 'the conditional-formatting rule is still there')
  assert.equal(rules?.[0]?.ref, 'B4:B4', 'still watching the range it watched')
  assert.equal(rules?.[0]?.rules?.[0]?.type, 'cellIs', 'still the type it was')

  // Sheet order and the values nobody touched.
  assert.deepEqual(
    workbook.worksheets.map((candidate) => candidate.name),
    ['One', 'Two'],
    'sheet order is the workbook’s own'
  )
  assert.deepEqual(
    [sheet?.getCell('A2').value, sheet?.getCell('B2').value, sheet?.getCell('A3').value, sheet?.getCell('B3').value],
    ['a', 2, 'b', 3],
    'and every cell the edit did not name holds exactly what it held'
  )

  results.push('an edit replaces the formula it lands on, and formulas, styles, rules and order survive')
}

// ---------------------------------------------------------------- the guard, on this path

async function aStaleBaselineIsRefusedAndTouchesNothing() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  const before = readFileSync(path)
  const mtimeBefore = statSync(path).mtimeMs

  // A baseline that is not what the disk says: somebody else wrote the file after the grid was drawn.
  const code = await codeOf(() =>
    writeCommand().resolver({
      input: {
        path,
        edits: [{ sheet: 0, row: 1, col: 1, value: '99' }],
        baselineMtime: mtimeBefore - 5_000,
      },
    })
  )
  assert.equal(code, 'WRITE_CONFLICT', 'a stale baseline is refused under the code the pane words')

  assert.equal(Buffer.compare(before, readFileSync(path)), 0, 'the bytes are untouched, not rewritten')
  assert.equal(statSync(path).mtimeMs, mtimeBefore, 'and the mtime did not move')
  const workbook = await parse(path)
  assert.equal(workbook.getWorksheet('One')?.getCell('B2').value, 2, 'and the edit is nowhere in the file')

  results.push('a stale baseline yields WRITE_CONFLICT and leaves the file byte for byte as it was')
}

async function forceOverwritesAStaleBaseline() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  const before = readFileSync(path)
  const written = await writeCommand().resolver({
    input: {
      path,
      edits: [{ sheet: 0, row: 1, col: 1, value: '99' }],
      baselineMtime: statSync(path).mtimeMs - 5_000,
      force: true,
    },
  })

  assert.notEqual(Buffer.compare(before, readFileSync(path)), 0, 'the file was rewritten')
  assert.equal(written.mtimeMs, statSync(path).mtimeMs, 'and the write reports what it left behind')
  const workbook = await parse(path)
  assert.equal(workbook.getWorksheet('One')?.getCell('B2').value, 99, 'the user’s value is the one on disk')

  results.push('force overwrites a stale baseline, and only force does')
}

async function aBaselineTheDiskMatchesSavesTwiceInARow() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  const first = await readFilePath().resolver({ input: { path } })
  const one = await writeCommand().resolver({
    input: { path, edits: [{ sheet: 0, row: 1, col: 1, value: '4' }], baselineMtime: first.baselineMtime },
  })

  // The mtime the write returned is the baseline for the next save, which is what makes two saves in a row
  // possible without an intervening read — and what would break if the write did not report one.
  assert.ok(one.mtimeMs !== null, 'the write reports an mtime to guard the next save with')
  await writeCommand().resolver({
    input: { path, edits: [{ sheet: 0, row: 1, col: 1, value: '5' }], baselineMtime: one.mtimeMs },
  })

  const workbook = await parse(path)
  assert.equal(workbook.getWorksheet('One')?.getCell('B2').value, 5, 'the second save went through')

  results.push('the mtime a write reports is a usable baseline for the next save')
}

// ---------------------------------------------------------------- refusals this path owns

async function anEncryptedContainerIsRefused() {
  const root = makeRoot()
  const path = join(root, 'locked.xlsx')
  const bytes = encryptedContainer()
  writeFileSync(path, bytes)

  const code = await codeOf(() =>
    writeCommand().resolver({ input: { path, edits: [{ sheet: 0, row: 0, col: 0, value: 'x' }] } })
  )
  assert.equal(code, 'SPREADSHEET_ENCRYPTED', 'a locked workbook is refused as locked, not as damaged')
  assert.equal(Buffer.compare(bytes, readFileSync(path)), 0, 'and nothing was written to it')

  results.push('a password-protected workbook is refused with the read’s own code and left alone')
}

async function aLegacyWorkbookIsAParseFailure() {
  const root = makeRoot()
  const path = join(root, 'legacy.xls')
  const bytes = legacyXlsContainer()
  writeFileSync(path, bytes)

  const code = await codeOf(() =>
    writeCommand().resolver({ input: { path, edits: [{ sheet: 0, row: 0, col: 0, value: 'x' }] } })
  )
  assert.equal(code, 'SPREADSHEET_PARSE_FAILED', 'the read’s own refusal, not a second .xls-specific one')
  assert.equal(Buffer.compare(bytes, readFileSync(path)), 0, 'and nothing was written to it')

  results.push('a legacy .xls is the read’s parse failure, with no second refusal and no write')
}

async function anEditTheGridCouldNotHaveProducedWritesNothing() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  // A sheet the file does not have, and a row past the cap the grid was shaped with. Neither can come
  // from a grid, so neither is applied — and the file is still a valid workbook afterwards.
  const written = await writeCommand().resolver({
    input: {
      path,
      edits: [
        { sheet: 9, row: 0, col: 0, value: 'x' },
        { sheet: 0, row: MAX_SHEET_ROWS, col: 0, value: 'x' },
      ],
    },
  })
  assert.equal(written.replacedFormulas, 0, 'no formula was reported, because no cell was touched')

  const again = await readFilePath().resolver({ input: { path } })
  assert.deepEqual(
    again.sheets?.[0].rows,
    [
      ['name', 'qty', 'price'],
      ['alpha', '2', '1.5'],
      ['beta', '10', '0.25'],
    ],
    'nothing moved, including the rows past the cap'
  )

  results.push('an edit no grid could have produced is dropped rather than growing the sheet')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('round trip', aValueEditRoundTrips)
    await step('formula replaced', anEditReplacesItsFormulaAndNothingElse)
    await step('guard: stale', aStaleBaselineIsRefusedAndTouchesNothing)
    await step('guard: force', forceOverwritesAStaleBaseline)
    await step('guard: twice', aBaselineTheDiskMatchesSavesTwiceInARow)
    await step('refusal: encrypted', anEncryptedContainerIsRefused)
    await step('refusal: legacy', aLegacyWorkbookIsAParseFailure)
    await step('bounds', anEditTheGridCouldNotHaveProducedWritesNothing)

    console.log(`spreadsheet write: ${results.length} passed`)
    for (const result of results) console.log(`  pass: ${result}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SPREADSHEET WRITE TEST FAILED:', err)
  process.exit(1)
})
