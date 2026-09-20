/**
 * The recent-workspaces list's rules, and the code a refused switch is reported under.
 *
 * Pure and shared rather than main-only, for the same reason `write-guard.ts` is: main does the
 * `stat` and the switch, but the *rule* — one root in, a new list out — is a decision a test should be
 * able to make without a disk, a store, or a window. `conveyor/stores/workspace.ts` reduces with these
 * rules, main raises the code, and the renderer branches on it to word the failure itself.
 *
 * Why the list exists at all: a folder is opened far less often than it is returned to, and the file
 * dialog makes every return a walk through the filesystem. Eight entries because that is what a menu
 * can show without scrolling past the folders the user is actually working in.
 */

/** How many roots are remembered before the oldest is dropped. */
export const MAX_RECENT_ROOTS = 8

/**
 * The code a switch is refused with when the path is not a folder that exists.
 *
 * A recent root is a path that *was* real, so it is the one kind of path the app holds that can stop
 * existing between sessions — a deleted folder, an unmounted drive, a renamed parent. Exported and
 * named rather than written out at the throw site so the module and the renderer cannot drift, and
 * pinned by a test: the renderer branches on this string, and a rename would otherwise surface as a
 * generic failure that says nothing about why the folder did not open.
 */
export const WORKSPACE_MISSING = 'WORKSPACE_MISSING'

/**
 * Whether two stored roots are the same folder.
 *
 * Case-insensitively, because the same folder is spelled with different case far more often than it
 * is spelled the same way twice — a drive letter the dialog upper-cases, a path the user typed, a
 * shell that echoes what it was given. It compares nothing else *not* because the rest is noise but
 * because main resolves every path before the store ever sees it, so the separator and trailing-slash
 * spellings are already one spelling by the time a list holds two of them.
 */
export function sameRoot(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Put a root at the front of the list, dropping any earlier entry for the same folder.
 *
 * Prepending rather than appending is the point of the list: it is ordered by recency, so the folder
 * just opened is the first one offered next time. A folder that is already listed therefore moves
 * rather than being added again — a list that could hold one folder twice would show it twice and
 * forget something else to make room.
 */
export function rememberRoot(roots: readonly string[], path: string): string[] {
  const withoutPath = roots.filter((root) => !sameRoot(root, path))
  return [path, ...withoutPath].slice(0, MAX_RECENT_ROOTS)
}

/**
 * Drop a root from the list without opening anything.
 *
 * Separate from `rememberRoot` because forgetting is not the inverse of remembering: it is the user
 * saying "never offer me this again" about a folder they are not switching to, and a folder that no
 * longer exists is exactly the entry worth removing. Whatever is open stays open.
 */
export function forgetRoot(roots: readonly string[], path: string): string[] {
  return roots.filter((root) => !sameRoot(root, path))
}
