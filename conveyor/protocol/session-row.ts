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
 * What a row calls a provider the app no longer offers.
 *
 * The mirror of `REMOVED_BUDDY_LABEL`, and for the same reason: a conversation's pair is history and is
 * never pruned, so a provider that has been deleted must be *named* as gone rather than printed as a raw
 * id no screen can resolve — or hidden behind the default, which would be a different claim about who
 * answered the turn.
 */
export const REMOVED_PROVIDER_LABEL = 'Removed provider'

/**
 * Whether a provider id still names something this build offers.
 *
 * `null` is "the roster has not answered yet", which is deliberately not a statement that the id is
 * gone: at launch the provider list is a bridge call away, and reading an unfinished answer as a delete
 * would relabel every row and seed every new conversation from the wrong pair. An empty roster is read
 * the same way, because this build always ships providers: an empty list is an unfinished answer rather
 * than a world with none in it. An id absent from a non-empty roster is the only deletion this rule
 * knows, and it is the same reading `reconcileTarget` makes of the header's persisted target.
 */
export function isProviderListed(providerId: string, providerOrder: readonly string[] | null): boolean {
  return providerOrder === null || providerOrder.length === 0 || providerOrder.includes(providerId)
}

/** The provider half of a row's line: the stored id, or the word for one that has been removed. */
export function sessionProviderLabel(providerId: string, providerOrder: readonly string[] | null = null): string {
  return isProviderListed(providerId, providerOrder) ? providerId : REMOVED_PROVIDER_LABEL
}

/**
 * The meta label for one conversation.
 *
 * An absent `engineId` is the Sam loop, and its pair comes back spelled exactly as the row has always
 * spelled it — one slash, no spaces — because every list suite and every user's habit reads that line that
 * way, and a fix about engine rows must not move the rows it is not about. The provider half is read
 * through the roster, though: a conversation that names a removed provider keeps the pair on its record
 * (the pair is history, never pruned) but the row says the provider is gone rather than printing an id
 * nothing can resolve.
 *
 * A present `engineId` is named through `engineLabel`, the app's one place an engine is given a word. That
 * covers an id this build no longer ships too: it is drawn as the id the record carries rather than as a name
 * invented for it, and it is therefore the same word the header above the transcript shows for the same
 * conversation — a row and its header cannot disagree about who ran the turn.
 */
export function sessionRowLabel(session: ChatSession, providerOrder: readonly string[] | null = null): string {
  if (session.engineId === undefined) {
    return `${sessionProviderLabel(session.providerId, providerOrder)}/${session.model}`
  }
  return engineLabel(session.engineId)
}

/**
 * The same pair in the tooltip's spelling — a middot rather than the line's slash.
 *
 * The title is a second surface for the same claim, so it is decided by the same rule rather than by a
 * template at the render site: a tooltip that printed the raw dead id while the line above it said the
 * provider was removed would be two answers to one question.
 */
export function sessionPairTitle(session: ChatSession, providerOrder: readonly string[] | null = null): string {
  return `${sessionProviderLabel(session.providerId, providerOrder)} · ${session.model}`
}
