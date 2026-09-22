/**
 * Cutting a transcript back to just before a turn, so an edited message can be sent again.
 *
 * Editing a message is not an edit in place. Everything after the turn being edited was written in
 * reply to words the user is about to change — an answer to a question that will no longer exist — so
 * it goes, rather than sitting under a message it no longer describes. One rule decides what "goes"
 * means, and it is shared on purpose: the dialog tells the user how many turns will be removed, and
 * the send that follows removes exactly those. Two implementations of the same subtraction would be a
 * count that can disagree with the cut, which is a dialog that lies about what a click will do.
 *
 * Generic over anything carrying an `id`, so the live turns and the stored ones read through it
 * unchanged: the renderer's `AgentTurn` and the record's turn are structurally the same, and the rule
 * has no reason to prefer one of them. That is also why it lives here rather than in the renderer —
 * main writes and validates the same transcript, and a later turn that cuts a stored record uses this
 * rule rather than a second copy of it.
 */

/**
 * The turns strictly before `turnId`, in the order they were in.
 *
 * Strictly before, and not including the named turn: the caller is replacing that turn, and its
 * replacement is built by the ordinary send path out of the text the user has just edited. Keeping it
 * would put the old words back beside the new ones.
 *
 * An id that is not in the transcript cuts nothing and returns the transcript as it is. That case is
 * not an error worth throwing over — a stale id arrives from a row that has since been re-rendered —
 * and a prefix returned for it would silently discard the conversation instead.
 *
 * The surviving turns are the same objects, not copies: a cut discards turns and leaves the ones it
 * keeps alone, so nothing a caller knows about a surviving turn has to be rebuilt. The input is never
 * mutated, so the result can be handed straight to the transcript store.
 */
export function truncateFromTurn<T extends { id: string }>(turns: readonly T[], turnId: string): T[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return [...turns]
  return turns.slice(0, index)
}
