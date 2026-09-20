/**
 * The write guard's decision: may a write proceed, given what was read and what the disk says now?
 *
 * Pure and shared rather than main-only, for the same reason `mentions.ts` and `git.ts` are: main does
 * the `stat` and the write, but the *rule* — three inputs, one verdict — is a decision a test should be
 * able to make without a filesystem. `conveyor/modules/workspace.ts` imports the code and the decision;
 * nothing in `app/` imports this file's machinery, though the renderer does branch on the code string
 * when it draws the banner.
 *
 * Why the rule exists at all: the editor reads a file, the user types, and something else writes the
 * file in between. Without a comparison between "what I read" and "what is there now", that save
 * silently discards whichever version lost the race. The mtime is the comparison — it is what a read
 * can carry cheaply that a write can check cheaply, and it moves when the bytes do.
 */

/**
 * The code a refused write is reported under.
 *
 * Exported and named rather than written out at the throw site, so the module and this decision cannot
 * drift, and pinned by a test: the renderer branches on this string, and a rename would otherwise
 * surface as a generic save error rather than as the conflict it is.
 */
export const WRITE_CONFLICT = 'WRITE_CONFLICT'

/** Whether a write may proceed. */
export type WriteDecision = 'allow' | typeof WRITE_CONFLICT

/**
 * Decide whether a write may go ahead.
 *
 * `baselineMtime` is the mtime the caller read when it loaded the content it is now saving, or `null`
 * when the caller never read anything — the agent's `write_file` tool and the terminal both write
 * content they were handed, with nothing to compare against, and they must keep behaving exactly as
 * they did before this guard existed. An absent baseline therefore always allows, whatever the disk
 * says.
 *
 * `diskMtime` is what a `stat` reports immediately before the write, or `null` when the target does not
 * exist. Absent is not "unchanged": a file that has been deleted is the disk having moved as far as it
 * can, and writing would recreate it over a deletion the user may have made on purpose.
 *
 * `force` is the user's second, deliberate answer — they have seen the banner and chosen their buffer —
 * and it is the only thing that overrides a mismatch. It is not a default and must never be inferred:
 * it is set by a distinct click after the conflict has been shown.
 *
 * The comparison is equality rather than order. A *newer* mtime and an *older* one are both "not what
 * we read", and a rule that only caught newer values would happily overwrite a file that had been
 * restored from a backup or checked out at an earlier revision.
 */
export function decideWrite(input: {
  baselineMtime: number | null
  diskMtime: number | null
  force: boolean
}): WriteDecision {
  // Nothing was read, so there is nothing to conflict with. This is the unguarded path, unchanged.
  if (input.baselineMtime === null) return 'allow'

  // The user has already been shown the mismatch and chosen their own content.
  if (input.force) return 'allow'

  return input.diskMtime === input.baselineMtime ? 'allow' : WRITE_CONFLICT
}
