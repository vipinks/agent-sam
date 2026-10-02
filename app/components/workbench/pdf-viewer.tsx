import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { Button } from '../ui/button'
import { base64ToBytes } from './base64'
import { DocumentError, openFailure, shownFailure, documentReadFailure, type DocumentFailure } from './document-error'
import { openPdf, type PdfDocument } from './pdf'

/**
 * A pdf, drawn a page at a time.
 *
 * A page and not a scroll of pages: pdf.js renders one page per call, laying out a document's worth of
 * them is a virtualisation problem of its own, and the toolbar's page counter is the honest form of
 * "where am I" for a format that has always had pagination. Zoom is a multiple of the page's own size,
 * which the boundary turns into a canvas of the right pixel dimensions.
 *
 * The bytes come from the bridge, as base64 — the read path's own encoding for a document — and the
 * parser is reached only once they are in hand. Everything below is a state of that wait: the read in
 * flight, the parser working, a failure from either, and the canvas.
 *
 * The two pieces of per-document state are reset with the document rather than left behind: opening
 * another pdf starts on page one at the zoom the reader last chose, and a failure from the previous
 * file cannot be shown over the next one.
 */

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

const UNREADABLE = 'It may be damaged, or use a feature this reader cannot draw.'

export function PdfViewer({ path }: { path: string }) {
  const file = conveyor.workspace.readDocument.useQuery({ input: { path }, retry: false })
  const openExternally = conveyor.workspace.openDocument.useMutation()

  const fileName = path.split(/[\\/]/).pop() ?? path
  const base64 = typeof file.data?.base64 === 'string' ? file.data.base64 : null

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [failure, setFailure] = useState<DocumentFailure | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (base64 === null) return

    let live = true
    let opened: PdfDocument | null = null

    setPdf(null)
    setFailure(null)
    setPage(1)

    void openPdf(base64ToBytes(base64))
      .then((document) => {
        if (!live) {
          // Opened after the file changed under it: destroying it here is what keeps a second document
          // from being held open by the render that is no longer on screen.
          document.destroy()
          return
        }

        opened = document
        setPdf(document)
      })
      .catch(() => {
        if (live) setFailure(shownFailure(fileName, UNREADABLE))
      })

    return () => {
      live = false
      opened?.destroy()
    }
  }, [base64, fileName])

  useEffect(() => {
    const canvas = canvasRef.current
    if (pdf === null || canvas === null) return

    let live = true

    void pdf.render(page, zoom, canvas).catch(() => {
      if (live) setFailure(shownFailure(fileName, UNREADABLE))
    })

    return () => {
      live = false
    }
  }, [pdf, page, zoom, fileName])

  const openFile = () => {
    // Fire and forget, but not silently: a shell that refuses the file has a sentence for why, and it is
    // shown in the same place a read failure would be.
    void openExternally.mutateAsync({ path }).catch((error: unknown) => setFailure(openFailure(error, fileName)))
  }

  const pageCount = pdf?.pageCount ?? 0
  const atFirstPage = page <= 1
  const atLastPage = pdf === null || page >= pageCount

  return (
    <div data-slot="pdf-viewer" className="flex h-full flex-col bg-background">
      {/*
        The toolbar says what is open and where in it the reader is. The open button is a download
        glyph because that is what it looks like from the reader's side — the file leaves the app — and
        its accessible name says what actually happens: the OS's own handler is given the file.
      */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={path}>
          {fileName}
        </p>

        <Button
          variant="ghost"
          size="xs"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoom((current) => Math.max(ZOOM_MIN, current - ZOOM_STEP))}
        >
          <ZoomOut />
        </Button>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{`${Math.round(zoom * 100)}%`}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom((current) => Math.min(ZOOM_MAX, current + ZOOM_STEP))}
        >
          <ZoomIn />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          aria-label="Previous page"
          disabled={atFirstPage}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft />
        </Button>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{`Page ${page} of ${pageCount}`}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Next page"
          disabled={atLastPage}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          <ChevronRight />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          aria-label={`Open ${fileName} in the default application`}
          title={`Open ${fileName} in the default application`}
          onClick={openFile}
        >
          <Download />
        </Button>
      </div>

      {file.isLoading && base64 === null ? (
        <p className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {`Reading ${fileName}…`}
        </p>
      ) : file.error ? (
        <DocumentError {...documentReadFailure(file.error, fileName)} />
      ) : failure !== null ? (
        <DocumentError {...failure} />
      ) : pdf === null ? (
        <p className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {`Opening ${fileName}…`}
        </p>
      ) : (
        // The page sits on the muted ground the rest of the app's surfaces use, so a white sheet is
        // visibly a sheet, and the box scrolls when a page is larger than the pane.
        <div className="min-h-0 flex-1 overflow-auto bg-muted p-4">
          <canvas ref={canvasRef} className="mx-auto block bg-background shadow-sm" />
        </div>
      )}
    </div>
  )
}
