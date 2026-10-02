import { TriangleAlert } from 'lucide-react'
import { ConveyorError } from 'electron-conveyor/react'
import { DOCUMENT_TOO_LARGE, DOCUMENT_UNSUPPORTED, PDF_BYTES_INVALID } from '@/conveyor/protocol/preview-kind'

/**
 * What a document viewer says when it cannot show the document.
 *
 * The two document surfaces reach the same failures through the same action, so they word them here,
 * once, for the reason `FileError` is shared between the preview panel and the code pane: two sentences
 * for one refusal would be two answers to one question.
 *
 * Every branch is on a ConveyorError *code*, never on a message string. The messages are main's to
 * write and exist for a log rather than for this pane; the codes are the part of the answer the
 * renderer is entitled to depend on.
 *
 * The two failures that are not the read's — the parser refusing bytes it cannot draw, and the shell
 * refusing to hand the file to another application — carry their detail from wherever the sentence was
 * actually written, so nothing here has to invent a reason.
 */

/** A failure, as the pane draws it: a title naming the file, and one sentence of detail. */
export interface DocumentFailure {
  title: string
  detail: string
}

/**
 * A read that failed, in words.
 *
 * `DOCUMENT_TOO_LARGE` is the one of these that is about the *reader* rather than the file, and it says
 * so with the number: a cap is a promise this app made and a reader is entitled to know where it is.
 * `PDF_BYTES_INVALID` is the opposite case — the file is fine and the name is wrong.
 */
export function documentReadFailure(error: unknown, name: string): DocumentFailure {
  const code = error instanceof ConveyorError ? error.code : null

  if (code === DOCUMENT_TOO_LARGE) {
    return {
      title: `${name} is too large to open`,
      detail: 'The viewer caps documents at 16 MB so a large read never blocks the window.',
    }
  }

  if (code === PDF_BYTES_INVALID) {
    return {
      title: `${name} is not a pdf`,
      detail: 'Its name says pdf, but the file does not begin with a pdf header.',
    }
  }

  if (code === DOCUMENT_UNSUPPORTED) {
    return {
      title: `${name} is not a document this viewer can render`,
      detail: 'It can be opened in the application that owns the format.',
    }
  }

  return {
    title: `${name} could not be opened`,
    detail: 'It may have been moved, renamed or deleted since the explorer listed it.',
  }
}

/**
 * A document the parser could not draw, or a file the shell would not open.
 *
 * Separate from the read's failures because they are about the attempt rather than about the file: the
 * bytes arrived and were not a document this reader can render, or the path is right and the OS has no
 * handler for it. Both carry a detail the caller already has wording for.
 */
export function shownFailure(name: string, detail: string): DocumentFailure {
  return { title: `${name} could not be shown`, detail }
}

/** A refusal from the open action — the shell's own sentence, kept rather than paraphrased. */
export function openFailure(error: unknown, name: string): DocumentFailure {
  return {
    title: `${name} could not be handed to the system`,
    detail: error instanceof ConveyorError ? error.message : 'The default application could not be launched.',
  }
}

/** The drawn failure: one icon, the title, and the sentence under it. */
export function DocumentError({ title, detail }: DocumentFailure) {
  return (
    <div data-slot="document-error" className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/50" />
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}
