import { memo, useMemo, useState } from 'react'
import { Table2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  editsByCell,
  fidelityCaption,
  omittedSheetsNote,
  sheetNotes,
  type SpreadsheetEdit,
  type SpreadsheetRead,
  type SpreadsheetSheet,
} from './spreadsheet'

/**
 * A workbook, as the pane shows it: sheet tabs, one grid, and what the file says about itself.
 *
 * One sheet is drawn at a time and the tabs are which one. That is the shape the caps assume: main
 * truncates per sheet, so a reader who is told sheet three is short can look at sheet three and see why.
 *
 * Nothing here decides how much of a sheet to show. The rows arrived already capped, and the notes are
 * read off them, so the pane cannot disagree with the read about what was kept.
 *
 * What this component is *not* is the owner of the edit. The list it draws edits from, the flag saying
 * whether the grid is editable, and the save that consumes them all live in the Code Viewer, for the
 * same reason the text editor's buffer does: the dirty dot, the Save button and the conflict banner are
 * the pane's chrome rather than the grid's, and a second copy of them down here would be a second answer
 * to "is this file unsaved". What arrives is a list, and what leaves is a callback — never a save, and
 * never the file on disk.
 *
 * Two things are deliberately *not* offered, and their absence is the same statement the read-only pane
 * made: there is no way to add a row, add a column, or write a formula. This is a value edit or nothing.
 */
export function SpreadsheetView({
  read,
  editing,
  edits,
  onEdit,
  saveNote,
}: {
  read: SpreadsheetRead
  editing: boolean
  edits: readonly SpreadsheetEdit[]
  /** One cell's typing, with the value the grid was showing it — the collector's decision is main's. */
  onEdit: (edit: SpreadsheetEdit, displayed: string) => void
  /** What the last save did not keep, or null. Wording lives in `savedLossNotice`. */
  saveNote: string | null
}) {
  /**
   * Which sheet is on screen, by index.
   *
   * Index rather than name, because sheet names are the file's and nothing guarantees the pane's tabs are
   * unique — a workbook is not supposed to repeat one, and a pane that keyed on the name would draw two
   * tabs selecting each other if it ever did.
   */
  const [activeSheet, setActiveSheet] = useState(0)

  const sheets = read.sheets
  // Clamped rather than trusted: a refetch could in principle return fewer sheets than the one being
  // shown, and an index past the end would render nothing at all instead of an empty workbook.
  const index = Math.min(activeSheet, Math.max(0, sheets.length - 1))
  const sheet = sheets[index]

  const notes = sheet === undefined ? [] : sheetNotes(sheet)
  const omitted = omittedSheetsNote(read)

  /**
   * The edits of the sheet on screen, grouped the way the grid asks for them.
   *
   * Memoized on the list and the index, which is what makes a keystroke cheap: the map's per-row entries
   * keep their identity unless that row's edits changed, and `SheetRow` uses that to skip redrawing the
   * rows the user is not typing in. Rebuilding it per render would redraw every cell on every character.
   */
  const edited = useMemo(() => editsByCell(edits, index), [edits, index])

  return (
    <div data-slot="spreadsheet" className="flex min-h-0 flex-1 flex-col">
      {/* The tabs. A group of pressed buttons rather than an ARIA tablist, because a tablist owes the
          reader arrow-key navigation and a roving tabindex, and a control that claims the role without
          them is worse than one that claims less. This is the shape the viewer's own Code | Preview
          switch already uses. */}
      {sheets.length > 0 && (
        <div
          role="group"
          aria-label="Sheets"
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5"
        >
          {sheets.map((candidate, candidateIndex) => (
            <Button
              key={candidateIndex}
              variant={candidateIndex === index ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={candidateIndex === index}
              title={candidate.name}
              onClick={() => setActiveSheet(candidateIndex)}
            >
              {candidate.name}
            </Button>
          ))}
        </div>
      )}

      {/* The grid, and the only scroller: the header sticks inside this box, so it stays put while the
          rows pass under it, and the table is wider than the pane when it needs to be — which is where
          the horizontal scroll comes from rather than from a second container. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {sheet === undefined ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
            <Table2 className="size-5 text-muted-foreground/50" aria-hidden="true" />
            This workbook has no sheets.
          </div>
        ) : sheet.rows.length === 0 ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">{sheet.name} is empty.</p>
        ) : (
          /*
            The table, drawn from the read it was handed.

            Every editable cell is a field whose value is the text typed into it *or* — until one is — the
            value the file showed, so the field on screen and the list that will be saved cannot disagree.
            That is the property the whole save rests on, since main is sent the list and never the DOM. A
            new read arrives as new props on this same instance, which is what makes an external write or a
            Reload visible here without this component having to notice that one happened.
          */
          <SheetTable sheet={sheet} sheetIndex={index} editing={editing} edits={edited} onEdit={onEdit} />
        )}
      </div>

      {/* What the caps left out, under the grid rather than over it: a note above the table would push
          the header down and read as a warning about the table, when it is a statement about its edges. */}
      {(notes.length > 0 || omitted !== null) && (
        <ul className="shrink-0 space-y-0.5 border-t border-border bg-muted px-3 py-1.5 text-[11.5px] text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {omitted !== null && <li key={omitted}>{omitted}</li>}
        </ul>
      )}

      <p
        data-slot="spreadsheet-caption"
        className="shrink-0 border-t border-border bg-muted px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
      >
        {fidelityCaption(read.fidelity, saveNote)}
      </p>
    </div>
  )
}

/**
 * One sheet, drawn as a table.
 *
 * The sheet's first row becomes the header, and it is drawn from the read rather than removed by it: a
 * spreadsheet's first row is a header only by convention, so main keeps it as row one and the decision
 * to *paint* it as a heading is made here, where the thing being decided is a rendering. A sheet with a
 * single row is therefore a table with a header and no body, which is what it is.
 *
 * Rows are not padded out to a common width. A row with two cells in a sheet whose widest row has eight
 * draws two cells: the empty cells are not there in the file, and drawing them would be inventing six
 * facts about a row nobody wrote. The grid's edges are ragged for exactly the reason the sheet's are —
 * and a ragged row stays ragged *while editing too*, which is the honest consequence of a value-only
 * edit: a field to type a ninth cell into would be a column being added, and adding columns is not
 * something this pane does.
 */
function SheetTable({
  sheet,
  sheetIndex,
  editing,
  edits,
  onEdit,
}: {
  sheet: SpreadsheetSheet
  sheetIndex: number
  editing: boolean
  edits: Map<number, Map<number, string>>
  onEdit: (edit: SpreadsheetEdit, displayed: string) => void
}) {
  const [header, ...body] = sheet.rows

  return (
    <table className="w-max min-w-full text-[12px]">
      {header !== undefined && (
        <thead>
          <SheetRow
            header
            sheetName={sheet.name}
            sheetIndex={sheetIndex}
            rowIndex={0}
            values={header}
            editing={editing}
            edits={edits.get(0)}
            onEdit={onEdit}
          />
        </thead>
      )}

      <tbody>
        {body.map((row, rowIndex) => (
          <SheetRow
            key={rowIndex}
            header={false}
            sheetName={sheet.name}
            sheetIndex={sheetIndex}
            // One past the array position, because the header is the sheet's own first row: the grid's
            // row index *is* the array index, and this is the number a person would count to.
            rowIndex={rowIndex + 1}
            values={row}
            editing={editing}
            edits={edits.get(rowIndex + 1)}
            onEdit={onEdit}
          />
        ))}
      </tbody>
    </table>
  )
}

/**
 * One row of the grid: the same cells in both modes, read-only text or an editable field.
 *
 * Drawn from the row's own array and nothing else, which is what keeps the read view exactly what it was.
 *
 * The memo is the reason a keystroke does not redraw the sheet. Its props are the row's values, which
 * never change while a file is open, plus the row's own slice of the edits — `undefined` for every row
 * nobody has typed into, and the same map instance from one render to the next for a row whose text has
 * not moved. So typing in one cell redraws one row, and the other nine hundred are skipped.
 *
 * The field is controlled from the two things that can set it: the text typed into this cell, and the
 * value the file showed before it. A keystroke records the edit and the recorded text is what comes back
 * as the field's value, so what is on screen and what the list holds cannot disagree — which is the
 * property the whole save depends on, since main is sent the list and never the DOM. Dropping the edits,
 * or reading new bytes underneath them, is the same mechanism in reverse: the value that comes back is the
 * file's again.
 *
 * Each field is labelled with the cell it edits, in the one coordinate system a reader of a spreadsheet
 * counts in — sheet, row, column, one-indexed — because a grid of fields is otherwise a grid of
 * unnamed inputs to anyone not looking at it.
 */
const SheetRow = memo(function SheetRow({
  values,
  rowIndex,
  sheetIndex,
  sheetName,
  header,
  editing,
  edits,
  onEdit,
}: {
  values: string[]
  rowIndex: number
  sheetIndex: number
  sheetName: string
  header: boolean
  editing: boolean
  edits: Map<number, string> | undefined
  onEdit: (edit: SpreadsheetEdit, displayed: string) => void
}) {
  // A tag rather than two branches: the header and the body differ in one word, and the cells inside
  // them differ in nothing at all.
  const Cell = header ? 'th' : 'td'

  return (
    <tr>
      {values.map((displayed, columnIndex) => {
        const text = edits?.get(columnIndex) ?? displayed

        if (!editing) {
          return (
            <Cell key={columnIndex} {...(header ? { scope: 'col' as const } : {})} title={text}>
              {text}
            </Cell>
          )
        }

        return (
          <Cell key={columnIndex} {...(header ? { scope: 'col' as const } : {})}>
            <input
              aria-label={`${sheetName} row ${rowIndex + 1} column ${columnIndex + 1}`}
              value={text}
              onChange={(event) =>
                onEdit(
                  { sheet: sheetIndex, row: rowIndex, col: columnIndex, value: event.target.value },
                  // The value the file itself is showing, so the collector can tell a real edit from a
                  // cell typed back to what it already said. Never the typed text: that would make every
                  // keystroke look like an edit, including the one that undoes the last.
                  displayed
                )
              }
              // A bare field rather than the shared Input, which carries a height and a border meant for a
              // form: a cell is already a box, and the field inside it draws only its own focus state.
              className="w-full min-w-0 bg-transparent font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </Cell>
        )
      })}
    </tr>
  )
})
