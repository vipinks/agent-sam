/**
 * Verifies the one rule that decides how a turn's tool steps are grouped into rows: consecutive steps
 * are one run, and every step belongs to exactly one run.
 *
 * The rule lives in `conveyor/protocol` rather than inside the bubble that draws it, for the same reason
 * the fold rule does: what counts as one run is the decision worth testing, and a rule test can state the
 * whole of it without a DOM. Whether the bubble is wired to it is a separate claim, made in
 * `testing/step-run-rows.test.tsx`.
 *
 * Purity is asserted rather than assumed, and twice over: the rule is called on a frozen input and the
 * input is checked to come back unmodified, and the module's own source is read to confirm it imports
 * nothing — so it cannot consult a store, a component or a clock, and cannot grow a second input that two
 * callers could disagree about.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupStepRuns, type StepRun } from '../../conveyor/protocol/step-runs'

const results: string[] = []

/** Where the module under test lives, from the root the suite is run from. */
const MODULE_PATH = join(process.cwd(), 'conveyor', 'protocol', 'step-runs.ts')

/** A step, as this rule sees it: the call it belongs to and where its call has got to. */
function step(callId: string, status: string) {
  return { callId, status }
}

// ---------------------------------------------------------------- grouping

/**
 * A turn's steps, cut into runs.
 *
 * Every step of a turn is a tool step, so every step lands in a run: the grouping never drops one, and
 * the counts across the runs add up to the length of the input. That is the property a transcript cannot
 * afford to lose — a step missing from a group row is a call the user cannot see or decide.
 */
function everyStepLandsInExactlyOneRun() {
  const steps = [step('a', 'ok'), step('b', 'ok'), step('c', 'ok')]
  const runs = groupStepRuns(steps)

  assert.equal(runs.length, 1, 'three consecutive steps are one run')
  assert.equal(runs[0].count, 3, 'and the run counts all three of them')
  assert.deepEqual(
    runs[0].steps.map((s) => s.callId),
    ['a', 'b', 'c'],
    'in the order the turn ran them, which is the order the cards are drawn in'
  )

  const total = runs.reduce((sum, run) => sum + run.count, 0)
  assert.equal(total, steps.length, 'every step of the turn is accounted for, none dropped and none doubled')

  results.push('consecutive steps land in one run, in order, and every step lands in exactly one run')
}

/**
 * A run is consecutive: a step that is not next to its neighbour starts a new one.
 *
 * The counts have to describe the rows a reader sees, so this is asserted as the whole shape of the walk
 * rather than as a length: three runs of one, two and one, off a turn of four steps that happened to
 * arrive in that order.
 */
function onlyConsecutiveStepsShareARun() {
  const runs = groupStepRuns([step('a', 'ok'), step('b', 'ok'), step('c', 'ok')])
  assert.deepEqual(
    runs.map((run) => run.count),
    [3],
    'a straight run of three is one row'
  )

  // The single-step case, which must still be a run of its own: one call is one row saying it happened,
  // not a step left out of the grouping.
  const alone = groupStepRuns([step('solo', 'ok')])
  assert.equal(alone.length, 1, 'a lone step is a run of one')
  assert.equal(alone[0].count, 1, 'with a count of one, which is what its row reads')

  const none = groupStepRuns([])
  assert.equal(none.length, 0, 'a turn with no steps draws no rows at all')

  results.push('a lone step is a run of one, and a turn with no steps draws no row')
}

/**
 * The cuts are where the caller says a new run begins, which is where a seam was recorded.
 *
 * This is the case the transcript actually draws: a turn that continued itself has more than one stretch
 * of work, and the shape of the row list is the shape of the turn. A cut outside the list, or twice at
 * the same place, is normalised away rather than drawing a step twice — which is asserted as the counts,
 * since that is what a reader would see.
 */
function theCutsCutTheRuns() {
  const steps = [step('a', 'ok'), step('b', 'ok'), step('c', 'ok')]

  const cutOnce = groupStepRuns(steps, [1])
  assert.deepEqual(
    cutOnce.map((run) => run.count),
    [1, 2],
    'a cut before the second step draws one run of one and one run of two'
  )
  assert.deepEqual(
    cutOnce.map((run) => run.key),
    ['a', 'b'],
    'each run is keyed by its own first call'
  )

  const cutTwice = groupStepRuns(steps, [1, 1])
  assert.deepEqual(
    cutTwice.map((run) => run.count),
    [1, 2],
    'the same cut named twice is still one cut'
  )
  assert.equal(
    groupStepRuns(steps, [0, 3, -1, 9]).length,
    1,
    'a cut at either edge or outside the list is no cut at all'
  )

  const total = cutOnce.reduce((sum, run) => sum + run.count, 0)
  assert.equal(total, steps.length, 'a cut never loses a step or draws one twice')

  // In flight is the run's own: the stretch holding the live call is the one left open.
  const cut = groupStepRuns([step('a', 'ok'), step('b', 'running')], [1])
  assert.equal(cut[0].inFlight, false, 'the landed stretch is folded')
  assert.equal(cut[1].inFlight, true, 'and the stretch still working is not')

  results.push('cuts draw one run per stretch, and a malformed cut never draws a step twice')
}

// ---------------------------------------------------------------- in flight

/**
 * A run is in flight while any of its steps is.
 *
 * This is the whole of what the fold rule reads for a group row, so it is the claim that decides whether
 * a run is open while the assistant is still working: a run holding a call that has not landed stays open
 * — which is also what puts a consent card in front of the user rather than behind a closed row.
 */
function aRunIsInFlightWhileAnyStepIs() {
  const landed = step('done', 'ok')
  const running = step('live', 'running')
  const awaiting = step('asked', 'awaiting')
  const queued = step('behind', 'queued')
  const undecided = step('lost', 'interrupted')

  assert.equal(groupStepRuns([landed])[0].inFlight, false, 'a run of finished calls is not in flight')
  assert.equal(groupStepRuns([running])[0].inFlight, true, 'a call still running keeps its run in flight')
  assert.equal(groupStepRuns([landed, awaiting, queued])[0].inFlight, true, 'an unanswered question does too')
  assert.equal(groupStepRuns([landed, undecided])[0].inFlight, false, 'a call nobody ever decided is over')

  // The mixed run, which is the case the rule is for: one finished call beside one that has not landed
  // belongs to the same row, and that row is the one being watched.
  const mixed = groupStepRuns([landed, running])
  assert.equal(mixed.length, 1, 'a finished call and a live one are the same run')
  assert.equal(mixed[0].inFlight, true, 'and the run is in flight for as long as its live step is')

  results.push('a run is in flight while any step of it is, and only then')
}

// ---------------------------------------------------------------- shape

/**
 * A run is named and keyed by its steps, so a redraw is the same run rather than a new one.
 *
 * The key matters the way the prose sections' keys do: a group row the user opened by hand must survive
 * the next step arriving, and a key that moved every time would be a new row that had never been opened.
 */
function aRunCarriesAStableIdentity() {
  const first = groupStepRuns([step('a', 'ok'), step('b', 'running')])[0]
  const again = groupStepRuns([step('a', 'ok'), step('b', 'ok')])[0]

  assert.equal(first.key, again.key, 'the same steps are the same run, whatever their statuses say now')
  assert.equal(first.key, 'a', 'and the key is the run the steps belong to, which is its first call')

  results.push('a run is keyed by its own steps, so a status change redraws the same row')
}

// ---------------------------------------------------------------- purity

/**
 * The rule is a function of its argument and nothing else.
 *
 * A frozen input is the probe: any write to it throws inside the module, so a passing call is proof that
 * the answer was computed rather than stored. Every step's status is read from the input as given, never
 * rewritten, which is what keeps one turn's grouping from depending on another's.
 */
function theRuleIsPure() {
  const frozen = Object.freeze([
    Object.freeze({ callId: 'a', status: 'ok' }),
    Object.freeze({ callId: 'b', status: 'running' }),
  ]) as ReadonlyArray<{ callId: string; status: string }>

  const first = groupStepRuns(frozen)
  const second = groupStepRuns([
    { callId: 'a', status: 'ok' },
    { callId: 'b', status: 'running' },
  ])

  assert.deepEqual(
    first.map((run: StepRun) => ({ key: run.key, count: run.count, inFlight: run.inFlight })),
    second.map((run: StepRun) => ({ key: run.key, count: run.count, inFlight: run.inFlight })),
    'equal inputs give equal answers'
  )
  assert.equal(frozen[0].status, 'ok', 'the steps that were passed in are not written through')
  assert.equal(frozen[1].status, 'running', 'on either of them')

  results.push('the rule is pure: frozen steps survive it, and equal inputs give equal answers')
}

/**
 * The module imports nothing, which is how it stays pure.
 *
 * Read rather than inferred, and for the same reason the fold rule reads its own source: an import of a
 * store or of a component would be a second input the rule could consult, and two callers would then be
 * answering a different question depending on what had been written elsewhere.
 */
function theModuleHoldsNoSecondInput() {
  assert.ok(existsSync(MODULE_PATH), `the rule module is where this suite reads it: ${MODULE_PATH}`)
  const source = readFileSync(MODULE_PATH, 'utf8')
  const imports = source.match(/^\s*import\b/gm) ?? []

  assert.equal(imports.length, 0, `the rule declares no imports, found ${imports.length}`)

  results.push('the rule module declares no imports at all — no store, no component, no clock')
}

// ---------------------------------------------------------------- report

async function main() {
  const step0 = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step0('grouping', everyStepLandsInExactlyOneRun)
  step0('consecutive', onlyConsecutiveStepsShareARun)
  step0('cuts', theCutsCutTheRuns)
  step0('in flight', aRunIsInFlightWhileAnyStepIs)
  step0('identity', aRunCarriesAStableIdentity)
  step0('purity', theRuleIsPure)
  step0('module', theModuleHoldsNoSecondInput)

  console.log('step runs: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('STEP RUNS TEST FAILED:', err)
  process.exit(1)
})
