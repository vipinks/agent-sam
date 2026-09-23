/**
 * Verifies the `set_plan` tool through the loop and into the transcript — no network, no keys.
 *
 * Two properties are the point of this suite, and neither is visible from the pure rules alone.
 *
 * The first is that `set_plan` is never gated. It touches no file, no shell and no network, so a
 * pause in front of it would be a consent dialog with nothing behind it — and a consent dialog with
 * nothing behind it is how a user is trained to click through the ones that matter. The mocked
 * provider declares a plan with the approval gate armed (`autoApprove: false`) and the chunk
 * sequence is asserted to contain no pause.
 *
 * The second is what the turn records. A plan declares work that is happening *now*, so a turn that
 * ends with a step still in progress must be recorded as interrupted: the transcript is read back
 * after a restart, and a stored plan claiming to be running in a process that has restarted is a
 * claim the app cannot support. The chunks are therefore fed through the real reducer and the real
 * serializer, so what is asserted is the file's contents rather than the loop's intentions.
 */
import { strict as assert } from 'node:assert'
import { applyAgentChunk, endTurnPlan, type AgentTurn } from '../../app/components/workbench/agent-session'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { executeTool, needsApproval, runAgentLoop } from '../../conveyor/modules/agent'
import { MAX_PLAN_STEPS, type PlanStep } from '../../conveyor/protocol/plan'
import { TRANSCRIPT_VERSION } from '../../conveyor/protocol/transcript'

const results: string[] = []

/** Build a Response whose body is the given SSE text, chunked however the caller likes. */
function sseResponse(frames: string[], chunkSize = 64): Response {
  const payload = frames.map((f) => `data: ${f}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/**
 * A `set_plan` call spread across frames, with its arguments split mid-string.
 *
 * Deliberately fragmented: the loop accumulates a call's id, name and arguments from separate
 * frames, and a plan is the one tool whose arguments are a structure rather than a path, so this is
 * where a fragmenting bug would show as a plan of one step with truncated text.
 */
function planCallFrames(callId: string, steps: readonly PlanStep[]): string[] {
  const args = JSON.stringify({ steps })
  const half = Math.floor(args.length / 2)
  return [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'set_plan', arguments: '' } }],
          },
        },
      ],
    }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }],
    }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }],
    }),
    '[DONE]',
  ]
}

/** A round-trip that answers with prose, which is what ends the loop. */
function proseFrames(text: string): string[] {
  return [JSON.stringify({ choices: [{ delta: { content: text } }] }), '[DONE]']
}

/** A provider that answers each request with the next scripted round. */
function scriptedFetch(rounds: string[][], log: unknown[]): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push(JSON.parse(String(init.body)))
    const frames = rounds[Math.min(call - 1, rounds.length - 1)]
    return sseResponse(frames)
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

/** Run one scripted conversation through the real loop, with the approval gate armed. */
async function runLoop(rounds: string[][]): Promise<Array<Record<string, unknown>>> {
  const log: unknown[] = []
  return collect(
    runAgentLoop({
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      // No folder is open: planning is not an action, so it must not need one.
      workspaceRoot: null,
      messages: [{ role: 'user', content: 'refactor the parser' }],
      autoApprove: false,
      signal: new AbortController().signal,
      fetchImpl: scriptedFetch(rounds, log) as never,
    })
  )
}

/**
 * Feed a run's chunks through the real reducer, end the turn, then freeze it the way a save does.
 *
 * Three real steps, in the order the pane performs them: chunks accumulate on the turn, the turn end
 * reconciles a plan that still claims to be running, and the serializer writes what is left. Anything
 * less would assert a plan the app never produces.
 */
function record(chunks: Array<Record<string, unknown>>): ReturnType<typeof serializeTranscript> {
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  return serializeTranscript({ turns: endTurnPlan(turns, 'assistant-1'), interrupted: false })
}

const DECLARED: PlanStep[] = [
  { id: 'read', text: 'Read the parser', status: 'in_progress' },
  { id: 'tests', text: 'Add tests for it', status: 'pending' },
]

async function declaredPlan() {
  const chunks = await runLoop([planCallFrames('call_1', DECLARED), proseFrames('Planned.')])

  // The notice is part of the sequence now, and the plan in it is why: this turn declared two steps
  // and finished neither, so the ordinary ending is not silent about it any more. The order is what is
  // asserted — the notice lands between the ending and the `done`, so a client that stopped reading at
  // `turn_end` would still be handed it.
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['tool_call_start', 'tool_result', 'plan', 'text_delta', 'turn_end', 'turn_end_notice', 'done'],
    `unexpected chunk sequence: ${JSON.stringify(chunks.map((c) => c.type))}`
  )
  assert.equal((chunks[5].unfinishedSteps as number) ?? null, 2, 'and it names the two steps the turn left open')

  // The exemption, asserted rather than assumed: an ungated call is the whole reason a plan can be
  // declared mid-turn without the run stopping to ask.
  assert.equal(needsApproval('set_plan'), false, 'set_plan touches nothing, so nothing needs consent')
  assert.ok(!chunks.some((c) => c.type === 'awaiting_approval'), 'a plan declaration must never pause for approval')

  // The call was assembled from fragments and answered as a success.
  assert.equal(chunks[0].tool, 'set_plan')
  assert.equal(chunks[1].ok, true, `set_plan should have been accepted: ${String(chunks[1].output)}`)

  // The chunk carries the plan itself, in the model's order, with its statuses intact.
  const plan = chunks[2].plan as PlanStep[]
  assert.deepEqual(plan, DECLARED, `the plan chunk must carry the declared plan: ${JSON.stringify(plan)}`)

  // And the turn stores it. The model finished its answer, but a step it left in progress is work
  // that is not happening any more — the turn is over, so the record says interrupted.
  const snapshot = record(chunks)
  assert.equal(snapshot.version, TRANSCRIPT_VERSION, 'storing a plan must not move the transcript version')

  // The turn was live as `in_progress` first: the reconcile above happens at the turn end, and a plan
  // that read as interrupted from the moment it arrived would be a checklist that never shows work
  // in flight. Asserted from the chunks alone, before any turn end is applied.
  const live = chunks.reduce<AgentTurn[]>(
    (turns, chunk) => applyAgentChunk(turns, 'assistant-1', chunk).turns,
    [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  )
  assert.equal(live[0].plan?.[0].status, 'in_progress', 'the plan is live while the turn is running')
  assert.deepEqual(
    snapshot.turns[0].plan,
    [
      { id: 'read', text: 'Read the parser', status: 'interrupted' },
      { id: 'tests', text: 'Add tests for it', status: 'pending' },
    ],
    `a turn that ended mid-plan must record it as interrupted: ${JSON.stringify(snapshot.turns[0].plan)}`
  )

  // And it survives the round trip a session load performs.
  assert.deepEqual(rehydrateTranscript(snapshot).turns[0].plan, snapshot.turns[0].plan, 'a stored plan reads back')
}

async function mergedDeclarations() {
  const chunks = await runLoop([
    planCallFrames('call_1', DECLARED),
    // The second declaration updates one id, omits the other, and adds a new one: an update must
    // update, must not drop what it left out, and must append what it added.
    planCallFrames('call_2', [
      { id: 'read', text: 'Read the parser', status: 'done' },
      { id: 'ship', text: 'Summarise the change', status: 'pending' },
    ]),
    proseFrames('Done.'),
  ])

  const plans = chunks.filter((c) => c.type === 'plan').map((c) => c.plan as PlanStep[])
  assert.equal(plans.length, 2, 'each declaration yields a chunk')
  assert.deepEqual(
    plans[1].map((s) => [s.id, s.status]),
    [
      ['read', 'done'],
      ['tests', 'pending'],
      ['ship', 'pending'],
    ],
    `the second chunk must carry the merged plan: ${JSON.stringify(plans[1])}`
  )

  // The turn's own record is the merged result, with the step left in progress reconciled away.
  assert.deepEqual(
    record(chunks).turns[0].plan?.map((s) => s.status),
    ['done', 'pending', 'pending']
  )
}

async function planStaysAbsent() {
  // An empty list is not an empty checklist: a plan with nothing in it is no plan, and a chunk
  // announcing one would put a box on screen with nothing to read.
  const chunks = await runLoop([planCallFrames('call_1', []), proseFrames('Nothing to plan.')])
  assert.ok(!chunks.some((c) => c.type === 'plan'), 'an empty declaration yields no plan chunk')
  assert.equal(record(chunks).turns[0].plan, undefined, 'an empty plan is stored as no plan at all')

  // A turn that never declared one carries no key, which is what keeps pre-plan snapshots valid.
  const plain = record([{ type: 'text_delta', text: 'hello' }])
  assert.equal('plan' in (plain.turns[0] as object), false, 'an ordinary turn carries no plan key')
}

async function planIsBounded() {
  const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
    id: `s${i}`,
    text: `Step ${i}`,
    status: 'pending',
  }))

  const outcome = await executeTool('set_plan', JSON.stringify({ steps: many }), null, new AbortController().signal)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'INVALID_TOOL_ARGS', 'a plan beyond the cap is refused by the schema, not truncated')
}

async function main() {
  const suites: Array<[string, () => Promise<void>]> = [
    ['a declared plan reaches the renderer ungated', declaredPlan],
    ['a second declaration merges over the first', mergedDeclarations],
    ['an empty plan stays absent', planStaysAbsent],
    ['a plan beyond the cap is refused', planIsBounded],
  ]

  let failed = 0
  for (const [name, run] of suites) {
    try {
      await run()
      results.push(`  ok    ${name}`)
    } catch (err) {
      failed += 1
      results.push(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(results.join('\n'))
  if (failed) {
    console.error(`\n${failed} of ${suites.length} plan suite(s) failed`)
    process.exit(1)
  }
  console.log(`\nall ${suites.length} plan checks passed`)
}

void main()
