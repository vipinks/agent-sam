import { useState } from 'react'
import { Table2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  fidelityCaption,
  omittedSheetsNote,
  sheetNotes,
  type SpreadsheetRead,
  type SpreadsheetSheet,
} from './spreadsheet'

/**
 * A workbook, as the pane shows it: sheet tabs, one read-only grid, and what the file says about itself.
 *
 * Read-only by construction rather than by a flag. There is no field, no `contentEditable`, and no
 * control anywhere in here that changes a cell, so there is nothing to disable — which is a stronger
 * statement than an absent toggle, because it cannot be undone by turning something on. The edit
 * affordance belongs to the text editor, and a workbook is not text.
 *
 * One sheet is drawn at a time and the tabs are which one. That is the shape the caps assume: main
 * truncates per sheet, so a reader who is told sheet three is short can look at sheet three and see why.
 *
 * Nothing here decides how much of a sheet to show. The rows arrived already capped, and the notes are
 * read off them, so the pane cannot disagree with the read about what was kept.
 */
export function SpreadsheetView({ read }: { read: SpreadsheetRead }) {
  /**
   * Which sheet is on screen, by index.
   *
   * Index rather than name, because sheet names are the file's and nothing guarantees the pane's tabs are
   * unique — a workbook is not supposed to repeat one, and a pane that keyed on the name would draw two
   * tabs selecting each other if it ever did.
   *
   * The parent remounts this component per open file (see the `key` in the Code Viewer), so the index
   * does not have to be reset when the file changes — and cannot be left pointing at a sheet of a
   * workbook that is no longer open.
   */
  const [activeSheet, setActiveSheet] = useState(0)

  const sheets = read.sheets
  // Clamped rather than trusted: a refetch could in principle return fewer sheets than the one being
  // shown, and an index past the end would render nothing at all instead of an empty workbook.
  const index = Math.min(activeSheet, Math.max(0, sheets.length - 1))
  const sheet = sheets[index]

  const notes = sheet === undefined ? [] : sheetNotes(sheet)
  const omitted = omittedSheetsNote(read)

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
          <SheetTable sheet={sheet} />
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
        {fidelityCaption(read.fidelity)}
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
 * facts about a row nobody wrote. The grid's edges are ragged for exactly the reason the sheet's are.
 */
function SheetTable({ sheet }: { sheet: SpreadsheetSheet }) {
  const [header, ...body] = sheet.rows

  return (
    <table className="w-max min-w-full text-[12px]">
      {header !== undefined && (
        <thead>
          <tr>
            {header.map((cell, columnIndex) => (
              <th key={columnIndex} scope="col" title={cell}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      )}

      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, columnIndex) => (
              <td key={columnIndex} title={cell}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
