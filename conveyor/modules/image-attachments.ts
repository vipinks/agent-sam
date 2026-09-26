import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command } from '../init'
import {
  IMAGE_ATTACH_NOT_FOUND,
  IMAGE_ATTACH_REFUSED,
  acceptedAttachmentMime,
  attachmentExtensionFor,
  attachmentRefusal,
  imageAttachmentRefSchema,
  type AttachmentRefusal,
  type ImageAttachmentRef,
} from '../protocol/image-attachments'

/**
 * The attachment store: the bytes behind a composer image, one folder per session, under
 * `userData/attachments`.
 *
 * Main-only, because it touches the disk. The renderer sends bytes and a media type and gets a
 * reference back; it never sees a path, and a reference is the only thing a transcript carries.
 *
 * Why a folder rather than columns in the transcript: a base64 image inline in a turn would multiply
 * the size of the one file the app rewrites at every turn boundary, and the bytes are not part of the
 * conversation — they are what the conversation pointed at. A folder per session also makes the
 * retention rule trivial: a conversation's images leave when the conversation does, because they are
 * inside the thing that is being removed.
 *
 * The root is a parameter on every function here rather than a call to `app.getPath` inside each one.
 * That is what lets a suite drive the whole file against a temp directory, including the deleting and
 * the sweeping, which are the halves that are worth testing and the halves a wrong path would ruin.
 * `app.getPath` appears exactly twice, in the two places that are the app's own entry points: the
 * module below, and the startup sweep `router.ts` calls.
 */

/** Path segments under `userData`. Never a hardcoded absolute path. */
const ATTACHMENT_DIR = ['attachments']

/**
 * The shape a folder or file name here is allowed to have.
 *
 * Checked in the store as well as at the wire, and deliberately duplicated: the schema below validates
 * what the renderer sends, but *these* are the values that become path segments, and a segment is the
 * thing that must not be able to escape its directory. Both checks are cheap; only this one is
 * load-bearing. Excludes separators, dots, and traversal segments by construction.
 */
const segmentSchema = z
  .string()
  .min(1)
  .regex(/^[0-9a-fA-F-]{36}$/, 'An attachment id must be a UUID.')

/**
 * The id check as a refusal rather than as a thrown schema error.
 *
 * One code for every path violation, the same code a refused type or a refused size carries: the
 * caller's next move does not depend on which of the three it was, and a caller that had to tell them
 * apart would be a caller remembering a fact nobody acts on.
 */
function assertSegment(value: string, what: string): void {
  if (segmentSchema.safeParse(value).success) return
  throw new ConveyorError(IMAGE_ATTACH_REFUSED, `This ${what} is not one this app can store an image under.`)
}

/** Where every session's attachments live: `userData/attachments`. */
function attachmentsRoot(userData: string): string {
  return join(userData, ...ATTACHMENT_DIR)
}

/** One session's folder. The caller has already checked the id's shape. */
function sessionDir(userData: string, sessionId: string): string {
  return join(attachmentsRoot(userData), sessionId)
}

/**
 * Throw the refusal a decision returned, or return normally when it returned none.
 *
 * The refusal is a value and the throwing happens here, because the rule lives in a file the renderer
 * also imports and a `ConveyorError` cannot be raised from there.
 */
function refuse(refusal: AttachmentRefusal | null): void {
  if (refusal) throw new ConveyorError(refusal.code, refusal.message)
}

/** What the composer hands over for one pasted image. */
export interface SaveAttachmentInput {
  sessionId: string
  name: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Store one image and return the reference a transcript and a send both carry.
 *
 * The refusal comes first and the directory is made last, so a refused image leaves nothing behind — no
 * folder, no file — which is the property that makes a refusal safe to report rather than something to
 * clean up after. The media type is checked before the size for no better reason than that a type
 * nothing can send is the more useful sentence.
 *
 * The name on disk is the generated id and the extension the *media type* implies. The user's own file
 * name travels in the reference for display only: it is never a path, so a name with a separator in it
 * cannot become one.
 */
export async function saveAttachment(userData: string, input: SaveAttachmentInput): Promise<ImageAttachmentRef> {
  assertSegment(input.sessionId, 'session id')

  refuse(attachmentRefusal({ mimeType: input.mimeType, bytes: input.bytes.byteLength }))

  // The refusal above has already answered the whitelist, so this cannot be null.
  const mimeType = acceptedAttachmentMime(input.mimeType)
  if (!mimeType) throw new ConveyorError(IMAGE_ATTACH_REFUSED, 'Only PNG, JPEG, WebP, and GIF images can be attached.')

  const id = randomUUID()
  const dir = sessionDir(userData, input.sessionId)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${id}.${attachmentExtensionFor(mimeType)}`), input.bytes)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('IMAGE_ATTACH_REFUSED', `Could not store this image. ${reason}`)
  }

  return imageAttachmentRefSchema.parse({
    id,
    name: input.name,
    mimeType,
    size: input.bytes.byteLength,
  })
}

/**
 * The bytes of one stored image, for the send path that has to turn a reference back into a data URL.
 *
 * Exported for the send path and for the tests, but deliberately not a conveyor query: the renderer has
 * no business holding an image it did not just paste, and bytes crossing back would be a second source
 * of truth about what a reference points at.
 *
 * The id's shape is checked before the file is addressed, for the same reason `sessions.ts` checks its
 * own: a crafted id would otherwise be interpolated into a path. A missing file is its own code
 * (`IMAGE_ATTACH_NOT_FOUND`) rather than a refusal, because the two are different facts — one is a name
 * this app will not build a path from, the other is an image that was there and is not any more.
 */
export async function readAttachmentBytes(userData: string, sessionId: string, id: string): Promise<Uint8Array> {
  assertSegment(sessionId, 'session id')
  assertSegment(id, 'image id')

  const dir = sessionDir(userData, sessionId)

  // The extension is stored nowhere but the name on disk, so the directory is what says which file an id
  // names. A session holds a handful of images; one listing is cheaper than a third copy of the type map
  // kept in step with the whitelist.
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    throw new ConveyorError(IMAGE_ATTACH_NOT_FOUND, 'This image is no longer stored.')
  }

  const name = names.find((candidate) => candidate.startsWith(`${id}.`))
  if (!name) throw new ConveyorError(IMAGE_ATTACH_NOT_FOUND, 'This image is no longer stored.')

  try {
    return await readFile(join(dir, name))
  } catch {
    throw new ConveyorError(IMAGE_ATTACH_NOT_FOUND, 'This image is no longer stored.')
  }
}

/**
 * Remove one session's attachments, for the conversation that is being deleted.
 *
 * A session with no attachments raises `IMAGE_ATTACH_NOT_FOUND` rather than succeeding quietly. The
 * caller that matters is the session-delete path, and it swallows exactly that code: "this conversation
 * never had an image" is the ordinary case rather than a failure of the delete, while every other
 * failure is one worth saying out loud. Stated as a code rather than as a boolean so a caller cannot
 * confuse the two by accident.
 *
 * Recursive, because the folder is the unit: nothing inside it is referenced by anything other than the
 * session it belongs to. The listing before the removal is what separates "nothing was stored" from
 * "the removal failed", since `rm` with `force` answers neither.
 */
export async function deleteSessionAttachments(userData: string, sessionId: string): Promise<void> {
  assertSegment(sessionId, 'session id')

  const dir = sessionDir(userData, sessionId)

  try {
    await readdir(dir)
  } catch {
    throw new ConveyorError(IMAGE_ATTACH_NOT_FOUND, 'This conversation has no stored images.')
  }

  try {
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('IMAGE_ATTACH_REFUSED', `Could not delete this conversation's images. ${reason}`)
  }
}

/**
 * Which attachment folders have no session behind them.
 *
 * Pure, and the mirror of `orphanedTranscriptFiles`, for the reason that one is pure: the rule takes
 * names in and answers names out, so it can be tested without a filesystem, and only the removing needs
 * one.
 *
 * It exists for the same failure too. Deleting a conversation removes its store metadata first and its
 * bytes second, and the attachment folder is removed by a *separate* step from the transcript file — so
 * a crash, a lock, or a failed removal between any two of those leaves a folder nothing will ever
 * reference again. Without a sweep those bytes are stranded for the life of the install.
 *
 * Only uuid-shaped names are considered, and the shape check is what protects a live folder: a name that
 * cannot be a session id is not one this app wrote, so it is not this sweep's to delete, whatever the
 * store happens to say.
 */
export function orphanedAttachmentDirs(names: string[], liveSessionIds: string[]): string[] {
  const live = new Set(liveSessionIds)

  return names.filter((name) => segmentSchema.safeParse(name).success && !live.has(name))
}

/**
 * Remove attachment folders whose session is gone, and report how many were removed.
 *
 * Called once on startup. A directory that does not exist yet is not an error — it means no image has
 * ever been attached. Each folder is removed independently and a failure is not fatal: a sweep that
 * cannot remove one folder must not stop the app from starting, or leave the remaining orphans behind.
 * The count returned is therefore of folders actually removed, not of orphans found.
 */
export async function sweepOrphanedAttachments(userData: string, liveSessionIds: string[]): Promise<number> {
  const dir = attachmentsRoot(userData)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No directory yet, or it cannot be read. Either way there is nothing this can safely do, and
    // startup must not fail over housekeeping.
    return 0
  }

  let removed = 0
  for (const name of orphanedAttachmentDirs(names, liveSessionIds)) {
    try {
      await rm(join(dir, name), { recursive: true, force: true })
      removed++
    } catch {
      // Left for the next startup rather than raised: one undeletable folder must not block the rest.
    }
  }

  return removed
}

/**
 * The startup sweep, against the root the running app actually uses.
 *
 * One of the two places `app.getPath` is read; the other is the module below. Kept as its own function
 * rather than a call at the top of this file so the sweep's *ordering* stays where it belongs — in
 * `router.ts`, beside the transcript sweep and after the store has restored, which is the only moment
 * the live ids are known.
 */
export function sweepAttachmentFolders(liveSessionIds: string[]): Promise<number> {
  return sweepOrphanedAttachments(app.getPath('userData'), liveSessionIds)
}

/** What the renderer may ask the store for. */
export const imageAttachmentsModule = defineModule({
  /**
   * Store one pasted image and hand back the reference the turn will carry.
   *
   * The bytes cross this boundary as a `Uint8Array` — an `ArrayBuffer`'s view, which survives the
   * structured clone an IPC call is — because the alternative, a base64 string, would be a third larger
   * on the wire and would have to be decoded here anyway.
   */
  save: command(
    z.object({
      sessionId: segmentSchema,
      name: z.string().min(1),
      mimeType: z.string().min(1),
      bytes: z.instanceof(Uint8Array),
    }),
    async ({ input }) => {
      return saveAttachment(app.getPath('userData'), input)
    }
  ),

  /**
   * Drop one conversation's images.
   *
   * The session-delete path already does this as part of deleting the conversation; this is the same
   * operation on its own, for a caller that needs the images gone while the conversation stays.
   */
  deleteSession: command(z.object({ sessionId: segmentSchema }), async ({ input }) => {
    await deleteSessionAttachments(app.getPath('userData'), input.sessionId)
  }),
})
