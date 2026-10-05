/**
 * The runs a turn's tool steps are cut into.
 *
 * A run is a stretch of consecutive steps that nothing interrupted: the cards a turn drew between two
 * points where the loop nudged itself, or the cards it drew after its last nudge. The transcript draws
 * one slim row per run rather than one header per call, which is the whole of what this rule decides —
 * which steps belong together, how many of them there are, and whether the stretch is still going.
 *
 * The cuts are the caller's, and they are the seams: `turn.continuations` records where the run resumed
 * itself, and the step after such a point begins a new row because the work before it and the work after
 * it were two different stretches of the turn. A cut that falls outside the list, or twice at the same
 * place, is a malformed record rather than a reason to draw a step twice — the rule normalises it away.
 *
 * The rule is a pure function of its two arguments, with no store, no clock and no import of any kind, for
 * the same reason the fold rule is: it is called while drawing, its answer has to be the same on every
 * frame of a stream, and keeping it out of here is what makes it testable with no DOM at all.
 */

/** A step as this rule sees it: which call it is, and where that call has got to. */
export interface RunStep {
  callId: string
  status: string
}

/** One stretch of consecutive steps, which is what a single group row stands for. */
export interface StepRun<T extends RunStep = RunStep> {
  /**
   * The run's identity: its first call.
   *
   * Stable by construction, which is what a row needs to be — a step's status changes as its call lands,
   * and a key that moved with it would be a new row that had never been opened by hand.
   */
  key: string
  /** How many steps the run holds, which is the count its row reads. */
  count: number
  /**
   * Whether any step of the run is still going.
   *
   * The single input the shared fold rule takes for a row, so it is the difference between a run that is
   * open while the assistant is working and one that folded itself the moment it landed — and, for a run
   * holding a call nobody has answered, the difference between a decision on screen and one behind a
   * closed row.
   */
  inFlight: boolean
  /** The steps themselves, in the order the turn ran them. */
  steps: readonly T[]
}

/**
 * Whether a step has not landed.
 *
 * The three in-flight statuses, named once rather than spelled out at each call site: a call being run
 * and the two halves of a consent pause are all steps in progress — nothing has happened to the call yet
 * — and a call nobody ever decided is not, because the turn it belonged to is over.
 */
function isInFlight(status: string): boolean {
  return status === 'running' || status === 'awaiting' || status === 'queued'
}

/**
 * The runs of `steps`, cut where `cuts` says a new one begins.
 *
 * With no cuts the whole list is one run, which is the case the transcript draws most of the time: a turn
 * that was never nudged drew its cards in one stretch. Every step lands in exactly one run, in order —
 * a step missing from a row is a call the user cannot see or decide, so the counts are asserted against
 * the length of the input rather than trusted.
 */
export function groupStepRuns<T extends RunStep>(steps: readonly T[], cuts: readonly number[] = []): StepRun<T>[] {
  // Where each run starts: the beginning of the list, plus every cut that actually falls inside it.
  // Deduped and sorted, so a seam recorded twice or out of order still draws each step exactly once.
  const starts = [...new Set([0, ...cuts.filter((at) => at > 0 && at < steps.length)])].sort((a, b) => a - b)

  const runs: StepRun<T>[] = []
  for (const [position, start] of starts.entries()) {
    const slice = steps.slice(start, starts[position + 1] ?? steps.length)
    // A list with no steps has no runs: an empty row would be a header over nothing.
    if (slice.length === 0) continue
    runs.push({
      key: slice[0].callId,
      count: slice.length,
      inFlight: slice.some((step) => isInFlight(step.status)),
      steps: slice,
    })
  }
  return runs
}
