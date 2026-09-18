import { basename, dirname, join } from 'path'
import { mkdir, readFile as readFileFromDisk, readdir, stat, writeFile as writeFileToDisk } from 'fs/promises'
import { dialog } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, command, event } from '../init'
import { resolveWorkspacePath } from './workspace-paths'
import { notifyWorkspaceChanged, workspaceChangedSchema } from '../events'

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
 */
export async function writeWorkspaceFile(rootPath: string, requested: string, content: string): Promise<string> {
  const target = resolveWorkspacePath(rootPath, requested)

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
  return target
}

/** One child of a listed directory. */
const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
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
   * Read one file as UTF-8 text. Size is checked before reading, so an oversized file never lands
   * in memory in the first place.
   */
  readFile: query(z.object({ path: z.string().min(1) }), async ({ input }) => {
    let size: number
    try {
      size = (await stat(input.path)).size
    } catch {
      throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
    }

    if (size > MAX_FILE_BYTES) {
      throw new ConveyorError(
        'FILE_TOO_LARGE',
        `${basename(input.path)} is ${(size / 1024 / 1024).toFixed(1)} MB — the viewer caps files at 1 MB.`
      )
    }

    let content: string
    try {
      content = await readFileFromDisk(input.path, 'utf8')
    } catch {
      throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
    }

    return { content, path: input.path }
  }),

  /**
   * Write a UTF-8 text file, creating any directories it needs.
   *
   * `rootPath` is required rather than optional: this is the agent's write path, and a write that
   * cannot be checked against a workspace must not happen at all. Containment is enforced by
   * `resolveWorkspacePath`, which also refuses a symlinked route out of the workspace.
   */
  writeFile: command(
    z.object({
      path: z.string().min(1),
      content: z.string(),
      rootPath: z.string().min(1),
    }),
    async ({ input }) => {
      const target = await writeWorkspaceFile(input.rootPath, input.path, input.content)
      return { path: target, bytes: Buffer.byteLength(input.content, 'utf8') }
    }
  ),
})
