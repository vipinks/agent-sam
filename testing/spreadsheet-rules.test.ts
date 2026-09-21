import { describe, expect, it } from 'vitest'
import {
  MAX_SHEETS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SPREADSHEET_BYTES,
  cellValueToDisplay,
  chartParts,
  isEncryptedWorkbook,
  shapeSheet,
  shapeSheets,
  spreadsheetKindForPath,
  spreadsheetOverCap,
  type SpreadsheetSheet,
} from '@/conveyor/protocol/spreadsheet'
import {
  fidelityCaption,
  omittedSheetsNote,
  sheetNotes,
  spreadsheetOf,
  type SpreadsheetRead,
} from '@/app/components/workbench/spreadsheet'

/**
 * The workbook read's rules, on plain arrays and plain bytes.
 *
 * Everything here is a decision rather than a parse, so none of it needs a disk, a parser or a workbook:
 * which names are workbooks, how much of a sheet survives the caps, whether a container is locked, and
 * how many chart parts an archive holds. The parse itself — real bytes through the real library — is the
 * node suite's business (`tests/workspace/spreadsheet-read-test.ts`); a rule test that needed a workbook
 * to state a rule could not state it about the boundary cases at all.
 *
 * The suites are deliberately split that way: this file can assert a 1001-row sheet's truncation flag
 * without writing a 1001-row file, and can assert the encrypted sniff on a container it hands over
 * directly, including the negative cases — a legacy binary workbook, a plain zip — that a real
 * encrypted file could not provide a control for.
 */

/** A byte array from text, in the encoding the container actually uses. */
function encoded(text: string, encoding: 'utf16le' | 'latin1'): number[] {
  if (encoding === 'latin1') return [...text].map((character) => character.charCodeAt(0))
  // UTF-16LE, which is how a compound file stores a directory entry's name.
  return [...text].flatMap((character) => {
    const code = character.charCodeAt(0)
    return [code & 0xff, (code >> 8) & 0xff]
  })
}

/** Bytes, concatenated from chunks of numbers and strings. */
function bytes(...chunks: (number[] | { text: string; encoding: 'utf16le' | 'latin1' })[]): Uint8Array {
  const flat: number[] = []
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) flat.push(...chunk)
    else flat.push(...encoded(chunk.text, chunk.encoding))
  }
  return new Uint8Array(flat)
}

/** The eight bytes every OLE2 compound file starts with. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** The four bytes every zip starts with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** A sheet of `rowCount` rows whose `columnCount`-th column exists, for the cap boundaries. */
function sheet(rows: number, columns: number): string[][] {
  return Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: columns }, (_, columnIndex) => `r${rowIndex}c${columnIndex}`)
  )
}

/** A shaped sheet, for the caption and note rules that take one. */
function shaped(sheetInput: Partial<SpreadsheetSheet>): SpreadsheetSheet {
  return { name: 'Sheet1', rows: [['h']], truncatedRows: false, truncatedColumns: false, ...sheetInput }
}

/** A read result, for the narrowing and the note rules. */
function read(overrides: Partial<SpreadsheetRead> = {}): SpreadsheetRead {
  return {
    kind: 'spreadsheet',
    sheets: [shaped({})],
    sheetsOmitted: 0,
    fidelity: {
      hasFormulas: false,
      formulaCount: 0,
      hasCharts: false,
      chartCount: 0,
      hasConditionalFormatting: false,
      encrypted: false,
    },
    bytes: 2048,
    baselineMtime: 1_700_000_000_000,
    ...overrides,
  }
}

describe('which names are workbooks', () => {
  it('is the two extensions this turn accepts, and nothing else', () => {
    expect(spreadsheetKindForPath('C:/w/book.xlsx')).toBe('spreadsheet')
    expect(spreadsheetKindForPath('C:/w/legacy.xls')).toBe('spreadsheet')

    // A csv is a text file the viewer already reads as text. Claiming it here would take a working path
    // away from its own kind, and the fidelity report would have nothing true to say about it.
    expect(spreadsheetKindForPath('C:/w/data.csv')).toBeNull()
    expect(spreadsheetKindForPath('C:/w/notes.txt')).toBeNull()
    expect(spreadsheetKindForPath('C:/w/book.xlsm')).toBeNull()
  })

  it('folds case, and reads only the last segment', () => {
    expect(spreadsheetKindForPath('C:/w/REPORT.XLSX')).toBe('spreadsheet')
    expect(spreadsheetKindForPath('C:/w/legacy.Xls')).toBe('spreadsheet')
    // The directory above is never consulted, so a folder named like a workbook cannot make the text
    // files inside it open as a table.
    expect(spreadsheetKindForPath('C:/sheets.xlsx/readme.md')).toBeNull()
  })

  it('treats an absent extension as no extension at all', () => {
    expect(spreadsheetKindForPath('C:/w/Makefile')).toBeNull()
    expect(spreadsheetKindForPath('C:/w/.xlsx')).toBeNull()
    expect(spreadsheetKindForPath('')).toBeNull()
  })
})

describe('the caps', () => {
  it('are the numbers the read is bounded by', () => {
    expect(MAX_SHEET_ROWS).toBe(1000)
    expect(MAX_SHEET_COLUMNS).toBe(64)
    expect(MAX_SHEETS).toBe(20)
    expect(MAX_SPREADSHEET_BYTES).toBe(8 * 1024 * 1024)
  })

  it('include the boundary and exclude one byte past it', () => {
    expect(spreadsheetOverCap(MAX_SPREADSHEET_BYTES)).toBe(false)
    expect(spreadsheetOverCap(MAX_SPREADSHEET_BYTES + 1)).toBe(true)
    expect(spreadsheetOverCap(0)).toBe(false)
  })

  it('does not truncate a sheet of exactly the cap', () => {
    const shapedSheet = shapeSheet('Sheet1', sheet(MAX_SHEET_ROWS, MAX_SHEET_COLUMNS))

    expect(shapedSheet.truncatedRows).toBe(false)
    expect(shapedSheet.truncatedColumns).toBe(false)
    expect(shapedSheet.rows).toHaveLength(MAX_SHEET_ROWS)
    // Every row kept in full, which is the half a flag alone would not catch.
    expect(shapedSheet.rows[0]).toHaveLength(MAX_SHEET_COLUMNS)
  })

  it('truncates one row past the cap, keeping the first thousand', () => {
    const shapedSheet = shapeSheet('Sheet1', sheet(MAX_SHEET_ROWS + 1, 2))

    expect(shapedSheet.truncatedRows).toBe(true)
    expect(shapedSheet.rows).toHaveLength(MAX_SHEET_ROWS)
    // The kept rows are the *top* of the sheet, so the row left out is the last one.
    expect(shapedSheet.rows[0][0]).toBe('r0c0')
    expect(shapedSheet.rows[MAX_SHEET_ROWS - 1][0]).toBe(`r${MAX_SHEET_ROWS - 1}c0`)
  })

  it('truncates columns on the widest row, not on the first one', () => {
    // A header of three columns and a tenth row two hundred wide: the row a reader notices first is not
    // the one that decides.
    const ragged = [
      ['a', 'b', 'c'],
      ...Array.from({ length: 8 }, () => []),
      Array.from({ length: 200 }, (_, i) => `c${i}`),
    ]
    const shapedSheet = shapeSheet('Sheet1', ragged)

    expect(shapedSheet.truncatedColumns).toBe(true)
    expect(shapedSheet.rows[0]).toHaveLength(3)
    expect(shapedSheet.rows[9]).toHaveLength(MAX_SHEET_COLUMNS)
  })

  it('leaves a sheet inside the caps alone, and does not pad a ragged one', () => {
    const shapedSheet = shapeSheet('Sheet1', [['a', 'b'], ['c'], []])

    expect(shapedSheet.truncatedRows).toBe(false)
    expect(shapedSheet.truncatedColumns).toBe(false)
    // A short row stays short: padding would claim those cells are empty rather than never written.
    expect(shapedSheet.rows).toEqual([['a', 'b'], ['c'], []])
    expect(shapedSheet.name).toBe('Sheet1')
  })

  it('decides the flags from the extent it is given, not from the rows in hand', () => {
    // This is the path the read takes: it builds only the window the caps allow and passes the sheet's
    // real size alongside. Deciding from `rows.length` here would compare a hundred against a thousand
    // and report a truncated sheet as complete.
    const window = sheet(10, 2)
    const shapedSheet = shapeSheet('Sheet1', window, { rows: 5000, columns: 300 })

    expect(shapedSheet.truncatedRows).toBe(true)
    expect(shapedSheet.truncatedColumns).toBe(true)
    expect(shapedSheet.rows).toHaveLength(10)
  })

  it('keeps twenty sheets and counts the rest as omitted', () => {
    const many = Array.from({ length: MAX_SHEETS + 5 }, (_, index) => shaped({ name: `S${index}` }))
    const result = shapeSheets(many)

    expect(result.sheets).toHaveLength(MAX_SHEETS)
    expect(result.sheetsOmitted).toBe(5)
    // Order is the author's, so the first twenty are the first twenty.
    expect(result.sheets[0].name).toBe('S0')
  })

  it('counts omissions from the total it is told, when it was not given every sheet', () => {
    const held = [shaped({ name: 'Only' })]
    const result = shapeSheets(held, 40)

    expect(result.sheets).toHaveLength(1)
    expect(result.sheetsOmitted).toBe(39)
  })
})

describe('the encrypted sniff', () => {
  it('says yes to a compound file carrying the encryption stream', () => {
    const container = bytes(
      CFB_MAGIC,
      { text: 'Root Entry', encoding: 'utf16le' },
      { text: 'EncryptionInfo', encoding: 'utf16le' }
    )

    expect(isEncryptedWorkbook(container)).toBe(true)
  })

  it('says no to a legacy workbook, which is the same container without it', () => {
    // The magic alone must not decide: a `.xls` is the same OLE2 container as an encrypted `.xlsx`, so
    // "starts with the compound-file magic" would report every Excel 97 file as locked.
    const legacy = bytes(
      CFB_MAGIC,
      { text: 'Workbook', encoding: 'utf16le' },
      { text: 'SummaryInformation', encoding: 'utf16le' }
    )

    expect(isEncryptedWorkbook(legacy)).toBe(false)
  })

  it('says no to a plain workbook, whatever its cells contain', () => {
    const plain = bytes(
      ZIP_MAGIC,
      { text: 'xl/worksheets/sheet1.xml', encoding: 'latin1' },
      {
        text: 'a cell whose text is EncryptionInfo',
        encoding: 'latin1',
      }
    )

    expect(isEncryptedWorkbook(plain)).toBe(false)
  })

  it('says no to a name that is not in the container at all', () => {
    expect(isEncryptedWorkbook(bytes(CFB_MAGIC))).toBe(false)
    expect(isEncryptedWorkbook(new Uint8Array(0))).toBe(false)
  })
})

describe('chart parts', () => {
  const chart = { text: 'xl/charts/chart1.xml', encoding: 'latin1' as const }

  it('counts an archive holding one chart once, though a zip names it twice', () => {
    // A well-formed archive carries each name in the local header and again in the central directory, so
    // counting raw occurrences would report two charts for every one and the caption would be wrong by a
    // factor of two on every file.
    const archive = bytes(ZIP_MAGIC, chart, { text: 'xl/worksheets/sheet1.xml', encoding: 'latin1' }, chart)

    expect(chartParts(archive)).toEqual(['xl/charts/chart1.xml'])
  })

  it('counts two charts as two', () => {
    const archive = bytes(ZIP_MAGIC, chart, { text: 'xl/charts/chart2.xml', encoding: 'latin1' })

    expect(chartParts(archive)).toHaveLength(2)
    expect(chartParts(archive)).toContain('xl/charts/chart2.xml')
  })

  it('finds none in a workbook without one, and none outside an archive', () => {
    expect(chartParts(bytes(ZIP_MAGIC, { text: 'xl/worksheets/sheet1.xml', encoding: 'latin1' }))).toEqual([])
    // Chart parts exist only inside an archive, so a text file that happens to spell the prefix is not a
    // workbook with charts in it.
    expect(chartParts(bytes([0x41, 0x42], chart))).toEqual([])
  })
})

describe('a cell as a display string', () => {
  it('renders the plain values, and Excel’s own spelling for a boolean', () => {
    expect(cellValueToDisplay('alpha')).toBe('alpha')
    expect(cellValueToDisplay(12.5)).toBe('12.5')
    expect(cellValueToDisplay(0)).toBe('0')
    expect(cellValueToDisplay(true)).toBe('TRUE')
    expect(cellValueToDisplay(false)).toBe('FALSE')
    expect(cellValueToDisplay(null)).toBe('')
    expect(cellValueToDisplay(undefined)).toBe('')
  })

  it('shows a formula’s cached result, and nothing when the file cached nothing', () => {
    // Neither candidate parser evaluates a formula, so the only number available is the one the file
    // stored beside it. Substituting the formula text for a missing result would put a string in a
    // numeric column and call it data.
    expect(cellValueToDisplay({ formula: 'B2*B3', result: 6 })).toBe('6')
    expect(cellValueToDisplay({ formula: 'B2+B3' })).toBe('')
    expect(cellValueToDisplay({ sharedFormula: 'A1', result: 'x' })).toBe('x')
    // A cached result keeps its own handling rather than being stringified.
    expect(cellValueToDisplay({ formula: 'A1', result: true })).toBe('TRUE')
  })

  it('renders a date from its own calendar fields', () => {
    // Local fields on purpose: `toISOString` would shift the day for every reader east or west of UTC,
    // and a date in a spreadsheet is a calendar day.
    expect(cellValueToDisplay(new Date(2020, 0, 15))).toBe('2020-01-15')
    expect(cellValueToDisplay(new Date(2020, 0, 15, 9, 5, 3))).toBe('2020-01-15 09:05:03')
  })

  it('renders the object shapes a workbook can carry', () => {
    expect(cellValueToDisplay({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab')
    expect(cellValueToDisplay({ text: 'link', hyperlink: 'https://example.com' })).toBe('link')
    expect(cellValueToDisplay({ error: '#DIV/0!' })).toBe('#DIV/0!')
    // Anything else is empty rather than `[object Object]`, which is what a generic stringify would put
    // in the cell.
    expect(cellValueToDisplay({ unknown: 1 })).toBe('')
  })
})

describe('narrowing a read result', () => {
  it('accepts a workbook and rejects the other kinds', () => {
    expect(spreadsheetOf(read())).toBe(true)
    expect(spreadsheetOf({ content: 'const a = 1\n', path: 'C:/w/a.ts' })).toBe(false)
    expect(spreadsheetOf({ kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AA', bytes: 1 })).toBe(
      false
    )
    expect(spreadsheetOf(undefined)).toBe(false)
    expect(spreadsheetOf(null)).toBe(false)
  })

  it('rejects a result that claims to be a workbook but cannot be drawn', () => {
    // A result with no sheets array would otherwise reach the grid and throw on `sheets.map`, which is a
    // crash rather than an empty file — the one outcome this predicate exists to prevent.
    expect(spreadsheetOf({ kind: 'spreadsheet', fidelity: {}, bytes: 1 })).toBe(false)
    expect(spreadsheetOf({ kind: 'spreadsheet', sheets: 'nope', fidelity: {}, bytes: 1 })).toBe(false)
    expect(spreadsheetOf({ kind: 'spreadsheet', sheets: [null], fidelity: {}, bytes: 1 })).toBe(false)
    expect(spreadsheetOf({ kind: 'spreadsheet', sheets: [{ name: 'S', rows: 'nope' }], fidelity: {}, bytes: 1 })).toBe(
      false
    )
    expect(spreadsheetOf({ kind: 'spreadsheet', sheets: [], bytes: 1 })).toBe(false)
  })

  it('accepts a workbook with no sheets, which is a real thing', () => {
    expect(spreadsheetOf(read({ sheets: [] }))).toBe(true)
  })
})

describe('the fidelity caption', () => {
  it('names the counts and says what the grid is', () => {
    const caption = fidelityCaption({
      hasFormulas: true,
      formulaCount: 12,
      hasCharts: true,
      chartCount: 1,
      hasConditionalFormatting: false,
      encrypted: false,
    })

    expect(caption).toBe('12 formulas, 1 chart — preview only')
  })

  it('pluralizes one way and one way only', () => {
    expect(
      fidelityCaption({
        hasFormulas: true,
        formulaCount: 1,
        hasCharts: true,
        chartCount: 2,
        hasConditionalFormatting: false,
        encrypted: false,
      })
    ).toBe('1 formula, 2 charts — preview only')
  })

  it('names conditional formatting, and says only what is true of the file', () => {
    expect(
      fidelityCaption({
        hasFormulas: false,
        formulaCount: 0,
        hasCharts: false,
        chartCount: 0,
        hasConditionalFormatting: true,
        encrypted: false,
      })
    ).toBe('conditional formatting — preview only')
  })

  it('still says the grid is a preview when the file has nothing to count', () => {
    // A plain sheet gets the sentence too: the grid is read-only whether or not a formula happens to be
    // in it, and that is the one thing the caption is always there to say.
    expect(
      fidelityCaption({
        hasFormulas: false,
        formulaCount: 0,
        hasCharts: false,
        chartCount: 0,
        hasConditionalFormatting: false,
        encrypted: false,
      })
    ).toBe('Preview only')
  })
})

describe('the notes under the grid', () => {
  it('quotes the rows actually in hand rather than the cap', () => {
    const truncated = shaped({ rows: sheet(1000, 3), truncatedRows: true })

    expect(sheetNotes(truncated)).toEqual(['Showing the first 1000 rows.'])
  })

  it('names the widest row for a column truncation, and lets both apply at once', () => {
    const truncated = shaped({ rows: [['a', 'b'], ['c']], truncatedRows: true, truncatedColumns: true })

    expect(sheetNotes(truncated)).toEqual(['Showing the first 2 rows.', 'Showing the first 2 columns.'])
  })

  it('says nothing about a sheet nothing was left out of', () => {
    expect(sheetNotes(shaped({}))).toEqual([])
  })

  it('names the sheets the cap left out, and only when it left some', () => {
    expect(omittedSheetsNote(read({ sheets: [shaped({})], sheetsOmitted: 0 }))).toBeNull()
    expect(omittedSheetsNote(read({ sheets: [shaped({})], sheetsOmitted: 3 }))).toBe('Showing the first 1 of 4 sheets.')
  })
})
