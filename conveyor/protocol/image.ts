/**
 * The read path's kind decision: is this file an image, and which media type is it?
 *
 * Pure and shared rather than main-only, for the same reason `write-guard.ts` is: main owns the byte
 * read, but the *rule* — a name in, a media type or nothing out — is a decision a test should be able
 * to make without a disk. `conveyor/modules/workspace.ts` imports it; the renderer imports nothing from
 * here, because what it needs to know travels in the read's own result rather than in a second lookup.
 *
 * Why the decision is made from the name at all: the extension is the only thing a viewer can know
 * before it has read a byte, and reading a file to discover it is not an image means the cap has to be
 * enforced on something already in memory. So the kind is settled first, and only then is a size asked
 * for — which is also what lets an image have a cap of its own without moving the text cap at all.
 */

/**
 * The code an oversized image read is refused under.
 *
 * Its own code rather than `FILE_TOO_LARGE`, because the two limits are different numbers and the
 * renderer words them differently: a text file over 1 MB is a preview the viewer declines, while an
 * image over 2 MB is one it cannot show. The renderer branches on this string, so it is exported and
 * named rather than written out at the throw site.
 */
export const IMAGE_TOO_LARGE = 'IMAGE_TOO_LARGE'

/**
 * How large an image may be before the viewer refuses it.
 *
 * Twice the text cap, and deliberately not the same number: a text read is shipped as a string the
 * pane then tokenizes, so the cap bounds two costs at once, while an image is shipped as a data URL
 * the pane hands straight to an `img` — and base64 adds a third again to the bytes on the wire. 2 MB
 * of file is therefore about 2.7 MB over IPC, which is the point past which a preview stops being
 * worth the round trip.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * The media types the viewer will render, by extension.
 *
 * `.svg` is in this list and is the one entry worth explaining: an svg is a *document*, and a document
 * can carry script. It is here because it is also the only vector format a workspace is likely to hold,
 * and it is safe exactly as long as it is never parsed as markup — which is a property of how the
 * renderer draws it (an `img` source) and of what main sends (base64, never a string of markup), not of
 * this map. Nothing here decides how the bytes are rendered, so nothing here can make that unsafe.
 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/**
 * The media type for a path, or `null` when it does not name an image.
 *
 * Only the last dot of the *last segment* is consulted. A path with no dot in its name has no
 * extension — a `Makefile` is not an image of some extension-less format — and a dot that only leads
 * the name is not one either, so `.gitignore` is not a gitignore-format image. The directory above is
 * never looked at, so a folder called `pics.png` cannot make the text files inside it render as
 * pictures.
 *
 * Lower-cased before the lookup: `.PNG` is what a camera writes, and a case-sensitive table would
 * refuse it on the one platform where the disk itself is case-insensitive.
 */
export function imageKindForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both no dot at all and a leading one.
  if (dot <= 0) return null

  const extension = name.slice(dot + 1).toLowerCase()
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null
}

/**
 * Whether an image of this size is past the cap.
 *
 * Inclusive at the boundary: a file of exactly `MAX_IMAGE_BYTES` is readable, and only a byte more is
 * refused. Stated as a function of one number rather than inline at the call site so the off-by-one has
 * somewhere to be tested, because getting it wrong in either direction is invisible — either a file
 * that fits is refused or one that does not is shipped.
 */
export function imageOverCap(bytes: number): boolean {
  return bytes > MAX_IMAGE_BYTES
}
