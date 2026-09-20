import type { TranscriptSnapshot } from './transcript'

/**
 * How a conversation gets a name.
 *
 * Shared rather than renderer-only because two processes now need the same answer: the panel derives
 * a title from a first message when a chat is created, and main derives one when exporting, so that
 * the file it writes is named the way the row that produced it is named. Two copies of the 48-
 * character rule would drift, and the drift would only show up as a filename that does not match the
 * list it came from.
 */

/** Title length, as specified: the first user message, truncated. */
export const TITLE_MAX = 48

/** The title a session gets when its first message is somehow blank. */
export const UNTITLED = 'Untitled conversation'

/**
 * Cap a title at the documented length.
 *
 * Truncation happens on the trimmed text, so trailing whitespace cannot eat into the 48 characters,
 * and an ellipsis is appended so a clipped title reads as clipped rather than as a short one.
 */
export function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= TITLE_MAX) return trimmed
  return `${trimmed.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

/**
 * The title a saved conversation implies, from its first user message.
 *
 * A conversation the user has renamed carries its name only in the session store, which main cannot
 * read from inside a module — so an export of a renamed session is named after the message that
 * started it. That is a limitation of what a transcript holds, not a choice: nothing else in the file
 * records the name. It is stated here rather than worked around because a fabricated name would be
 * worse than an honest one.
 */
export function titleFromTranscript(snapshot: TranscriptSnapshot): string {
  const firstUserTurn = snapshot.turns.find((turn) => turn.role === 'user' && turn.content.trim() !== '')
  if (!firstUserTurn) return UNTITLED
  return titleFromMessage(firstUserTurn.content) || UNTITLED
}
