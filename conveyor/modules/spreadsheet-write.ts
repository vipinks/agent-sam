import * as ExcelJS from 'exceljs'
import { ConveyorError } from 'electron-conveyor/main'
import {
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  SPREADSHEET_ENCRYPTED,
  SPREADSHEET_PARSE_FAILED,
  isEncryptedWorkbook,
} from '../protocol/spreadsheet'
import { gridAddress, isFormulaValue, typedCellValue, type SpreadsheetEdit } from '../protocol/spreadsheet-edit'
import type { WorkbookBytes } from './spreadsheet-parse'

/**
 * Writing a workbook: the edit list applied to real bytes, and the only place one is modified.
 *
 * This is main-only and deliberately not shared, for the same reason `spreadsheet-parse.ts` is its own
 * file: it is the part that needs a real parser and a real workbook, and it is composed by
 * `workspace.ts` rather than being a module of its own. Bytes in and bytes out — nothing here touches
 * `fs`, because the read, the stale-baseline guard and the disk write all live in `workspace.ts` where
 * every kind of file is handled the same way. That is also what makes this function stateless: it is
 * handed the bytes that are on disk *now* and returns the bytes that should replace them, with no
 * state of its own to go stale between the two.
 *
 * The order of the three decisions is the read's, and for the read's reasons. An encrypted container is
 * settled first and without the parser, because a password-protected workbook is not a zip at all and
 * its parse failure would be a syntax error about a file that is not damaged — it is locked. (The pane
 * has already refused to offer editing for one of these; the check is here because a rule that only
 * exists in the UI is a rule a second caller would not have.) Then the parse, whose failure is the only
 * input that produces `SPREADSHEET_PARSE_FAILED` — the code that means "these really are not a workbook
 * I can read", which covers a truncated file and a legacy binary `.xls` alike. A `.xls` needs no second
 * refusal *here* either: it never reaches the pane as a spreadsheet, because turn A's read refuses it,
 * so a grid over one does not exist to be edited.
 *
 * Why a rewrite rather than a patch: neither this library nor any other in the tree can write a single
 * cell into a container. The file is parsed, changed in memory and serialized as a whole, which is what
 * makes a save a value-only edit with a fidelity story rather than a transparent one — see the probe in
 * `.preview/phase20-probe/`, whose findings word the confirmation the pane raises before the first edit
 * and the caption it shows afterwards. Measured there: formulas (with their cached results), styles,
 * sheet order and seven of the eight conditional-formatting rule types come back intact, `duplicateValues`
 * rules and every chart part do not, and the style of the very cell an edit lands on survives it.
 */

/** What one application of an edit list produces. */
export interface AppliedSpreadsheetEdits {
  /** The workbook to write, serialized. */
  bytes: Buffer
  /**
   * How many of the applied edits landed on a formula cell.
   *
   * Counted rather than inferred, because the caller has no way to know: the grid a user edits is
   * display strings, and whether a cell held a formula is invisible in it. A save that replaced one is
   * a save that discarded a formula, and the pane says so out loud on the strength of this number.
   */
  replacedFormulas: number
}

/**
 * Whether an edit names a cell the pane could actually have drawn.
 *
 * Both halves matter and neither is about trusting the caller. The sheet index is looked up in the
 * workbook and an index the file does not have writes nothing, because the only way to hold one is to
 * be looking at a grid older than the file — and a write of that grid's edits into a workbook that has
 * since changed shape is exactly what the stale-baseline guard refuses, so a drop here can only happen
 * under a deliberate `force`. The address is bounded by the same caps the read shaped the grid with, so
 * an edit past them is not something the pane can produce; applying it would *grow* the sheet, and a
 * cell the viewer could never have shown is not a value the user could have typed into.
 */
function onTheGrid(edit: SpreadsheetEdit): boolean {
  return edit.row >= 0 && edit.col >= 0 && edit.row < MAX_SHEET_ROWS && edit.col < MAX_SHEET_COLUMNS
}

/**
 * Apply value-only edits to workbook bytes and hand back the workbook to write.
 *
 * One cell at a time, and only the cell's value: no formula is authored, no style is touched, no row or
 * column is inserted or removed. A formula cell an edit lands on is *replaced* by a literal — that is
 * what editing one means — and every cell the edit list does not name is left exactly as the file had
 * it, which is the claim the probe measured and the node suite pins.
 *
 * The previous value is read before it is overwritten because two decisions need it: whether the typed
 * text is a number (`typedCellValue`), and whether the cell was a formula (the count above). Reading it
 * from the parsed workbook rather than from the parse *result* matters — the result is display strings
 * and display strings have lost their types.
 */
export async function applySpreadsheetEdits(
  bytes: Buffer,
  edits: readonly SpreadsheetEdit[]
): Promise<AppliedSpreadsheetEdits> {
  if (isEncryptedWorkbook(bytes)) {
    throw new ConveyorError(SPREADSHEET_ENCRYPTED, 'This workbook is password protected, so it cannot be edited.')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    // The same cast, and the same defect in the dependency's declarations, as the read: see
    // `spreadsheet-parse.ts`, where the type is documented and exported.
    await workbook.xlsx.load(bytes as unknown as WorkbookBytes)
  } catch {
    throw new ConveyorError(SPREADSHEET_PARSE_FAILED, 'This workbook could not be read.')
  }

  let replacedFormulas = 0

  for (const edit of edits) {
    const worksheet = workbook.worksheets[edit.sheet]
    if (worksheet === undefined || !onTheGrid(edit)) continue

    const { row, column } = gridAddress(edit)
    const cell = worksheet.getCell(row, column)
    const previous: unknown = cell.value
    if (isFormulaValue(previous)) replacedFormulas += 1
    cell.value = typedCellValue(previous, edit.value)
  }

  // Serialized here rather than by a `writeFile`, so the bytes and the decision about writing them stay
  // apart: the caller stats the disk between this call and the write, and a library writing the file
  // itself would close that window.
  const serialized = await workbook.xlsx.writeBuffer()
  return { bytes: Buffer.from(serialized as unknown as ArrayBuffer), replacedFormulas }
}
