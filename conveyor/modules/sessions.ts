import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { app, dialog } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, query } from '../init'
import {
  transcriptSnapshotSchema,
  emptySnapshot,
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
} from '../protocol/transcript'
import {
  conversationText,
  searchTranscriptText,
  sessionSearchResultSchema,
  SEARCH_MAX_SNIPPETS,
  SEARCH_MIN_TERM,
} from '../protocol/search'
import { exportFileName, renderExport } from '../protocol/export'
import { recordedInstructions } from '../protocol/context'
import { exportTitle } from '../protocol/session-title'
import { IMAGE_ATTACH_NOT_FOUND } from '../protocol/image-attachments'
import { deleteSessionAttachments } from './image-attachments'

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

/**
 * How many transcript files one search may read.
 *
 * A scan is bounded by files rather than by matching: without a cap, one search over a long history
 * reads every conversation on disk, and the cost grows with the size of the user's history rather
 * than with the size of their query. The order is the directory's — a filename is an id, not a
 * timestamp — which is why the cap is generous enough for a realistic history and why the panel
 * presents the result as "matches found" rather than as an exhaustive list.
 */
export const SEARCH_MAX_FILES = 200

/** The most bytes one transcript may contribute to a scan. Beyond this it is skipped. */
export const SEARCH_MAX_FILE_BYTES = 512 * 1024

/**
 * Transcript files under `userData/sessions`, as ids.
 *
 * An unreadable directory is an empty history rather than an error: a search over nothing should
 * return nothing, not fail the panel it is attached to.
 */
async function listTranscriptFiles(): Promise<string[]> {
  let files: string[]
  try {
    files = await readdir(sessionsDir())
  } catch {
    return []
  }

  const ids: string[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    // Shape-checked, so a stray file that cannot be a session id is never read as one.
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * Read a transcript for a scan, refusing one large enough to matter.
 *
 * `loadTranscriptFile` reads whatever is there; a scan is different, because it may do this hundreds
 * of times in one call, and a single pathological file would then dominate the cost. The size is
 * checked with a `stat` before the read, so an oversized file is never in memory at all.
 *
 * An oversized or unreadable file is skipped by the caller rather than reported: one conversation the
 * search will not look inside is a far smaller problem than a search that fails or that stalls.
 */
async function loadBounded(id: string): Promise<TranscriptSnapshot | null> {
  const path = transcriptPath(id)

  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return null
  }
  if (size > SEARCH_MAX_FILE_BYTES) return null

  return loadTranscriptFile(id)
}

/**
 * Write an exported file.
 *
 * Deliberately not atomic, unlike a transcript save: the user chose this path in a dialog, so the
 * file is theirs, and a temp-then-rename would leave a stray sibling beside it if the process died in
 * between. A half-written export at a path the user picked is recoverable by exporting again, and
 * `writeFile` truncates rather than appends, so the retry is clean.
 */
async function writeExportFile(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, 'utf8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('SESSION_EXPORT_FAILED', `Could not write ${basename(path)}. ${reason}`)
  }
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

  /**
   * Remove one transcript, and the images its turns referenced. A session with no file is already in the
   * desired state.
   *
   * The attachments go with the conversation, and that is the whole retention rule: a reference in a turn
   * points at a folder named after the session, so the folder is meaningless the moment the session is.
   * A conversation that never had an image raises `IMAGE_ATTACH_NOT_FOUND` from the store, which is
   * swallowed here by *code* — nothing was stored, which is the ordinary case — while any other failure
   * is reported like the transcript's own, since the startup sweep exists precisely because a delete
   * that failed halfway leaves bytes nothing will reference again.
   */
  deleteTranscript: command(z.object({ id: idSchema }), async ({ input }) => {
    try {
      await rm(transcriptPath(input.id), { force: true })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new ConveyorError('SESSION_DELETE_FAILED', `Could not delete this conversation. ${reason}`)
    }

    try {
      await deleteSessionAttachments(app.getPath('userData'), input.id)
    } catch (err) {
      if (err instanceof ConveyorError && err.code === IMAGE_ATTACH_NOT_FOUND) return
      const reason = err instanceof Error ? err.message : String(err)
      throw new ConveyorError('SESSION_DELETE_FAILED', `Could not delete this conversation. ${reason}`)
    }
  }),

  /** An empty snapshot, so the renderer never constructs one from a literal. */
  emptyTranscript: query(() => emptySnapshot()),

  /** The snapshot version this build writes, for the renderer to stamp. */
  transcriptVersion: query(() => TRANSCRIPT_VERSION),

  /**
   * Scan saved conversations for a term, and report where it appears.
   *
   * A query rather than a command because it only reads — and because the panel wants it keyed per
   * term while the user types, which is what `useQuery` does and a mutation would not.
   *
   * The result is snippets and a count. A transcript body never crosses this boundary in either
   * direction: the panel needs to know where the words are, not what surrounds them, and it holds no
   * conversation it did not open itself.
   */
  searchSessions: query(
    z.object({
      // The floor is shared with the extractor rather than restated, so the term the UI scans with and
      // the term this accepts cannot disagree.
      term: z.string().min(SEARCH_MIN_TERM),
    }),
    async ({ input }) => {
      // Bounded before the loop, not inside it: the cap is on how much of the user's history one
      // keystroke may read, so it has to be applied to the file list rather than to what the scan
      // finds. Capping the *results* instead would let a term that matches nothing read every file on
      // disk — which is exactly the search that costs the most.
      const files = (await listTranscriptFiles()).slice(0, SEARCH_MAX_FILES)
      const results: Array<{ id: string; matchCount: number; snippets: string[] }> = []

      for (const id of files) {
        // A corrupt or oversized file is skipped rather than raised. Searching is a read-only
        // convenience over the user's own history, and one unreadable conversation in it must not
        // take the whole search down with it.
        let snapshot: TranscriptSnapshot | null
        try {
          snapshot = await loadBounded(id)
        } catch {
          continue
        }
        if (!snapshot) continue

        const found = searchTranscriptText(conversationText(snapshot), input.term, SEARCH_MAX_SNIPPETS)
        if (found.matchCount === 0) continue
        results.push({ id, matchCount: found.matchCount, snippets: found.snippets })
      }

      return sessionSearchResultSchema.array().parse(results)
    }
  ),

  /**
   * Write one conversation out as a file, and report where it landed.
   *
   * Main-only, necessarily: it reads the transcript, renders the bytes, opens the OS save dialog and
   * writes the file. The renderer sends an id, a format and the title its list is showing, and
   * receives a path — never a transcript, and never a byte of the file.
   *
   * `title` is optional and is the *stored* name, which only the renderer has: a renamed session's
   * name lives in the session store, and nothing in a transcript records it. Without it an export of
   * a renamed conversation would be named after the message that started it, disagreeing with the row
   * the user clicked. It is validated as a bounded optional string here, and sanitized for filesystem
   * use before it becomes a filename.
   *
   * A dismissed dialog returns null rather than throwing. Cancelling a save is an ordinary outcome,
   * and reporting it as an error would put a failure toast on a deliberate decision.
   *
   * The markdown export also names the project instructions the conversation was sent under, when its
   * turns recorded one. That is read back out of the transcript rather than sent by the renderer, for
   * the same reason the conversation is: the file is the record, and a copy on the wire would be a
   * second source of truth about what stood behind the answers.
   */
  exportSession: command(
    z.object({
      id: idSchema,
      format: z.enum(['markdown', 'json']),
      // Bounded rather than unbounded: this crosses the trust boundary and ends up in a filename.
      // A title longer than this is not a title, and the schema says so rather than the filesystem.
      title: z.string().max(200).optional(),
    }),
    async ({ input, ctx }) => {
      const snapshot = await loadTranscriptFile(input.id)
      if (!snapshot) {
        // Nothing has been saved for this session, so there is nothing to write. Its own code,
        // because the panel says something different for this than for a write failure.
        throw new ConveyorError('SESSION_NOT_FOUND', 'This conversation has no saved transcript yet.')
      }

      // The stored name when the renderer supplied one, otherwise the first-message rule.
      const title = exportTitle(input.title, snapshot)
      // Read back out of the turns it was recorded on, not passed down from the renderer: the
      // transcript is the record, and a second copy travelling over IPC could disagree with it.
      const instructions = recordedInstructions(snapshot.turns)
      const contents = renderExport(snapshot, {
        title,
        format: input.format,
        instructionsFile: instructions?.file ?? null,
        instructionsTruncated: instructions?.truncated ?? false,
      })
      const defaultPath = exportFileName(title, input.format)

      // The calling window parents the dialog when there is one, so the sheet is attached to the
      // window that asked rather than to the app.
      const win = ctx.window
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath, title: 'Export conversation' })
        : await dialog.showSaveDialog({ defaultPath, title: 'Export conversation' })

      if (result.canceled || !result.filePath) return null

      await writeExportFile(result.filePath, contents)
      return result.filePath
    }
  ),
})
