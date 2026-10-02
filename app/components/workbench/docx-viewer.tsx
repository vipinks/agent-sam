import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { Button } from '../ui/button'
import { base64ToBytes } from './base64'
import { docxToHtml } from './docx'
import { sanitizeDocumentHtml } from './document-html'
import { DocumentError, openFailure, documentReadFailure, type DocumentFailure } from './document-error'

/**
 * A Word document, as html.
 *
 * The conversion is mammoth's and happens in this process: the bytes arrive base64, become a container,
 * and come back as html. What this file owns is what is done with that html — it is pruned to the
 * elements a document is made of (`document-html.ts`, and the reason it exists) and drawn inside one
 * container. Nothing about the file's own bytes reaches the DOM except through that pass.
 *
 * The conversion is one step per document rather than per render: it is keyed on the bytes, so a zoom or
 * a re-render cannot re-parse a Word file, and switching documents abandons the one in flight instead of
 * letting its result arrive over the next one.
 */

/** Where the document is in its journey from base64 to something drawable. */
type ConversionState =
  | { status: 'idle' }
  | { status: 'converting' }
  | { status: 'html'; html: string }
  | { status: 'refused'; message: string }

/** Bytes the bridge could not have sent, which only a corrupted payload reaches. */
const UNREADABLE_BYTES = 'The bytes of this document could not be decoded, so it cannot be shown.'

function useDocxHtml(base64: string | null): ConversionState {
  const [state, setState] = useState<ConversionState>({ status: 'idle' })

  useEffect(() => {
    if (base64 === null) {
      setState({ status: 'idle' })
      return
    }

    let live = true

    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(base64)
    } catch {
      setState({ status: 'refused', message: UNREADABLE_BYTES })
      return
    }

    setState({ status: 'converting' })

    void docxToHtml(bytes).then((conversion) => {
      if (!live) return

      setState(
        conversion.ok ? { status: 'html', html: conversion.html } : { status: 'refused', message: conversion.message }
      )
    })

    return () => {
      live = false
    }
  }, [base64])

  return state
}

export function DocxViewer({ path }: { path: string }) {
  const file = conveyor.workspace.readDocument.useQuery({ input: { path }, retry: false })
  const openExternally = conveyor.workspace.openDocument.useMutation()

  const fileName = path.split(/[\\/]/).pop() ?? path
  const base64 = typeof file.data?.base64 === 'string' ? file.data.base64 : null
  const conversion = useDocxHtml(base64)
  const [openFailed, setOpenFailed] = useState<DocumentFailure | null>(null)

  // Pruned once per converted document rather than per render: the pass parses a whole html string, and
  // a re-render for any other reason should not pay for it again.
  const html = useMemo(
    () => (conversion.status === 'html' ? sanitizeDocumentHtml(conversion.html) : null),
    [conversion]
  )

  const openFile = () => {
    setOpenFailed(null)
    void openExternally.mutateAsync({ path }).catch((error: unknown) => setOpenFailed(openFailure(error, fileName)))
  }

  return (
    <div data-slot="docx-viewer" className="flex h-full flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={path}>
          {fileName}
        </p>

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
      ) : openFailed !== null ? (
        <DocumentError {...openFailed} />
      ) : conversion.status === 'converting' ? (
        <p className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {`Converting ${fileName}…`}
        </p>
      ) : conversion.status === 'refused' ? (
        <DocumentError title={`${fileName} could not be shown`} detail={conversion.message} />
      ) : html === null ? (
        <p className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {`Opening ${fileName}…`}
        </p>
      ) : (
        /*
          One container, styled through Tailwind's own child selectors: the html inside it is a string
          this app did not write, so there is no component tree to give class names to, and a stylesheet
          of its own would be a second place the app's type scale lives.
        */
        <div
          data-slot="docx"
          className="min-h-0 flex-1 overflow-auto px-8 py-6 text-[13px] leading-relaxed [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-[14px] [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}
