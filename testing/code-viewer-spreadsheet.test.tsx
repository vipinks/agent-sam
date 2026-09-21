import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
 * What only a DOM test can see is what the pane does with the sheets main sent: one tab per sheet, the
 * sheet on screen swapping when a tab is pressed, the fidelity line, and — the part this turn is most
 * likely to get wrong — that no edit affordance appears anywhere. Whether a workbook *parses*, what its
 * caps leave out and which codes its refusals carry are decided in main and tested there
 * (`tests/workspace/spreadsheet-read-test.ts`, `testing/spreadsheet-rules.test.ts`).
 *
 * Mounted with the workspace-change subscription, because that lives at the workbench rather than in the
 * viewer: rendering the viewer alone would leave the refetch case with no listener at all.
 */

const ROOT = 'C:/w'
const SHEET_PATH = 'C:/w/report.xlsx'
const DISK_MTIME = 1_700_000_000_000

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

  it('offers no way to change anything', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: SHEET_PATH })
    const { container } = renderViewer()

    await screen.findByRole('group', { name: 'Sheets' })

    // Not a toggle that is off, and not a field that is disabled: neither exists. Nor the `read-only`
    // label, which is the viewer saying it declined to open a *text* file — a workbook was never one.
    expect(screen.queryByLabelText('Edit this file')).toBeNull()
    expect(screen.queryByLabelText('Stop editing')).toBeNull()
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
