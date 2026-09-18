import { basename, join } from 'path'
import { readFile as readFileFromDisk, readdir, stat } from 'fs/promises'
import { dialog } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, command } from '../init'

/**
 * Local workspace access — the only place in the app that touches the file system. The renderer
 * never sees `fs`: it calls these primitives through the inferred `conveyor` client, and every
 * path crossing that boundary is validated by the zod schema below before it reaches the disk.
 */

/** Directories that are never worth browsing and always costly to walk. */
const HIDDEN_ENTRIES = new Set(['node_modules', '.git', 'dist'])

/** Reads larger than this are refused rather than shipped over IPC — see `readFile`. */
const MAX_FILE_BYTES = 1024 * 1024

/** One child of a listed directory. */
const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
})

export const workspaceModule = defineModule({
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
})
