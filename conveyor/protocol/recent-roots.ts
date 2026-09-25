/**
 * The recent-workspaces list's rules, what a root is called, and the code a refused switch is reported
 * under.
 *
 * Pure and shared rather than main-only, for the same reason `write-guard.ts` is: main does the
 * `stat` and the switch, but the *rule* — one root in, a new list out — is a decision a test should be
 * able to make without a disk, a store, or a window. `conveyor/stores/workspace.ts` reduces with these
 * rules, main raises the code, and the renderer branches on it to word the failure itself.
 *
 * Why the list exists at all: a folder is opened far less often than it is returned to, and the file
 * dialog makes every return a walk through the filesystem. Eight entries because that is what a menu
 * can show without scrolling past the folders the user is actually working in.
 *
 * The chips the home screen offers are derived here as well, from this list and the session metadata
 * beside it: what a folder is called, how much is in it, and which conversation a click resumes are one
 * reading of those two lists, and a test should be able to make it without rendering a screen.
 */
import type { ChatSession } from '../stores/chat-sessions'

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
 * A root's last segment: what the folder is called where the whole path will not fit.
 *
 * Split on both separators rather than on whichever one this machine uses, because the path was
 * written by the OS the app was running on and a stored root can outlive a change of platform. A
 * trailing separator is dropped rather than named, so a path stored with one still shows its folder.
 *
 * Here rather than in a renderer module because two surfaces name a folder this way — the switcher's
 * entries and the home screen's chips — and because the chip view models below are built from it: one
 * rule for "what this folder is called", not one per screen that shows a folder.
 */
export function rootTail(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/** One folder home offers back, as a chip needs it. */
export interface ProjectChip {
  /** The folder, exactly as the store holds it. */
  root: string
  /** The folder's last segment: what the chip is named. */
  label: string
  /** How many conversations were last used in this folder. */
  count: number
  /**
   * The most recently touched of them, or null when there are none.
   *
   * Null rather than an empty string, because there is no id here to be empty: the chip opens a folder
   * when it has nothing to resume, and that is a different click from opening a conversation.
   */
  sessionId: string | null
}

/**
 * The chips the home screen draws: one per remembered folder, in the order the list is kept in.
 *
 * The store's order, not an order of this function's own. The list is by recency of *folders* — the one
 * just opened is first — and that is the claim a row of project chips makes; sorting by the
 * conversations inside them would answer a different question, and would move a folder the user just
 * opened out from under the pointer.
 *
 * A folder with nothing in it is still a chip. It is offered at zero rather than dropped: the folder is
 * one the user opened, and the count is what tells them there is nothing to resume there yet.
 *
 * A conversation with no project belongs to no folder, so it counts towards none of them. It has not
 * run anywhere, and reading it into whichever folder happens to be open would be a claim about work
 * that never happened.
 */
export function projectChips(roots: readonly string[], sessions: readonly ChatSession[]): ProjectChip[] {
  return roots.map((root) => {
    const inRoot = sessions.filter((session) => session.lastRoot !== undefined && sameRoot(session.lastRoot, root))

    // By `updatedAt` rather than by the list's order or by `createdAt`: "most recently touched" is what
    // makes this the conversation the user was last in, and it is stated here so the chip keeps saying
    // that even if the list ever arrives in another order.
    const newest = inRoot.reduce<ChatSession | null>(
      (best, candidate) => (best === null || candidate.updatedAt > best.updatedAt ? candidate : best),
      null
    )

    return { root, label: rootTail(root), count: inRoot.length, sessionId: newest?.id ?? null }
  })
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
