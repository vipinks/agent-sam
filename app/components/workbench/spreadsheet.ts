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
 * One cell edit, as the pane collects and sends it.
 *
 * Restated here rather than imported from the protocol module, exactly as `SpreadsheetRead` is and for
 * the same reason: this is what the renderer *sends*, and the two have to be changed together on
 * purpose. The indices are the grid's own — the sheet's position in the tab row, and the row and column
 * as the table drew them, counting from zero — which is the point: the pane names the cell the user
 * could see, and main is the side that knows where that lands in a workbook.
 */
export interface SpreadsheetEdit {
  sheet: number
  row: number
  col: number
  value: string
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
 *
 * `saveNote` is the one addition a save makes, and it goes last because it is the newest fact: what this
 * save did *not* keep, from `savedLossNotice`. A save rewrites the whole workbook, so a file that had a
 * chart in it arrives back without one, and the caption is where that is said — the fresh read cannot
 * say it, because it describes the file as it now is and cannot remember what was in it before. Null,
 * the default, is the ordinary case and leaves the sentence exactly as it has always been.
 */
export function fidelityCaption(fidelity: SpreadsheetFidelity, saveNote: string | null = null): string {
  const parts: string[] = []

  if (fidelity.formulaCount > 0) {
    parts.push(`${fidelity.formulaCount} ${plural(fidelity.formulaCount, 'formula')}`)
  }
  if (fidelity.chartCount > 0) {
    parts.push(`${fidelity.chartCount} ${plural(fidelity.chartCount, 'chart')}`)
  }
  if (fidelity.hasConditionalFormatting) parts.push('conditional formatting')

  const base = parts.length === 0 ? 'Preview only' : `${parts.join(', ')} — preview only`
  return saveNote === null ? base : `${base} — ${saveNote}`
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

/**
 * The edit list with one more typing recorded in it, or with a cell's entry removed.
 *
 * The rule that keeps "dirty" honest. Typing a value into a cell and then typing back what the cell
 * already displayed leaves nothing to save, and holding that as an edit would put a dirty dot on the
 * file and rewrite the cell with the value it already held — a change the user did not make. So a value
 * equal to the displayed one *removes* the entry rather than adding it, and re-typing the same value
 * into an already-edited cell replaces the entry rather than duplicating it. The comparison is by exact
 * characters, like the text editor's own baseline comparison: whitespace is a thing a user can type.
 *
 * Order is the order the cells were visited and means nothing: main applies by address, so two edits
 * cannot collide and the position of an entry in the list is not a fact about the file.
 */
export function recordEdit(
  edits: readonly SpreadsheetEdit[],
  edit: SpreadsheetEdit,
  displayed: string
): SpreadsheetEdit[] {
  const without = edits.filter(
    (existing) => existing.sheet !== edit.sheet || existing.row !== edit.row || existing.col !== edit.col
  )
  return edit.value === displayed ? without : [...without, edit]
}

/**
 * The edits of one sheet, as the grid needs them: by row, then by column, the text typed into each.
 *
 * A map of maps rather than a search per cell, because the grid asks this question once per cell it
 * draws and a lookup that scanned the list would be the whole edit list times the whole sheet. It is
 * also what makes the drawing cheap to keep correct: the row a user is typing in is the only row whose
 * entry changes identity, so the memoized rows either side of it are not redrawn at all.
 *
 * A cell can appear only once — `recordEdit` guarantees it — and a later entry still wins if one ever
 * did, because the alternative would be two answers to one cell and the grid would have to choose.
 */
export function editsByCell(edits: readonly SpreadsheetEdit[], sheet: number): Map<number, Map<number, string>> {
  const byRow = new Map<number, Map<number, string>>()

  for (const edit of edits) {
    if (edit.sheet !== sheet) continue
    const row = byRow.get(edit.row) ?? new Map<number, string>()
    row.set(edit.col, edit.value)
    byRow.set(edit.row, row)
  }

  return byRow
}

/**
 * What a save will not preserve, for the file that is open — the sentence before the first edit.
 *
 * Every clause is a measurement rather than a caution, and they were taken by round-tripping real
 * workbooks through this writer (`.preview/phase20-probe/`, whose logs are the record). What survived:
 * formulas as formulas, their cached results, styles — including the style of the very cell an edit
 * lands on — sheet order, and seven of the eight conditional-formatting rule types. What did not:
 * charts, every one of them, whichever cell the save touched; `duplicateValues` rules; and a formula in
 * a cell an edit lands on, which is replaced by the literal value typed into it.
 *
 * So the sentence is assembled from the flags rather than fixed, and it names only what this file
 * actually has: warning a file with no charts that charts will be lost would be true of the writer and
 * false of the save, which is the sort of warning a reader learns to skip. Null means nothing here is at
 * risk, and the pane then enters edit mode without asking.
 *
 * The qualifiers stay attached — "formulas elsewhere are kept" — because the point of naming a loss is
 * to be believed, and a reader who is told formulas die and then sees them all still there has been
 * told something untrue about their file.
 */
export function lossNotice(fidelity: SpreadsheetFidelity): string | null {
  const lost: string[] = []

  if (fidelity.hasCharts) lost.push('charts are not written back')
  if (fidelity.hasFormulas) {
    lost.push('a formula in a cell you edit is replaced by the value you type (formulas elsewhere are kept)')
  }
  if (fidelity.hasConditionalFormatting) {
    lost.push('duplicate-values conditional-formatting rules are not written back (the other rule types are)')
  }

  if (lost.length === 0) return null
  return `Saving rewrites the whole workbook: ${lost.join('; ')}.`
}

/**
 * What the save that just finished did not keep, for the caption — the same measurements, reported
 * after the fact rather than before it.
 *
 * Both clauses come from facts the pane is holding rather than from a guess about the file: whether the
 * workbook it saved had charts, which is the fidelity of the read the edits were made against, and how
 * many formulas the edits landed on, which main counted while it still had the cells in hand. The file
 * itself cannot be asked afterwards — a chart is simply absent from the new bytes, and an absence is not
 * evidence of anything.
 *
 * `duplicateValues` rules are deliberately not mentioned here. Whether a workbook had one is not a fact
 * the read reports — it reports that conditional formatting is present, not which rule types — so the
 * only honest place to name them is the confirmation before the first edit, which is exactly where they
 * are named.
 *
 * Null when the save discarded neither, so an ordinary save adds nothing to a caption that already
 * describes the file correctly.
 */
export function savedLossNotice(input: { hadCharts: boolean; replacedFormulas: number }): string | null {
  const lost: string[] = []

  if (input.hadCharts) lost.push('charts were not kept')
  if (input.replacedFormulas > 0) {
    const count = input.replacedFormulas
    const formula = plural(count, 'formula')
    lost.push(
      `${count} ${formula} in the cells you edited ${count === 1 ? 'was' : 'were'} replaced by your value${count === 1 ? '' : 's'}`
    )
  }

  return lost.length === 0 ? null : `saved: ${lost.join('; ')}`
}
