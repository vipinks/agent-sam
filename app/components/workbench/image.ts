/**
 * The image half of a read result, as the viewer narrows it.
 *
 * Main decides the kind from the file's name and answers with either text or a data URL
 * (`conveyor/protocol/image.ts`); what is left here is the renderer's side of that decision, kept out of
 * the component for the same reason `editing.ts` and `gutter.ts` are: it is a shape and a wording that a
 * test should be able to exercise by calling a function rather than by rendering a pane.
 *
 * Nothing in this file draws anything, and nothing in it decides whether the bytes are safe. What
 * arrives is a data URL — an encoded picture, never markup — and the one component that uses this (an
 * `img` source) is what makes the svg case safe. That is a property of the render, not of the shape, so
 * it is asserted where it can actually fail: in the pane's DOM test.
 */

/** One image read: the fields main sends instead of `content`. */
export interface ImageRead {
  kind: 'image'
  mime: string
  dataUrl: string
  /** The file's size in bytes, as the disk reported it. */
  bytes: number
  /** The mtime of the bytes, as every read reports it. */
  baselineMtime?: number
}

/**
 * The image a read result carries, as a type predicate so a caller can narrow with it.
 *
 * Takes `unknown` rather than the query's own result type, so the component does not have to tell the
 * compiler which half it holds before this function has looked. The checks are the narrowing: a result
 * that says it is an image but has no data URL to show is treated as text rather than rendered as an
 * `img` with an undefined source, which would be a broken picture claiming to be a file. Every field the
 * pane reads is checked, so the claim is honest about what a caller may then use; fields main sends that
 * the pane never looks at are not named here, and so are not claimed.
 *
 * Branched on `kind` and never on the presence of `content`, so a text result of an empty file — no
 * characters at all — is still a text result.
 */
export function imageOf(data: unknown): data is ImageRead {
  if (data === null || typeof data !== 'object') return false

  const candidate = data as { kind?: unknown; mime?: unknown; dataUrl?: unknown; bytes?: unknown }
  if (candidate.kind !== 'image') return false
  if (typeof candidate.mime !== 'string' || typeof candidate.dataUrl !== 'string') return false

  return typeof candidate.bytes === 'number'
}

/**
 * Bytes as a reader counts them, for the caption under an image.
 *
 * The renderer's own wording, like every other sentence this pane shows: main reports a number, and how
 * it is said is the UI's business — a server that decided on "2.0 KB" would be wording a caption it
 * cannot see. It is also the caption's *only* number, so there is no second place for a disagreement
 * about the file's size to appear.
 *
 * One decimal above a kilobyte, and none below it: a byte count is exact up to 1023 and does not need
 * the noise after it.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
