/**
 * The turns a run continues from, when a message is written again.
 *
 * Editing a message and regenerating a reply both used to cut the transcript: everything after the turn
 * being acted on was removed, because it had been an answer to words the user was about to change. They
 * are branch points now — the turn keeps its place and its id, the tail it stood at the head of is parked
 * as a branch rather than removed, and the trail that is checked out ends at the reply being written again.
 *
 * What the model is handed is the conversation up to the question being answered, and that is what this
 * rule is: a prefix, never a cut. A reply written again has to be written from the history it was written
 * from the first time, or the run would answer a question nobody asked. The turns after the target are
 * left out for that same reason, and they are also not on screen: what followed the old answer was written
 * from a conversation that is no longer checked out, so leaving it beside the new answer would be the
 * divergence the branch model removes rather than an accepted cost.
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
 * question as it now stands: the turn's own `content` and `mentionPaths`, never a parked branch's. A
 * reply being rewritten is the answer, so it is left out and its question is the last thing in the result
 * either way.
 *
 * Everything after the target is left out, which is what the trail that is checked out does too: the
 * turns after a branch point belong to the branch it replaced, and this rule and the pane agree about
 * where the conversation ends. The transcript's own `turns` array is that trail, so this rule reads the
 * branch the user is on without knowing branches exist.
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

/**
 * Compaction: a summary turn at the head of a conversation, standing for turns that are still there.
 *
 * A summary is a regular turn whose `summarizesTurns` names what it speaks for. That is the whole
 * record-side mechanism — nothing is moved, marked, or deleted — and these rules are the arithmetic
 * around it: which turns a compaction replaces, what the stubbed summary says, and what the seam row
 * expands to. Kept here, beside `runHistoryFor`, because both answer one question about a list of
 * turns: what does a send get.
 *
 * Pure and generic over anything carrying an id and a role, for the reason the two rules above are:
 * the live turns and the stored ones are the same shape, and a second copy of this arithmetic is a
 * second answer waiting to disagree with the first.
 */

/** The turns a manual compaction replaces: everything before the turn the conversation is on. */
export function compactionRange<T extends { id: string }>(turns: readonly T[]): T[] {
  // The last turn stays: compaction is triggered from the conversation in front of the user, and the
  // exchange they are looking at is the one it must not swallow. Nothing to fold below two turns.
  return turns.length < 2 ? [] : turns.slice(0, turns.length - 1)
}

/** How the seam row names the range it stands for. */
export function seamLabel(count: number): string {
  return `Turns 1 through ${count} summarized`
}

/**
 * The stubbed summary: the range's header, then what the user actually asked in it.
 *
 * Deliberately not clever. This turn provides the mechanism, not the summarisation: concatenating the
 * user's messages preserves the conversation's key content and produces a working summary, and a real
 * one from the Sam loop replaces this function's body rather than the projection around it. Assistant
 * prose is left out because a summary of a conversation is what was asked and settled, and the answers
 * are the part a model can afford to lose first.
 */
export function summaryText(turns: readonly { role: 'user' | 'assistant'; content: string }[]): string {
  const asked = turns.filter((turn) => turn.role === 'user' && turn.content.trim()).map((turn) => turn.content)
  return [`Summary of turns 1 through ${turns.length}:`, ...asked].join('\n')
}

/** Every id any summary turn in the list stands for, in the order they were summarized. */
export function summarizedIds<T extends { summarizesTurns?: string[] }>(turns: readonly T[]): string[] {
  const ids: string[] = []
  for (const turn of turns) {
    for (const id of turn.summarizesTurns ?? []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The records a given summary stands for, in transcript order.
 *
 * Read off the transcript rather than off the summary, because the summary names ids and the records
 * are what the seam row expands to — the words, in the order they were said.
 */
export function summarizedTurns<T extends { id: string }>(
  turns: readonly T[],
  summary: { summarizesTurns?: string[] }
): T[] {
  const ids = new Set(summary.summarizesTurns ?? [])
  return turns.filter((turn) => ids.has(turn.id))
}
