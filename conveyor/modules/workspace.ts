import { basename, dirname, join, resolve } from 'path'
import { mkdir, readFile as readFileFromDisk, readdir, stat, writeFile as writeFileToDisk } from 'fs/promises'
import { dialog } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, command, event } from '../init'
import { resolveWorkspacePath } from './workspace-paths'
import { notifyWorkspaceChanged, workspaceChangedSchema } from '../events'
import { decideWrite, WRITE_CONFLICT } from '../protocol/write-guard'
import { WORKSPACE_MISSING } from '../protocol/recent-roots'
import { IMAGE_TOO_LARGE, imageKindForPath, imageOverCap } from '../protocol/image'
import { SPREADSHEET_TOO_LARGE, spreadsheetKindForPath, spreadsheetOverCap } from '../protocol/spreadsheet'
import type { SpreadsheetEdit } from '../protocol/spreadsheet-edit'
import { parseSpreadsheet } from './spreadsheet-parse'
import { applySpreadsheetEdits } from './spreadsheet-write'

/**
 * Local workspace access — the only place in the app that touches the file system. The renderer
 * never sees `fs`: it calls these primitives through the inferred `conveyor` client, and every
 * path crossing that boundary is validated by the zod schema below before it reaches the disk.
 */

/** Directories that are never worth browsing and always costly to walk. */
const HIDDEN_ENTRIES = new Set(['node_modules', '.git', 'dist'])

/** Reads larger than this are refused rather than shipped over IPC — see `readFile`. */
export const MAX_FILE_BYTES = 1024 * 1024

/**
 * Write a UTF-8 file, creating parent directories as needed, and report it.
 *
 * This is the one place a workspace file is written, and the agent's `write_file` tool calls it
 * rather than reaching for `fs` itself. That is what makes the change notification complete: a
 * second write path would be a second place to remember to announce, and the agent's writes are
 * exactly the ones the renderer used to miss.
 *
 * `options.baselineMtime` is the optional guard against a silent overwrite. When it is present, the
 * target is `stat`ed *immediately* before the write and a differing mtime refuses the write with
 * `WRITE_CONFLICT` rather than replacing content that changed since it was read. When it is absent the
 * write is unguarded and behaves exactly as it did before the guard existed — which is the case for
 * every caller that was not given a baseline to compare against. The agent's `write_file` tool and the
 * terminal both pass nothing here: an agent writes content it was handed rather than content it read,
 * so it has no baseline, and inventing one would make those flows refuse writes for no reason.
 *
 * `options.force` is the user's deliberate override after a conflict has been shown to them. It is not
 * a default and must never be inferred from a failure: it is set by a separate action, because
 * "overwrite what someone else changed" is a decision that belongs to the person making it.
 */
export async function writeWorkspaceFile(
  rootPath: string,
  requested: string,
  content: string,
  options: { baselineMtime?: number | null; force?: boolean } = {}
): Promise<{ path: string; mtimeMs: number | null }> {
  const target = resolveWorkspacePath(rootPath, requested)

  // Before anything is created or written, so a refused write touches the disk not at all.
  await guardAgainstStaleWrite(target, requested, options)

  try {
    // Recursive mkdir is idempotent, so this is also the common path where the directory exists.
    await mkdir(dirname(target), { recursive: true })
    await writeFileToDisk(target, content, 'utf8')
  } catch (err) {
    // A refused write is more useful to the agent than a raw errno, but it must not be worded as a
    // traversal failure — the containment check above is the only source of that code.
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('WRITE_FAILED', `Could not write ${requested}. ${reason}`)
  }

  notifyWorkspaceChanged({ kind: 'written', path: target })

  // The mtime this write left behind, so a caller guarding its *next* save has a baseline to send
  // without a separate read. A stat that fails here is not worth failing the write over — the bytes
  // are on disk, and a caller with no mtime simply writes unguarded next time.
  let mtimeMs: number | null = null
  try {
    mtimeMs = (await stat(target)).mtimeMs
  } catch {
    mtimeMs = null
  }

  return { path: target, mtimeMs }
}

/**
 * The stale-baseline guard both write paths run, in the one place it is written down.
 *
 * It is a function rather than a block because the two paths that need it need exactly the same thing —
 * text and a workbook differ in what gets written, not in when it may be — and a second copy of a
 * concurrency rule is a second place for it to drift.
 *
 * The `stat` is deliberately not cached or taken earlier: the whole point is to ask the disk at the last
 * possible moment, because the window between reading and writing is exactly where the other writer
 * gets in. A file that has been deleted reads as absent rather than unchanged, which `decideWrite`
 * treats as the disk having moved as far as it can. `force` is the user's deliberate override after a
 * conflict has been shown to them, never an inference from one.
 *
 * `requested` is the name to report the refusal under, which is the caller's spelling of the file rather
 * than the resolved path: the message is read by a person looking at a pane, and an absolute path they
 * never typed is not what they would recognise.
 */
async function guardAgainstStaleWrite(
  target: string,
  requested: string,
  options: { baselineMtime?: number | null; force?: boolean }
): Promise<void> {
  const baseline = options.baselineMtime ?? null
  // Nothing was read, so there is nothing to conflict with: the unguarded path, unchanged.
  if (baseline === null) return

  let diskMtime: number | null = null
  try {
    diskMtime = (await stat(target)).mtimeMs
  } catch {
    // Absent, which `decideWrite` treats as the disk having moved rather than as unchanged.
    diskMtime = null
  }

  if (decideWrite({ baselineMtime: baseline, diskMtime, force: options.force === true }) === WRITE_CONFLICT) {
    throw new ConveyorError(
      WRITE_CONFLICT,
      `${requested} changed on disk since it was read, so it was not overwritten.`
    )
  }
}

/**
 * Write a workbook with a value-only edit list applied to what is on disk now.
 *
 * Stateless, and that is the design rather than an accident of how it was written: it re-reads the bytes
 * every time, parses them, applies the list and writes the result, so there is no earlier version of the
 * file held anywhere to go stale. The edit list describes a grid that was drawn from a read at some
 * earlier moment, and the only version worth changing is the one the disk has now.
 *
 * The order is the read's, the parse's, then the guard, then the write. The guard cannot run earlier — it
 * exists to close the window between reading and writing, and the parse and the serialization sit inside
 * that window — and it must not run later, because a check after the bytes are written is a report rather
 * than a guard. A refused save therefore leaves the file exactly as it was: nothing truncated, no event
 * raised, and the existing `WRITE_CONFLICT` the pane already knows how to word.
 *
 * The path is the one the read returned and is treated the way `readFile` treats it: an absolute path a
 * pane is looking at, not a path an agent composed. Containment is a rule about the paths the agent can
 * name — which is why `writeWorkspaceFile` resolves its target under a root and this does not pretend to.
 *
 * The return carries the mtime to guard the *next* save with, exactly as the text write's does, plus the
 * count of formulas the edits replaced. That count is the one fact about this save that the file can no
 * longer tell anyone afterwards, so the caller is told rather than left to infer it.
 */
export async function writeSpreadsheetFile(
  path: string,
  edits: readonly SpreadsheetEdit[],
  options: { baselineMtime?: number | null; force?: boolean } = {}
): Promise<{ path: string; mtimeMs: number | null; replacedFormulas: number }> {
  const requested = basename(path)

  let bytes: Buffer
  try {
    bytes = await readFileFromDisk(path)
  } catch {
    // A workbook that is gone cannot be edited, and FILE_UNAVAILABLE is what the pane already words for
    // a read that could not happen either.
    throw new ConveyorError('FILE_UNAVAILABLE', 'This workbook could not be read.')
  }

  const applied = await applySpreadsheetEdits(bytes, edits)

  await guardAgainstStaleWrite(path, requested, options)

  try {
    // Bytes rather than a string, which is the one way this write differs from the text one: it is
    // already serialized, and re-encoding it as utf8 would corrupt it.
    await writeFileToDisk(path, applied.bytes)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('WRITE_FAILED', `Could not write ${requested}. ${reason}`)
  }

  notifyWorkspaceChanged({ kind: 'written', path })

  // The mtime this write left behind, so a caller guarding its next save has a baseline without a
  // separate read. A stat that fails here is not worth failing the write over: the bytes are on disk,
  // and a caller with no mtime simply writes unguarded next time.
  let mtimeMs: number | null = null
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    mtimeMs = null
  }

  return { path, mtimeMs, replacedFormulas: applied.replacedFormulas }
}

/** One child of a listed directory. */
const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
})

/**
 * One cell edit, as it crosses the boundary.
 *
 * Validated for shape and sign only: an integer index at or above zero. The upper bound is deliberately
 * not here — it is the grid's cap, and it belongs where the grid is, in `spreadsheet-write.ts`, against
 * the same constants the read shaped that grid with. Writing it twice would be two places to change it
 * and one to forget.
 */
const spreadsheetEditSchema = z.object({
  sheet: z.number().int().min(0),
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  value: z.string(),
})

export const workspaceModule = defineModule({
  /**
   * Pushed to every window when something in the workspace changes on disk. Directory listings and
   * file contents are cached per path, and these changes originate in main — an agent's write, a
   * shell command — so the renderer has no mutation of its own to invalidate from. This is how it
   * hears about them.
   */
  onChanged: event(workspaceChangedSchema),

  /**
   * Ask the OS for a folder. Returns null when the user cancels — a cancel is an ordinary outcome,
   * not an error, so it is not thrown.
   */
  pickFolder: command(async ({ ctx }) => {
    const win = ctx.window
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }),

  /**
   * Switch to a folder the app already knows: a recent root, or one the dialog just returned.
   *
   * The one thing this adds over `pickFolder` is the check that the folder is still there. A recent
   * root is the only path the app holds that can stop existing between sessions — a deleted folder, a
   * drive that is not mounted, a renamed parent — and a root stored without one would leave the tree,
   * the git panel and the viewer pointed at something nothing can read.
   *
   * The `stat` is here rather than in the renderer because the renderer has no filesystem, and the
   * failure is a *code* rather than a message: `WORKSPACE_MISSING` is what the UI branches on to say
   * the folder is gone, and what tells it not to add the path to the recents list it is showing.
   *
   * The resolve is not cosmetic. Recents are compared by path, so every path handed to the store is
   * resolved first — one spelling per folder, whatever separators or trailing separator the caller
   * used. It resolves the path *before* the stat, so the check and the stored value cannot be answers
   * about two different paths.
   *
   * A missing folder announces nothing: there is no change to tell the windows about, and an event
   * here would invalidate the tree they are still correctly showing.
   */
  openRoot: command(z.object({ path: z.string().min(1) }), async ({ input }) => {
    const path = resolve(input.path)

    let isDirectory = false
    try {
      isDirectory = (await stat(path)).isDirectory()
    } catch {
      // Unreadable is the same outcome as gone here: neither can be browsed, and neither is worth
      // different wording. A file rather than a folder is the third case, and takes the same branch.
      isDirectory = false
    }

    if (!isDirectory) {
      throw new ConveyorError(WORKSPACE_MISSING, `${path} is not a folder that exists.`)
    }

    // The root the tree, the git panel and the viewer are pointed at has just changed, and the
    // renderer cannot see that by itself — this is the event every other change reaches them through,
    // so a switch invalidates the listings and the repository reads the same way a write does. Raised
    // after the check, never before: a refused switch must leave those caches alone.
    notifyWorkspaceChanged({ kind: 'command-exited' })

    return { path }
  }),

  /**
   * List one directory. Deliberately single-level: the explorer calls this again as each folder is
   * expanded, so opening a root with a deep tree does not read the whole thing.
   */
  listDirectory: query(z.object({ path: z.string().min(1) }), async ({ input }) => {
    let names: string[]
    try {
      names = await readdir(input.path)
    } catch {
      // Unreadable is indistinguishable from gone as far as the tree is concerned, so it collapses
      // to a single stable code instead of leaking errno strings to the UI.
      throw new ConveyorError('DIRECTORY_UNAVAILABLE', 'This folder could not be read.')
    }

    const visible = names.filter((name) => !HIDDEN_ENTRIES.has(name))
    const entries = await Promise.all(
      visible.map(async (name) => {
        const path = join(input.path, name)
        try {
          // A symlink is followed by default, which is what a file tree should show.
          const stats = await stat(path)
          return { name, path, isDirectory: stats.isDirectory() }
        } catch {
          // Raced with a delete, or a link pointing nowhere. Skipping one entry beats failing the
          // whole listing.
          return null
        }
      })
    )

    const resolved = entries.filter((entry) => entry !== null)
    // Directories first, then case-insensitive by name — the order every file tree uses.
    resolved.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return directoryEntrySchema.array().parse(resolved)
  }),

  /**
   * Read one file, as text, as an image, or as a workbook, decided by its name.
   *
   * Size is checked before anything is read, so an oversized file never lands in memory in the first
   * place — and the check uses a different cap per kind, which is why the kind is settled first. A
   * text read is a string this pane will tokenize; an image read is a data URL it hands to an `img`,
   * and base64 makes what crosses IPC a third larger than the file; a workbook read is a parsed table,
   * whose useful content is a small fraction of its bytes. Same shape of decision, three different
   * numbers.
   *
   * The three results are deliberately different objects rather than one object with optional halves.
   * A text result is exactly what it always was, field for field, so every existing caller and stored
   * transcript is unaffected; an image result carries `kind`, `mime`, `dataUrl` and `bytes` instead of
   * `content`; a workbook result carries `kind`, `sheets` and `fidelity`. No caller that understands
   * one can mistake it for another, and the branches are in a deliberate order — image, workbook, then
   * text — so that the text cap is never applied to a kind whose cap is its own. A 3 MB workbook is
   * readable even though a 3 MB text file is not, for the same reason a 1.5 MB image is.
   *
   * `baselineMtime` is the mtime of the bytes being returned, and it is what lets an editor save
   * safely: it sends that number back with its write, and main refuses the write if the disk has moved
   * on since. It is optional and additive, so a caller that ignores it — and any stored transcript
   * holding an older result — is unaffected. Every kind carries it, because a file's mtime is a fact
   * about the file rather than about how it is displayed.
   */
  readFile: query(z.object({ path: z.string().min(1) }), async ({ input }) => {
    const mime = imageKindForPath(input.path)

    let stats: { size: number; mtimeMs: number }
    try {
      // One `stat` for both the size check and the baseline: the mtime has to describe the bytes that
      // are about to be read, so asking twice would be two answers to one question.
      const result = await stat(input.path)
      stats = { size: result.size, mtimeMs: result.mtimeMs }
    } catch {
      // A missing image and a missing text file are the same failure, and they arrive here before
      // anything has asked which kind they are — the kind is the name's, so it is known even for a
      // file the disk no longer has.
      throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
    }

    if (mime !== null) {
      if (imageOverCap(stats.size)) {
        throw new ConveyorError(
          IMAGE_TOO_LARGE,
          `${basename(input.path)} is ${(stats.size / 1024 / 1024).toFixed(1)} MB — the viewer caps images at 2 MB.`
        )
      }

      let bytes: Buffer
      try {
        bytes = await readFileFromDisk(input.path)
      } catch {
        throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
      }

      // A data URL rather than a buffer, because it is the one encoding that crosses IPC as a string
      // and needs nothing in the renderer. The svg case reads the same way as the rest: the file is
      // served under its own media type, base64, so the renderer receives *bytes it can only decode as
      // a picture* — never markup it could be tempted to inject. Nothing here decides that second half;
      // main's part is to never send a document, only an encoded image.
      return {
        kind: 'image' as const,
        mime,
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        bytes: stats.size,
        path: input.path,
        baselineMtime: stats.mtimeMs,
      }
    }

    if (spreadsheetKindForPath(input.path) !== null) {
      if (spreadsheetOverCap(stats.size)) {
        throw new ConveyorError(
          SPREADSHEET_TOO_LARGE,
          `${basename(input.path)} is ${(stats.size / 1024 / 1024).toFixed(1)} MB — the viewer caps workbooks at 8 MB.`
        )
      }

      let bytes: Buffer
      try {
        bytes = await readFileFromDisk(input.path)
      } catch {
        throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
      }

      // The parse is handed the bytes and nothing else: it reads the container for what the container
      // knows — encryption, chart parts — and the parser for the sheets. Both refusals it can raise
      // travel out of here unchanged, because they are already codes the renderer branches on.
      const parsed = await parseSpreadsheet(bytes)

      return {
        kind: 'spreadsheet' as const,
        sheets: parsed.sheets,
        sheetsOmitted: parsed.sheetsOmitted,
        fidelity: parsed.fidelity,
        bytes: stats.size,
        path: input.path,
        baselineMtime: stats.mtimeMs,
      }
    }

    if (stats.size > MAX_FILE_BYTES) {
      throw new ConveyorError(
        'FILE_TOO_LARGE',
        `${basename(input.path)} is ${(stats.size / 1024 / 1024).toFixed(1)} MB — the viewer caps files at 1 MB.`
      )
    }

    let content: string
    try {
      content = await readFileFromDisk(input.path, 'utf8')
    } catch {
      throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
    }

    return { content, path: input.path, baselineMtime: stats.mtimeMs }
  }),

  /**
   * Write a UTF-8 text file, creating any directories it needs.
   *
   * `rootPath` is required rather than optional: this is the agent's write path, and a write that
   * cannot be checked against a workspace must not happen at all. Containment is enforced by
   * `resolveWorkspacePath`, which also refuses a symlinked route out of the workspace.
   *
   * `baselineMtime` is optional on the wire, and its absence is meaningful rather than a default: a
   * caller that never read the file — an agent writing content it was handed, or a test — keeps the
   * unguarded behaviour. `force` is only ever set after a conflict has been shown to the user.
   */
  writeFile: command(
    z.object({
      path: z.string().min(1),
      content: z.string(),
      rootPath: z.string().min(1),
      /**
       * The mtime the caller read, as a finite number. Validated here because it crosses the boundary
       * and an `NaN` would sail through a comparison and disable the guard silently — the one outcome
       * worse than not having one.
       */
      baselineMtime: z.number().finite().optional(),
      force: z.boolean().optional(),
    }),
    async ({ input }) => {
      const written = await writeWorkspaceFile(input.rootPath, input.path, input.content, {
        baselineMtime: input.baselineMtime ?? null,
        force: input.force === true,
      })
      return { path: written.path, bytes: Buffer.byteLength(input.content, 'utf8'), mtimeMs: written.mtimeMs }
    }
  ),

  /**
   * Write value-only cell edits into a workbook, guarded by the mtime it was read at.
   *
   * The renderer sends an edit list and a baseline and nothing else: no bytes, no formula, no style, and
   * no instruction about what type a typed value takes. That is the boundary this command exists to
   * keep — the pane knows what the user typed and where, and main owns the workbook, so the mapping from
   * grid index to cell and the decision about what a typed string becomes both happen on this side.
   *
   * `baselineMtime` is optional on the wire and its absence is meaningful rather than a default, exactly
   * as it is for a text write: a caller that never read the file keeps the unguarded behaviour. `force`
   * is only ever set by a second, deliberate click after a conflict has been shown.
   *
   * The result is deliberately small — the path, the mtime the write left behind, and how many formulas
   * the edits replaced. The last one is the only thing about this save that the file itself can no longer
   * tell anyone, and the pane's caption says it out loud.
   */
  writeSpreadsheet: command(
    z.object({
      path: z.string().min(1),
      edits: z.array(spreadsheetEditSchema),
      /**
       * The mtime the caller read, as a finite number — validated for the same reason the text write
       * validates it, because an `NaN` would sail through a comparison and silently disable the guard.
       */
      baselineMtime: z.number().finite().optional(),
      force: z.boolean().optional(),
    }),
    async ({ input }) =>
      writeSpreadsheetFile(input.path, input.edits, {
        baselineMtime: input.baselineMtime ?? null,
        force: input.force === true,
      })
  ),
})
