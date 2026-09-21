/**
 * The workbook half of a read result, as the viewer narrows it, and the sentences the grid says about it.
 *
 * Main decides the kind from the file's name, reads the bytes, parses them and shapes the sheets
 * (`conveyor/protocol/spreadsheet.ts`, `conveyor/modules/spreadsheet-parse.ts`); what is left here is the
 * renderer's side of that decision, kept out of the component for the same reason `image.ts`, `editing.ts`
 * and `preview.ts` are: it is a shape and a wording that a test should be able to exercise by calling a
 * function rather than by rendering a pane and reading the DOM.
 *
 * The shape is restated here rather than imported from the protocol module, exactly as `ImageRead` is.
 * That is not duplication for its own sake: the renderer's contract is what main *sends over IPC*, and
 * importing the sender's type would make a change on the sending side silently change what the pane
 * claims to accept. Restating it means the two have to be changed together on purpose.
 *
 * Nothing here draws anything, reads a file, or decides how many rows are worth showing — the caps are
 * main's, and the pane renders whatever arrived, saying plainly what was left out.
 */

/** One sheet, as it arrives: display strings, and whether the caps left anything behind. */
export interface SpreadsheetSheet {
  name: string
  /** Display strings, the sheet's first row included — a header is a convention, not a fact. */
  rows: string[][]
  truncatedRows: boolean
  truncatedColumns: boolean
}

/**
 * What the file said about itself.
 *
 * `chartCount` is carried beside `hasCharts` because the caption names a number: a boolean cannot
 * honestly produce one, and "1 chart" read from a flag would be a guess that looks like a fact.
 */
export interface SpreadsheetFidelity {
  hasFormulas: boolean
  formulaCount: number
  hasCharts: boolean
  chartCount: number
  hasConditionalFormatting: boolean
  encrypted: boolean
}

/** One workbook read: the fields main sends instead of `content`. */
export interface SpreadsheetRead {
  kind: 'spreadsheet'
  sheets: SpreadsheetSheet[]
  /** How many sheets the cap left out. */
  sheetsOmitted: number
  fidelity: SpreadsheetFidelity
  /** The file's size in bytes, as the disk reported it. */
  bytes: number
  baselineMtime?: number
}

/**
 * The workbook a read result carries, as a type predicate so a caller can narrow with it.
 *
 * Takes `unknown` rather than the query's own result type, so the component does not have to tell the
 * compiler which half it holds before this function has looked. Every field the pane reads is checked,
 * so the claim is honest about what a caller may then use; fields main sends that the pane never looks
 * at are not named here, and so are not claimed.
 *
 * A sheet list is required to be an array, and each sheet to be an object with a name and rows. A
 * result claiming to be a workbook with no sheets array would otherwise reach the grid and throw on
 * `sheets.map`, which is a crash rather than an empty file — the one outcome this predicate exists to
 * prevent. An empty array is accepted, because a workbook with no sheets is a real thing and the pane
 * says so.
 *
 * Branched on `kind` and never on the presence of `content`, so a text result of an empty file — no
 * characters at all — is still a text result.
 */
export function spreadsheetOf(data: unknown): data is SpreadsheetRead {
  if (data === null || typeof data !== 'object') return false

  const candidate = data as { kind?: unknown; sheets?: unknown; fidelity?: unknown; bytes?: unknown }
  if (candidate.kind !== 'spreadsheet') return false
  if (!Array.isArray(candidate.sheets)) return false
  if (typeof candidate.fidelity !== 'object' || candidate.fidelity === null) return false
  if (typeof candidate.bytes !== 'number') return false

  return candidate.sheets.every((sheet) => {
    if (sheet === null || typeof sheet !== 'object') return false
    const candidateSheet = sheet as { name?: unknown; rows?: unknown }
    return typeof candidateSheet.name === 'string' && Array.isArray(candidateSheet.rows)
  })
}

/**
 * The fidelity line under the grid: what the file contains, and that this is a preview.
 *
 * Two things are deliberate here. The counts come from the file rather than from the page, so a sheet
 * the caps shortened still reports the workbook's real totals — a caption that quietly counted only the
 * visible rows would be a smaller number that looks like the answer. And the trailing clause is on
 * *every* caption, including one with nothing else in it: the grid is read-only, and the one sentence
 * that says so should not depend on whether the file happened to contain a formula.
 *
 * Pluralized one way and one way only, because a caption is prose and "1 formulas" is the kind of thing
 * a reader stops trusting the rest of the sentence over.
 */
export function fidelityCaption(fidelity: SpreadsheetFidelity): string {
  const parts: string[] = []

  if (fidelity.formulaCount > 0) {
    parts.push(`${fidelity.formulaCount} ${plural(fidelity.formulaCount, 'formula')}`)
  }
  if (fidelity.chartCount > 0) {
    parts.push(`${fidelity.chartCount} ${plural(fidelity.chartCount, 'chart')}`)
  }
  if (fidelity.hasConditionalFormatting) parts.push('conditional formatting')

  if (parts.length === 0) return 'Preview only'
  return `${parts.join(', ')} — preview only`
}

/** `one` singular, `many` plural. */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/**
 * The notes under the grid for the sheet on screen: what the caps left out of it.
 *
 * The numbers are read from the rows in hand rather than from the caps, so the sentence is about what is
 * actually being drawn: "the first 1000 rows" is true because a thousand are there, not because a
 * constant says a thousand would have been kept. A note that quoted the cap while the sheet showed
 * fewer rows would be the sort of small lie that makes a reader distrust the row count itself.
 *
 * Both notes can apply at once — a sheet can be too long and too wide — and they are separate rather
 * than joined, so neither has to be parsed out of the other.
 */
export function sheetNotes(sheet: SpreadsheetSheet): string[] {
  const notes: string[] = []

  if (sheet.truncatedRows) {
    notes.push(`Showing the first ${sheet.rows.length} rows.`)
  }
  if (sheet.truncatedColumns) {
    notes.push(`Showing the first ${widestRow(sheet)} columns.`)
  }

  return notes
}

/**
 * The note for sheets the cap left out entirely.
 *
 * Null when nothing was dropped, so the caller renders no element rather than an empty one. The total is
 * the sheets on screen plus the ones omitted, which is the only way the pane can name it — main reports
 * the omissions as a count, because it deliberately never builds the sheets it is about to drop.
 */
export function omittedSheetsNote(read: SpreadsheetRead): string | null {
  if (read.sheetsOmitted <= 0) return null
  const total = read.sheets.length + read.sheetsOmitted
  return `Showing the first ${read.sheets.length} of ${total} sheets.`
}

/** The number of columns the widest row actually carries, which is what the note quotes. */
function widestRow(sheet: SpreadsheetSheet): number {
  return sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
}
