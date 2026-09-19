/**
 * The consent gate's coordination rule, as a pure function.
 *
 * When one assistant frame asks for several calls and more than one of them needs consent, the loop
 * must decide which *single* call to put in front of the user next. That decision used to be
 * implicit in the loop's control flow, and it was wrong: the whole batch was presented together and
 * one click answered all of it, which is consent the user never gave for the second and later calls.
 *
 * Extracted here so the rule can be stated once and tested directly, without a provider, a disk, or
 * a DOM. The loop asks this function who is next; it does not work it out for itself. Kept free of
 * module imports so nothing main-only can be dragged into the renderer through it.
 */

/** A call from one assistant frame, and whether it needs consent before it may run. */
export interface FrameCall {
  callId: string
  needsApproval: boolean
}

/** What the user said about one call. Consent is per call: each of these settles exactly one. */
export type GateOutcome = 'approved' | 'denied'

export interface GateDecision {
  callId: string
  outcome: GateOutcome
}

/** Who to put in front of the user next, or that this frame has nothing left to ask. */
export type GateStep = { kind: 'present'; callId: string } | { kind: 'resolved' }

/**
 * The calls in this frame that still have no decision, in frame order.
 *
 * Frame order is the contract, not a preference: the provider requires the tool messages that answer
 * a frame's calls to follow that turn, so the loop walks the frame in the order the model wrote it.
 */
export function undecidedCalls(calls: readonly FrameCall[], decisions: readonly GateDecision[]): string[] {
  const answered = new Set(decisions.map((decision) => decision.callId))
  return calls.filter((call) => call.needsApproval && !answered.has(call.callId)).map((call) => call.callId)
}

/**
 * The next call to present, or `resolved` when every gated call in the frame has an answer.
 *
 * Always the *first* undecided gated call. A decision that arrived for a later call therefore cannot
 * skip one ahead of it: presenting the tail while the head is still unanswered would drop the head's
 * consent, which is the failure this whole rule exists to prevent. Decisions for calls outside the
 * frame, or repeated for a call already decided, change nothing.
 */
export function nextCallToPresent(calls: readonly FrameCall[], decisions: readonly GateDecision[]): GateStep {
  const [next] = undecidedCalls(calls, decisions)
  return next === undefined ? { kind: 'resolved' } : { kind: 'present', callId: next }
}
