/**
 * The viewer's dispatch rule: which kind of file a name says it is, and what a document's first bytes
 * say about themselves.
 *
 * Pure and shared rather than renderer-only, for the reason `image.ts` and `spreadsheet.ts` are: the
 * dispatch is a decision a test should be able to make by calling a function rather than by rendering a
 * surface and looking for the right toolbar, and main needs the same answer — `readDocument` decides
 * from this rule whether a path is one it may ship as base64 at all.
 *
 * The rule reads the *name*, because the extension is the only thing a surface can know about a path
 * before it has the bytes, and the surface has to choose before it reads: mounting a pdf component and
 * discovering on the first byte that this is a docx would be a component that renders an apology for
 * having been mounted. The image and workbook halves are delegated to their own files rather than
 * repeated here — a second list of image extensions would be a second place for the two answers to
 * disagree, which is the divergence `preview.ts` avoids the same way.
 *
 * `.doc` is deliberately its own kind rather than folded into `.docx`. The two are different
 * containers — one is a zip of xml parts and the other is a binary blob from the nineties — and the
 * viewer cannot render the second one at all. Keeping them apart is what lets the fallback branch on
 * the difference instead of recognising the legacy format by trying to parse it and failing.
 */

import { imageKindForPath } from './image'
import { spreadsheetKindForPath } from './spreadsheet'

/** What a name says the file is, as the dispatch answers it. */
export type PreviewKind = 'pdf' | 'docx' | 'doc' | 'image' | 'markdown' | 'spreadsheet' | 'other'

/**
 * The codes a document read can refuse under.
 *
 * Named and exported rather than written out at the throw site, because the renderer branches on the
 * string: a typo there would be a second, silently unreachable state rather than an error. Each is its
 * own code for the reason the image and workbook caps have their own — the limits are different numbers
 * and the sentences differ — and `PDF_BYTES_INVALID` is the odd one out: nothing is oversized or
 * missing, and the bytes are simply not the format the name promised.
 */
export const DOCUMENT_TOO_LARGE = 'DOCUMENT_TOO_LARGE'
export const DOCUMENT_UNSUPPORTED = 'DOCUMENT_UNSUPPORTED'
export const PDF_BYTES_INVALID = 'PDF_BYTES_INVALID'

/**
 * How large a document may be before the read refuses it.
 *
 * Sixteen megabytes, twice the workbook cap, because a pdf is a container of already-compressed streams
 * and is routinely a scanned document — megabytes of images with no lower-fidelity form to fall back to.
 * Unlike a text read there is nothing to trim: a partially-shipped pdf does not render, so the only
 * honest answers are the whole file or a refusal. Base64 adds a third again on the wire, which is what
 * keeps this a cap rather than an absence of one.
 */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

/**
 * The two extensions the chat and the viewer both render as markdown.
 *
 * Written out here as well as in `app/components/workbench/preview.ts` rather than imported from it:
 * the dependency runs the other way — the renderer imports from this directory — and a protocol file
 * that reached into `app/` would be the first one that could not be tested without a DOM. The pair is
 * two strings, and the two rules agree on them rather than on a shared constant.
 */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown'])

/** The extensions that name a document container, each as its own kind. */
const DOCUMENT_KINDS: Readonly<Record<string, PreviewKind>> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'doc',
}

/**
 * The extension of a name, folded, or `''` when it has none.
 *
 * Only the last dot of the *last segment* counts, so a path with no dot in its name has no extension —
 * a `Makefile` is not a document of some extension-less format — a dot that only leads the name is not
 * one either (`.gitignore`), and a directory called `reports.pdf` cannot make the files inside it
 * documents.
 */
function extensionOfName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both no dot at all and a leading one.
  if (dot <= 0) return ''

  return name.slice(dot + 1).toLowerCase()
}

/**
 * The kind of file a name names.
 *
 * Case-folded throughout, because `.PDF` is what a scanner writes and a case-sensitive table would
 * refuse it on the one platform whose disk is case-insensitive.
 *
 * The document lookup is guarded by `Object.hasOwn` rather than by the value being truthy: a record
 * literal inherits `Object.prototype`, so a file called `notes.constructor` would otherwise be answered
 * with a function, and a dispatch built on that would mount a surface for a name that means nothing.
 */
export function previewKind(fileName: string): PreviewKind {
  const extension = extensionOfName(fileName)
  if (extension === '') return 'other'

  if (Object.hasOwn(DOCUMENT_KINDS, extension)) return DOCUMENT_KINDS[extension]
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  // Asked of the two existing rules rather than repeated: a picture and a workbook are answered for the
  // same names here as they are there, by construction.
  if (imageKindForPath(fileName) !== null) return 'image'
  if (spreadsheetKindForPath(fileName) !== null) return 'spreadsheet'

  return 'other'
}

/** The four bytes every pdf starts with: `%PDF`. */
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]

/** The four bytes every zip container starts with, and therefore every modern docx. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/** Whether a buffer begins with a signature, byte for byte. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false

  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Whether a document's bytes are a pdf.
 *
 * A prefix, and nothing more forgiving than that: the format's own header is the first thing in the
 * file, so a name that promises a pdf and a buffer that does not begin with `%PDF` is a mislabelled
 * file. Saying so here is what keeps the refusal in this app's wording — the alternative is shipping
 * the bytes to pdf.js and rendering *its* complaint about a missing structure, which is a sentence
 * about a parser rather than an answer about the file.
 *
 * Nothing here reads the version or any structure past the header: this decides whether a file is a pdf
 * at all, never whether a particular pdf is one the renderer can draw.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, PDF_SIGNATURE)
}

/**
 * Whether a document's bytes are a zip container — that is, whether they could be a docx.
 *
 * The same kind of answer as `looksLikePdf`, for the same reason: mammoth reports a buffer that is not
 * a container in its own words, and a viewer that showed those words would be telling its reader about
 * a central directory. A docx that *is* a container and is still unreadable is a different failure, and
 * mammoth's own rejection is the only evidence for it.
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_SIGNATURE)
}

/**
 * Whether a document of this size is past the cap.
 *
 * Inclusive at the boundary, like every other cap in this app: a file of exactly `MAX_DOCUMENT_BYTES` is
 * read and only a byte more is refused. Stated as a function of one number so the off-by-one has a place
 * to fail — getting it wrong in either direction is invisible, because either a file that fits is
 * refused or one that does not is shipped.
 */
export function documentOverCap(bytes: number): boolean {
  return bytes > MAX_DOCUMENT_BYTES
}
