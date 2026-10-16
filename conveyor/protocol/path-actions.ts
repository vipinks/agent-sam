import { sameRoot } from './recent-roots'

/**
 * The two acts an explorer row offers beyond opening it: removing a path, and showing it in the OS's
 * own file manager.
 *
 * The codes live here, and the refusal decision with them, because both sides need the same answer:
 * main raises one and the explorer names it. A caller that branched on messages would treat a reworded
 * refusal as a new state, and the two spellings would drift the first time one of them changed.
 */

/** Nothing was on disk at that path when the act ran — the row was deleted outside the app. */
export const PATH_GONE = 'PATH_GONE'

/** The filesystem itself refused the removal: a lock, a permission, a path in use. */
export const PATH_DELETE_FAILED = 'PATH_DELETE_FAILED'

/**
 * The open folder itself.
 *
 * It heads the tree rather than appearing as a row, so nothing offers to remove it — this is the
 * command's own refusal, for a caller that names it anyway. Removing the folder every pane is pointed at
 * would leave the workbench describing a workspace that is no longer there.
 */
export const ROOT_UNREMOVABLE = 'ROOT_UNREMOVABLE'

/** The two refusals a removal can arrive as before it touches anything. */
export type RemovalRefusal = typeof ROOT_UNREMOVABLE | typeof PATH_GONE

/**
 * Whether a removal may proceed, or the code it is refused under.
 *
 * The root is asked first, and deliberately before the disk is: the open folder is on disk by
 * definition, so an existence check can never speak for it, and this is the one refusal that must not
 * depend on a stat succeeding. Then the gone path, which is the ordinary race — the entity was deleted
 * between the listing and the click — and the honest answer there is that there is nothing to remove,
 * rather than a silent success that reports work it did not do.
 *
 * The comparison is `sameRoot`'s, the one the recents switcher already uses to ask whether a stored
 * folder is the one that is open: case-insensitively, because on the platform this ships to a path's
 * case is not part of its identity.
 */
export function removalRefusal(input: { target: string; root: string; exists: boolean }): RemovalRefusal | null {
  if (sameRoot(input.target, input.root)) return ROOT_UNREMOVABLE
  if (!input.exists) return PATH_GONE
  return null
}
