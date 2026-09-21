/**
 * The write path's two rules: where a displayed grid index lands in a workbook, and what type the text
 * a user typed takes once it is stored.
 *
 * Pure and shared rather than main-only, for the same reason `write-guard.ts` and `spreadsheet.ts` are:
 * main owns the parser, the bytes and the write, but these two *decisions* — one index in and one
 * address out, one displayed value plus one typed string in and one stored value out — are decisions a
 * test should be able to make on plain numbers and plain strings, without a workbook, a disk or a
 * parser. `conveyor/modules/spreadsheet-write.ts` imports them; nothing in `app/` does, because the
 * renderer sends grid indices and typed text and lets main decide what they mean.
 *
 * Neither rule parses anything, and that is what keeps this file answerable on literals: the mapping is
 * arithmetic rather than a walk of a worksheet, and the typing rule is decided from the value the cell
 * already held rather than from anything the text looks like on its own.
 */

/**
 * One cell edit as it crosses the boundary: a displayed grid index, and the text typed into it.
 *
 * Deliberately the grid's coordinates and not the workbook's. The pane drew a dense array from zero and
 * this names a position in it, so an edit is always about a cell the user could see — which is what
 * makes the mapping below a rule rather than a convention two sides have to agree on separately.
 */
export interface SpreadsheetEdit {
  /** The sheet's position in the workbook, numbered the way the pane's tabs are. */
  sheet: number
  /** The row's position in the grid the pane drew, its first row counting as zero. */
  row: number
  /** The column's position in that same grid. */
  col: number
  /** What the user typed, exactly as typed: what type it takes is `typedCellValue`'s decision. */
  value: string
}

/**
 * Where a displayed grid index lands in the worksheet: the inverse of the mapping the read applied.
 *
 * The grid is a dense array from zero, the workbook is one-indexed, and the parse bridged the two by
 * walking `getRow(1…rowCount)` and `getCell(1…columnCount)` to fill `rows[0…]`. That is the mapping
 * being reversed here, and reversing it is what lets an edit name the cell the user saw rather than a
 * worksheet address the renderer would have had to invent — the renderer has no worksheet, no
 * spreadsheet library and no notion of A1 notation, and it must not acquire one.
 *
 * Both axes take the same rule, and that is not a coincidence to be traded on later: a sheet's first
 * row is the grid's first row, its first column is the grid's first column, and no offset applies to
 * one and not the other. The worksheet's own one-indexed habit is visible from the other side in
 * `row.values`, whose slot zero is always empty for exactly this reason.
 */
export function gridAddress(edit: { row: number; col: number }): { row: number; column: number } {
  return { row: edit.row + 1, column: edit.col + 1 }
}

/**
 * Whether a cell's value is a formula, in either of the two ways a workbook records one.
 *
 * Both halves are needed and for the reason the read gives: a shared formula is written on one cell and
 * every cell after it carries `sharedFormula` with no formula text of its own, and both are formulas in
 * the file. The write path asks because it counts how many of them an edit replaced, and a count that
 * missed the shared half would under-report on the sheets where it matters most.
 */
export function isFormulaValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const cell = value as { formula?: unknown; sharedFormula?: unknown }
  return cell.formula !== undefined || cell.sharedFormula !== undefined
}

/**
 * Whether the value a cell displayed was a number.
 *
 * The one subtlety is the formula: a cell holding one displays its *cached* result — nothing in this
 * app evaluates a formula — so a formula decides this question through its result, and one that cached
 * nothing displayed nothing and is therefore not numeric. Everything else answers about itself: a
 * number is a number, and text, dates, booleans and errors are not, whatever the characters they render
 * as. A date is the case worth naming, because `2026-01-02` contains digits and is still not a number.
 */
function displayedWasNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (!isFormulaValue(value)) return false
  return displayedWasNumeric((value as { result?: unknown }).result)
}

/**
 * The value to store for a typed string, under this feature's one typing rule:
 *
 * **a typed value becomes a number only when the cell it replaces displayed a number; every other
 * typed value is stored as the text it is.**
 *
 * The rule is about the cell rather than about the keystrokes, and that is the whole point of it.
 * Deciding from the text alone would re-type a cell the user never meant to re-type: `007` typed into a
 * text column is an account number, and storing it as the number 7 would quietly lose the two zeros
 * that made it that account. Reading the cell first makes the file's own convention the answer — digits
 * in a numeric cell are a quantity, digits in a text cell are text — and it is a rule the read already
 * supports, because a cell's displayed string is derived from its type and not the other way round.
 *
 * The text is stored *as typed* rather than trimmed: a leading space in a cell is a character the user
 * put there, and nothing on this path is a formatter. Trailing and leading whitespace settles only the
 * question of whether the text reads as a number, which is why the trim is on the test and not on the
 * value.
 *
 * Only a finite number qualifies. `Infinity` has no cell representation to write, and a text value that
 * merely starts with digits (`12abc`) is not a number any reader would recognise as one, which is the
 * same judgement `Number()` already makes by rejecting it.
 *
 * An emptied cell becomes an empty string rather than a removed cell: deleting a cell is not a value
 * edit, and a cell that vanished from the file is not one this path could put back.
 */
export function typedCellValue(previous: unknown, typed: string): string | number {
  const text = typed.trim()
  if (text !== '' && displayedWasNumeric(previous) && Number.isFinite(Number(text))) return Number(text)
  return typed
}
