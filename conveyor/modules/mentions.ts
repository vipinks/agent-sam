import { readFile, readdir, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { app } from 'electron'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query } from '../init'
import { MAX_FILE_BYTES } from './workspace'
import { resolveWorkspacePath } from './workspace-paths'
import { workspaceRootFromStoreFile } from './terminal'
import {
  isSkippedPath,
  isSkippedSegment,
  MAX_MENTION_ENTRIES,
  orderDirectoryEntries,
  type MentionRead,
} from '../protocol/mentions'

/**
 * Mention targets, and the reads behind them.
 *
 * The rules live in `conveyor/protocol/mentions.ts`; this file is the part that touches the disk —
 * walking, and reading one file under the same containment and size laws every other read follows.
 *
 * The walk and the read are plain exported functions taking a root path, deliberately: that is what
 * lets the node suites exercise the real decision logic against a seeded temp tree rather than a
 * reimplementation that could pass while the shipped code disagrees. The module member at the bottom is
 * a thin wrapper over them, so the query crossing IPC and the function under test cannot drift.
 *
 * It imports electron for `app.getPath`, like `sessions.ts` does. The suites still run outside Electron
 * because `tests/stubs/register.cjs` redirects the import, and the walk itself never consults it.
 */

/**
 * Every file under the workspace root, as workspace-relative paths.
 *
 * Three properties, each of which is the difference between a usable picker and a hang.
 *
 * The cap applies *during* the walk. A walk that collected everything and sliced afterwards would
 * already have paid the cost it was avoiding — a tree with half a million files read in full to show
 * two thousand of them — so the collector stops at the boundary and the caller never sees more.
 *
 * The skip list is checked before descending, on the directory's own name, so a `node_modules` is
 * never opened rather than opened and filtered. That is the whole reason the skip exists: the cost is
 * the readdir, not the entry.
 *
 * The order is deterministic, so the cap keeps the same entries from run to run rather than whichever
 * ones the filesystem happened to return first.
 *
 * Containment is the workspace's own law, applied to the root once: this only ever walks *down* from
 * a resolved root, so no entry can be outside it. A directory that cannot be read — permissions, a
 * race with a delete — is skipped rather than failing the walk, because one unreadable directory must
 * not take the whole picker down with it.
 */
export async function listWorkspaceFiles(rootPath: string | null): Promise<string[]> {
  if (!rootPath) return []

  let root: string
  try {
    root = resolveWorkspacePath(rootPath, '.')
  } catch {
    // No workspace, or a root that has gone missing. Both mean there is nothing to list, which is a
    // legitimate answer for a picker to show rather than an error to raise over.
    return []
  }

  const found: string[] = []
  // Breadth-first with an explicit queue rather than recursion: a deep tree would otherwise be a
  // stack-depth problem, and the cap has to be checked in one place for every path.
  const queue: string[] = [root]

  while (queue.length > 0 && found.length < MAX_MENTION_ENTRIES) {
    const dir = queue.shift() as string

    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      // Unreadable or raced away. Skipping one directory beats failing the walk.
      continue
    }

    for (const name of orderDirectoryEntries(names)) {
      if (found.length >= MAX_MENTION_ENTRIES) break
      // Checked on the name before anything is opened, so a skipped tree costs one comparison rather
      // than a readdir.
      if (isSkippedSegment(name)) continue

      const absolute = join(dir, name)
      let isDirectory: boolean
      try {
        // Followed, like the explorer: a link to a directory is a directory. The containment law is
        // enforced at the root, and entries are reached only by walking down from it.
        isDirectory = (await stat(absolute)).isDirectory()
      } catch {
        continue
      }

      if (isDirectory) {
        queue.push(absolute)
        continue
      }

      // Relative and separator-normalised to `/`, so a path recorded on Windows is the same string a
      // transcript written on Linux would carry. The skip check runs again here because a nested
      // skipped segment can arrive with a directory name that passed above.
      const rel = relative(root, absolute).split(sep).join('/')
      if (isSkippedPath(rel)) continue
      found.push(rel)
    }
  }

  return found
}

/**
 * Read one mentioned file, under the caps that govern every read in this app.
 *
 * Never throws, and that is the point: a mention is the user asking for a file, and a file that
 * cannot be included is a fact to report rather than a send to fail. Each failure is mapped to its
 * own status so the caller can name it — and so the renderer can branch on a code rather than on
 * wording, which is the rule everywhere else a failure crosses this boundary.
 *
 * `resolveWorkspacePath` is what enforces containment, and it is called rather than reimplemented:
 * a mention that named `../../etc/passwd` is refused by the same check the agent's own tools obey.
 */
export async function readMention(rootPath: string | null, requested: string): Promise<MentionRead> {
  const path = typeof requested === 'string' ? requested : ''

  let target: string
  try {
    target = resolveWorkspacePath(rootPath, path)
  } catch (err) {
    // A traversal, a NUL byte, or no workspace at all. All three are the user asking for something
    // outside what can be handed over, which is one outcome as far as the message is concerned.
    if (err instanceof ConveyorError) return { path, status: 'refused' }
    return { path, status: 'missing' }
  }

  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return { path, status: 'missing' }
  }

  // Sized before the read, like every other read here: an oversized file is refused rather than
  // loaded and then discarded, and the code says why.
  if (size > MAX_FILE_BYTES) return { path, status: 'too-large' }

  try {
    const text = await readFile(target, 'utf8')
    return { path, status: 'ok', text }
  } catch {
    return { path, status: 'missing' }
  }
}

/**
 * Read every mention a send asked for, in the order it asked.
 *
 * Sequential rather than concurrent, deliberately. The cap is small, this runs once per send, and a
 * `Promise.all` over a user-controlled list is a burst of simultaneous disk reads for a latency win
 * nobody can perceive — while making the failure ordering depend on which read settled first.
 */
export async function readMentions(rootPath: string | null, paths: readonly string[]): Promise<MentionRead[]> {
  const out: MentionRead[] = []
  for (const path of paths) {
    out.push(await readMention(rootPath, path))
  }
  return out
}

/**
 * The workspace as a flat list of mention targets, for the picker.
 *
 * A query rather than a command because it only reads, and it takes no input: the root is the open
 * folder, which main already holds, so the renderer cannot ask for a walk of somewhere else. Returning
 * paths only is deliberate — the contents are read per send by the loop above, and a picker has no use
 * for them, so nothing but names crosses this boundary.
 */
export const mentionsModule = defineModule({
  /** Every mentionable file in the open workspace, as workspace-relative paths. */
  listFilesFlat: query(async () => {
    // The store file is the same one the terminal module reads for its cwd default: modules cannot
    // import the router, and this is a plain JSON file main already owns. Read here rather than taken
    // as input so a walk cannot be pointed at any directory the renderer names.
    return listWorkspaceFiles(workspaceRootFromStoreFile(app.getPath('userData')))
  }),
})
