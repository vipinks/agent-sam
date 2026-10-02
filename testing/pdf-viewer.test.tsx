import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { PdfViewer } from '@/app/components/workbench/pdf-viewer'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/**
 * The pdf viewer, with the pdf boundary stood in for.
 *
 * What pdf.js does with the bytes — parsing a page tree, painting a canvas — cannot happen in jsdom at
 * all: there is no canvas implementation behind `getContext`, and no layout for a viewport to describe.
 * So the boundary is mocked and what is asserted is the wiring around it, which is the half this phase
 * actually wrote: that the file is read through the bridge, that the bytes reach the parser, that the
 * toolbar's zoom and page controls move the page being rendered and stop at the ends, that the open
 * button calls the action, and that loading and failure arrive as words.
 *
 * Stated plainly rather than implied: a green run here is not evidence that a page renders. That claim
 * needs a real window and a real document, and it is Boss's eyes that settle it.
 */

const PDF_PATH = 'C:/w/manual.pdf'
/** `%PDF-1.7\n` — the four bytes the reader checks for, then a version and a newline. */
const PDF_BASE64 = 'JVBERi0xLjcK'
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]

/**
 * The pdf boundary, as a spy.
 *
 * `vi.hoisted` because the factory below is hoisted above this file's own imports, so the spy has to
 * be created before them. The module is mocked by its `@/` path — the same file the component reaches
 * as `./pdf` — because vitest resolves both specifiers to one module id.
 */
const boundary = vi.hoisted(() => ({
  // Typed rather than bare: an untyped `vi.fn()` records a zero-length argument tuple, so the bytes the
  // component hands the parser could not be asserted on at all.
  openPdf: vi.fn<(bytes: Uint8Array) => Promise<unknown>>(),
}))

vi.mock('@/app/components/workbench/pdf', () => ({
  openPdf: boundary.openPdf,
}))

function documentResult(path: string) {
  return { kind: 'document', base64: PDF_BASE64, path, baselineMtime: 1_700_000_000_000 }
}

function stubViewer(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    readDocument: () => documentResult(PDF_PATH),
    openDocument: () => ({ path: PDF_PATH }),
    ...overrides,
  })
  setActiveStub(stub)
  return stub
}

function renderViewer(element: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
}

/** One opened document, as the mocked boundary answers: a page count and a render that records. */
function openedDocument(pageCount = 3) {
  const render = vi.fn<(page: number, zoom: number, canvas: HTMLCanvasElement) => Promise<void>>(async () => {})
  const destroy = vi.fn()
  boundary.openPdf.mockResolvedValue({ pageCount, render, destroy })
  return { render, destroy }
}

beforeEach(() => {
  queryClient.clear()
  boundary.openPdf.mockReset()
})

describe('PdfViewer', () => {
  it('reads the file and hands its bytes to the parser, with the file name on the toolbar', async () => {
    const { render: renderPage } = openedDocument()
    stubViewer()

    renderViewer(<PdfViewer path={PDF_PATH} />)

    // The name is the toolbar's own statement about what is open, so it is asserted before the bytes:
    // a viewer that read a file nobody asked for would otherwise pass everything below.
    expect(await screen.findByText('manual.pdf')).toBeTruthy()

    await waitFor(() => expect(boundary.openPdf).toHaveBeenCalledTimes(1))
    const handed = boundary.openPdf.mock.calls[0][0] as Uint8Array
    expect(Array.from(handed.slice(0, 4))).toEqual(PDF_SIGNATURE)

    // The first page is rendered by itself, without a gesture: opening a document shows page one.
    await waitFor(() => expect(renderPage).toHaveBeenCalled())
    expect(renderPage.mock.calls[0][1]).toBe(1)
  })

  it('renders in words while the read is still in flight', async () => {
    openedDocument()
    stubViewer({ readDocument: () => new Promise(() => {}) })

    renderViewer(<PdfViewer path={PDF_PATH} />)

    expect(screen.getByText(/Reading manual\.pdf/)).toBeTruthy()
  })

  it('moves the zoom with the toolbar and re-renders the page at the new scale', async () => {
    const { render: renderPage } = openedDocument()
    stubViewer()
    const user = userEvent.setup()

    renderViewer(<PdfViewer path={PDF_PATH} />)
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))
    expect(screen.getByText('100%')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeTruthy()
    await waitFor(() => expect(renderPage).toHaveBeenLastCalledWith(1, 1.25, expect.anything()))

    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('100%')).toBeTruthy()
    await waitFor(() => expect(renderPage).toHaveBeenLastCalledWith(1, 1, expect.anything()))
  })

  it('stops moving the zoom at the two ends of its range', async () => {
    openedDocument()
    stubViewer()
    const user = userEvent.setup()

    renderViewer(<PdfViewer path={PDF_PATH} />)
    await screen.findByText('100%')

    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    for (let press = 0; press < 8; press += 1) await user.click(zoomOut)
    // A quarter of a page's width is as far out as a reader can be expected to read; past it the
    // control is inert rather than continuing to shrink the page into a stamp.
    expect(screen.getByText('50%')).toBeTruthy()
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true)

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    for (let press = 0; press < 20; press += 1) await user.click(zoomIn)
    expect(screen.getByText('300%')).toBeTruthy()
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true)
  })

  it('pages through the document and stops at both ends', async () => {
    const { render: renderPage } = openedDocument(3)
    stubViewer()
    const user = userEvent.setup()

    renderViewer(<PdfViewer path={PDF_PATH} />)
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    const previous = screen.getByRole('button', { name: 'Previous page' })
    const next = screen.getByRole('button', { name: 'Next page' })

    // Page one is the first page, so there is nothing behind it.
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    expect((previous as HTMLButtonElement).disabled).toBe(true)
    expect((next as HTMLButtonElement).disabled).toBe(false)

    await user.click(next)
    await waitFor(() => expect(renderPage).toHaveBeenLastCalledWith(2, 1, expect.anything()))
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
    expect((previous as HTMLButtonElement).disabled).toBe(false)

    await user.click(next)
    await waitFor(() => expect(renderPage).toHaveBeenLastCalledWith(3, 1, expect.anything()))
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()
    expect((next as HTMLButtonElement).disabled).toBe(true)

    await user.click(previous)
    // Back onto the page behind it, at the zoom it was already drawn at: a step in either direction is
    // a re-render of the page that is now current, not a stack of previous ones.
    await waitFor(() => expect(renderPage.mock.calls.at(-1)?.[0]).toBe(2))
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
  })

  it('offers the file to the OS through the open action', async () => {
    openedDocument()
    const stub = stubViewer()
    const user = userEvent.setup()

    renderViewer(<PdfViewer path={PDF_PATH} />)
    await screen.findByText('manual.pdf')

    await user.click(screen.getByRole('button', { name: 'Open manual.pdf in the default application' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openDocument'))
    const call = stub.callsTo('workspace').find((entry) => entry.method === 'openDocument')
    expect(call?.args[0]).toEqual({ path: PDF_PATH })
  })

  it('says so in words when the file cannot be read', async () => {
    openedDocument()
    stubViewer({
      readDocument: () => {
        throw new ConveyorError('PDF_BYTES_INVALID', 'manual.pdf does not begin with a pdf header, so it is not a pdf.')
      },
    })

    renderViewer(<PdfViewer path={PDF_PATH} />)

    expect(await screen.findByText(/manual\.pdf is not a pdf/)).toBeTruthy()
    expect(screen.getByText(/does not begin with a pdf header/)).toBeTruthy()
    // Nothing was handed to the parser: a refusal is an answer, not a document to draw.
    expect(boundary.openPdf).not.toHaveBeenCalled()
  })

  it('says so in words when the file is past the cap', async () => {
    openedDocument()
    stubViewer({
      readDocument: () => {
        throw new ConveyorError('DOCUMENT_TOO_LARGE', 'manual.pdf is 20.0 MB — the viewer caps documents at 16 MB.')
      },
    })

    renderViewer(<PdfViewer path={PDF_PATH} />)

    expect(await screen.findByText(/manual\.pdf is too large to open/)).toBeTruthy()
    expect(screen.getByText(/caps documents at 16 MB/)).toBeTruthy()
  })

  it('says so in words when the document cannot be parsed', async () => {
    stubViewer()
    boundary.openPdf.mockRejectedValue(new Error('Invalid PDF structure'))

    renderViewer(<PdfViewer path={PDF_PATH} />)

    expect(await screen.findByText(/manual\.pdf could not be shown/)).toBeTruthy()
    expect(screen.getByText(/not a pdf this reader can open|damaged/i)).toBeTruthy()
  })

  it('says so in words when the shell refuses to open the file', async () => {
    openedDocument()
    stubViewer({
      openDocument: () => {
        throw new ConveyorError('OPEN_FAILED', 'Failed to open path')
      },
    })
    const user = userEvent.setup()

    renderViewer(<PdfViewer path={PDF_PATH} />)
    await screen.findByText('manual.pdf')

    await user.click(screen.getByRole('button', { name: 'Open manual.pdf in the default application' }))

    expect(await screen.findByText(/manual\.pdf could not be handed to the system/)).toBeTruthy()
  })
})
