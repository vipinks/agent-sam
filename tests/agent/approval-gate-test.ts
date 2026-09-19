/**
 * Verifies the consent gate's coordination rule: which call, if any, a frame presents next.
 *
 * This is the half of per-call consent that is pure, so it is tested on its own — no provider, no
 * disk, no React. The defect it guards against is the previous behaviour where one frame's gated
 * calls were presented together and answered by a single click, which is consent the user never
 * actually gave for the second and later calls.
 *
 * The awkward cases are the ones the loop must not get wrong: a frame whose gated calls are not
 * adjacent, a decision that arrives for a call further down the frame, and a decision repeated or
 * naming a call this frame never had.
 */
import { strict as assert } from 'node:assert'
import { nextCallToPresent, undecidedCalls, type FrameCall, type GateDecision } from '../../conveyor/protocol/approval'

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

function firstGatedCallIsPresentedAlone() {
  const presented = nextCallToPresent(threeCalls, [])
  assert.deepEqual(presented, { kind: 'present', callId: 'c1' }, 'the first gated call is presented')

  // The step names exactly one call: there is no representation here for "two at once", which is
  // what makes the batch prompt of the previous behaviour impossible to express.
  assert.deepEqual(undecidedCalls(threeCalls, []), ['c1', 'c3'], 'the rest of the frame stays queued')

  results.push('a three-call frame presents its first gated call alone')
}

function decidingTheHeadPresentsTheNextGatedCall() {
  const decisions: GateDecision[] = [{ callId: 'c1', outcome: 'approved' }]
  assert.deepEqual(
    nextCallToPresent(threeCalls, decisions),
    { kind: 'present', callId: 'c3' },
    'the third call must be presented after the first is decided — never skipped'
  )
  assert.deepEqual(undecidedCalls(threeCalls, decisions), ['c3'], 'only the third is still queued')

  results.push('after deciding the first call, the last gated call is presented')
}

function theFrameResolvesOnlyWhenEveryGatedCallIsAnswered() {
  const decisions: GateDecision[] = [
    { callId: 'c1', outcome: 'approved' },
    { callId: 'c3', outcome: 'approved' },
  ]
  assert.deepEqual(nextCallToPresent(threeCalls, decisions), { kind: 'resolved' })
  assert.deepEqual(undecidedCalls(threeCalls, decisions), [])

  results.push('the frame resolves once every call needing consent has an answer')
}

function aDenialAlsoSettlesTheCall() {
  const deniedHead: GateDecision[] = [{ callId: 'c1', outcome: 'denied' }]
  assert.deepEqual(
    nextCallToPresent(threeCalls, deniedHead),
    { kind: 'present', callId: 'c3' },
    'a denied call is answered, so the frame moves on'
  )

  const bothDenied: GateDecision[] = [
    { callId: 'c1', outcome: 'denied' },
    { callId: 'c3', outcome: 'denied' },
  ]
  assert.deepEqual(nextCallToPresent(threeCalls, bothDenied), { kind: 'resolved' })

  results.push('a denial settles its call as surely as an approval does')
}

function aFrameNeedingNothingIsResolved() {
  const safe: FrameCall[] = [
    { callId: 'c1', needsApproval: false },
    { callId: 'c2', needsApproval: false },
  ]
  assert.deepEqual(nextCallToPresent(safe, []), { kind: 'resolved' }, 'nothing to present')
  assert.deepEqual(undecidedCalls(safe, []), [])

  results.push('a frame whose calls need no consent resolves at once')
}

function anOutOfOrderDecisionDoesNotSkipTheHead() {
  // A later call decided while the head is still unanswered: presenting the tail would silently
  // drop the head's consent, which is exactly the failure per-call consent exists to prevent.
  const decisions: GateDecision[] = [{ callId: 'c3', outcome: 'approved' }]
  assert.deepEqual(
    nextCallToPresent(threeCalls, decisions),
    { kind: 'present', callId: 'c1' },
    'the head is still presented, whatever else has been decided'
  )
  assert.deepEqual(undecidedCalls(threeCalls, decisions), ['c1'], 'and only the head is still queued')

  results.push('a decision for a later call does not skip an undecided head')
}

function repeatsAndStrangersAreIgnored() {
  const decisions: GateDecision[] = [
    { callId: 'c1', outcome: 'approved' },
    { callId: 'c1', outcome: 'approved' },
    { callId: 'ghost', outcome: 'denied' },
  ]
  assert.deepEqual(
    nextCallToPresent(threeCalls, decisions),
    { kind: 'present', callId: 'c3' },
    'a repeated decision changes nothing, and a decision for a call outside the frame is not one'
  )

  results.push('repeated and out-of-frame decisions change nothing')
}

function anEmptyFrameIsResolved() {
  assert.deepEqual(nextCallToPresent([], []), { kind: 'resolved' })
  results.push('an empty frame is resolved')
}

function main() {
  step('first gated call alone', firstGatedCallIsPresentedAlone)
  step('next gated call', decidingTheHeadPresentsTheNextGatedCall)
  step('frame resolves', theFrameResolvesOnlyWhenEveryGatedCallIsAnswered)
  step('denial settles', aDenialAlsoSettlesTheCall)
  step('nothing to approve', aFrameNeedingNothingIsResolved)
  step('out-of-order decision', anOutOfOrderDecisionDoesNotSkipTheHead)
  step('repeats and strangers', repeatsAndStrangersAreIgnored)
  step('empty frame', anEmptyFrameIsResolved)

  console.log(`approval gate: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
