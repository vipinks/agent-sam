import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, query } from '../init'
import {
  transcriptSnapshotSchema,
  emptySnapshot,
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
} from '../protocol/transcript'

/**
 * Transcript storage — one JSON file per session, under `userData/sessions`.
 *
 * Main-only, because it touches the disk. The renderer asks for a transcript by id and gets a
 * snapshot back; it never sees a path.
 *
 * Transcripts live here rather than in the chat-sessions store because that store broadcasts to
 * every window on change — a transcript there would push the whole conversation over IPC once per
 * token while a model streams. Written at turn boundaries instead, this is a handful of writes per
 * conversation rather than hundreds per second.
 */

/** Path segments under `userData`. Never a hardcoded absolute path. */
const SESSION_DIR = ['sessions']

/**
 * The id check is duplicated from the store on purpose: the store validates what the renderer sends,
 * but this module is what turns an id into a filename, and a filename is the thing that must not be
 * able to escape its directory. Both checks are cheap; only one of them is load-bearing here.
 */
const idSchema = z
  .string()
  .min(1)
  .regex(/^[0-9a-fA-F-]{36}$/, 'A session id must be a UUID.')

function sessionsDir(): string {
  return join(app.getPath('userData'), ...SESSION_DIR)
}

/** Resolve an id to a file path. The id is already validated by the caller's schema. */
function transcriptPath(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

/**
 * Write a transcript atomically: a temp file in the same directory, then a rename over the target.
 *
 * The rename is what makes it atomic — a reader either sees the old file or the new one, never a
 * half-written one. It is also why the temp file is a sibling rather than in the OS temp directory:
 * a rename across filesystems is a copy, which is not atomic.
 */
export async function saveTranscriptFile(id: string, snapshot: TranscriptSnapshot): Promise<void> {
  const dir = sessionsDir()
  await mkdir(dir, { recursive: true })

  const target = transcriptPath(id)
  // The temp name carries the pid, so two windows saving the same session cannot collide on it.
  const temp = `${target}.${process.pid}.tmp`

  try {
    await writeFile(temp, JSON.stringify(snapshot), 'utf8')
    await rename(temp, target)
  } catch (err) {
    // A failed write must not leave its temp file behind to be mistaken for a session later.
    await unlink(temp).catch(() => undefined)
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('SESSION_WRITE_FAILED', `Could not save this conversation. ${reason}`)
  }
}

/** Read a transcript, or null when the session has never been saved. */
export async function loadTranscriptFile(id: string): Promise<TranscriptSnapshot | null> {
  let raw: string
  try {
    raw = await readFile(transcriptPath(id), 'utf8')
  } catch {
    // Absent is an ordinary outcome — a session created but not yet used has no file.
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConveyorError('SESSION_CORRUPT', 'This conversation is unreadable and was left untouched.')
  }

  const result = transcriptSnapshotSchema.safeParse(parsed)
  if (!result.success) {
    // Valid JSON but not a transcript — a hand-edited or truncated file. Reported with its own code
    // so the row can say so rather than silently showing an empty conversation.
    throw new ConveyorError('SESSION_CORRUPT', 'This conversation is unreadable and was left untouched.')
  }
  return result.data
}

/**
 * Which transcript files have no session metadata behind them.
 *
 * Pure, and separate from the deleting below, so the rule can be tested without a filesystem: it
 * takes the filenames found on disk and the ids the store still knows about, and answers which files
 * are orphaned.
 *
 * This exists because deleting a session removes its metadata first and its file second. If the file
 * delete then fails — a lock, a permission, a crash between the two steps — the metadata is gone and
 * nothing will ever reference the file again. Without a sweep those bytes are stranded forever.
 *
 * Only `<uuid>.json` is considered. A temp file from an interrupted atomic write is *not* an orphan
 * to be reasoned about here: it was never a session, so treating it as one would risk deleting a file
 * that a concurrent save is about to rename into place.
 */
export function orphanedTranscriptFiles(files: string[], liveSessionIds: string[]): string[] {
  const live = new Set(liveSessionIds)
  const orphans: string[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    // Shape-checked as well as membership-checked: a stray name that cannot be a session id is not
    // ours to delete, whatever the store says.
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue
    if (!live.has(id)) orphans.push(id)
  }

  return orphans
}

/**
 * Delete transcript files whose session metadata is gone, and report how many were removed.
 *
 * Called once on startup. A directory that does not exist yet is not an error — it just means no
 * conversation has ever been saved.
 *
 * Each file is removed independently and failures are not fatal: a sweep that cannot delete one file
 * must not stop the app from starting, or leave the remaining orphans behind. The count returned is
 * therefore of files actually deleted, not of orphans found.
 */
export async function sweepOrphanedTranscripts(liveSessionIds: string[]): Promise<number> {
  const dir = sessionsDir()

  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    // No directory yet, or it cannot be read. Either way there is nothing this can safely do, and
    // startup must not fail over housekeeping.
    return 0
  }

  const orphans = orphanedTranscriptFiles(files, liveSessionIds)
  let deleted = 0

  for (const id of orphans) {
    try {
      await rm(transcriptPath(id), { force: true })
      deleted++
    } catch {
      // Left for the next startup rather than raised: one undeletable file must not block the rest.
    }
  }

  return deleted
}

export const sessionsModule = defineModule({
  /** Persist one transcript. Called at turn boundaries, not per token. */
  saveTranscript: command(z.object({ id: idSchema, snapshot: transcriptSnapshotSchema }), async ({ input }) => {
    await saveTranscriptFile(input.id, input.snapshot)
  }),

  /**
   * Read one transcript. Null means "never saved"; a file that exists but will not parse raises
   * SESSION_CORRUPT instead, so the two cases stay distinguishable.
   */
  loadTranscript: query(z.object({ id: idSchema }), async ({ input }) => {
    return loadTranscriptFile(input.id)
  }),

  /** Remove one transcript. A session with no file is already in the desired state. */
  deleteTranscript: command(z.object({ id: idSchema }), async ({ input }) => {
    try {
      await rm(transcriptPath(input.id), { force: true })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new ConveyorError('SESSION_DELETE_FAILED', `Could not delete this conversation. ${reason}`)
    }
  }),

  /** An empty snapshot, so the renderer never constructs one from a literal. */
  emptyTranscript: query(() => emptySnapshot()),

  /** The snapshot version this build writes, for the renderer to stamp. */
  transcriptVersion: query(() => TRANSCRIPT_VERSION),
})
