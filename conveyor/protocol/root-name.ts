/**
 * The folder a session's root is named by, for a header nine pixels of height.
 *
 * The chat header states where a session is running, and it has room for a name rather than a path: the
 * last segment of the root, with the whole path kept for the tooltip. That is a rule rather than a render,
 * so it lives here with the other protocol rules and is exercised without a DOM — and it is string work
 * rather than `path` work because the renderer is not allowed a path module. Nothing in this file imports
 * one, which is what lets the pane call it at all.
 *
 * Both separators are handled, and that is not a platform nicety. The root arrives from main in the
 * platform's own spelling, and a root restored from a stored conversation may have been written on
 * another one, so the split is on either separator and a trailing one names the same folder rather than
 * an empty name.
 *
 * The absent answer is `null`, deliberately rather than an empty string: the chip is drawn from this
 * value, and a chip with nothing in it would claim a project where there is none. A caller that gets
 * `null` draws nothing, which is the only honest rendering of a session with no project.
 */

/** One or more separators, either flavour, run together so a doubled separator names nothing extra. */
const SEPARATORS = /[\\/]+/

/**
 * The last segment of `root`, or `null` when there is no folder to name.
 *
 * `null` covers the three ways a session says it has no project — the field absent, the field empty, and
 * the field holding only whitespace — as well as a root that is nothing but separators, which has no
 * segment to be named by. Collapsing them into one answer is the point: the caller has one thing to
 * decide, and it decides it the same way for every spelling of "nothing here".
 */
export function rootFolderName(root: string | null | undefined): string | null {
  if (root === null || root === undefined) return null

  const trimmed = root.trim()
  if (trimmed === '') return null

  const segments = trimmed.split(SEPARATORS).filter((segment) => segment !== '')
  // A drive-relative root such as `C:/` splits to a single segment and is named by it; a root of nothing
  // but separators splits to none, which is the absent answer rather than an empty name.
  return segments.length === 0 ? null : segments[segments.length - 1]
}
