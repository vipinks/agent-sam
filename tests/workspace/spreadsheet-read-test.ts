/**
 * The workbook half of the read path, against real bytes on a real disk.
 *
 * Two things have to be true of this suite or it is not evidence of anything. The fixtures must be real
 * workbooks, written by the library the app actually parses with, because the claim being tested is that
 * a file a spreadsheet program could have produced reads back as the rows it holds — a hand-written
 * buffer would only prove that the code agrees with itself. And the read must go through the registered
 * query, invoked the way the router invokes it, so what is exercised is the app's own path rather than a
 * reimplementation of it.
 *
 * No electron: `electron` is stubbed for the whole node run (see `tests/stubs/`).
 *
 * What is deliberately *not* here: the chart flag's true case. Neither candidate parser can write a chart
 * and no CFB or zip writer is available to inject one, so the positive case is proven where the evidence
 * is the bytes — `testing/spreadsheet-rules.test.ts` seeds a container holding `xl/charts/chart1.xml` and
 * asserts the count — and what is proven here is the honest negative: a real workbook reports no charts.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import * as ExcelJS from 'exceljs'
import { MAX_SPREADSHEET_BYTES, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from '../../conveyor/protocol/spreadsheet'
import { workspaceModule, MAX_FILE_BYTES } from '../../conveyor/modules/workspace'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-sheet-'))
  roots.push(root)
  return root
}

/**
 * A read result as this suite sees it: every field any shape can carry, all optional.
 *
 * Deliberately not the union the app narrows on. The claims here are about *which* fields came back —
 * that a workbook result carries no `content`, that a text result carries no `sheets` — and a type that
 * admitted only one shape could not state either.
 */
interface ReadResult {
  kind?: string
  content?: string
  sheets?: { name: string; rows: string[][]; truncatedRows: boolean; truncatedColumns: boolean }[]
  sheetsOmitted?: number
  fidelity?: {
    hasFormulas: boolean
    formulaCount: number
    hasCharts: boolean
    chartCount: number
    hasConditionalFormatting: boolean
    encrypted: boolean
  }
  bytes?: number
  path: string
  baselineMtime?: number
}

/** The registered query, as the router reaches it. */
function readFileQuery(): { resolver: (opts: { input: unknown }) => Promise<ReadResult> } {
  return workspaceModule.record.readFile as unknown as {
    resolver: (opts: { input: unknown }) => Promise<ReadResult>
  }
}

function read(path: string): Promise<ReadResult> {
  return readFileQuery().resolver({ input: { path } })
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

/** The sheet named `name`, or a failure that names what was there instead. */
function sheetNamed(result: ReadResult, name: string) {
  const found = result.sheets?.find((sheet) => sheet.name === name)
  assert.ok(found, `expected a sheet named ${name}, got ${JSON.stringify(result.sheets?.map((s) => s.name))}`)
  return found
}

/** The eight bytes every OLE2 compound-file container starts with. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** `name` as a compound file stores a directory entry's name: UTF-16LE. */
function utf16le(name: string): number[] {
  return [...name].flatMap((character) => {
    const code = character.charCodeAt(0)
    return [code & 0xff, (code >> 8) & 0xff]
  })
}

/**
 * The notes a modern spreadsheet program writes for a password-protected workbook.
 *
 * Neither candidate parser can encrypt, so this container is assembled here rather than produced by a
 * library — and it is worth being exact about what that does and does not prove. The 512-byte header is
 * genuine, with the version fields a real OLE2 file carries, and the stream names are stored the way a
 * real one stores them, in UTF-16LE. What it is not is a fully allocated compound file with an
 * allocation table, because building one by hand is a container writer's job and no writer is available.
 *
 * That is enough to be real evidence, because the sniff reads exactly two things: the magic, and the
 * UTF-16LE stream name. Both are here and in their real form, and the negative controls in the rules
 * suite are what stop the sniff from being a one-line guess — a legacy container without the name, and a
 * plain zip containing the name as cell text.
 */
function encryptedContainer(): Buffer {
  const header = Buffer.alloc(512, 0)
  Buffer.from(CFB_MAGIC).copy(header, 0)
  header.writeUInt16LE(0x003e, 24) // minor version
  header.writeUInt16LE(0x0003, 26) // major version: 3, the common one
  header.writeUInt16LE(0xfffe, 28) // byte order, little endian
  header.writeUInt16LE(9, 30) // sector shift: 512-byte sectors
  header.writeUInt16LE(6, 32) // mini sector shift

  return Buffer.concat([
    header,
    // The directory entry names, which is where the sniff actually looks.
    Buffer.from(utf16le('Root Entry')),
    Buffer.from(utf16le('EncryptionInfo')),
    Buffer.from(utf16le('EncryptedPackage')),
    Buffer.alloc(4096, 0x11),
  ])
}

/** A legacy binary workbook's container: the same OLE2 magic and no encryption streams. */
function legacyXlsContainer(): Buffer {
  return Buffer.concat([
    Buffer.from(CFB_MAGIC),
    Buffer.from(utf16le('Workbook')),
    Buffer.from(utf16le('SummaryInformation')),
    Buffer.alloc(2048, 0x42),
  ])
}

/**
 * A cell payload that does not compress, so a fixture can be made deliberately large.
 *
 * A repeating character would deflate to almost nothing and the fixture would not have the size the test
 * needs, so this has to be a sequence with real entropy in it — and getting that wrong is not academic.
 * The first version of this used a linear congruential generator's *low* bits (`state % 64`), which have a
 * period of 64: the payload repeated every 64 characters, deflate crushed it to nothing, and the fixture
 * came out at 20 KB instead of megabytes. The assertion caught it, which is the point of asserting the
 * size, but the lesson is in the generator rather than in the assertion.
 *
 * So: a counter-based mix whose output is taken from the well-mixed high bits, over an alphabet that
 * excludes the five characters XML escapes. Excluding them keeps the payload's bytes the same bytes once
 * the file is written, so the size arithmetic below does not have to allow for escaping — 90 symbols is
 * about 6.5 bits each, so deflate can reclaim at most a fifth of the payload and the file stays the size
 * the test asked for.
 */
function incompressible(rowCount: number, length: number): string[] {
  const alphabet = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).filter(
    (character) => !'&<>"\''.includes(character)
  )

  let state = 0x9e3779b9
  const rows: string[] = []
  for (let row = 0; row < rowCount; row += 1) {
    let cell = ''
    for (let index = 0; index < length; index += 1) {
      state = (state + 0x9e3779b9) >>> 0
      let mixed = Math.imul(state ^ (state >>> 16), 0x21f0aaad) >>> 0
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0
      mixed = (mixed ^ (mixed >>> 15)) >>> 0
      cell += alphabet[mixed % alphabet.length]
    }
    rows.push(cell)
  }
  return rows
}

// ---------------------------------------------------------------- the fixtures, written for real

const PLAIN_ROWS = [
  ['name', 'qty', 'price'],
  ['alpha', 2, 1.5],
  ['beta', 10, 0.25],
  ['gamma', 4, 12],
]

async function writePlain(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  for (const row of PLAIN_ROWS) sheet.addRow(row)
  await workbook.xlsx.writeFile(path)
}

async function writeMultiSheet(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheets: [string, string[][]][] = [
    ['First', [['a1', 'a2']]],
    ['Second', [['b1']]],
    ['Third', [['c1', 'c2', 'c3']]],
  ]
  for (const [name, rows] of sheets) {
    const sheet = workbook.addWorksheet(name)
    for (const row of rows) sheet.addRow(row)
  }
  await workbook.xlsx.writeFile(path)
}

/**
 * Formulas, a styled header and a conditional formatting rule.
 *
 * Two formulas, and the difference between them is the point: one was written without a cached result
 * and one with. A reader with no calculation engine has only the cached value to show, so this pair is
 * what pins the claim that a display string is computed only when the file itself stored a number.
 */
async function writeFormulaStyled(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Calc')
  sheet.addRow(['label', 'value'])
  sheet.getRow(1).font = { bold: true }
  sheet.addRow(['a', 2])
  sheet.addRow(['b', 3])
  sheet.addRow(['sum', { formula: 'B2+B3' }])
  sheet.addRow(['prod', { formula: 'B2*B3', result: 6 }])
  // On a cell that already holds a value, deliberately: asking for a *new* cell to set a format would
  // widen the sheet by a column, and the rows below are asserted exactly — an empty trailing cell would
  // have to be asserted too, and the assertion would then be about this fixture rather than about the read.
  sheet.getCell('B2').numFmt = '0.00'
  sheet.addConditionalFormatting({
    ref: 'B4:B4',
    rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['3'], style: { font: { bold: true } } }],
  })
  await workbook.xlsx.writeFile(path)
}

/**
 * The three cap boundaries in one workbook: over the row cap, exactly at it, and over the column cap.
 *
 * The exact case matters as much as the over case — a sheet of exactly the cap must not be reported as
 * truncated — and it is cheap to write here, which is the reason to prove it against a real file rather
 * than only against an array.
 */
async function writeCapBoundaries(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()

  const long = workbook.addWorksheet('Long')
  for (let row = 0; row < MAX_SHEET_ROWS + 1; row += 1) long.addRow([`r${row}`, row])

  const exact = workbook.addWorksheet('Exact')
  for (let row = 0; row < MAX_SHEET_ROWS; row += 1) exact.addRow([`e${row}`])

  const wide = workbook.addWorksheet('Wide')
  wide.addRow(['header', ...Array.from({ length: MAX_SHEET_COLUMNS }, (_, index) => `h${index}`)])
  wide.addRow(['row', ...Array.from({ length: MAX_SHEET_COLUMNS }, (_, index) => `v${index}`)])

  await workbook.xlsx.writeFile(path)
}

/** A workbook larger than the text cap but well under the workbook cap. */
async function writeLarge(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Big')
  // 2400 rows of 1024 characters, and the character set is what makes the arithmetic work: 64 symbols is
  // six bits each, so deflate can reclaim about a quarter of the payload and no more. That leaves the
  // file comfortably over the 1 MB text cap while staying under the 8 MB workbook cap, which is the whole
  // point of the fixture — a payload of repeating characters would compress to nothing and prove nothing.
  for (const cell of incompressible(2400, 1024)) sheet.addRow([cell])
  await workbook.xlsx.writeFile(path)
}

// ---------------------------------------------------------------- what a read answers

async function aPlainSheetComesBackRowForRow() {
  const root = makeRoot()
  const path = join(root, 'plain.xlsx')
  await writePlain(path)

  const result = await read(path)

  assert.equal(result.kind, 'spreadsheet', 'the result says what it is')
  // A workbook result has no text half — `content` would be the bytes of a zip read as text.
  assert.equal(result.content, undefined, 'a workbook carries no text content')
  assert.equal(result.sheets?.length, 1, 'and it carries its sheets')

  const sheet = sheetNamed(result, 'Data')
  assert.deepEqual(
    sheet.rows,
    [
      ['name', 'qty', 'price'],
      ['alpha', '2', '1.5'],
      ['beta', '10', '0.25'],
      ['gamma', '4', '12'],
    ],
    'the rows are the seeded cells, as display strings'
  )
  assert.equal(sheet.truncatedRows, false, 'a four-row sheet is not truncated')
  assert.equal(sheet.truncatedColumns, false, 'nor is a three-column one')

  assert.equal(result.bytes, statSync(path).size, 'the byte count is the file’s, not the payload’s')
  assert.equal(typeof result.baselineMtime, 'number', 'and it reports the mtime it read')
  results.push('a plain sheet returns its rows exactly, as display strings')
}

async function sheetNamesAndTheirOrderSurvive() {
  const root = makeRoot()
  const path = join(root, 'multi.xlsx')
  await writeMultiSheet(path)

  const result = await read(path)

  assert.deepEqual(
    result.sheets?.map((sheet) => sheet.name),
    ['First', 'Second', 'Third'],
    'the sheets come back in the workbook’s own order'
  )
  // Order is the file's author's, so the assertion is on the sequence rather than on membership: a read
  // that sorted the sheets would pass a set comparison and still be wrong.
  assert.deepEqual(sheetNamed(result, 'First').rows, [['a1', 'a2']], 'and each keeps its own rows')
  assert.deepEqual(sheetNamed(result, 'Second').rows, [['b1']], 'including a one-cell sheet')
  assert.deepEqual(sheetNamed(result, 'Third').rows, [['c1', 'c2', 'c3']], 'and a three-cell one')
  assert.equal(result.sheetsOmitted, 0, 'nothing was left out')
  results.push('a multi-sheet workbook returns its sheet names in order')
}

async function formulasAndConditionalFormattingAreReported() {
  const root = makeRoot()
  const path = join(root, 'formula.xlsx')
  await writeFormulaStyled(path)

  const result = await read(path)
  const fidelity = result.fidelity
  assert.ok(fidelity, 'the read carries a fidelity report')

  assert.equal(fidelity.hasFormulas, true, 'the fixture has formulas and the report says so')
  assert.equal(fidelity.formulaCount, 2, 'and counts both of them')
  assert.equal(fidelity.hasConditionalFormatting, true, 'and reports the conditional formatting rule')
  assert.equal(fidelity.encrypted, false, 'and reports that an unlocked file was not locked')

  // The chart flag's honest negative, on a real workbook: nothing was injected, so there are no chart
  // parts, and a sniff that fired here would be firing on something that is not there. The positive case
  // belongs to the rules suite, where the container's bytes are the evidence.
  assert.equal(fidelity.hasCharts, false, 'a real workbook written without a chart reports none')
  assert.equal(fidelity.chartCount, 0, 'and counts none')

  const sheet = sheetNamed(result, 'Calc')
  assert.deepEqual(
    sheet.rows,
    [
      ['label', 'value'],
      ['a', '2'],
      ['b', '3'],
      // Written with no cached result: a reader with no calculation engine has no number to show, and
      // the cell is empty rather than showing its formula text as though it were a value.
      ['sum', ''],
      // Written with a cached result: that stored number is what a reader can show.
      ['prod', '6'],
    ],
    'a formula shows its cached result, and nothing when the file cached none'
  )
  results.push('a formula fixture reports its formulas and its conditional formatting')
  results.push('display strings for formulas are the file’s cached results, empty when uncached')
}

async function theCapsAreTheBoundariesTheyClaimToBe() {
  const root = makeRoot()
  const path = join(root, 'caps.xlsx')
  await writeCapBoundaries(path)

  const result = await read(path)

  const long = sheetNamed(result, 'Long')
  assert.equal(long.rows.length, MAX_SHEET_ROWS, 'an over-long sheet keeps exactly the row cap')
  assert.equal(long.truncatedRows, true, 'and says it lost rows')
  assert.equal(long.truncatedColumns, false, 'while its two columns both fit')

  const exact = sheetNamed(result, 'Exact')
  assert.equal(exact.rows.length, MAX_SHEET_ROWS, 'a sheet of exactly the cap keeps all of it')
  // The off-by-one that would otherwise be invisible: a sheet of exactly the cap, reported as truncated,
  // tells a reader something was dropped when nothing was.
  assert.equal(exact.truncatedRows, false, 'and is not reported as truncated')

  const wide = sheetNamed(result, 'Wide')
  assert.equal(wide.truncatedColumns, true, 'an over-wide sheet says it lost columns')
  assert.equal(Math.max(...wide.rows.map((row) => row.length)), MAX_SHEET_COLUMNS, 'and keeps exactly the column cap')
  assert.equal(wide.truncatedRows, false, 'while its two rows both fit')
  results.push('the row and column caps are inclusive at the boundary and flagged past it')
}

async function aWorkbookOverTheTextCapIsStillRead() {
  const root = makeRoot()
  const path = join(root, 'large.xlsx')
  await writeLarge(path)

  const size = statSync(path).size
  // The point of this case: the kind is settled before a size is compared, so a workbook between the
  // text cap and the workbook cap is read as a workbook rather than refused as an oversized text file.
  assert.ok(size > MAX_FILE_BYTES, `the fixture is over the text cap (${size} bytes)`)
  assert.ok(size < MAX_SPREADSHEET_BYTES, 'and under the workbook cap')

  const result = await read(path)
  assert.equal(result.kind, 'spreadsheet', 'over the text cap is still a workbook')
  assert.equal(result.bytes, size, 'with the bytes it has')
  results.push('a workbook over the text cap but under the workbook cap is read as a workbook')
}

async function aWorkbookOverItsOwnCapIsRefused() {
  const root = makeRoot()
  const path = join(root, 'huge.xlsx')
  // The size is all the cap looks at, so a real workbook is not needed to prove the refusal — and the
  // refusal happens before a byte is read, which is the property being asserted.
  writeFileSync(path, Buffer.alloc(MAX_SPREADSHEET_BYTES + 1024, 7))

  const err = await errorOf(() => read(path))
  assert.equal(err.code, 'SPREADSHEET_TOO_LARGE', 'the refusal has a code of its own')
  assert.equal((err as unknown as { sheets?: unknown }).sheets, undefined, 'and no sheets are attached')
  results.push('a workbook past 8 MB is refused as SPREADSHEET_TOO_LARGE, unread')
}

async function anEncryptedWorkbookIsRefusedAsLocked() {
  const root = makeRoot()
  const path = join(root, 'locked.xlsx')
  writeFileSync(path, encryptedContainer())

  const err = await errorOf(() => read(path))
  // The distinction this code exists for: the container is intact and the file is not corrupt, so
  // reporting it as SPREADSHEET_PARSE_FAILED would be a false statement about the bytes.
  assert.equal(err.code, 'SPREADSHEET_ENCRYPTED', 'a locked workbook is its own outcome')
  results.push('a password-protected workbook is refused as SPREADSHEET_ENCRYPTED')
}

async function aLegacyBinaryWorkbookIsTheParseFailureItIs() {
  const root = makeRoot()
  const path = join(root, 'legacy.xls')
  writeFileSync(path, legacyXlsContainer())

  const err = await errorOf(() => read(path))
  // Documented rather than papered over: the chosen parser reads OOXML and has no reader for the legacy
  // binary format, so a genuine `.xls` fails here. The kind decision still routes it to this path — which
  // is what makes the failure a clear one instead of a file opening as mojibake.
  assert.equal(err.code, 'SPREADSHEET_PARSE_FAILED', 'a legacy binary workbook is a parse failure')
  results.push('a legacy .xls is refused as SPREADSHEET_PARSE_FAILED (the parser is OOXML-only)')
}

async function aCsvIsStillText() {
  const root = makeRoot()
  const path = join(root, 'table.csv')
  writeFileSync(path, 'name,qty\nalpha,2\n', 'utf8')

  const result = await read(path)

  // Deliberately unchanged: a csv is a text file, the viewer already reads it as text, and the kind
  // decision leaves it alone. Taking it here would remove a working path rather than add one.
  assert.equal(result.content, 'name,qty\nalpha,2\n', 'a csv is still returned as its own text')
  assert.equal(result.kind, undefined, 'and carries no kind of its own')
  assert.equal(result.sheets, undefined, 'and no sheets')
  results.push('a csv stays a text read, byte for byte')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('plain sheet', aPlainSheetComesBackRowForRow)
    await step('multi-sheet', sheetNamesAndTheirOrderSurvive)
    await step('formula + styled', formulasAndConditionalFormattingAreReported)
    await step('caps', theCapsAreTheBoundariesTheyClaimToBe)
    await step('over the text cap', aWorkbookOverTheTextCapIsStillRead)
    await step('over the workbook cap', aWorkbookOverItsOwnCapIsRefused)
    await step('encrypted', anEncryptedWorkbookIsRefusedAsLocked)
    await step('legacy .xls', aLegacyBinaryWorkbookIsTheParseFailureItIs)
    await step('csv stays text', aCsvIsStillText)

    console.log(`spreadsheet read: ${results.length} passed`)
    for (const result of results) console.log(`  pass: ${result}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SPREADSHEET READ TEST FAILED:', err)
  process.exit(1)
})
