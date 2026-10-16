/**
 * The turns a run continues from, when a message is written again.
 *
 * Editing a message and regenerating a reply both used to cut the transcript: everything after the turn
 * being acted on was removed, because it had been an answer to words the user was about to change. They
 * are rewritten in place now — the turn keeps its place and its id, what it said before is kept as a
 * previous version beside the new one, and nothing after it is removed.
 *
 * What the model is handed is still the conversation up to the question being answered, and that is what
 * this rule is: a prefix, never a cut. A reply written again has to be written from the history it was
 * written from the first time, or the run would answer a question nobody asked; and the turns after the
 * target are left out for the same reason, which is the divergence an in-place rewrite costs and accepts.
 * Later replies stay exactly as they are — written from the older words — and the pane shows that rather
 * than pretending otherwise.
 *
 * Generic over anything carrying an `id`, so the live turns and the stored ones read through it
 * unchanged: the renderer's `AgentTurn` and the record's turn are structurally the same, and the rule has
 * no reason to prefer one of them. That is also why it lives here rather than in the renderer — main
 * writes and validates the same transcript, and a later turn that reads a stored record uses this rule
 * rather than a second copy of it.
 */

/**
 * The turns strictly before `turnId`, in the order they were in.
 *
 * Strictly before, and not including the named turn: the reply at that id is the one being written
 * again, so it is not part of the history it is written from. Its question is the last thing in the
 * result, which is the shape a regenerate has always been handed.
 *
 * An id that is not in the transcript cuts nothing and returns the transcript as it is. That case is
 * not an error worth throwing over — a stale id arrives from a row that has since been re-rendered —
 * and a prefix returned for it would silently discard the conversation instead.
 *
 * The surviving turns are the same objects, not copies: the rule selects turns and leaves the ones it
 * keeps alone, so nothing a caller knows about a surviving turn has to be rebuilt. The input is never
 * mutated, so the result can be handed straight to the transcript store.
 */
export function truncateFromTurn<T extends { id: string }>(turns: readonly T[], turnId: string): T[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return [...turns]
  return turns.slice(0, index)
}

/**
 * The turns a re-run for `turnId` continues from: everything before it, plus the turn itself when the
 * turn is the question.
 *
 * The halves differ because the turns acted on differ. A message the user edited *is* what the model is
 * asked — the words just written are the question — so it is included, and what is included is the
 * version in force: the turn's own `content` and `mentionPaths`, never a version parked behind it. A
 * reply being rewritten is the answer, so it is left out and its question is the last thing in the
 * result either way.
 *
 * Everything after the target is left out, which is the one thing this rule and the transcript on screen
 * deliberately disagree about: the transcript keeps every later turn, and the history is the context this
 * run is answering from rather than a description of the conversation as it now stands.
 *
 * An id that is not in the transcript returns the transcript as it is, for the reason the cut above does:
 * a stale id arrives from a row that has since been re-rendered, and a prefix returned for it would
 * silently discard the conversation.
 */
export function runHistoryFor<T extends { id: string; role: 'user' | 'assistant' }>(
  turns: readonly T[],
  turnId: string
): T[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return [...turns]
  return turns[index].role === 'user' ? turns.slice(0, index + 1) : truncateFromTurn(turns, turnId)
}
