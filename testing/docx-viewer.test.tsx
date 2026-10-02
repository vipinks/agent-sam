import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { DocxViewer } from '@/app/components/workbench/docx-viewer'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/**
 * The Word viewer, with the conversion boundary stood in for.
 *
 * What only a DOM can show is what the pane does with the html once it has it, and that is exactly
 * where this surface's risk lives: mammoth's html is a *string*, and the one thing this app has never
 * done with a file's contents is hand them to the DOM as markup. So the boundary is mocked, the html it
 * returns is hostile on purpose, and the assertions are about what survives — the text, and none of the
 * script, handler or URL that arrived with it.
 *
 * The conversion itself is proved without a DOM, against a real container through the real mammoth
 * (`tests/ui/docx-convert-test.ts`). What is stubbed here is the same boundary a rule test cannot reach
 * and jsdom cannot run.
 */

const DOCX_PATH = 'C:/w/report.docx'
/** The zip signature and four bytes behind it: enough for the read to be the app's own base64. */
const DOCX_BASE64 = 'UEsDBGp1bms='
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/**
 * The conversion boundary, as a spy.
 *
 * `vi.hoisted` because the mock factory below is hoisted above this file's imports. Mocked by its `@/`
 * path — the same file the component reaches as `./docx` — because vitest resolves both specifiers to
 * one module id.
 */
const boundary = vi.hoisted(() => ({
  // Typed rather than bare: an untyped `vi.fn()` records a zero-length argument tuple, so the bytes the
  // viewer hands the converter could not be asserted on at all.
  docxToHtml: vi.fn<(bytes: Uint8Array) => Promise<unknown>>(),
}))

vi.mock('@/app/components/workbench/docx', () => ({
  docxToHtml: boundary.docxToHtml,
}))

function documentResult(path: string) {
  return { kind: 'document', base64: DOCX_BASE64, path, baselineMtime: 1_700_000_000_000 }
}

function stubViewer(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    readDocument: () => documentResult(DOCX_PATH),
    openDocument: () => ({ path: DOCX_PATH }),
    ...overrides,
  })
  setActiveStub(stub)
  return stub
}

function renderViewer(element: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
}

/** The container the converted document is drawn in, found by the slot the theme styles it through. */
function documentSlot(container: HTMLElement): HTMLElement {
  const slot = container.querySelector<HTMLElement>('[data-slot="docx"]')
  expect(slot).not.toBeNull()
  return slot as HTMLElement
}

beforeEach(() => {
  queryClient.clear()
  boundary.docxToHtml.mockReset()
})

describe('DocxViewer', () => {
  it('renders the converted html inside the document container, named on its toolbar', async () => {
    boundary.docxToHtml.mockResolvedValue({
      ok: true,
      html: '<h2>Quarterly report</h2><p>Hello from the document.</p>',
    })
    stubViewer()

    const { container } = renderViewer(<DocxViewer path={DOCX_PATH} />)

    expect(await screen.findByText('report.docx')).toBeTruthy()
    // Waited for by its text rather than grabbed straight away: the conversion is a promise, so the
    // render that follows the bytes is still the loading one and the container is not there yet.
    await screen.findByText('Hello from the document.')
    // The paragraph is found inside the container rather than anywhere in the document, so a render
    // that put it in the toolbar would not pass this.
    expect(within(documentSlot(container)).getByText('Hello from the document.')).toBeTruthy()
    expect(within(documentSlot(container)).getByRole('heading', { name: 'Quarterly report' })).toBeTruthy()

    await waitFor(() => expect(boundary.docxToHtml).toHaveBeenCalledTimes(1))
    const handed = boundary.docxToHtml.mock.calls[0][0] as Uint8Array
    expect(Array.from(handed.slice(0, 4))).toEqual(ZIP_SIGNATURE)
  })

  /**
   * The security half, asserted where it can fail.
   *
   * A Word file is user data like any other, and the html produced from one is the first string in this
   * app that is *rendered as markup*. What must not survive is a script, an inline handler, a
   * `javascript:` url, and a reference that points off the machine: the first two would run in this
   * window, the third is a way to run one, and the fourth is a request to a stranger's server from a
   * document that is meant to be local.
   */
  it('keeps the text and drops the script, the handler and the off-machine reference', async () => {
    boundary.docxToHtml.mockResolvedValue({
      ok: true,
      html:
        '<p onclick="steal()">Body text</p>' +
        '<script>alert(1)</script>' +
        '<a href="javascript:alert(1)">a link</a>' +
        '<img src="https://tracker.example/pixel.png" alt="tracked">' +
        '<object data="plugin.swf"></object>',
    })
    stubViewer()

    const { container } = renderViewer(<DocxViewer path={DOCX_PATH} />)

    await screen.findByText('Body text')
    const slot = documentSlot(container)

    expect(slot.querySelector('script')).toBeNull()
    expect(slot.querySelector('object')).toBeNull()
    expect(within(slot).getByText('Body text').hasAttribute('onclick')).toBe(false)
    expect(within(slot).getByText('a link').hasAttribute('href')).toBe(false)
    // The image element itself is allowed through — a document's figures are the point of the format —
    // but an address that points off this machine is not.
    expect(slot.querySelector('img')?.getAttribute('src')).toBeNull()
  })

  it('renders in words while the file is being read, and while it is being converted', async () => {
    boundary.docxToHtml.mockReturnValue(new Promise(() => {}))
    stubViewer()
    const reading = renderViewer(<DocxViewer path={DOCX_PATH} />)
    expect(screen.getByText(/Reading report\.docx/)).toBeTruthy()
    reading.unmount()
    boundary.docxToHtml.mockReset()

    boundary.docxToHtml.mockReturnValue(new Promise(() => {}))
    stubViewer()
    renderViewer(<DocxViewer path={DOCX_PATH} />)
    // The bytes are in hand and the converter is working: a second state, worded rather than blank.
    expect(await screen.findByText(/Converting report\.docx/)).toBeTruthy()
  })

  it('says so in words when the conversion refuses the file', async () => {
    boundary.docxToHtml.mockResolvedValue({
      ok: false,
      message: 'This file is not a Word document. A .docx is a zip container, and this file does not begin like one.',
    })
    stubViewer()

    renderViewer(<DocxViewer path={DOCX_PATH} />)

    expect(await screen.findByText('report.docx could not be shown')).toBeTruthy()
    expect(screen.getByText(/not a Word document/)).toBeTruthy()
  })

  it('says so in words when the read fails', async () => {
    boundary.docxToHtml.mockResolvedValue({ ok: true, html: '<p>unused</p>' })
    stubViewer({
      readDocument: () => {
        throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
      },
    })

    renderViewer(<DocxViewer path={DOCX_PATH} />)

    expect(await screen.findByText('report.docx could not be opened')).toBeTruthy()
    expect(screen.getByText(/moved, renamed or deleted/)).toBeTruthy()
    expect(boundary.docxToHtml).not.toHaveBeenCalled()
  })

  it('offers the file to the OS through the open action', async () => {
    boundary.docxToHtml.mockResolvedValue({ ok: true, html: '<p>Body text</p>' })
    const stub = stubViewer()
    const user = userEvent.setup()

    renderViewer(<DocxViewer path={DOCX_PATH} />)
    await screen.findByText('report.docx')

    await user.click(screen.getByRole('button', { name: 'Open report.docx in the default application' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openDocument'))
    const call = stub.callsTo('workspace').find((entry) => entry.method === 'openDocument')
    expect(call?.args[0]).toEqual({ path: DOCX_PATH })
  })
})
