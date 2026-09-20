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
 * The fallback, not the usual answer: a conversation the user has renamed carries its name in the
 * session store, which main cannot read from inside a module, so the renderer passes it in. This is
 * what answers when there is no stored title to pass — a session that was never named, or a caller
 * that has none — and it is also what makes an export's heading agree with the name the app itself
 * derived for that conversation.
 */
export function titleFromTranscript(snapshot: TranscriptSnapshot): string {
  const firstUserTurn = snapshot.turns.find((turn) => turn.role === 'user' && turn.content.trim() !== '')
  if (!firstUserTurn) return UNTITLED
  return titleFromMessage(firstUserTurn.content) || UNTITLED
}

/**
 * The name an export should use, given the title the session store has, if any.
 *
 * The two callers want different things from the returned title, and each handles that itself: the
 * **filename** is sanitized by `exportFileName`, because a title is user text and may hold
 * separators that would put the write somewhere other than where the dialog said, while the
 * **heading inside the document** is the title as written — it is read by a person, and mangling it
 * there would be visibly wrong (a title of "a/b" belongs in the file as "a/b").
 *
 * An absent, empty, or whitespace-only stored title falls back to the first user message, so a
 * session that has never been renamed still opens the dialog under a sensible name rather than under
 * "Untitled conversation".
 */
export function exportTitle(stored: string | undefined, snapshot: TranscriptSnapshot): string {
  const trimmed = stored?.trim()
  if (trimmed) return trimmed
  return titleFromTranscript(snapshot)
}
