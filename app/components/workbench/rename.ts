/**
 * The decision a rename makes, kept out of the component.
 *
 * Renaming has one rule that is easy to lose in an event handler and hard to notice losing: a title
 * that is empty or only whitespace is not a title. If that check lived in a `keydown` branch, an
 * Enter on a blanked field would write an empty name to the store — and the store's schema would
 * accept it, because `.min(1)` on the raw string is satisfied by a single space.
 */

/**
 * What a submitted title should become, or null when it should not be a title at all.
 *
 * Whitespace is collapsed rather than merely trimmed: a pasted line break in a one-line list row
 * would otherwise become a title that cannot be read.
 */
export function normalizeTitle(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  return collapsed.length === 0 ? null : collapsed
}

/**
 * The title to write for a submission, or null when there is nothing to write.
 *
 * Null covers both refusals — a blank submission, and resubmitting the name it already has — because
 * the caller does the same thing for each: leave the session as it is and close the editor. The
 * current title is normalised for the comparison, so opening an editor and pressing Enter without
 * typing anything is not a change.
 */
export function planRename(currentTitle: string, submitted: string): { title: string } | null {
  const next = normalizeTitle(submitted)
  if (next === null) return null
  if (next === normalizeTitle(currentTitle)) return null
  return { title: next }
}
