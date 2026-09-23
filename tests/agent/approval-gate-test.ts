/**
 * Verifies the consent gate's law, which has two halves and one point.
 *
 * The first half is where a frame's walk must stop: at the first call that needs a decision, never
 * behind one. The second is what a turn may look like while it is stopped there: no call behind the
 * undecided one may carry a recorded outcome. Between them they say the same thing about the same
 * moment — nothing happens behind a question that has not been answered — which is why they are one
 * suite: the reported session broke both at once, a command waiting on a decision with two reads
 * already marked done behind it.
 *
 * Pure, so it runs with no provider, no disk and no DOM: the loop asks the first rule where to stop,
 * and the second is checked against the transcript the renderer would have built.
 */
import { strict as assert } from 'node:assert'
import { firstPauseViolation, nextGateIndex, type CallOutcome, type FrameCall } from '../../conveyor/protocol/approval'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** The shape the reported defect had: three calls, the first and last of which need consent. */
const threeCalls: FrameCall[] = [
  { callId: 'c1', needsApproval: true },
  { callId: 'c2', needsApproval: false },
  { callId: 'c3', needsApproval: true },
]

// ---------------------------------------------------------------- where the walk stops

function theWalkStopsAtTheFirstCallNeedingConsent() {
  assert.equal(nextGateIndex(threeCalls, 0), 0, 'a frame that opens on a gated call stops at it')

  // The exempt call in front of the third call is not a stop: the walk runs it and carries on, which
  // is what keeps the order the model wrote rather than an order of the gate's choosing.
  assert.equal(nextGateIndex(threeCalls, 1), 2, 'the walk carries on past an exempt call to the gate')
  assert.equal(nextGateIndex(threeCalls, 2), 2, 'and stops at the gate it is standing on')

  results.push('the walk stops at the first call that needs consent, past the exempt ones in front')
}

function aCallBehindTheCursorIsNeverPresentedAgain() {
  // The half that makes a resume the same rule as a fresh frame: the decided call is behind the
  // cursor, and the gate must not send the walk back to it. Asking again would be a second question
  // about a call the user has already answered.
  assert.equal(nextGateIndex(threeCalls, 1), 2, 'the gate is the next one, never the one already passed')
  assert.equal(nextGateIndex(threeCalls, 3), -1, 'and nothing is left past the end of the frame')

  results.push('a call behind the cursor is never presented again')
}

function aFrameNeedingNothingWalksToItsEnd() {
  const safe: FrameCall[] = [
    { callId: 'c1', needsApproval: false },
    { callId: 'c2', needsApproval: false },
  ]
  assert.equal(nextGateIndex(safe, 0), -1, 'nothing to stop at')
  assert.equal(nextGateIndex(safe, 1), -1, 'and nothing from the middle either')
  assert.equal(nextGateIndex([], 0), -1, 'an empty frame has no gate')

  results.push('a frame whose calls need no consent has no gate at all')
}

// ---------------------------------------------------------------- what a pause may look like

/**
 * The reported session, step for step: six results, then the command the user was being asked about,
 * then two more results behind it — the two reads that ran while the command sat undecided.
 */
const REPORTED_TURN: CallOutcome[] = [
  ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((callId) => ({ callId, status: 'ok' })),
  { callId: 'c7', status: 'awaiting' },
  { callId: 'r8', status: 'ok' },
  { callId: 'r9', status: 'ok' },
]

function theReportedTurnIsAViolation() {
  const violation = firstPauseViolation(REPORTED_TURN)
  assert.ok(violation, 'a result behind an undecided call must be reported, not tolerated')
  assert.deepEqual(
    violation,
    { awaitingCallId: 'c7', settledCallId: 'r8' },
    'and it must name the call that was waiting and the first one that ran behind it'
  )

  results.push('the reported session is reported as a violation, naming both calls')
}

function aTurnThatWaitsIsClean() {
  // The same frame as the loop now produces it: the results in front of the decision, the decision
  // itself, and everything behind it queued with no outcome of its own.
  const paused: CallOutcome[] = [
    { callId: 'r1', status: 'ok' },
    { callId: 'c2', status: 'awaiting' },
    { callId: 'r3', status: 'queued' },
    { callId: 'r4', status: 'queued' },
  ]
  assert.equal(firstPauseViolation(paused), null, 'a turn waiting on a decision is clean')

  // Queued is undecided too: a call behind a queued one has no more right to have run.
  assert.deepEqual(
    firstPauseViolation([
      { callId: 'c1', status: 'queued' },
      { callId: 'c2', status: 'ok' },
    ]),
    { awaitingCallId: 'c1', settledCallId: 'c2' },
    'a queued call is undecided as well'
  )

  // Announcing a call is not settling it: a card that is starting is what the pause itself put on
  // screen, and the rule is about outcomes.
  assert.equal(
    firstPauseViolation([
      { callId: 'c1', status: 'awaiting' },
      { callId: 'c2', status: 'running' },
    ]),
    null,
    'a call that is merely starting is not an outcome'
  )

  results.push('a turn waiting on a decision is clean, and a queued call is undecided too')
}

function everyKindOfOutcomeCounts() {
  for (const status of ['ok', 'failed', 'denied', 'interrupted']) {
    assert.deepEqual(
      firstPauseViolation([
        { callId: 'c1', status: 'awaiting' },
        { callId: 'c2', status },
      ]),
      { awaitingCallId: 'c1', settledCallId: 'c2' },
      `a ${status} behind an undecided call is still an ending that happened too early`
    )
  }

  // A decision settles its own call, so what follows it is ordinary work rather than a violation.
  assert.equal(
    firstPauseViolation([
      { callId: 'c1', status: 'denied' },
      { callId: 'c2', status: 'interrupted' },
    ]),
    null,
    'a turn that ended where it stood is not a turn that ran ahead'
  )

  results.push('every recorded ending counts, and a settled call is not a violation')
}

function theFirstViolationIsTheOneReported() {
  const twice: CallOutcome[] = [
    { callId: 'c1', status: 'awaiting' },
    { callId: 'c2', status: 'ok' },
    { callId: 'c3', status: 'ok' },
  ]
  assert.deepEqual(
    firstPauseViolation(twice),
    { awaitingCallId: 'c1', settledCallId: 'c2' },
    'the first call that ran behind the decision is the one worth naming'
  )
  assert.equal(firstPauseViolation([]), null, 'a turn with no calls is clean')
  assert.equal(
    firstPauseViolation([
      { callId: 'c1', status: 'ok' },
      { callId: 'c2', status: 'failed' },
    ]),
    null,
    'a turn with nothing undecided is clean however its calls ended'
  )

  results.push('the first violation is the one reported, and clean turns stay clean')
}

function main() {
  step('the walk stops at the gate', theWalkStopsAtTheFirstCallNeedingConsent)
  step('nothing behind the cursor is re-presented', aCallBehindTheCursorIsNeverPresentedAgain)
  step('a frame needing nothing has no gate', aFrameNeedingNothingWalksToItsEnd)
  step('the reported turn is a violation', theReportedTurnIsAViolation)
  step('a waiting turn is clean', aTurnThatWaitsIsClean)
  step('every recorded ending counts', everyKindOfOutcomeCounts)
  step('the first violation is reported', theFirstViolationIsTheOneReported)

  console.log(`approval gate: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
