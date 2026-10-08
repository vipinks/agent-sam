/**
 * The outbound history's own rules: what a provider may be sent, and what has to be made of a
 * transcript that is not legal as it stands.
 *
 * ## The defect these exist for
 *
 * A turn can end without writing anything. A reply the provider cut off at its output cap is the
 * ordinary case — Phase 36 empties such a frame of its calls, so the round-trip ends with nothing
 * spoken and nothing asked for — and a stop that arrived with nothing in it, a broken stream, or a
 * provider's refusal leaves the same shape behind. The loop records an assistant turn for the round-trip
 * regardless, because a provider expects the turn that asked for tools to be present when its results
 * come back, and that turn is written down with an empty string when there is nothing to write.
 *
 * An assistant message with no content and no calls is not something a provider accepts. Its answer is a
 * 400 for the *whole* request, naming one position — and the position is the same on every rebuild,
 * because the empty turn is in the history rather than in the request: a stored transcript that carries
 * one re-sends it on every continue, so every send is refused at the same index and no send repairs it.
 * Measured on a real transcript (a six-turn conversation whose third and fifth assistant turns are
 * empty), the outbound array carried `{"role":"assistant","content":""}` at positions 5 and 7, and every
 * request after the cap re-sent the same position 5 verbatim.
 *
 * ## Where this is applied
 *
 * One step, in the mapper every dialect of this app's own agent goes through, rather than a patch per
 * dialect: the history is shaped once, and the OpenAI-compatible body and the Anthropic body are both
 * built from the result. Repaired on the way out rather than on disk, deliberately: a stored transcript
 * is the user's record of what was said, and a migration that rewrote those turns would be editing their
 * conversation to work around a bug in the request builder.
 */

/**
 * What these rules read: the fields of a message that decide whether it may go out.
 *
 * Structural rather than imported, so the loop's own `ChatMessage` and the renderer's `HistoryMessage`
 * both qualify without a protocol module learning either of them.
 */
export interface HistoryMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | readonly unknown[]
  tool_calls?: readonly unknown[]
}

/**
 * What an assistant turn that produced nothing says, on the occasion one has to stay.
 *
 * A turn is dropped from the outbound history when it says nothing and asks for nothing — unless taking
 * it out would put two turns of one role side by side. Both dialects refuse that: OpenAI's gateways
 * validate the alternation of a conversation, and Anthropic rejects two same-role messages outright, so
 * the message after a dropped turn has to be answered for rather than joined to the one before it.
 *
 * The wording says what is true and no more. It is not a claim about the model, and it is not an error:
 * it is the record of a turn that happened and had nothing to put in it, which is the fact a model
 * reading the conversation back needs in order to place what comes next.
 */
export const EMPTY_ASSISTANT_MARKER = '(assistant turn produced no content)'

/**
 * Whether a message carries anything: something to read, or a call to answer.
 *
 * An assistant turn that fails both is the one a provider refuses. A string of spaces counts as nothing,
 * because a gateway that trims for its own emptiness check would refuse it and one that did not would
 * still be handed a turn with no meaning in it — and the unspoken rule this rests on is that a turn the
 * model put nothing into is not a thing the model said.
 */
export function speaksOrAsks(message: HistoryMessageLike): boolean {
  const content = message.content
  const spoke = typeof content === 'string' ? content.trim() !== '' : content.length > 0
  return spoke || (message.tool_calls?.length ?? 0) > 0
}

/**
 * The history as a provider may legally receive it.
 *
 * Two rules, both about the same turn. An assistant message that says nothing and asks for nothing is
 * dropped from the request; if dropping it would leave two turns of one role adjacent, it stays and
 * carries the neutral marker instead. Nothing else is ever removed, which is what keeps a tool result
 * paired with the call it answers: a message with `tool_calls` is never a candidate for the drop, so no
 * result can be left addressing a call that is no longer in the request.
 *
 * Called on the last step before a body is built, so what it is handed is what would have gone out.
 */
export function sanitizeOutboundHistory<M extends HistoryMessageLike>(messages: readonly M[]): M[] {
  const silent = messages.map((message) => message.role === 'assistant' && !speaksOrAsks(message))
  const out: M[] = []

  for (const [index, message] of messages.entries()) {
    if (!silent[index]) {
      out.push(message)
      continue
    }

    // The turns this one would have sat between, among those that will actually go out — a run of silent
    // turns is one gap rather than several, which is why the search skips past them.
    const before = out.at(-1)
    let next = index + 1
    while (next < messages.length && silent[next]) next += 1
    const after = next < messages.length ? messages[next] : undefined

    if (before !== undefined && after !== undefined && before.role === after.role) {
      // Cast rather than rebuilt: the only field replaced is `content`, every other field is the same
      // object's, and the replacement is a string — which is this shape's own content type, and what the
      // caller's narrower content type already permits for a message that carries no images.
      out.push({ ...message, content: EMPTY_ASSISTANT_MARKER } as M)
      continue
    }

    // Nothing to stand between: the turn goes, and the request is what the conversation was.
  }

  return out
}
