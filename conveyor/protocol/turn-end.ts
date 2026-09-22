/**
 * How a turn ended, and whether there is anything left to continue.
 *
 * Pure, and shared rather than main-only, for the same reason the plan's rules are: main diagnoses
 * the ending — it is the side holding the provider's stream — and the renderer decides what to say
 * about it, so the vocabulary and the mapping into it have to be one thing rather than two.
 *
 * The rule exists because a turn can die in three ways and two of them used to look exactly like
 * success. The model can finish (`model_stop`), the provider can cut the reply off at its own output
 * limit (`truncated`), or the reply can stop arriving mid-sentence (`stream_error`). The first is the
 * ordinary ending and needs nothing said about it. The other two are a conversation that stopped
 * without announcing itself, which is what this vocabulary exists to make sayable.
 */

/** The three endings. Closed set, because every one of them is something the UI must word. */
export const TURN_END_CAUSES = ['model_stop', 'truncated', 'stream_error'] as const
export type TurnEndCause = (typeof TURN_END_CAUSES)[number]

/**
 * The `finish_reason` / `stop_reason` values that mean the provider ran out of output room.
 *
 * `length` is the OpenAI-dialect spelling and `max_tokens` is Anthropic's; they are the same event,
 * so both are listed rather than one being translated into the other at the parser.
 *
 * Anything else — `stop`, `tool_calls`, `end_turn`, `tool_use`, a value a newer provider invented —
 * is read as the model stopping on its own. That is deliberate: an ending nobody can name is not
 * evidence of truncation, and inventing a card for it would put a Continue button under answers that
 * are already complete, which is how a user learns to ignore the button that matters.
 */
export const TRUNCATION_FINISH_REASONS = ['length', 'max_tokens'] as const

/**
 * What the loop observed about one assistant reply.
 *
 * Evidence rather than a verdict: the mapping from these facts to a cause is the rule below, and
 * keeping the two apart is what lets the rule be tested on values a provider was never asked for.
 */
export interface TurnEndEvidence {
  /**
   * Every finish reason the stream reported for this reply, in arrival order.
   *
   * A list rather than one value because the stream is the authority and not every provider sends
   * the frame exactly once: reading only the last would let a truncation be overwritten by a later
   * frame, so a single truncating value anywhere in the reply is enough.
   */
  finishReasons: readonly string[]
  /** True when an accumulated tool-call payload was not valid JSON when the stream ended. */
  toolCallCut: boolean
  /**
   * The code of a failure raised while the reply was arriving, if one was.
   *
   * Only failures from that phase arrive here. A provider that refused the request outright — no
   * key, a rejected key, a rate limit — never started a reply, so there is no turn to diagnose and
   * those keep the failure path they already had.
   */
  streamErrorCode?: string
}

/**
 * The cause, from the strongest evidence available.
 *
 * The order is the whole rule. A stream that broke explains every other observation — a truncated
 * reply that is also cut mid-JSON is a reply that stopped arriving — so it is read first. A
 * truncating finish reason outranks a cut payload because the provider said so in its own words,
 * while a cut payload is an inference drawn from JSON that does not parse. And the fallback is the
 * ordinary ending rather than an accusation: nothing observed means nothing went wrong.
 */
export function turnEndCause(evidence: TurnEndEvidence): TurnEndCause {
  if (evidence.streamErrorCode !== undefined) return 'stream_error'
  if (evidence.finishReasons.some((reason) => isTruncating(reason))) return 'truncated'
  if (evidence.toolCallCut) return 'truncated'
  return 'model_stop'
}

function isTruncating(reason: string): boolean {
  return (TRUNCATION_FINISH_REASONS as readonly string[]).includes(reason)
}

/**
 * Whether a stream's accumulated tool-call payloads ended mid-JSON.
 *
 * A tool call arrives as fragments, so the only way to know whether the last of them arrived is to
 * try to read the result: JSON that does not parse is a payload that was still being written when
 * the stream stopped. A payload that never arrived at all is not counted — a provider that sent an
 * id and a name and no arguments has said something the tool layer can refuse in its own terms, and
 * calling that a cut reply would put a truncation card under a call that was merely malformed.
 */
export function isToolCallCut(payloads: readonly string[]): boolean {
  return payloads.some((payload) => {
    const json = payload.trim()
    if (json === '') return false
    try {
      JSON.parse(json)
      return false
    } catch {
      return true
    }
  })
}

/**
 * Whether a turn that ended this way can be picked up again.
 *
 * A turn the model stopped on its own has nothing to continue — it said what it had to say, and
 * asking again would produce a second answer to a finished question. The two causes that mean the
 * reply was cut short always can be: the conversation is intact on the provider's side of the next
 * request, so continuing costs one round-trip and rewrites nothing. That is also why this is the
 * predicate the notice is emitted on: a dead turn is exactly a turn that can be resumed, and
 * continuing is still the user's click rather than the app's decision.
 */
export function isResumable(cause: TurnEndCause): boolean {
  return cause !== 'model_stop'
}

/**
 * What the Continue button sends, as an ordinary user message.
 *
 * A sentence rather than a protocol marker, because that is what it becomes: the next request is a
 * normal one, and the model reads this where it would read anything else the user typed. One string
 * for both causes, because the reply was cut off either way and the model has what it needs to carry
 * on in the history it already has.
 */
export const RESUME_MESSAGE = 'Continue from where you left off.'
