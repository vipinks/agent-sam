import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkspaceChangeInvalidation } from '@/app/components/workbench/use-workspace-changes'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The viewer with a workbook open.
 *
 * What only a DOM test can see is what the pane does with the sheets main sent — one tab per sheet, the
 * sheet on screen swapping when a tab is pressed, the fidelity line — and, since editing arrived, how
 * the grid is opened: that the loss is named before the first edit, that cancelling leaves it read-only,
 * that a cell's typing reaches the bridge as an edit list plus the baseline the read handed over, and
 * that the two banners answer a refused save. Whether a workbook *parses*, what its caps leave out, which
 * codes its refusals carry and what a save actually preserves are decided in main and tested there
 * (`tests/workspace/spreadsheet-read-test.ts`, `tests/workspace/spreadsheet-write-test.ts`,
 * `testing/spreadsheet-rules.test.ts`, `testing/spreadsheet-edit-rules.test.ts`).
 *
 * Mounted with the workspace-change subscription, because that lives at the workbench rather than in the
 * viewer: rendering the viewer alone would leave the refetch case with no listener at all.
 */

const ROOT = 'C:/w'
const SHEET_PATH = 'C:/w/report.xlsx'
const DISK_MTIME = 1_700_000_000_000
const DISK_MTIME_2 = 1_700_000_000_999

/**
 * A workbook result, shaped the way main sends one.
 *
 * Three sheets with distinguishable cells, so "the grid swapped" is an assertion about content rather
 * than about which button looks pressed. The fidelity numbers are the ones the caption must word:
 * twelve formulas and one chart.
 */
function workbookResult() {
  return {
    kind: 'spreadsheet',
    sheets: [
      {
        name: 'First',
        rows: [
          ['h1', 'h2'],
          ['a1', 'a2'],
        ],
        truncatedRows: false,
        truncatedColumns: false,
      },
      {
        name: 'Second',
        rows: [['b1']],
        truncatedRows: false,
        truncatedColumns: false,
      },
      {
        name: 'Third',
        rows: [
          ['h1', 'h2'],
          ['c1', 'c2'],
        ],
        truncatedRows: true,
        truncatedColumns: false,
      },
    ],
    sheetsOmitted: 0,
    fidelity: {
      hasFormulas: true,
      formulaCount: 12,
      hasCharts: true,
      chartCount: 1,
      hasConditionalFormatting: false,
      encrypted: false,
    },
    bytes: 4096,
    path: SHEET_PATH,
    baselineMtime: DISK_MTIME,
  }
}

function stubViewer(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => workbookResult(),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT })
  setActiveStub(stub)
  return stub
}

function ViewerUnderChangeSubscription() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  useWorkspaceChangeInvalidation(selectedFile)
  return <CodeViewer />
}

function renderViewer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ViewerUnderChangeSubscription />
    </QueryClientProvider>
  )
}

/** The sheet tabs, once the read has landed and the grid has drawn. */
async function sheetTab(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const group = screen.queryByRole('group', { name: 'Sheets' })
    if (group === null) throw new Error('the sheet tabs have not rendered yet')
    const found = within(group).getByRole('button', { name })
    return found
  })
}

/** How many times the read path has been asked for the open file. */
function reads(stub: BridgeStub): number {
  return stub.callsTo('workspace').filter((call) => call.method === 'readFile').length
}

/**
 * Open the grid, through the confirmation this fixture raises.
 *
 * The fixture has formulas and a chart, so the toggle asks first — which is asserted on its own above
 * rather than here — and continuing is what produces the fields. The first sheet's row 2 column 2 is the
 * `a2` in the fixture.
 */
async function startEditingWorkbook(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByLabelText('Edit this workbook'))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  return waitFor(() => {
    const field = screen.queryByLabelText('First row 2 column 2')
    if (field === null) throw new Error('the grid has not been opened yet')
    return field as HTMLInputElement
  })
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('a workbook in the viewer', () => {
  it('draws one tab per sheet, and the first sheet as a header plus body', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    const group = await screen.findByRole('group', { name: 'Sheets' })

    // One tab per sheet, in the workbook's order, with the first one shown.
    const tabs = within(group).getAllByRole('button')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['First', 'Second', 'Third'])
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true')
    expect(tabs[1].getAttribute('aria-pressed')).toBe('false')

    // The sheet's own first row is the header, so it is a `th` in a `thead` rather than a body row: a
    // header is a rendering decision, and this is where that decision is visible.
    const headerCells = Array.from(container.querySelectorAll('thead th')).map((cell) => cell.textContent)
    expect(headerCells).toEqual(['h1', 'h2'])
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'))
    expect(bodyRows).toHaveLength(1)
    expect(Array.from(bodyRows[0].querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['a1', 'a2'])
  })

  it('swaps the grid when a tab is pressed', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    expect(container.textContent).toContain('a1')

    fireEvent.click(await sheetTab('Third'))

    // The assertion is about content rather than about which button looks pressed: the third sheet's
    // cells are on screen and the first sheet's are not.
    await waitFor(() => expect(container.textContent).toContain('c1'))
    expect(container.textContent).not.toContain('a1')
    expect((await sheetTab('Third')).getAttribute('aria-pressed')).toBe('true')
    expect((await sheetTab('First')).getAttribute('aria-pressed')).toBe('false')
  })

  it('captions the file in one line', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })

    // The counts are the file's, and the trailing clause is what tells the reader this is a preview
    // rather than an editor they have not found yet.
    const caption = container.querySelector('[data-slot="spreadsheet-caption"]')
    expect(caption?.textContent).toBe('12 formulas, 1 chart — preview only')
  })

  it('offers a toggle of its own, and no field until the loss is confirmed', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })

    // A workbook has a toggle of its own rather than the text editor's — the two are never both offered,
    // because a grid holds values and a textarea holds characters.
    expect(screen.queryByLabelText('Edit this file')).toBeNull()
    expect(screen.queryByLabelText('Stop editing')).toBeNull()
    expect(screen.getByLabelText('Edit this workbook')).toBeTruthy()

    // And nothing is writable yet: no field exists until the grid has been opened, and no Save button
    // either, because there is nothing to save. Nor the `read-only` label, which is the viewer saying it
    // declined to open a *text* file — a workbook was never one.
    expect(screen.queryByLabelText('Save file')).toBeNull()
    expect(screen.queryByText('read-only')).toBeNull()
    expect(container.querySelectorAll('textarea, input, [contenteditable]')).toHaveLength(0)

    // The two layers that belong to a text file: line numbers and painted tokens.
    expect(container.querySelector('[data-slot="code-gutter"]')).toBeNull()
    expect(container.querySelector('[data-slot="code-backdrop"]')).toBeNull()
  })

  it('says what the caps left out, under the grid', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    // The first sheet is short and complete, so nothing is said about it.
    expect(container.textContent).not.toContain('Showing the first')

    fireEvent.click(await sheetTab('Third'))

    await waitFor(() => expect(container.textContent).toContain('Showing the first 2 rows.'))
  })

  it('shows the locked state for a workbook that cannot be unlocked', async () => {
    stubViewer({
      readFile: () => {
        throw new ConveyorError('SPREADSHEET_ENCRYPTED', 'This workbook is password protected.')
      },
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    // Branched on the code, and worded as a locked file rather than a broken one: nothing was refused
    // for its size and nothing is corrupt.
    expect(await screen.findByText('report.xlsx is password protected')).toBeTruthy()
    expect(container.querySelector('table')).toBeNull()
    // And it is never offered for editing: the pane has no grid to edit, because the read refused the
    // container rather than the user.
    expect(screen.queryByLabelText('Edit this workbook')).toBeNull()
  })

  it('names the two limits a workbook can hit', async () => {
    stubViewer({
      readFile: () => {
        throw new ConveyorError('SPREADSHEET_TOO_LARGE', 'report.xlsx is 9.0 MB.')
      },
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    expect(await screen.findByText('report.xlsx is too large to preview')).toBeTruthy()
    expect(container.textContent).toContain('caps workbooks at 8 MB')
  })

  it('names the loss before the first edit, and stays read-only when that is refused', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    fireEvent.click(screen.getByLabelText('Edit this workbook'))

    // The sentence is the probe's findings rather than a caution, and this fixture has both a chart and
    // formulas: one is dropped outright by the writer, the other dies only in the cell an edit lands on.
    const prompt = await screen.findByRole('alert')
    expect(prompt.textContent).toContain('charts are not written back')
    expect(prompt.textContent).toContain('a formula in a cell you edit is replaced by the value you type')
    expect(prompt.textContent).toContain('formulas elsewhere are kept')
    // Conditional formatting is deliberately not named: this file has none, and warning about it would be
    // true of the writer and false of the save.
    expect(prompt.textContent).not.toContain('duplicate-values')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Cancelling is not a decision to remember: nothing was recorded, no field appeared, and the prompt
    // closed. Asking again is what makes refusing free.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(container.querySelectorAll('textarea, input, [contenteditable]')).toHaveLength(0)
    expect(screen.queryByLabelText('Save file')).toBeNull()
    expect(container.textContent).toContain('12 formulas, 1 chart — preview only')

    fireEvent.click(screen.getByLabelText('Edit this workbook'))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('opens a field per shown cell once the loss is accepted, and saves the edits on Ctrl+S', async () => {
    const stub = stubViewer({
      writeSpreadsheet: () => ({ path: SHEET_PATH, mtimeMs: DISK_MTIME_2, replacedFormulas: 0 }),
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    const field = await startEditingWorkbook()

    // A cell of the first sheet, named the way a reader of a spreadsheet counts: row 2, column 2 is the
    // `a2` in the fixture, which is grid row 1 column 1 and so sheet row 2 column 2.
    expect(field.value).toBe('a2')
    fireEvent.change(field, { target: { value: '99' } })

    // The dot is the store's flag as well as the pane's, so it is asserted through the store: a
    // workbooks's unsaved work is its edit list.
    await waitFor(() =>
      expect(useWorkbenchStore.getState().editor).toEqual({ path: SHEET_PATH, dirty: true, externalNonce: 0 })
    )

    const readsBefore = reads(stub)
    await userEvent.keyboard('{Control>}s{/Control}')

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeSpreadsheet'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeSpreadsheet')
    expect(written?.args[0]).toEqual({
      path: SHEET_PATH,
      edits: [{ sheet: 0, row: 1, col: 1, value: '99' }],
      baselineMtime: DISK_MTIME,
    })

    // Saved: the edits are gone, the file is clean, and the grid has been re-read rather than left
    // showing the values it was drawn from.
    await waitFor(() => expect(reads(stub)).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(screen.queryByLabelText('report.xlsx has unsaved changes')).toBeNull())
    await waitFor(() =>
      expect(useWorkbenchStore.getState().editor).toEqual({ path: SHEET_PATH, dirty: false, externalNonce: 0 })
    )
  })

  it('answers a refused workbook save with the same banner, and forces only on a second click', async () => {
    const stub = stubViewer({
      writeSpreadsheet: (input) => {
        const { force } = input as { force?: boolean }
        if (!force) throw new ConveyorError('WRITE_CONFLICT', 'changed on disk')
        return { path: SHEET_PATH, mtimeMs: DISK_MTIME_2, replacedFormulas: 0 }
      },
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    const field = await startEditingWorkbook()
    fireEvent.change(field, { target: { value: '99' } })
    await userEvent.keyboard('{Control>}s{/Control}')

    // The same banner a text conflict gets, because it is the same conflict: the disk moved and the save
    // was declined rather than written.
    expect(await screen.findByText(/changed on disk since you opened it, so your save was not written/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))

    await waitFor(() =>
      expect(
        stub
          .callsTo('workspace')
          .filter((call) => call.method === 'writeSpreadsheet' && (call.args[0] as { force?: boolean }).force === true)
      ).toHaveLength(1)
    )
    // And the force went along with the edits, rather than being a licence to write nothing.
    const forced = stub
      .callsTo('workspace')
      .find((call) => call.method === 'writeSpreadsheet' && (call.args[0] as { force?: boolean }).force === true)
    expect((forced?.args[0] as { edits: unknown[] }).edits).toEqual([{ sheet: 0, row: 1, col: 1, value: '99' }])
  })

  it('takes the disk on Reload, dropping the edits and re-reading the file', async () => {
    const stub = stubViewer({
      writeSpreadsheet: () => {
        throw new ConveyorError('WRITE_CONFLICT', 'changed on disk')
      },
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    const field = await startEditingWorkbook()
    fireEvent.change(field, { target: { value: '99' } })
    await userEvent.keyboard('{Control>}s{/Control}')
    await screen.findByRole('button', { name: 'Reload' })

    const readsBefore = reads(stub)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(reads(stub)).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(screen.queryByLabelText('report.xlsx has unsaved changes')).toBeNull())
    // The field shows the file again rather than the text that was typed over it: the value is the read's
    // with no edit left to show, and the banner's question is no longer open.
    await waitFor(() => expect((screen.getByLabelText('First row 2 column 2') as HTMLInputElement).value).toBe('a2'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says in the caption what the save did not keep', async () => {
    stubViewer({
      writeSpreadsheet: () => ({ path: SHEET_PATH, mtimeMs: DISK_MTIME_2, replacedFormulas: 1 }),
    })
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })
    const field = await startEditingWorkbook()
    fireEvent.change(field, { target: { value: '99' } })
    await userEvent.keyboard('{Control>}s{/Control}')

    // Both losses, in the caption's own line: the chart this fixture's fidelity reported, and the one
    // formula main counted while it still had the cells in hand. The chart is the half the fresh read
    // cannot report — it describes the file as it now is, and an absence is not evidence.
    await waitFor(() =>
      expect(container.querySelector('[data-slot="spreadsheet-caption"]')?.textContent).toContain(
        'saved: charts were not kept; 1 formula in the cells you edited was replaced by your value'
      )
    )
  })
})

describe('a change on disk', () => {
  it('refetches a workbook exactly as it refetches text', async () => {
    const stub = stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    renderViewer()
    await screen.findByRole('group', { name: 'Sheets' })

    const before = reads(stub)
    // What main broadcasts after the file is written. The invalidation is keyed by path and knows
    // nothing about kinds, which is the property under test for the third time now — and the reason
    // this turn did not have to touch the invalidation path at all.
    stub.emit('conveyor:event:workspace:onChanged', { kind: 'written', path: SHEET_PATH })
    // The burst is coalesced, so give the window a chance to close before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200))

    await waitFor(() => expect(reads(stub)).toBeGreaterThan(before))
  })
})
