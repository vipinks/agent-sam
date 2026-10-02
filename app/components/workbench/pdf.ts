import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * pdf.js, on this app's terms.
 *
 * Loaded on the first document rather than at import: pdf.js is a parser, a renderer and a small
 * virtual machine of its own, and a window that never opens a pdf should not pay for any of it. The
 * dynamic import below is therefore the whole of the deferral, and the bundler is free to put the
 * library in a chunk that is fetched when a document is opened and never before.
 *
 * The worker is a *bundled asset of this app*, addressed through the same origin that serves the
 * renderer. That is what the window's policy already allows: `app/index.html` declares `script-src
 * 'self'` and no `worker-src`, so a worker falls back to `script-src` and then to `default-src` — both
 * of which are `'self'`. A `blob:` worker, which is how pdf.js is often wired and how many examples
 * do it, would be refused by that policy, so it is not used here; and if the worker cannot start at
 * all, pdf.js falls back to running the same file on the main thread, which is the same origin and the
 * same permission. Nothing in the policy had to be weakened for this to work.
 *
 * Two asset directories pdf.js can use are deliberately *not* configured, and the gap is worth naming:
 * `wasmUrl`, `cMapUrl` and `standardFontDataUrl` would need those files copied into the renderer's
 * output, which is a build step this phase did not add. Their absence costs JPEG2000 images, ICC
 * colour management and non-embedded CJK fonts; an ordinary document with embedded fonts draws without
 * any of them.
 */

type PdfjsModule = typeof import('pdfjs-dist')

/**
 * The library, fetched once for the life of the window.
 *
 * Held as the promise rather than as the module, so two viewers opening at the same moment share one
 * fetch instead of racing for it.
 */
let loading: Promise<PdfjsModule> | null = null

function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= import('pdfjs-dist')

  return loading
}

/** One open document: how long it is, how to draw a page of it, and how to let it go. */
export interface PdfDocument {
  pageCount: number
  render: (page: number, zoom: number, canvas: HTMLCanvasElement) => Promise<void>
  destroy: () => void
}

/**
 * Open a pdf from the bytes the bridge sent.
 *
 * A handle rather than a page count, because the document is worth keeping: pdf.js parses a page tree,
 * and re-parsing it on every page turn or zoom would be paying for the file once per gesture.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs()

  // Set before the first document: pdf.js reads it when it creates its worker, and a document created
  // first would be the one that fell back to the main thread.
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  // The loading *task* is what is held, not only the document it resolves to: tearing the document down
  // is the task's job, and letting go of it at the wrong moment would leave pdf.js's worker alive for
  // the life of the window.
  const task = pdfjs.getDocument({ data: bytes })
  const pdf = await task.promise

  return {
    pageCount: pdf.numPages,

    /**
     * Draw one page onto a canvas.
     *
     * Scaled by the device ratio and sized twice: the canvas *element* is the page's size in CSS
     * pixels, and its backing store is that multiplied by the ratio, so text is drawn at the screen's
     * real resolution instead of being blown up by the compositor. Both are floor-ed to whole pixels —
     * a fractional backing store is a blurred one.
     */
    render: async (page, zoom, canvas) => {
      const pdfPage = await pdf.getPage(page)
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: zoom * pixelRatio })

      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`

      await pdfPage.render({ canvas, viewport }).promise
    },

    destroy: () => {
      void task.destroy()
    },
  }
}
