/**
 * Verifies the one rule the collapsible sections share: a step's section is open while the step is in
 * flight, folds the moment the step completes, and stops answering to that rule once the user has
 * toggled it by hand.
 *
 * The rule lives in `conveyor/protocol` rather than inside the two components that read it — the
 * thinking block and the tool-call card — because the decision is the thing worth testing, and a rule
 * test can state the whole of it: the three events, the flag that records a manual toggle, what a
 * second tick changes and what it leaves alone. Whether the two components are wired to it is a
 * separate claim, made in `testing/section-collapse-wiring.test.tsx`.
 *
 * Purity is asserted rather than assumed, and twice over: the rule is called on a frozen state and the
 * state is checked to come back unmodified, and the module's own source is read to confirm it imports
 * nothing at all — so it cannot consult a store, a component or a clock, and cannot grow a second input
 * that two callers could disagree about.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  advanceSectionCollapse,
  openingSectionCollapse,
  SECTION_FOLDED,
  type SectionCollapse,
  type SectionCollapseEvent,
} from '../../conveyor/protocol/collapse'

const results: string[] = []

/** The three things that can happen to a section, in the order this suite walks them. */
const EVENTS: readonly SectionCollapseEvent[] = ['started', 'completed', 'toggled']

/** Where the module under test lives, from the root the suite is run from. */
const MODULE_PATH = join(process.cwd(), 'conveyor', 'protocol', 'collapse.ts')

// ---------------------------------------------------------------- opening state

/**
 * A section mounts in the state its step is already in.
 *
 * The two cases are the two ways a section can appear: a card that arrives `running` or with the
 * transcript reopened mid-run is in flight as it mounts and must be open, and a card read back from
 * yesterday is finished as it mounts and must be folded — which is the state a conversation reopened
 * tomorrow is read in, so nothing folds itself in front of the reader.
 */
function openingStateFollowsTheStep() {
  const inFlight = openingSectionCollapse(true)
  assert.equal(inFlight.expanded, true, 'a step in flight opens its section as it mounts')
  assert.equal(inFlight.manual, false, 'and claims nothing: no toggle has happened')

  const complete = openingSectionCollapse(false)
  assert.equal(complete.expanded, false, 'a step already finished mounts folded')
  assert.equal(complete.manual, false, 'and unclaimed too')

  assert.equal(SECTION_FOLDED.expanded, false, 'the shared folded state is folded')
  assert.equal(SECTION_FOLDED.manual, false, 'and unclaimed')

  results.push('a section mounts open while its step is in flight, and folded once it is not')
}

// ---------------------------------------------------------------- the in-flight transition

/**
 * Going in flight opens the section and clears the manual flag.
 *
 * Clearing is the load-bearing half: the flag means "the user has taken this one over", and a step that
 * starts running again is a new step as far as the rule is concerned — the section belongs to the run
 * again until the run is over.
 */
function inFlightOpensAndClearsTheClaim() {
  const opened = advanceSectionCollapse(SECTION_FOLDED, 'started')
  assert.equal(opened.expanded, true, 'in flight opens the section')
  assert.equal(opened.manual, false, 'and leaves it unclaimed')

  const reopened = advanceSectionCollapse({ expanded: false, manual: true }, 'started')
  assert.equal(reopened.expanded, true, 'a new in-flight period re-opens a section the user folded')
  assert.equal(reopened.manual, false, 'and clears the manual flag with it')

  // The tick that changes nothing. A stream ticks this event repeatedly while a step runs, so a state
  // this event cannot improve is returned as it stands — an equal-but-new object per frame would be a
  // re-render per frame for a section that is already where it should be.
  const alreadyOpen: SectionCollapse = { expanded: true, manual: false }
  assert.equal(
    advanceSectionCollapse(alreadyOpen, 'started'),
    alreadyOpen,
    'an open, unclaimed section is left as it is'
  )

  results.push('in flight opens the section, clears the manual flag, and leaves an open one alone')
}

// ---------------------------------------------------------------- the completion transition

/**
 * Completing folds the section, unless a manual toggle is recorded.
 *
 * This is the whole of the auto-collapse: the transition out of flight is the only event that folds
 * anything, and it folds nothing the user has claimed.
 */
function completionFoldsUnclaimedSections() {
  const folded = advanceSectionCollapse({ expanded: true, manual: false }, 'completed')
  assert.equal(folded.expanded, false, 'the transition to complete folds the section')
  assert.equal(folded.manual, false, 'and claims nothing on the way out')

  const claimed: SectionCollapse = { expanded: true, manual: true }
  const kept = advanceSectionCollapse(claimed, 'completed')
  assert.equal(kept, claimed, 'a completion tick leaves a section the user has claimed exactly as it is')

  const alreadyFolded: SectionCollapse = { expanded: false, manual: false }
  assert.equal(
    advanceSectionCollapse(alreadyFolded, 'completed'),
    alreadyFolded,
    'and a folded unclaimed section is not disturbed by a repeat tick'
  )

  results.push('completion folds an unclaimed section and leaves a claimed one open')
}

// ---------------------------------------------------------------- the manual toggle

/**
 * A toggle is the user's, and it sticks.
 *
 * What "sticks" means is asserted as reference equality on through-ticks: the rule returns the state it
 * was handed, so no later completion tick can re-fold a section the user has just opened by hand. The
 * flag is set on either direction of the toggle — a section the user folded by hand is theirs too, and
 * a rule that only recorded the opening direction would re-open it on the next completion.
 */
function aManualToggleSticks() {
  const opened = advanceSectionCollapse(SECTION_FOLDED, 'toggled')
  assert.equal(opened.expanded, true, 'a toggle on a folded section opens it')
  assert.equal(opened.manual, true, 'and records the hand that did it')

  const throughTicks = advanceSectionCollapse(opened, 'completed')
  assert.equal(throughTicks, opened, 'the next completion tick leaves it open')
  assert.equal(advanceSectionCollapse(throughTicks, 'completed'), opened, 'and the one after that')

  const closed = advanceSectionCollapse(opened, 'toggled')
  assert.equal(closed.expanded, false, 'a second toggle folds it again')
  assert.equal(closed.manual, true, 'still claimed')
  assert.equal(advanceSectionCollapse(closed, 'completed'), closed, 'and a folded claimed section stays folded')

  results.push('a manual toggle sticks, through every completion tick that follows it')
}

// ---------------------------------------------------------------- purity

/**
 * The rule is a function of its two arguments and nothing else.
 *
 * A frozen state is the probe: any write to it throws inside the module, so a passing call is proof
 * that the answer was computed rather than stored. The same call is then made twice on equal inputs,
 * because a rule that answered differently the second time would be reading something besides them.
 */
function theRuleIsPure() {
  const frozen = Object.freeze({ expanded: true, manual: false }) as SectionCollapse

  for (const event of EVENTS) {
    const first = advanceSectionCollapse(frozen, event)
    const second = advanceSectionCollapse({ expanded: true, manual: false }, event)
    assert.deepEqual(first, second, `${event}: equal inputs give equal answers`)
  }

  assert.equal(frozen.expanded, true, 'the state that was passed in is not written through')
  assert.equal(frozen.manual, false, 'on either field')

  // A changed answer is a new state, never the argument handed back with a field rewritten: the
  // components compare states by identity, and an in-place edit would be invisible to them.
  const changed = advanceSectionCollapse(frozen, 'completed')
  assert.notEqual(changed, frozen, 'a change is a new object')
  assert.equal(frozen.expanded, true, 'and the one it replaced still says what it said')

  const events = new Set(EVENTS)
  assert.equal(events.size, 3, 'three events are covered here, and they are all the rule takes')

  results.push('the rule is pure: frozen inputs survive it, and equal inputs give equal answers')
}

/**
 * The module imports nothing, which is how it stays pure.
 *
 * Read rather than inferred: an import of a store or of a component would be a second input the rule
 * could consult, and the two callers would then be answering a different question depending on what had
 * been written elsewhere. The file is small enough that an import statement is the whole of what could
 * be there besides the rule.
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
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('mount', openingStateFollowsTheStep)
  step('in flight', inFlightOpensAndClearsTheClaim)
  step('completion', completionFoldsUnclaimedSections)
  step('manual toggle', aManualToggleSticks)
  step('purity', theRuleIsPure)
  step('module', theModuleHoldsNoSecondInput)

  console.log('section collapse: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('SECTION COLLAPSE TEST FAILED:', err)
  process.exit(1)
})
