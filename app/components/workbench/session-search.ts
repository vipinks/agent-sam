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
 * The rows a term leaves visible.
 *
 * Case-insensitive substring, over the title only. The list is a list of names, so filtering on
 * anything else would hide a row whose name matches, which is precisely the row the user is looking
 * for. An empty or whitespace-only term filters nothing.
 */
export function filterSessionsByTitle(sessions: ChatSession[], term: string): ChatSession[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return sessions
  return sessions.filter((session) => session.title.toLowerCase().includes(needle))
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
