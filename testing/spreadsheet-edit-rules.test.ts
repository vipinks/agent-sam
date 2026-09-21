import { describe, expect, it } from 'vitest'
import { gridAddress, isFormulaValue, typedCellValue } from '@/conveyor/protocol/spreadsheet-edit'
import {
  editsByCell,
  fidelityCaption,
  lossNotice,
  recordEdit,
  savedLossNotice,
  type SpreadsheetEdit,
  type SpreadsheetFidelity,
} from '@/app/components/workbench/spreadsheet'

/**
 * The write path's rules, and the pane's edit list, on plain values.
 *
 * Everything here is a decision rather than a write, which is what makes it testable without a workbook,
 * a disk or a parser: where a displayed index lands in a worksheet, what type a typed value takes, what a
 * typing does to the edit list, and the two sentences a save is allowed to say about itself. The write
 * itself — real bytes through the real library — is the node suite's business
 * (`tests/workspace/spreadsheet-write-test.ts`), and the wiring that reaches it is the DOM suite's.
 *
 * The typing rule is the one worth stating in a test file as well as in the module: a typed value becomes
 * a number only when the cell it replaces displayed a number, because a cell's display is derived from
 * its type and not the other way round.
 */

/** A fidelity report with everything off, so each case can turn on just the flag it is about. */
function fidelity(overrides: Partial<SpreadsheetFidelity> = {}): SpreadsheetFidelity {
  return {
    hasFormulas: false,
    formulaCount: 0,
    hasCharts: false,
    chartCount: 0,
    hasConditionalFormatting: false,
    encrypted: false,
    ...overrides,
  }
}

/** One edit, with the grid coordinates a pane would have collected. */
function edit(overrides: Partial<SpreadsheetEdit> = {}): SpreadsheetEdit {
  return { sheet: 0, row: 1, col: 1, value: '99', ...overrides }
}

describe('the grid-to-workbook mapping', () => {
  it('is one-indexed on both axes, reversing the read', () => {
    // The grid's first row and first column are the sheet's A1, which is row 1 and column 1 to a
    // worksheet. Both axes take the same rule; neither has an offset the other lacks.
    expect(gridAddress({ row: 0, col: 0 })).toEqual({ row: 1, column: 1 })
    expect(gridAddress({ row: 4, col: 1 })).toEqual({ row: 5, column: 2 })
    expect(gridAddress({ row: 999, col: 63 })).toEqual({ row: 1000, column: 64 })
  })

  it('maps the header row like any other, because it is the sheet’s first row', () => {
    // Row zero of the grid is the row the pane *paints* as a header, and painting it is a rendering
    // decision: the read kept it as row one of the data, so it maps to row one of the worksheet.
    expect(gridAddress({ row: 0, col: 3 }).row).toBe(1)
  })
})

describe('the typing rule', () => {
  it('stores a number when the cell it replaces displayed a number', () => {
    expect(typedCellValue(2, '99')).toBe(99)
    expect(typedCellValue(2, '007')).toBe(7)
    expect(typedCellValue(1.5, '12')).toBe(12)
  })

  it('stores text when the cell it replaces displayed text, however numeric the typing looks', () => {
    // The case the rule exists for: an account number, a phone number, a postcode. Parsing every typed
    // digit would turn `007` into 7 and quietly lose the two characters that made it that number.
    expect(typedCellValue('a', '99')).toBe('99')
    expect(typedCellValue('a', '007')).toBe('007')
  })

  it('lets a formula cell decide through its cached result, which is what it displays', () => {
    // Nothing in this app evaluates a formula, so a formula cell shows the result the file stored — and
    // that is the value the rule asks about.
    expect(typedCellValue({ formula: 'B2*B3', result: 6 }, '7')).toBe(7)
    expect(typedCellValue({ formula: 'B2*B3', result: 'six' }, '7')).toBe('7')
    // Written without a cached result, it displayed nothing, so nothing says the cell was numeric.
    expect(typedCellValue({ formula: 'B2+B3' }, '5')).toBe('5')
    expect(typedCellValue({ sharedFormula: 'B2+B3' }, '5')).toBe('5')
  })

  it('reads everything that is not a number as not numeric, including a date', () => {
    // A date is the case worth naming: `2026-01-02` is full of digits and is not a number.
    expect(typedCellValue(new Date(2026, 0, 2), '2026')).toBe('2026')
    expect(typedCellValue(true, '1')).toBe('1')
    expect(typedCellValue(null, '1')).toBe('1')
    expect(typedCellValue(undefined, '1')).toBe('1')
    expect(typedCellValue({ error: '#DIV/0!' }, '1')).toBe('1')
  })

  it('stores what was typed, and only asks the trimmed text whether it is a number', () => {
    // Whitespace inside a cell is a character somebody put there; nothing on this path is a formatter.
    expect(typedCellValue(2, ' 12 ')).toBe(12)
    expect(typedCellValue('a', ' 12 ')).toBe(' 12 ')
    expect(typedCellValue(2, '')).toBe('')
    expect(typedCellValue(2, '   ')).toBe('   ')
  })

  it('refuses anything that is not a finite number', () => {
    expect(typedCellValue(2, 'abc')).toBe('abc')
    expect(typedCellValue(2, '12abc')).toBe('12abc')
    expect(typedCellValue(2, 'Infinity')).toBe('Infinity')
    expect(typedCellValue(2, 'NaN')).toBe('NaN')
  })

  it('recognises a formula in either of the two ways a workbook records one', () => {
    expect(isFormulaValue({ formula: 'A1+B1' })).toBe(true)
    expect(isFormulaValue({ sharedFormula: 'A1+B1' })).toBe(true)
    expect(isFormulaValue(3)).toBe(false)
    expect(isFormulaValue('=A1+B1')).toBe(false)
    expect(isFormulaValue(null)).toBe(false)
    expect(isFormulaValue(undefined)).toBe(false)
  })
})

describe('the edit list', () => {
  it('records one edit per cell, and replaces rather than duplicates a retyping', () => {
    const first = recordEdit([], edit({ value: '5' }), '2')
    expect(first).toEqual([{ sheet: 0, row: 1, col: 1, value: '5' }])

    const second = recordEdit(first, edit({ value: '7' }), '2')
    expect(second).toEqual([{ sheet: 0, row: 1, col: 1, value: '7' }])

    const other = recordEdit(second, edit({ row: 2, value: 'x' }), 'b')
    expect(other).toHaveLength(2)
  })

  it('drops an edit typed back to what the cell already displayed', () => {
    // Otherwise a user who types and then undoes has left the file dirty and handed main a cell to
    // rewrite with the value it already held.
    const typed = recordEdit([], edit({ value: '5' }), '2')
    expect(recordEdit(typed, edit({ value: '2' }), '2')).toEqual([])
  })

  it('compares exactly, because whitespace is a thing a user can type', () => {
    expect(recordEdit([], edit({ value: '2 ' }), '2')).toHaveLength(1)
  })

  it('groups one sheet by row and column, and ignores the other sheets', () => {
    const edits = [
      edit({ row: 1, col: 1, value: 'a' }),
      edit({ row: 1, col: 3, value: 'b' }),
      edit({ sheet: 1, row: 1, col: 1, value: 'c' }),
    ]

    const byRow = editsByCell(edits, 0)
    expect([...byRow.keys()]).toEqual([1])
    expect(byRow.get(1)?.get(1)).toBe('a')
    expect(byRow.get(1)?.get(3)).toBe('b')
    expect(editsByCell(edits, 1).get(1)?.get(1)).toBe('c')
    expect(editsByCell(edits, 2).size).toBe(0)
  })

  it('gives a cell one answer, later entries winning', () => {
    const byRow = editsByCell([edit({ value: 'first' }), edit({ value: 'last' })], 0)
    expect(byRow.get(1)?.get(1)).toBe('last')
  })
})

describe('what a save is allowed to say about itself', () => {
  it('names exactly the losses this file can suffer, from the measured ones', () => {
    // The probe's findings, not a general caution: charts are dropped by the writer, a formula in an
    // edited cell is replaced by the value typed into it, and `duplicateValues` rules are not written
    // back — while formulas elsewhere, styles, sheet order and the other rule types are.
    const notice = lossNotice(fidelity({ hasFormulas: true, hasCharts: true, hasConditionalFormatting: true }))
    expect(notice).toContain('charts are not written back')
    expect(notice).toContain('a formula in a cell you edit is replaced by the value you type')
    expect(notice).toContain('formulas elsewhere are kept')
    expect(notice).toContain('duplicate-values conditional-formatting rules are not written back')
  })

  it('says nothing when nothing is at risk, so the grid opens without a question', () => {
    expect(lossNotice(fidelity())).toBeNull()
    // Conditional formatting alone is a real case: the pane asks, and the sentence says plainly which
    // rule type is the one that will not survive.
    expect(lossNotice(fidelity({ hasConditionalFormatting: true }))).not.toBeNull()
  })

  it('names only the flags the file actually raised', () => {
    const chartsOnly = lossNotice(fidelity({ hasCharts: true }))
    expect(chartsOnly).toContain('charts are not written back')
    expect(chartsOnly).not.toContain('formula')
  })

  it('reports after the fact only what it can still know', () => {
    expect(savedLossNotice({ hadCharts: true, replacedFormulas: 0 })).toBe('saved: charts were not kept')
    expect(savedLossNotice({ hadCharts: false, replacedFormulas: 1 })).toBe(
      'saved: 1 formula in the cells you edited was replaced by your value'
    )
    expect(savedLossNotice({ hadCharts: true, replacedFormulas: 3 })).toBe(
      'saved: charts were not kept; 3 formulas in the cells you edited were replaced by your values'
    )
    expect(savedLossNotice({ hadCharts: false, replacedFormulas: 0 })).toBeNull()
  })

  it('appends the note to the caption, and leaves the caption alone without one', () => {
    const report = fidelity({ hasFormulas: true, formulaCount: 2 })
    expect(fidelityCaption(report)).toBe('2 formulas — preview only')
    expect(fidelityCaption(report, 'saved: charts were not kept')).toBe(
      '2 formulas — preview only — saved: charts were not kept'
    )
  })
})
