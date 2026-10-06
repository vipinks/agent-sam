import { engineLabel } from './engine'
import type { ChatSession } from '../stores/chat-sessions'

/**
 * What a conversation list row calls the thing that answered it.
 *
 * The row's trailing meta is the one part of the line that is a claim rather than a label: which model ran
 * the turn. For a conversation that runs an engine that claim is *not* the record's `providerId`/`model` —
 * those name the Sam loop this conversation is not running, and the engine brings its own model and
 * provider — so the row has to read the engine key instead.
 *
 * A rule rather than a render-site expression, for the reason the other session rules are: it is a decision
 * about the record, and it can be held still without a DOM. The render site keeps its own concerns — the age
 * prefix, the separator, the tooltip's spelling.
 */

/**
 * The meta label for one conversation.
 *
 * An absent `engineId` is the Sam loop, and its pair comes back spelled exactly as the row has always
 * spelled it — one slash, no spaces — because every list suite and every user's habit reads that line that
 * way, and a fix about engine rows must not move the rows it is not about.
 *
 * A present `engineId` is named through `engineLabel`, the app's one place an engine is given a word. That
 * covers an id this build no longer ships too: it is drawn as the id the record carries rather than as a name
 * invented for it, and it is therefore the same word the header above the transcript shows for the same
 * conversation — a row and its header cannot disagree about who ran the turn.
 */
export function sessionRowLabel(session: ChatSession): string {
  if (session.engineId === undefined) return `${session.providerId}/${session.model}`
  return engineLabel(session.engineId)
}
