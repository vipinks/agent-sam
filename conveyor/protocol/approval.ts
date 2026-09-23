/**
 * The consent gate's rules, as pure functions.
 *
 * Two rules, one promise. The first is what the loop does *at* the gate: a frame is walked in the
 * order the model wrote it, and the walk stops dead at the first call that needs a decision —
 * nothing behind that call runs until the user answers, an approval-exempt call included. The second
 * is what a turn is allowed to look like *during* one: no call behind an undecided one may carry a
 * recorded outcome.
 *
 * The two are stated here together because they are the same law seen from the two sides that can
 * break it — the loop that runs the calls, and the transcript that records them. A rule kept only in
 * the loop's control flow is a rule no test can hold still, which is how the session this phase was
 * written for ended up with two reads marked done behind a command nobody had decided yet.
 *
 * Kept free of module imports so nothing main-only can be dragged into the renderer through it.
 */

/** A call from one assistant frame, and whether it needs consent before it may run. */
export interface FrameCall {
  callId: string
  needsApproval: boolean
}

/**
 * The index of the call a frame's walk must stop at, from `cursor` on — and `-1` when every call from
 * there may run without asking anyone.
 *
 * This is the gate, stated as one question: given where the walk has got to, is there a call it may
 * not run yet? Always the *first* such call, because the walk executes everything in front of it.
 * Never an index before the cursor, because those calls are behind the walk: an exempt call that has
 * already run, or a gated call the user has already decided. That second half is what makes a resumed
 * run and a fresh one the same rule — the resume enters with the decided call behind its cursor
 * rather than with a decision it has to keep re-reading.
 *
 * `cursor` is where the walk has got to: 0 for a frame nobody has looked at yet, and the call after
 * the decision for a resumed one.
 */
export function nextGateIndex(calls: readonly FrameCall[], cursor: number): number {
  for (let index = cursor; index < calls.length; index += 1) {
    if (calls[index].needsApproval) return index
  }
  return -1
}

/**
 * A call as a transcript records it: which call it was, and how far it got.
 *
 * Structural rather than imported, because the renderer's `ToolStep` is the renderer's type and this
 * module must not depend on it — and because the rule reads exactly these two fields and nothing
 * else about a step.
 */
export interface CallOutcome {
  callId: string
  status: string
}

/** The two calls that show a decision was not waited for. */
export interface PauseViolation {
  /** The call that was still undecided. */
  awaitingCallId: string
  /** The call behind it that had already run, or refused, or been ended. */
  settledCallId: string
}

/**
 * The statuses that mean a call is still undecided: the one being asked about, and the ones queued
 * behind it. Distinct states rather than one, because only the first may be actioned.
 */
const UNDECIDED_STATUSES = ['awaiting', 'queued']

/**
 * The statuses that mean an outcome is on the record for a call.
 *
 * `interrupted` belongs here rather than with the undecided pair: a call nobody ever answered has
 * still ended, and a call that ran behind it would be the same defect one process later. `running` is
 * deliberately absent — announcing that a call is starting is not settling it, and what may not
 * happen behind an open decision is a recorded outcome.
 */
const RECORDED_STATUSES = ['ok', 'failed', 'denied', 'interrupted']

/**
 * The first place a turn's calls break the pause invariant, or `null` when they obey it.
 *
 * The invariant: while any call is undecided, no later call may carry a recorded outcome. It is a
 * rule about *order within one turn*, which is the only thing that can be wrong here — the calls of a
 * frame are written down in the order the model asked for them, so a result below an open decision is
 * a result the loop ran before the user said yes, and that is precisely what must never be written
 * again.
 *
 * Phrased as "the first place" rather than a boolean so a failing transcript says which two calls
 * broke it, and so a caller that only cares whether it holds reads `null` and stops.
 */
export function firstPauseViolation(steps: readonly CallOutcome[]): PauseViolation | null {
  let undecided: string | null = null

  for (const step of steps) {
    if (UNDECIDED_STATUSES.includes(step.status)) {
      undecided ??= step.callId
      continue
    }
    if (undecided && RECORDED_STATUSES.includes(step.status)) {
      return { awaitingCallId: undecided, settledCallId: step.callId }
    }
  }

  return null
}
