import { ConveyorError } from 'electron-conveyor/main'
import * as ExcelJS from 'exceljs'
import {
  MAX_SHEETS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  SPREADSHEET_ENCRYPTED,
  SPREADSHEET_PARSE_FAILED,
  cellValueToDisplay,
  chartParts,
  isEncryptedWorkbook,
  shapeSheet,
  shapeSheets,
  type SpreadsheetFidelity,
  type SpreadsheetSheet,
  type SpreadsheetSheets,
} from '../protocol/spreadsheet'

/**
 * Reading a workbook: the parser, and the only place one runs.
 *
 * This is main-only and deliberately not shared, unlike the rules it calls. The rules are decisions a
 * test can make on plain arrays and plain buffers; this is the part that needs a real parser, a real
 * container and a real workbook, and it is placed beside `workspace.ts` for the same reason
 * `workspace-paths.ts` is — it is a piece of the main process the module composes, not a module of its
 * own. Nothing here touches `fs`: the bytes arrive already read, so the size cap and the read order
 * stay in one place in `workspace.ts` where every kind is handled the same way.
 *
 * Why the whole file is worth reading: three of the read's answers cannot come from the parser at all.
 * A password-protected workbook is not a zip, so it fails as "corrupt" when it is nothing of the kind;
 * a chart has no API in this parser; and the row and column *extents* of a sheet are needed before the
 * parse, because the caps decide how much of it to build. So the container is asked directly for the
 * first two, and the parser is asked for the third through the same caps the rest of the app uses.
 */

/** What one workbook read produces: the sheets, and what the file says about itself. */
export interface ParsedSpreadsheet extends SpreadsheetSheets {
  fidelity: SpreadsheetFidelity
}

/**
 * The type exceljs's own declarations demand for a workbook's bytes.
 *
 * Not `Buffer`, deliberately and reluctantly. The published `index.d.ts` opens with
 * `declare interface Buffer extends ArrayBuffer { }`, which shadows Node's Buffer inside that file, so
 * the parameter of `load` is that local interface — and a real `Buffer`, which lacks ArrayBuffer's
 * `resizable`, `resize`, `detached` and `maxByteLength`, does not satisfy it. The two are the same
 * bytes at runtime and the library reads them correctly; only the declaration disagrees. Naming the
 * demanded type here means the cast below is written once, against the declaration that is actually
 * wrong, rather than as a bare `as` at the call site where the reason would be lost.
 *
 * Recorded as a defect in the dependency rather than hidden: it is the first thing to re-check if
 * exceljs ever republishes its types. Exported because the write path loads from bytes too, and a second
 * copy of this explanation next to a second alias would be the same defect documented twice.
 */
export type WorkbookBytes = Parameters<ExcelJS.Workbook['xlsx']['load']>[0]

/**
 * A worksheet, as read by what exceljs actually exposes rather than by what it declares.
 *
 * `conditionalFormattings` is a real, populated array on a loaded worksheet — it is how that library
 * carries the rules it parses, and it is the reason this parser was chosen — but it appears nowhere in
 * `index.d.ts`, so reaching it takes a cast. The cast is as narrow as it can be, and the field is
 * checked rather than trusted below, so a future release that renames or drops it degrades to "no
 * conditional formatting reported" instead of throwing on the way into an otherwise fine read.
 */
interface WorksheetWithConditionalFormattings {
  conditionalFormattings?: unknown[]
}

/**
 * Parse workbook bytes into the shaped sheets and fidelity a read returns.
 *
 * Three outcomes, and the order they are taken in is the whole design. An encrypted container is
 * settled first and without the parser, because the parser's answer for one is a syntax error and the
 * honest sentence is a different one: the file is not damaged, it is locked. Then the parse itself,
 * whose failure is the only input that can produce `SPREADSHEET_PARSE_FAILED` — the code that means
 * "these really are not a workbook I can read", whether they are a legacy binary `.xls` that this
 * parser has no reader for, or a truncated file, or not a workbook at all.
 *
 * Sheets are shaped as they are built rather than after, and the loop is bounded by the caps: a
 * hundred-thousand-row sheet becomes a thousand-element array, not a hundred-thousand-element one that
 * is immediately discarded. The sheet's real extent is read off the worksheet before that loop and
 * passed to `shapeSheet`, which is what keeps the truncation flags honest when the array no longer
 * describes the sheet.
 *
 * The fidelity counters deliberately *are* allowed to see the whole file: a formula count is a
 * statement about the workbook, so a caption saying "12 formulas" must not quietly mean "12 in the part
 * you can see". The cost is one extra pass over rows that are already in memory, which is why the two
 * caps above exist — they bound what crosses IPC, not what the counters may count.
 */
export async function parseSpreadsheet(bytes: Buffer): Promise<ParsedSpreadsheet> {
  if (isEncryptedWorkbook(bytes)) {
    throw new ConveyorError(
      SPREADSHEET_ENCRYPTED,
      'This workbook is password protected, so its sheets cannot be shown.'
    )
  }

  const workbook = new ExcelJS.Workbook()
  try {
    // `load` rejects on a container it cannot inflate and on XML it cannot parse, which together are
    // every way a read can fail that is about the bytes rather than about the viewer's limits.
    await workbook.xlsx.load(bytes as unknown as WorkbookBytes)
  } catch {
    // The parser's own message is not forwarded. It names internal structures and is written for a
    // developer reading a stack trace; the renderer words this failure for a person, and it branches on
    // the code rather than on any sentence.
    throw new ConveyorError(SPREADSHEET_PARSE_FAILED, 'This workbook could not be read.')
  }

  const worksheets = workbook.worksheets
  const sheets: SpreadsheetSheet[] = []
  let formulaCount = 0
  let hasConditionalFormatting = false

  for (const worksheet of worksheets) {
    // Workbook-level rather than per-sheet: the report answers "does this file use it at all", which is
    // the question the caption asks. It is a plain array on the worksheet, so this costs nothing.
    // Reached through the cast above and checked before use, because the field is untyped.
    const rules = (worksheet as unknown as WorksheetWithConditionalFormattings).conditionalFormattings
    if (Array.isArray(rules) && rules.length > 0) hasConditionalFormatting = true

    // Both extents are read before any row is asked for. `getRow` creates the row it is asked for, so
    // asking first would grow the sheet and make the second extent a measurement of this loop rather
    // than of the file.
    const rowExtent = worksheet.rowCount
    const columnExtent = worksheet.columnCount

    // Only the sheets that survive the cap are built into rows. The rest are still walked below, for
    // the counters — the point of the cap is to bound the payload, not to blind the report.
    if (sheets.length < MAX_SHEETS) {
      const rows: string[][] = []
      // Empty rows inside the extent are kept as empty rows rather than skipped, so row 5 of the sheet
      // is row 5 of the grid: a viewer that closed the gaps would draw a table that is not the file.
      for (let rowNumber = 1; rowNumber <= Math.min(rowExtent, MAX_SHEET_ROWS); rowNumber += 1) {
        const row = worksheet.getRow(rowNumber)
        const cells: string[] = []
        for (let columnNumber = 1; columnNumber <= Math.min(columnExtent, MAX_SHEET_COLUMNS); columnNumber += 1) {
          cells.push(cellValueToDisplay(row.getCell(columnNumber).value))
        }
        rows.push(cells)
      }
      sheets.push(shapeSheet(worksheet.name, rows, { rows: rowExtent, columns: columnExtent }))
    }

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value: unknown = cell.value
        // A formula is an object with `formula` on it — or `sharedFormula`, for every cell after the
        // one a shared formula was written on, which carries no formula text of its own but is still a
        // formula in the file. Both halves are needed or a sheet built from one fill handle would be
        // reported as having one formula in it.
        if (value !== null && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          formulaCount += 1
        }
      })
    })
  }

  const charts = chartParts(bytes)

  return {
    // The sheet count is passed rather than inferred, because the loop above shaped only the sheets the
    // cap allowed and those are the only ones this array can describe.
    ...shapeSheets(sheets, worksheets.length),
    fidelity: {
      hasFormulas: formulaCount > 0,
      formulaCount,
      hasCharts: charts.length > 0,
      chartCount: charts.length,
      hasConditionalFormatting,
      // Always false here, and that is the answer rather than a placeholder: an encrypted container was
      // refused above, so reaching this line means the question was asked and answered. `workspace.ts`
      // never reports this flag true, and `image.ts` has the same shape for the same reason — a report
      // with no hole in it is one a caller cannot read as "not yet known".
      encrypted: false,
    },
  }
}
