import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Where a document selected in the explorer surfaces: in the Preview resident, and in the code pane.
 *
 * The rule this wires — which kind a name names — is proved without a DOM in `tests/ui/preview-kind-test.ts`,
 * and the two viewers themselves are proved in `pdf-viewer.test.tsx` and `docx-viewer.test.tsx`. What only
 * a rendered workbench can show is what this phase actually changed: that the explorer's own selection
 * reaches the routing, that the routing mounts the pdf reader for a `.pdf` and the Word reader for a
 * `.docx` in *both* panes rather than in one, that a `.doc` — which no surface in this app can draw —
 * arrives as a card stating the format is not previewed here and offering the OS as the way out instead
 * of as a dead end, that a document the read refused (past the cap, missing, mislabelled) is drawn as
 * words with that same way out rather than as a blank pane, and that the picture, the markdown file and
 * the workbook reach exactly the surfaces they reached before.
 *
 * The whole workbench is rendered, rather than the two panes in isolation, because the claim is about the
 * *selection*: a suite that set `selectedFile` by hand would prove the panes agree with the store and not
 * that an explorer row reaches them. The rail is the dock's own control, so the same render shows the
 * resident and then the code pane holding the same file.
 *
 * The two document boundaries are stood in for — pdf.js cannot lay out a page in jsdom, and mammoth's
 * conversion is proved against a real container in `tests/ui/docx-convert-test.ts`. Stated plainly: a
 * green run here is evidence that the right surface was mounted and that the cards say what they should.
 * It is not evidence that a page renders or that a Word file converts. That claim needs a real window, a
 * real pdf and a real docx, and it is Boss's eyes that settle it.
 */

/**
 * The resize primitive, stood in for exactly as `explorer-double-click.test.tsx` stands in for it.
 *
 * The dock is a claim about the inner group's columns, and the library's own panel measures a box that
 * jsdom never lays out. The stand-in keeps the ids the suite finds panels by.
 */
const standIn = vi.hoisted(() => ({ groups: new Map<string, { defaultLayout?: Record<string, number> }>() }))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    id,
    defaultLayout,
    children,
  }: {
    id?: string
    defaultLayout?: Record<string, number>
    children?: ReactNode
  }) => {
    if (id) standIn.groups.set(id, { defaultLayout })
    return (
      <div data-group id={id}>
        {children}
      </div>
    )
  },
  ResizablePanel: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-panel id={id}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

/**
 * The two document boundaries, as spies.
 *
 * `vi.hoisted` because the factories below are hoisted above this file's imports, and mocked by their
 * `@/` paths — the same files the viewers reach as `./pdf` and `./docx` — because vitest resolves both
 * specifiers to one module id.
 */
const boundaries = vi.hoisted(() => ({
  openPdf: vi.fn<(bytes: Uint8Array) => Promise<unknown>>(),
  docxToHtml: vi.fn<(bytes: Uint8Array) => Promise<unknown>>(),
}))

vi.mock('@/app/components/workbench/pdf', () => ({ openPdf: boundaries.openPdf }))
vi.mock('@/app/components/workbench/docx', () => ({ docxToHtml: boundaries.docxToHtml }))

const ROOT = 'C:/w'
const PDF = 'C:/w/manual.pdf'
const DOCX = 'C:/w/report.docx'
/** The binary Word container: named by the dispatch, and refused by every reader in this app. */
const LEGACY = 'C:/w/letter.doc'
const IMAGE = 'C:/w/logo.png'
const MARKDOWN = 'C:/w/notes.md'
const SHEET = 'C:/w/book.xlsx'

const DISK_MTIME = 1_700_000_000_000
/** `%PDF-1.7\n`, then the zip signature: enough for each read to be the app's own base64. */
const PDF_BASE64 = 'JVBERi0xLjcK'
const DOCX_BASE64 = 'UEsDBGp1bms='
const MARKDOWN_SOURCE = ['# Notes', '', '- one', ''].join('\n')

/** An image read, as main shapes it: a kind and a data URL rather than text. */
function imageResult(path: string) {
  return {
    kind: 'image',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    bytes: 2048,
    path,
    baselineMtime: DISK_MTIME,
  }
}

/** A workbook read, as main shapes it: a parsed grid rather than text. */
function workbookResult(path: string) {
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
    ],
    sheetsOmitted: 0,
    fidelity: {
      hasFormulas: false,
      formulaCount: 0,
      hasCharts: false,
      chartCount: 0,
      hasConditionalFormatting: false,
      encrypted: false,
    },
    bytes: 4096,
    path,
    baselineMtime: DISK_MTIME,
  }
}

/**
 * The whole workbench, over a folder holding one row per kind this routing has an answer for.
 *
 * Every read is answered by kind rather than by path alone, because a read that answered a workbook with
 * text would let a broken routing pass: the panes ask for a shape, and the shape is what decides.
 */
function stubWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    listDirectory: (input) => {
      const path = (input as { path: string }).path
      if (path !== ROOT) return []
      return [
        { name: 'manual.pdf', path: PDF, isDirectory: false },
        { name: 'report.docx', path: DOCX, isDirectory: false },
        { name: 'letter.doc', path: LEGACY, isDirectory: false },
        { name: 'logo.png', path: IMAGE, isDirectory: false },
        { name: 'notes.md', path: MARKDOWN, isDirectory: false },
        { name: 'book.xlsx', path: SHEET, isDirectory: false },
      ]
    },
    readFile: (input) => {
      const path = (input as { path: string }).path
      if (path === IMAGE) return imageResult(path)
      if (path === SHEET) return workbookResult(path)
      return { path, content: MARKDOWN_SOURCE, baselineMtime: DISK_MTIME }
    },
    readDocument: (input) => {
      const path = (input as { path: string }).path
      return {
        kind: 'document',
        base64: path === DOCX ? DOCX_BASE64 : PDF_BASE64,
        path,
        baselineMtime: DISK_MTIME,
      }
    },
    openDocument: (input) => ({ path: (input as { path: string }).path }),
    // Every other read a pane makes is answered emptily: the git panel, the provider lists and the
    // mention index are not this file's subject, and an unstubbed query would be noise in the middle
    // of a routing claim.
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    openRoot: () => ROOT,
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
  setActiveStub(stub)
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/** The right rail, by the name it states to everything that is not a pointer. */
function rightRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Right rail' })
}

/** One of the right rail's residents, by its label. */
function resident(label: string): HTMLElement {
  return within(rightRail()).getByRole('button', { name: label })
}

/** The docked panel's node, or null while the right rail is alone. */
function docked(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#code')
}

/** One row of the tree, by the name it shows. Found rather than got: the listing arrives async. */
function row(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name })
}

/**
 * The slot a document surface draws itself through, inside the pane that is docked.
 *
 * The panel's own node rather than the document: a surface that arrived in the explorer, the transcript
 * or the chat would pass an assertion made against `screen` and tell us nothing about where the reader
 * meets it.
 */
function slotInDock(container: HTMLElement, slot: string): Element | null {
  return docked(container)?.querySelector(`[data-slot="${slot}"]`) ?? null
}

/**
 * The open file, seen in the Preview resident.
 *
 * One helper for the gesture both panes are reached by: select the row, then dock the resident. Written
 * once because every claim below is made twice, once per pane, and a suite that spelled the gesture out
 * six times could drift between its two halves.
 */
async function showInPreview(container: HTMLElement, fileName: string): Promise<HTMLElement> {
  await userEvent.click(await row(fileName))
  await userEvent.click(resident('Preview'))
  await waitFor(() => expect(useWorkbenchStore.getState().rightPanel).toBe('preview'))
  const panel = docked(container)
  expect(panel).not.toBeNull()
  return panel as HTMLElement
}

/** The same open file, seen in the code pane. */
async function showInCode(container: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(resident('Code'))
  await waitFor(() => expect(useWorkbenchStore.getState().rightPanel).toBe('code'))
  const panel = docked(container)
  expect(panel).not.toBeNull()
  return panel as HTMLElement
}

beforeEach(() => {
  standIn.groups.clear()
  localStorage.clear()
  useWorkbenchStore.setState({
    // The explorer's own drawer view: the tree has to be on screen for its rows to be clicked.
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
  boundaries.openPdf.mockReset()
  boundaries.docxToHtml.mockReset()
  // One opened pdf with three pages and a render that records; one converted Word file with a paragraph
  // in it. The defaults are what a *readable* document looks like, so the failure cases below have to say
  // so explicitly.
  boundaries.openPdf.mockResolvedValue({
    pageCount: 3,
    render: vi.fn<(page: number, zoom: number, canvas: HTMLCanvasElement) => Promise<void>>(async () => {}),
    destroy: vi.fn(),
  })
  boundaries.docxToHtml.mockResolvedValue({ ok: true, html: '<p>Body text</p>' })
})

describe('a pdf selected in the explorer', () => {
  it('opens the pdf reader in the Preview resident and in the code pane', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    const preview = await showInPreview(container, 'manual.pdf')
    await waitFor(() => expect(preview.querySelector('[data-slot="pdf-viewer"]')).not.toBeNull())

    const code = await showInCode(container)
    await waitFor(() => expect(code.querySelector('[data-slot="pdf-viewer"]')).not.toBeNull())

    // Read as a document, not as text: the routing asks for the bytes the reader draws, and the text
    // read that would have handed the pane a mojibake string is never made.
    expect(stub.methodsOn('workspace')).toContain('readDocument')
    expect(stub.methodsOn('workspace')).not.toContain('readFile')
  })
})

describe('a Word file selected in the explorer', () => {
  it('opens the Word reader in the Preview resident and in the code pane', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    const preview = await showInPreview(container, 'report.docx')
    await waitFor(() => expect(preview.querySelector('[data-slot="docx-viewer"]')).not.toBeNull())
    expect(await within(preview).findByText('Body text')).toBeTruthy()

    const code = await showInCode(container)
    await waitFor(() => expect(code.querySelector('[data-slot="docx-viewer"]')).not.toBeNull())
    expect(await within(code).findByText('Body text')).toBeTruthy()
  })
})

describe('a legacy .doc selected in the explorer', () => {
  it('is a card naming the format, with the OS as the way out, in both panes', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    const preview = await showInPreview(container, 'letter.doc')

    // The rule, in words: the legacy container is named as one this viewer does not render, so the card
    // reads as a decision rather than as a failure of the app.
    expect(within(preview).getByText(/letter\.doc is a legacy Word file/)).toBeTruthy()
    expect(within(preview).getByText(/binary \.doc format/)).toBeTruthy()
    // No surface was mounted and no read was made: a file nothing here can draw is not read to prove it.
    expect(preview.querySelector('[data-slot="pdf-viewer"]')).toBeNull()
    expect(preview.querySelector('[data-slot="docx-viewer"]')).toBeNull()

    // The way out, on the button and through the action the fallback exists for.
    await userEvent.click(within(preview).getByRole('button', { name: 'Open externally' }))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openDocument'))
    const call = stub.callsTo('workspace').find((entry) => entry.method === 'openDocument')
    expect(call?.args[0]).toEqual({ path: LEGACY })

    const code = await showInCode(container)
    expect(within(code).getByText(/letter\.doc is a legacy Word file/)).toBeTruthy()
    expect(within(code).getByRole('button', { name: 'Open externally' })).toBeTruthy()
  })
})

describe('a document the read refuses', () => {
  it('is the over-cap card, in words and with the external escape, in both panes', async () => {
    stubWorkbench({
      readDocument: () => {
        throw new ConveyorError('DOCUMENT_TOO_LARGE', 'report.docx is 20.0 MB — the viewer caps documents at 16 MB.')
      },
    })
    const { container } = renderWorkbench()

    const preview = await showInPreview(container, 'report.docx')

    expect(await within(preview).findByText(/report\.docx is too large to open/)).toBeTruthy()
    expect(within(preview).getByText(/caps documents at 16 MB/)).toBeTruthy()
    expect(within(preview).getByRole('button', { name: 'Open externally' })).toBeTruthy()

    const code = await showInCode(container)
    expect(await within(code).findByText(/report\.docx is too large to open/)).toBeTruthy()
    expect(within(code).getByRole('button', { name: 'Open externally' })).toBeTruthy()
  })

  it('is the failure wording with the external escape, never a blank pane', async () => {
    stubWorkbench({
      readDocument: () => {
        throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
      },
    })
    const { container } = renderWorkbench()

    const preview = await showInPreview(container, 'manual.pdf')

    expect(await within(preview).findByText(/manual\.pdf could not be opened/)).toBeTruthy()
    expect(within(preview).getByText(/moved, renamed or deleted/)).toBeTruthy()
    expect(within(preview).getByRole('button', { name: 'Open externally' })).toBeTruthy()

    const code = await showInCode(container)
    expect(await within(code).findByText(/manual\.pdf could not be opened/)).toBeTruthy()
    expect(within(code).getByRole('button', { name: 'Open externally' })).toBeTruthy()
  })
})

describe('the kinds that were already routed', () => {
  it('draws the picture, the markdown file and the workbook exactly as before', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    // One kind at a time, and each one twice: the resident first, then the code pane, so "unchanged" is a
    // claim about both places the surfaces are drawn rather than about the one that happened to be docked.
    const picture = await showInPreview(container, 'logo.png')
    await waitFor(() => expect(picture.querySelector('[data-slot="image"]')).not.toBeNull())
    await showInCode(container)
    await waitFor(() => expect(slotInDock(container, 'image')).not.toBeNull())

    const markdown = await showInPreview(container, 'notes.md')
    await waitFor(() => expect(markdown.querySelector('[data-slot="markdown-preview"]')).not.toBeNull())
    // The rendering is the shared renderer's, so the heading is found as an element rather than as the
    // characters that spell it in the source — which is what tells a preview from the read view.
    expect(await within(markdown).findByRole('heading', { name: 'Notes' })).toBeTruthy()
    await showInCode(container)
    await waitFor(() => expect(slotInDock(container, 'markdown-preview')).not.toBeNull())

    const sheet = await showInPreview(container, 'book.xlsx')
    await waitFor(() => expect(sheet.querySelector('[data-slot="spreadsheet"]')).not.toBeNull())
    await showInCode(container)
    await waitFor(() => expect(slotInDock(container, 'spreadsheet')).not.toBeNull())
  })
})
