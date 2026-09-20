import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import type { SessionSearchResult } from '@/conveyor/protocol/search'

/**
 * The list-level halves of search: which rows are shown, and which user asked for them.
 *
 * The rules are separated from the panel for the same reason the small session rules already are —
 * they are the part that is easy to get subtly wrong and invisible when it is, and keeping them here
 * means they can be exercised without rendering anything.
 */

/**
 * The rows a search leaves visible, and the reason each one is there.
 *
 * A row qualifies two ways, and the list is the union of them:
 *
 * - Its **title** matches the term, found here and instantly, because the titles are already in the
 *   store.
 * - Its **body** matches, which only main can know: it owns the transcripts, and the renderer is not
 *   allowed to receive one.
 *
 * The union is the whole point and the thing that was wrong before it existed. Taking only the title
 * matches renders an empty list for a term the user remembers typing — the search reports "no
 * conversations match" about a conversation that does, which reads as the app having lost the
 * history rather than as a filter being narrow.
 *
 * Order is the store's order, not the scan's: the scan answers in directory order, and letting that
 * decide the list would reshuffle every row the moment a scan resolved. A body match is *added* to
 * the metadata list rather than rebuilding it.
 *
 * `bodyMatchIds` being undefined means the scan has not answered yet — not that it found nothing —
 * so the title matches stand alone for that moment. That is what keeps typing immediate: the list
 * narrows on the keystroke, and the body matches arrive under it when the scan returns.
 */
export function planVisibleSessions(
  sessions: ChatSession[],
  term: string,
  bodyMatchIds: string[] | undefined
): ChatSession[] {
  const byBody = new Set(bodyMatchIds ?? [])
  const needle = term.trim().toLowerCase()

  // An empty term is not a filter, and a running scan is not a reason to show anything on its own:
  // with no needle there is nothing to be a match *of*, so the metadata list is the answer.
  if (!needle) return sessions

  return sessions.filter((session) => byBody.has(session.id) || session.title.toLowerCase().includes(needle))
}

/**
 * One session's matches, from the ids the search returned.
 *
 * By id rather than by position, because the two lists are produced independently: the rows come from
 * the store (which every window shares and any window can change) and the matches come from a scan
 * that ran a moment earlier. Matching them by index would silently attach one conversation's snippets
 * to another's row the first time a session was created or deleted in between.
 */
export function snippetsFor(id: string, results: SessionSearchResult[] | undefined): SessionSearchResult | undefined {
  return results?.find((result) => result.id === id)
}

/**
 * Whether a term is long enough to be worth scanning for.
 *
 * The floor lives in the protocol module, shared with the schema main validates with, so the input
 * that starts a scan and the scan's own minimum cannot disagree.
 */
export function isSearchable(term: string, minimum: number): boolean {
  return term.trim().length >= minimum
}
