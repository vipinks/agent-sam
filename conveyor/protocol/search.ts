import { z } from 'zod'
import type { TranscriptSnapshot } from './transcript'

/**
 * Searching saved conversations: the matching rules, and the shape a result crosses the boundary in.
 *
 * Pure, and free of electron and fs, because the interesting part is not the reading but what counts
 * as a match. Main scans the files and calls in here; the suites call in here directly, so the rules
 * are pinned without a filesystem or a dialog in the way.
 *
 * The one thing this module never does is hand a transcript out. A result carries snippets and a
 * count, which is all the panel can show — the transcript body stays in main, where it was read.
 */

/** Characters of context around a match: roughly one line of prose either side. */
export const SEARCH_SNIPPET_CHARS = 120

/**
 * Snippets per session.
 *
 * Three, because the panel is a list of conversations: one match says "here", and a handful more is
 * enough to tell two similar conversations apart. More would push the rows off the screen.
 */
export const SEARCH_MAX_SNIPPETS = 3

/**
 * The shortest term worth scanning for.
 *
 * Shared with the command's input schema rather than restated there, so the floor the UI enforces and
 * the floor main enforces cannot drift apart. Two characters match most conversations and most words,
 * which makes the scan cost real and the results useless.
 */
export const SEARCH_MIN_TERM = 3

/** One session's matches, as the panel renders them. Never a transcript. */
export const sessionSearchResultSchema = z.object({
  id: z.string(),
  /** Every occurrence in the conversation, not just the ones that produced a snippet. */
  matchCount: z.number().int().nonnegative(),
  snippets: z.array(z.string()),
})

export type SessionSearchResult = z.infer<typeof sessionSearchResultSchema>

/**
 * The prose of a conversation, as one string to search.
 *
 * Turn contents in order, joined by a blank line, with empty turns dropped. Tool arguments and
 * outputs are deliberately not included: this searches what was *said*, and a session whose only
 * match is a byte count inside a tool result is not what someone means when they search for words
 * they remember typing.
 */
export function conversationText(snapshot: TranscriptSnapshot): string {
  return snapshot.turns
    .map((turn) => turn.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n')
}

/**
 * How many times the term occurs, case-insensitively.
 *
 * Occurrences are counted without overlap, which is what a reader counting by hand would find: in
 * `aaaa`, the term `aa` appears twice, not three times.
 */
export function countMatches(text: string, term: string): number {
  const needle = term.trim().toLowerCase()
  if (!needle) return 0

  const haystack = text.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    count++
    from = at + needle.length
  }
  return count
}

/**
 * Up to `limit` excerpts, each centred on a different match, in the order they occur.
 *
 * Each excerpt is roughly `SEARCH_SNIPPET_CHARS` of context with whitespace collapsed to a single
 * line, and an ellipsis marks a side that was cut — so a snippet reads as an excerpt rather than as
 * a short sentence that happens to be there.
 *
 * Centring is the whole point: a snippet that always began at the match would show the term and
 * nothing about where it came from, which is exactly the question a search result has to answer.
 */
export function extractSnippets(text: string, term: string, limit = SEARCH_MAX_SNIPPETS): string[] {
  const needle = term.trim()
  if (!needle || limit <= 0) return []

  const haystack = text.toLowerCase()
  const lowered = needle.toLowerCase()
  const snippets: string[] = []
  let from = 0

  while (snippets.length < limit) {
    const at = haystack.indexOf(lowered, from)
    if (at === -1) break

    const { start, end } = excerptWindow(text, at, needle.length)
    snippets.push(excerpt(text, start, end))
    // The next search starts where this excerpt *ended*, not after the match it was built around.
    // Resuming at the match would make three snippets three overlapping views of one neighbourhood:
    // the same text again, under a heading that promised more matches.
    from = Math.max(end, at + lowered.length)
  }

  return snippets
}

/** The count and the excerpts together, which is what one result consists of. */
export function searchTranscriptText(
  text: string,
  term: string,
  limit = SEARCH_MAX_SNIPPETS
): { matchCount: number; snippets: string[] } {
  return { matchCount: countMatches(text, term), snippets: extractSnippets(text, term, limit) }
}

/**
 * The stretch of text one snippet is cut from: the match, plus roughly half the budget either side,
 * clamped to the text.
 *
 * Returned as offsets rather than as a string because the caller uses the end position to decide
 * where the next snippet may begin.
 */
function excerptWindow(text: string, at: number, length: number): { start: number; end: number } {
  const half = Math.max(0, Math.floor((SEARCH_SNIPPET_CHARS - length) / 2))
  return { start: Math.max(0, at - half), end: Math.min(text.length, at + length + half) }
}

/**
 * One excerpt between two offsets, on a single line, marked where it was cut.
 *
 * The ellipses sit outside the character budget rather than inside it, so a snippet is never shown
 * with less context than intended just because both sides were trimmed.
 */
function excerpt(text: string, start: number, end: number): string {
  const body = text
    .slice(start, end)
    // A match in the middle of a paragraph would otherwise carry the newlines into a one-line
    // snippet, and the row would grow to a paragraph height and shove the list around.
    .replace(/\s+/g, ' ')
    .trim()

  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
