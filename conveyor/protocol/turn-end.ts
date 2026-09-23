import type { PlanStep } from './plan'

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
 * asking again would produce a second answer to a finished question. A truncated reply is the same
 * turn stopped by the provider rather than by the model, and the two can always be continued: the
 * conversation is intact on the provider's side of the next request, so continuing costs one
 * round-trip and rewrites nothing. That is also why this is the predicate the notice is emitted on: a
 * dead turn is exactly a turn that can be resumed, and for the two cut-off causes it answers about the
 * reply where the loop answers about the work. The two sets differ on both sides and deliberately: this
 * one allows every reply that was cut short, while `shouldAutoContinue` below also allows a stop with a
 * plan left and still excludes a dropped connection.
 */
export function isResumable(cause: TurnEndCause): boolean {
  return cause !== 'model_stop'
}

/**
 * What a turn owes the user when it ends with work still on its plan.
 *
 * The rule exists because a plan is the one part of a turn that can say "there is more" in the user's
 * own terms, and a turn that stopped partway through one used to be indistinguishable from a turn that
 * had finished: the checklist sat there with steps still pending and nothing on screen said the run was
 * over. A plan that rots quietly is worse than one that failed loudly.
 *
 * `cause` is part of the question rather than a switch over the answer. The verdict does not depend on
 * it — unfinished work is unfinished whether the reply stopped on its own or was cut off, and a rule
 * that only spoke up for the dramatic ending would be silent exactly where it is needed most — so it is
 * echoed into the payload and the caller merges one object rather than pairing a payload with the fact
 * it came from. Said plainly here because it is the sort of parameter a later reader would otherwise
 * add branches to.
 */
export interface PlanUnfinishedNotice {
  /** The ending this notice belongs to, as it was diagnosed. */
  cause: TurnEndCause
  /**
   * How many steps are not done: work still pending, plus work a reconciled plan marked interrupted.
   *
   * Counted from the plan the caller reconciled, never from the plan as it was declared — a step the
   * turn was midway through is unfinished work, and calling it anything else would report a stopped
   * turn as having finished what it started.
   */
  unfinishedSteps: number
  /**
   * Always true, and the reason this notice is said apart from the cause copy.
   *
   * An unfinished plan is work that can be picked up whatever the reply did, so the model stopping on
   * its own is not the end of the matter. `isResumable` answers about the *reply* — a complete answer
   * has nothing to continue — and this answers about the *work*, which is a different question with a
   * different answer. Whether that pick-up is the user's click or the loop's own nudge depends on the
   * cause, which is what `shouldAutoContinue` decides; this flag is the weaker claim both cases share,
   * and is what the card reads when the loop has stopped continuing.
   */
  resumable: true
}

/**
 * How many steps of a plan are still to do: pending work, plus work a reconciliation marked interrupted.
 *
 * Counted from the plan the caller reconciled, never from the plan as it was declared — a step the turn
 * was midway through is unfinished work, and calling it anything else would report a stopped turn as
 * having finished what it started.
 */
export function unfinishedPlanSteps(plan: readonly PlanStep[]): number {
  return plan.filter((step) => step.status !== 'done').length
}

/**
 * The notice a plan-shaped ending has earned, or null when there is nothing to announce.
 *
 * Null for a turn with no plan and for a plan with every step done, which is what keeps the card off
 * the overwhelming majority of turns: a notice under every answer is a notice nobody reads.
 */
export function planUnfinishedNotice(plan: readonly PlanStep[], cause: TurnEndCause): PlanUnfinishedNotice | null {
  const unfinishedSteps = unfinishedPlanSteps(plan)
  if (unfinishedSteps === 0) return null

  return { cause, unfinishedSteps, resumable: true }
}

/**
 * How many times one turn may continue itself before the user is asked.
 *
 * A cap rather than a preference, and the number is the product decision: a turn that has stopped eight
 * times with the same steps still on its plan is not going to be talked into finishing by a ninth
 * nudge, so the stop past it is the one the card goes up for. It is also what keeps this feature
 * bounded in the user's money rather than in the app's hope.
 *
 * Eight rather than four because four was set against a model that stops on its own, and that is not
 * the death a long turn actually has. Four continuations of a capped reply is a quarter of a plan, and
 * a plan that takes ten exchanges to finish — which is what a real piece of work takes — hit the card at
 * the exact moment the loop had learned enough to help.
 */
export const AUTO_CONTINUE_MAX = 8

/**
 * Whether a turn that is ending should be picked up again by the app rather than by the user.
 *
 * This reverses an earlier decision, deliberately, and then corrects its first attempt at that reversal.
 * Phase 23 and Phase 31 both chose no auto-continue, on the grounds that continuing is the user's click;
 * live use then showed what that choice costs. A stop with steps still on the plan stops at the same
 * place every time, so the click was never a decision — it was the same click, over and over, until the
 * user learned to stop reading the card. So the app takes the click it can predict, up to a budget, and
 * the user's Continue becomes the exception: the endings a nudge cannot fix.
 *
 * Phase 33 took that to mean `model_stop` alone, on the reasoning that nudging a cut-off reply buys the
 * same cap again. That reasoning was wrong in practice, and the evidence was the live-use failure this
 * phase exists for: on a long turn the dominant death is not the model deciding it is done, it is the
 * provider running out of output room mid-plan. `truncated` is not a decision the model made — it is
 * the same turn, stopped at the same place by a limit on the reply rather than on the work — so nudging
 * it continues the work, and a request that asks for the rest fits under the cap the next reply has.
 * Automating the click the user would have made anyway is the whole point of the rule, and a truncated
 * turn with work left is exactly that click.
 *
 * `stream_error` stays manual, and it is the one line kept from Phase 33's split: a reply that stopped
 * arriving is not a state a further request can move. Nothing the app sends reopens the connection, and
 * the person is the only party who can act on a dropped line — which is why the card, and not a nudge,
 * is what that ending gets.
 *
 * Written as a predicate over the reconciled plan, like every other rule here: the caller reconciles
 * once, and this decides on the same list the card would have counted.
 */
export function shouldAutoContinue(cause: TurnEndCause, plan: readonly PlanStep[], usedBudget: number): boolean {
  if (cause === 'stream_error') return false
  if (usedBudget >= AUTO_CONTINUE_MAX) return false
  return unfinishedPlanSteps(plan) > 0
}

/**
 * What the app says to the model when it continues a turn the model had stopped.
 *
 * A user-role message, because that is the only role the provider's API has for the operator speaking,
 * and it is sent to the provider and never rendered as user speech: the pane is never told a person
 * typed this, so a transcript of the conversation has no such turn in it.
 *
 * It names the count and the place to start, because those are the two things a stopped model gets
 * wrong when it resumes — it restates what it already finished, or it picks up somewhere arbitrary. The
 * number is the reconciled plan's own, so it describes the work that is actually left.
 */
export function autoContinueNudge(unfinishedSteps: number): string {
  return `You stopped with ${unfinishedSteps} plan steps remaining; continue now from the first unfinished step without restating completed work`
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
