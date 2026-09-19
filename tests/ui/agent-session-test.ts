/**
 * Verifies the renderer's agent-session reducer: turning agent chunks into transcript turns.
 *
 * This is the half the component leans on, so it is tested on its own — no DOM, no React. The point
 * is that a chunk stream produces the right cards and the right statuses, including the awkward
 * cases: a result arriving for a call that is not there, marker text that only looks like a chunk,
 * and a pause that cannot be resumed.
 */
import { strict as assert } from 'node:assert'
import {
  applyAgentChunk,
  resolveDecision,
  startAssistantTurn,
  startUserTurn,
  toHistory,
} from '../../app/components/workbench/agent-session'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** Apply a run of chunks, as the panel does, and hand back the final transcript. */
function run(chunks: unknown[]) {
  const user = startUserTurn('do it')
  const assistant = startAssistantTurn()
  let turns = [user, assistant]
  const effects: Array<Record<string, unknown>> = []
  for (const chunk of chunks) {
    const out = applyAgentChunk(turns, assistant.id, chunk)
    turns = out.turns
    effects.push(out.effect as Record<string, unknown>)
  }
  return { turns, effects, assistantId: assistant.id }
}

// ---------------------------------------------------------------- text

function textAccumulates() {
  const { turns } = run([
    { type: 'text_delta', text: 'Read' },
    { type: 'text_delta', text: 'ing now.' },
  ])
  assert.equal(turns[1].content, 'Reading now.', 'deltas should accumulate in order')
  assert.equal(turns[1].steps.length, 0)
  results.push('text deltas accumulate into the assistant turn')
}

// ---------------------------------------------------------------- tool steps

function toolLifecycle() {
  const { turns, effects } = run([
    { type: 'text_delta', text: 'Let me look. ' },
    { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'src/app.ts' } },
    { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'file body' },
    { type: 'text_delta', text: 'It exports App.' },
  ])

  const turn = turns[1]
  assert.equal(turn.steps.length, 1, 'one card for one call')
  assert.equal(turn.steps[0].callId, 'a1')
  assert.equal(turn.steps[0].tool, 'read_file')
  assert.equal(turn.steps[0].status, 'ok', 'a successful result settles the card')
  assert.equal(turn.steps[0].output, 'file body', 'the output is kept for the card to show')
  assert.equal(turn.content, 'Let me look. It exports App.', 'prose continues around the call')
  assert.equal(effects.length, 4)

  results.push('a call and its result become one card, with prose either side')
}

function failedResult() {
  const { turns } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'write_file', args: { path: '../x' } },
    { type: 'tool_result', callId: 'a1', tool: 'write_file', ok: false, code: 'PATH_TRAVERSAL', output: 'refused' },
  ])
  const step0 = turns[1].steps[0]
  assert.equal(step0.status, 'failed', 'a refusal must not look like a success')
  assert.equal(step0.code, 'PATH_TRAVERSAL', 'the code is carried for the UI to branch on')
  results.push('a refused tool is shown as failed, with its code')
}

function resultForAnUnknownCallIsIgnored() {
  const { turns } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: {} },
    // A late chunk from a cancelled run, or a result for a call this build never saw.
    { type: 'tool_result', callId: 'ghost', tool: 'read_file', ok: true, output: 'x' },
  ])
  assert.equal(turns[1].steps.length, 1, 'a stray result must not invent a second card')
  assert.equal(turns[1].steps[0].status, 'running', 'and must not settle an unrelated card')
  results.push('a result for an unknown call is ignored')
}

function multipleCallsInOneTurn() {
  const { turns } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: { path: 'one' } },
    { type: 'tool_call_start', callId: 'a2', tool: 'read_file', args: { path: 'two' } },
    { type: 'tool_result', callId: 'a2', tool: 'read_file', ok: true, output: '2' },
  ])
  const steps = turns[1].steps
  assert.equal(steps.length, 2, 'a batch should produce a card per call')
  assert.equal(steps[0].status, 'running', 'the unsettled call stays running')
  assert.equal(steps[1].status, 'ok', 'the settled one is marked ok')
  results.push('a batch of calls produces a card each, settled independently')
}

// ---------------------------------------------------------------- the consent pause

function pauseIsReported() {
  const call = { id: 'a1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }
  const { turns, effects } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'write_file', args: { path: 'x' } },
    {
      type: 'awaiting_approval',
      callId: 'a1',
      tool: 'write_file',
      args: { path: 'x' },
      messages: [{ role: 'user', content: 'do it' }],
      calls: [call],
      steps: 1,
    },
  ])

  assert.equal(turns[1].steps[0].status, 'awaiting', 'the card must show it needs a decision')
  const approval = effects[1].approval as Record<string, unknown> | undefined
  assert.ok(approval, 'the pause must be reported as an effect')
  assert.equal(approval.callId, 'a1')
  assert.deepEqual(approval.calls, [call], 'the model calls are carried through for resume')
  assert.ok(Array.isArray(approval.messages), 'the history is carried through')

  results.push('a pause is reported with its calls and history to resume with')
}

/**
 * One decision covers every gated call in the turn, so every one of their cards must say so — not
 * just the call the pause names. Leaving a sibling showing "running" would misreport a run that is
 * actually blocked on the user.
 */
function everyGatedCallIsMarked() {
  const calls = [
    { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a"}' } },
    { id: 'w2', type: 'function', function: { name: 'run_command', arguments: '{"command":"x"}' } },
  ]
  const { turns, effects } = run([
    { type: 'tool_call_start', callId: 'w1', tool: 'write_file', args: { path: 'a' } },
    { type: 'tool_call_start', callId: 'w2', tool: 'run_command', args: { command: 'x' } },
    { type: 'awaiting_approval', callId: 'w1', tool: 'write_file', args: { path: 'a' }, messages: [], calls, steps: 1 },
  ])

  assert.equal(turns[1].steps[0].status, 'awaiting', 'the named call waits')
  assert.equal(turns[1].steps[1].status, 'awaiting', 'so does its sibling, which one decision also answers')
  assert.deepEqual((effects[2].approval as Record<string, unknown>).calls, calls)

  results.push('every call in a gated batch is marked as awaiting the one decision')
}

function pauseWithoutACallIsNotActionable() {
  const { effects } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'write_file', args: {} },
    { type: 'awaiting_approval', callId: 'a1', tool: 'write_file', args: {}, messages: [], steps: 0 },
  ])
  // Nothing to resume with, so it must not be offered as an approval — otherwise the card would
  // wait for a button press that cannot lead anywhere.
  assert.equal(effects[1].approval, undefined, 'a pause with no call cannot be resumed')
  results.push('a pause lacking its calls is not offered as an approval')
}

function decisions() {
  const { turns, assistantId } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'write_file', args: { path: 'x' } },
  ])

  const denied = resolveDecision(turns, assistantId, 'a1', false)
  assert.equal(denied[1].steps[0].status, 'denied', 'denial settles the card')
  assert.ok(denied[1].steps[0].output, 'and says so, rather than leaving it blank')

  const approved = resolveDecision(turns, assistantId, 'a1', true)
  assert.equal(approved[1].steps[0].status, 'running', 'approval puts it back to running')
  assert.equal(approved[1].steps[0].output, undefined, 'with no stale output')

  results.push('approval resumes the card and denial records it')
}

// ---------------------------------------------------------------- history

function historyIsTextOnly() {
  const { turns } = run([
    { type: 'tool_call_start', callId: 'a1', tool: 'read_file', args: {} },
    { type: 'tool_result', callId: 'a1', tool: 'read_file', ok: true, output: 'body' },
  ])
  const history = toHistory(turns)

  assert.deepEqual(history, [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: '' },
  ])
  // The agent owns the provider-shaped history, so this must not try to reproduce tool turns.
  assert.ok(!history.some((m) => 'tool_calls' in m), 'tool turns must not be rebuilt here')
  results.push('history stays text-only; the agent owns the tool turns')
}

function erroredTurnsAreNotSent() {
  const { turns } = run([{ type: 'text_delta', text: 'partial' }])
  turns[1] = { ...turns[1], error: 'provider failed' }
  const history = toHistory(turns)
  assert.equal(history.length, 1, 'a failed turn must not be replayed to the provider')
  assert.equal(history[0].role, 'user')
  results.push('a failed assistant turn is dropped from history')
}

// ---------------------------------------------------------------- robustness

function junkChunks() {
  const { turns, effects } = run([
    null,
    'not an object',
    42,
    { type: 'something_new', payload: 1 },
    { type: 'text_delta' },
  ])
  assert.equal(turns[1].content, '', 'a text delta without text adds nothing')
  assert.equal(turns[1].steps.length, 0, 'junk must not create cards')
  assert.equal(effects[4].textDelta, '', 'and reports an empty delta rather than throwing')
  results.push('unknown and malformed chunks are ignored, not fatal')
}

function identityIsPreserved() {
  const user = startUserTurn('hi')
  const assistant = startAssistantTurn()
  const before = [user, assistant]
  const after = applyAgentChunk(before, assistant.id, { type: 'text_delta', text: 'x' }).turns

  assert.equal(after[0], user, 'an untouched turn must keep its identity so memo can skip it')
  assert.notEqual(after[1], assistant, 'the changed turn is replaced')
  results.push('only the changed turn is replaced, so memo still skips the rest')
}

function doneIsReported() {
  const { effects } = run([{ type: 'text_delta', text: 'hi' }, { type: 'done', reason: 'complete', steps: 2 }])
  assert.deepEqual(effects[1].done, { reason: 'complete' })

  const capped = run([{ type: 'done', reason: 'max_steps', steps: 10 }])
  assert.deepEqual(capped.effects[0].done, { reason: 'max_steps' })
  results.push('completion and the step cap are both reported')
}

function main() {
  step('text', textAccumulates)
  step('tool lifecycle', toolLifecycle)
  step('failed result', failedResult)
  step('unknown call', resultForAnUnknownCallIsIgnored)
  step('multiple calls', multipleCallsInOneTurn)
  step('pause', pauseIsReported)
  step('every gated call marked', everyGatedCallIsMarked)
  step('pause without a call', pauseWithoutACallIsNotActionable)
  step('decisions', decisions)
  step('history', historyIsTextOnly)
  step('failed turns', erroredTurnsAreNotSent)
  step('junk chunks', junkChunks)
  step('identity', identityIsPreserved)
  step('done', doneIsReported)

  console.log(`agent session: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
