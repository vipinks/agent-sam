/**
 * Verifies the rule behind the MCP servers panel's one process control: what a row's status, the call it
 * has in flight, and its last failure make its single button draw, name and dispatch.
 *
 * The counterpart of `mcp-panel-test.ts`, and pure in the same way: a status, a phase and a failure are
 * data in, and a glyph, an action, a word and an enabled flag are data out. This suite imports the rules
 * and nothing else — no store, no component — because a rule a renderer reads must be reachable without
 * one; the button's own wiring is `testing/tools-panel-wiring.test.tsx`'s subject.
 *
 * The status table is written as a `Record` over the panel's own union rather than as four loose cases,
 * so a fifth status the panel learns is a type error here until this file says what its button does. The
 * interesting part is still precedence, which is why the phases and the failure are asserted as pairs: a
 * row can be running *and* have had a start that failed, and which of the two the button is about is the
 * whole of what this rule decides.
 *
 * What the glyph is *called* is the protocol layer's business rather than the component's: the rule names
 * a glyph (`play`, `stop`, `spinner`, `retry`) and the renderer maps that name to the glyph it already
 * imports. Nothing here names a component, and nothing here names a status word either — the one word the
 * rule produces is the verb the button's label and tooltip lead with.
 */
import { strict as assert } from 'node:assert'
import {
  MCP_PANEL_STATUS_FILTERS,
  planMcpServerButton,
  type McpPanelRowStatus,
  type McpServerButtonView,
  type McpPanelProcessPhase,
} from '../../conveyor/protocol/mcp-panel'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** The phase a row is in when its button is not waiting on anything. */
const IDLE: McpPanelProcessPhase = 'idle'

/**
 * What each status draws with nothing in flight and nothing failed.
 *
 * Two statuses share a glyph and a word and differ in one flag, and that is the honest reading rather
 * than a duplication: a switched-off server and a project server whose grant is absent are both servers a
 * start would refuse, so both offer a Start that is disabled. What told them apart was never the control —
 * the switch and the trust chip say it — and the rule says it too, by withholding the click.
 */
const BY_STATUS: Record<McpPanelRowStatus, McpServerButtonView> = {
  running: { glyph: 'stop', action: 'stop', enabled: true, word: 'Stop' },
  stopped: { glyph: 'play', action: 'start', enabled: true, word: 'Start' },
  disabled: { glyph: 'play', action: 'start', enabled: false, word: 'Start' },
  'needs-trust': { glyph: 'play', action: 'start', enabled: false, word: 'Start' },
}

// ---------------------------------------------------------------- the status

function everyStatusDrawsItsOwnGlyphAndDispatchesTheActionItNames() {
  for (const [status, expected] of Object.entries(BY_STATUS) as [McpPanelRowStatus, McpServerButtonView][]) {
    assert.deepEqual(
      planMcpServerButton({ status, phase: IDLE, failed: false }),
      expected,
      `${status} draws ${expected.glyph} and dispatches ${expected.action}`
    )
  }

  // The table is tied to the panel's own list of statuses, so the runtime check agrees with the type
  // check above: a status the filter offers and this file has no entry for would be a status whose button
  // nothing states.
  assert.deepEqual(
    [...MCP_PANEL_STATUS_FILTERS.filter((value) => value !== 'all')].sort(),
    Object.keys(BY_STATUS).sort(),
    'every status the panel classifies has a button here'
  )

  // A running server's control is the Stop, and a stopped one's is the Start: the glyph is the status, so
  // the two must not collapse into one affordance.
  assert.equal(planMcpServerButton({ status: 'running', phase: IDLE, failed: false }).action, 'stop')
  assert.equal(planMcpServerButton({ status: 'stopped', phase: IDLE, failed: false }).action, 'start')

  // And no word the button says is a status word: the label names the action, because the rail is not
  // allowed to state a status in text anywhere.
  for (const view of Object.values(BY_STATUS)) {
    assert.ok(!/Running|Stopped/.test(view.word), `${view.word} is an action, not a status`)
  }

  results.push('each status draws its own glyph, and the two processes dispatch the action they name')
}

// ---------------------------------------------------------------- the phase

function aCallInFlightIsASpinnerThatDispatchesNothing() {
  for (const [phase, word] of [
    ['starting', 'Starting'],
    ['stopping', 'Stopping'],
  ] as const) {
    for (const status of ['stopped', 'running'] as const) {
      assert.deepEqual(
        planMcpServerButton({ status, phase, failed: false }),
        { glyph: 'spinner', action: null, enabled: false, word },
        `a ${phase} row shows the spinner and names ${word}, whatever the mirror says of ${status}`
      )
    }
  }

  // The phase outranks the status, which is the pair that matters: a stop just asked for on a row the
  // mirror still calls running is a row waiting, not a row to be asked again. `enabled: false` is the
  // mechanism — the click is refused rather than accepted and dropped.
  const stopping = planMcpServerButton({ status: 'running', phase: 'stopping', failed: false })
  assert.equal(stopping.action, null, 'a click on a spinner dispatches nothing')
  assert.equal(stopping.enabled, false, 'and the button refuses it rather than ignoring it')

  results.push('a call in flight is a disabled spinner naming the word it is doing')
}

// ---------------------------------------------------------------- the failure

function aFailedStartOffersARetryOfThatSameStart() {
  assert.deepEqual(
    planMcpServerButton({ status: 'stopped', phase: IDLE, failed: true }),
    { glyph: 'retry', action: 'start', enabled: true, word: 'Retry' },
    'a failed start offers the same start again, under a glyph that says it failed'
  )

  // A process that answers outranks a stale failure: whatever the last attempt did, a refresh that found
  // tools behind this id means the row is about stopping it. Offering a retry there would ask for a start
  // main would refuse.
  assert.deepEqual(
    planMcpServerButton({ status: 'running', phase: IDLE, failed: true }),
    BY_STATUS.running,
    'a running row is a Stop even after a start that failed'
  )

  // And where a start is not permitted, the retry is not offered as a live control: the flag and the
  // grant decide, and the button falls back to the disabled Start its status gives it rather than naming
  // an action the row cannot take.
  assert.deepEqual(planMcpServerButton({ status: 'disabled', phase: IDLE, failed: true }), BY_STATUS.disabled)
  assert.deepEqual(planMcpServerButton({ status: 'needs-trust', phase: IDLE, failed: true }), BY_STATUS['needs-trust'])

  // A failure is only a failure of the start. A row whose stop failed was left running by it, and the row
  // that says what went wrong is the panel's line, not a second start.
  assert.equal(
    planMcpServerButton({ status: 'stopped', phase: IDLE, failed: false }).glyph,
    'play',
    'with nothing failed, a stopped row is a plain Play'
  )

  results.push('a failed start offers a retry, and a running row keeps its Stop')
}

// ---------------------------------------------------------------- purity

function theRuleIsPureOverItsInputs() {
  const input = Object.freeze({ status: 'stopped', phase: IDLE, failed: false } as const)
  const first = planMcpServerButton(input)
  const second = planMcpServerButton(input)

  assert.deepEqual(second, first, 'the same input answers the same way twice')
  assert.notEqual(second, first, 'and each call answers with a value of its own rather than a shared one')
  assert.deepEqual(input, { status: 'stopped', phase: IDLE, failed: false }, 'while the input is left as it was')

  // Exactly the four facts the button reads and no more: a rule that leaked a fifth would be one the
  // component would have to ignore, which is how a status comes to be drawn twice.
  assert.deepEqual(Object.keys(planMcpServerButton({ status: 'running', phase: IDLE, failed: false })).sort(), [
    'action',
    'enabled',
    'glyph',
    'word',
  ])

  results.push('the rule is pure over its inputs, and answers with the four facts and no others')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('status', everyStatusDrawsItsOwnGlyphAndDispatchesTheActionItNames)
  step('phase', aCallInFlightIsASpinnerThatDispatchesNothing)
  step('failure', aFailedStartOffersARetryOfThatSameStart)
  step('purity', theRuleIsPureOverItsInputs)

  console.log(`mcp panel button: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err: unknown) {
  console.error('MCP PANEL BUTTON TEST FAILED:', err)
  process.exit(1)
}
