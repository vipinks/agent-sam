/**
 * Verifies the plan-unfinished notice through the real loop, against a mocked provider — no network, no
 * keys.
 *
 * The pure rule is asserted in `testing/turn-end-rules.test.ts`. What can only be seen here is whether
 * the loop that ends a turn actually reaches it, with the plan the turn was working from. Three things
 * are the point.
 *
 * The first is the ordinary ending that used to be silent: the model stops on its own with steps still
 * on the plan, and the turn says so. That is the case the notice exists for, and it is the one a
 * cause-keyed rule would have missed.
 *
 * The second is that a pause carries the plan with it. The resumed run is a *new* run with an empty
 * plan of its own, so a plan that is not handed back is a plan the resumed turn cannot report on — and
 * a turn that cannot report on it is the silent ending again, one round-trip later.
 *
 * The third is the shape of the notice itself: one chunk, naming both facts when both are true, so a
 * truncated turn with an unfinished plan reports the cut reply and the unfinished work rather than
 * either alone. The chunks are fed through the real reducer and the real serializer, so what is
 * asserted is the transcript's contents rather than the loop's intentions.
 */
import { strict as assert } from 'node:assert'
import {
  applyAgentChunk,
  currentEndNotice,
  endTurnPlan,
  type AgentTurn,
} from '../../app/components/workbench/agent-session'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { runAgentLoop, MAX_STEPS } from '../../conveyor/modules/agent'
import { agentSystemPrompt } from '../../conveyor/protocol/context'
import type { PlanStep } from '../../conveyor/protocol/plan'
import { AUTO_CONTINUE_MAX, RESUME_MESSAGE } from '../../conveyor/protocol/turn-end'

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

/** One frame reporting where the reply ended. */
function stopFrame(reason: string): string {
  return JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })
}

function proseFrames(text: string, reason = 'stop'): string[] {
  return [JSON.stringify({ choices: [{ delta: { content: text } }] }), stopFrame(reason), '[DONE]']
}

/** A `set_plan` call, declared the way the model declares one. */
function planFrames(callId: string, steps: readonly PlanStep[]): string[] {
  const args = JSON.stringify({ steps })
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
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }),
    stopFrame('tool_calls'),
    '[DONE]',
  ]
}

/** A `write_file` call, which is the one that needs consent before it can run. */
function writeFrames(callId: string, path: string): string[] {
  const args = JSON.stringify({ path, content: 'x\n' })
  return [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'write_file', arguments: '' } }],
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }),
    stopFrame('tool_calls'),
    '[DONE]',
  ]
}

/** A tool call as the model sent it, and as the pause hands it back. */
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

/** A provider that answers each request with the next scripted round, and logs what it was sent. */
function scriptedFetch(
  rounds: Array<string[] | Response>,
  log: Array<{ messages: Array<{ role: string; content: string }> }>
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push(JSON.parse(String(init.body)))
    const round = rounds[Math.min(call - 1, rounds.length - 1)]
    return Array.isArray(round) ? sseResponse(round) : round
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

interface RunOptions {
  rounds: Array<string[] | Response>
  messages?: Array<Record<string, unknown>>
  pending?: Record<string, unknown>
  plan?: readonly PlanStep[]
  steps?: number
  /** Auto-continuations this turn has already spent, for the endings the loop will not pick up again. */
  continuations?: number
}

async function runLoop(opts: RunOptions): Promise<{
  chunks: Array<Record<string, unknown>>
  sent: Array<{ messages: Array<{ role: string; content: string }> }>
}> {
  const sent: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const chunks = await collect(
    runAgentLoop({
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      // No folder is open: planning and diagnosis are not actions, so neither needs one.
      workspaceRoot: null,
      messages: (opts.messages ?? [{ role: 'user', content: 'refactor the parser' }]) as never,
      autoApprove: false,
      signal: new AbortController().signal,
      fetchImpl: scriptedFetch(opts.rounds, sent) as never,
      ...(opts.pending ? { pending: opts.pending as never } : {}),
      ...(opts.plan ? { plan: opts.plan } : {}),
      ...(opts.steps !== undefined ? { steps: opts.steps } : {}),
      ...(opts.continuations !== undefined ? { continuations: opts.continuations } : {}),
    })
  )
  return { chunks, sent }
}

/** Feed a run's chunks through the real reducer, end the turn, then freeze it the way a save does. */
function record(chunks: Array<Record<string, unknown>>): ReturnType<typeof serializeTranscript> {
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  return serializeTranscript({ turns: endTurnPlan(turns, 'assistant-1'), interrupted: false })
}

/** The notice chunk of a run, if it had one. */
function notice(chunks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === 'turn_end_notice')
}

/** The system messages a request carried, which is what the injection rule is about. */
function systems(sent: Array<{ messages: Array<{ role: string; content: string }> }>, index = 0): string[] {
  return (sent[index]?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content)
}

const DISCIPLINE = 'set_plan immediately when a step transitions to done or interrupted'

// ---------------------------------------------------------------- the ordinary ending

async function aCleanStopMidPlanAnnouncesItself() {
  const { chunks } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      proseFrames('I have started on the precedence table.'),
    ],
  })

  // The ending the card used to be silent on: the model stopped by itself, and the work is not done.
  assert.equal(chunks.at(-2)?.type, 'turn_end_notice', 'a clean stop mid-plan announces itself')
  assert.equal(chunks.at(-1)?.type, 'done', 'and the run still ends the ordinary way')
  assert.equal(notice(chunks)?.cause, 'model_stop', 'naming the ending it actually had')
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'and counting what is left: the step under way and the one after it')
  assert.equal(notice(chunks)?.resumable, true, 'as work that can be picked up, though the reply itself was complete')

  // The turn as it is stored: reconciled, and carrying the same count.
  const saved = record(chunks)
  assert.equal(
    saved.turns[0].plan?.some((step) => step.status === 'in_progress'),
    false,
    'nothing still runs'
  )
  assert.equal(saved.turns[0].endNotice?.unfinishedSteps, 2, 'and the notice is part of the record')

  // And the card read back from it is history: same news, nothing to click.
  const restored = rehydrateTranscript(saved)
  assert.equal(currentEndNotice(restored.turns)?.unfinishedSteps, 2, 'a reopened conversation still says so')
  assert.equal(currentEndNotice(restored.turns)?.resumable, false, 'without offering to continue a run that is gone')

  results.push('a model that stops cleanly mid-plan yields a notice naming the unfinished steps')
}

async function aFinishedPlanEndsInSilence() {
  const { chunks } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'edit', text: 'Change the table', status: 'pending' },
      ]),
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the table', status: 'done' },
      ]),
      proseFrames('Both steps are done.'),
    ],
  })

  // A plan with nothing left on it is a turn that did its work, and a card under it would be the
  // noise that makes the real one invisible.
  assert.equal(
    chunks.some((chunk) => chunk.type === 'turn_end_notice'),
    false,
    'a finished plan says nothing'
  )
  assert.equal(chunks.at(-1)?.reason, 'complete', 'and the run ends the ordinary way')
  results.push('a fully done plan ends without a notice')
}

async function aCutOffTurnWithAnUnfinishedPlanNamesBoth() {
  // Run with the budget already spent, for the reason `tests/agent/turn-end-test.ts` gives at its own
  // cut-off case: a truncated reply mid-plan is picked up by the loop while it has budget, so the
  // ending this case is about is the one it reaches when it has none.
  const { chunks } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the table', status: 'pending' },
      ]),
      proseFrames('I am halfway through the ta', 'length'),
    ],
    continuations: AUTO_CONTINUE_MAX,
  })

  // One chunk, two facts: the reply was cut off, and work is left. A user told only one of them still
  // needs the other.
  assert.equal(notice(chunks)?.cause, 'truncated', 'the cut reply is named')
  assert.equal(notice(chunks)?.unfinishedSteps, 1, 'and the work it left is named with it')
  assert.equal(chunks.filter((chunk) => chunk.type === 'turn_end_notice').length, 1, 'as one notice, not two')
  results.push('a truncated turn with an unfinished plan names both, in one notice')
}

async function aStoppedRunMidPlanStillSaysWhatIsLeft() {
  // The run hits the step budget with the plan unfinished: the model never got to answer, so the turn
  // ends on a `done` with no reply of its own to diagnose. It is the same silent ending, and it is
  // announced by the same rule.
  const { chunks } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'edit', text: 'Change the table', status: 'pending' },
      ]),
      writeFrames('w1', 'src/parser.ts'),
    ],
    // One step of the budget left, so the declaration above is made and the run then stops before it
    // can ask the model for anything else.
    steps: MAX_STEPS - 1,
  })

  assert.equal(chunks.at(-1)?.reason, 'max_steps', 'the run stops at the budget')
  assert.equal(chunks.at(-2)?.type, 'turn_end_notice', 'and it is not a silent stop')
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'naming the step under way and the one after it')
  assert.equal(notice(chunks)?.resumable, true, 'with a way on, because the work is still there to do')
  results.push('a run stopped at the step budget with a plan unfinished announces it too')
}

// ---------------------------------------------------------------- the pause

async function aPauseCarriesThePlanBackToTheResumedRun() {
  const declared: PlanStep[] = [
    { id: 'read', text: 'Read the parser', status: 'done' },
    { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
    { id: 'tests', text: 'Add tests for it', status: 'pending' },
  ]

  const first = await runLoop({
    rounds: [planFrames('p1', declared), writeFrames('w1', 'src/parser.ts')],
  })

  const paused = first.chunks.find((chunk) => chunk.type === 'awaiting_approval')
  assert.ok(paused, 'the write pauses for consent')
  // Everything a decision needs, and the plan among it: the resumed run starts with an empty plan of
  // its own, so a plan the pause does not carry is a plan the resumed turn cannot report on.
  assert.deepEqual(paused?.plan, declared, 'the pause carries the plan the turn was working from')

  // Now the resume, with the plan handed back the way the renderer hands it back.
  const second = await runLoop({
    rounds: [proseFrames('The table is updated.')],
    messages: paused?.messages as Array<Record<string, unknown>>,
    pending: { calls: paused?.calls, denied: false },
    plan: paused?.plan as PlanStep[],
    steps: paused?.steps as number,
  })

  // The write cannot run without a folder, which is the point: the refusal is fed back and the model
  // answers — and the turn that ends is the plan's turn, not an empty one. A resume that started from
  // an empty plan would report nothing here, which is the failure this case exists to catch.
  //
  // Which is also why the assertions below are about what the plan carried back, not about which budget
  // ends the turn: a plan that came back with two steps still unfinished is a plan the loop now keeps
  // picking the turn up for, so this run spends its auto-continue budget and the model keeps stopping
  // until one of the two budgets runs out. The seams are the stronger evidence for this case's subject —
  // a resume that had lost the plan would have ended on the first stop with none.
  const spent = second.chunks.filter((chunk) => chunk.type === 'auto_continue')
  assert.equal(spent.length > 0, true, 'the plan it carried back is what kept the turn going')
  assert.equal(second.chunks.at(-1)?.type, 'done', 'and it still ends through one of the loop’s endings')
  assert.equal(
    ['complete', 'max_steps'].includes(String(second.chunks.at(-1)?.reason)),
    true,
    `unexpected ending: ${JSON.stringify(second.chunks.at(-1))}`
  )
  assert.equal(
    notice(second.chunks)?.unfinishedSteps,
    2,
    'and the plan survived the pause: the step the ending interrupted, and the one never started'
  )
  results.push('a pause carries the plan, so the resumed turn can still report what is unfinished')
}

// ---------------------------------------------------------------- the injection

async function theInjectionCarriesTheDisciplineOnceAndOnlyWhenItIsAbsent() {
  const fresh = await runLoop({ rounds: [proseFrames('Nothing to do.')] })
  const firstSystem = systems(fresh.sent)
  assert.equal(
    firstSystem.filter((content) => content.includes(DISCIPLINE)).length,
    1,
    'a fresh send carries the plan-discipline line exactly once'
  )

  // A resumed run re-enters with the history the pause handed back, which already contains the
  // composed prompt. Injecting again would put the same standing instruction in the request twice. The
  // prompt is composed for this host's platform, because that is what the loop composes for itself —
  // the shell line is the only part that differs, and a mismatch there would be the test's mistake
  // rather than the rule's.
  const carried = await runLoop({
    rounds: [proseFrames('Nothing more to do.')],
    messages: [
      { role: 'system', content: agentSystemPrompt(process.platform) },
      { role: 'user', content: 'refactor the parser' },
    ],
    pending: { calls: [call('w1', 'write_file', { path: 'src/parser.ts', content: 'x\n' })], denied: false },
  })
  const resumed = systems(carried.sent)
  assert.equal(
    resumed.filter((content) => content.includes(DISCIPLINE)).length,
    1,
    'and a history that already carries it is not given it a second time'
  )
  assert.equal(resumed.length, 1, 'the standing prompt is injected once in total')
  results.push('the discipline line is injected exactly once, and skipped when the history carries it')
}

// ---------------------------------------------------------------- the pause as a card

async function aPauseIsEnoughToRenderOrToName() {
  // The bridge between the two suites: a pause either comes back as the same pending card or is
  // reconciled at load into a named state. This is the loop's half of it — the chunk carries
  // everything the card needs, so there is no third outcome where the pause renders as neither.
  const { chunks } = await runLoop({ rounds: [writeFrames('w1', 'src/parser.ts')] })
  const paused = chunks.find((chunk) => chunk.type === 'awaiting_approval')

  assert.ok(paused, 'the pause arrived')
  for (const key of ['callId', 'tool', 'args', 'calls', 'messages', 'plan']) {
    assert.ok(paused?.[key] !== undefined, `the pause carries ${key}, so a card can be built from it alone`)
  }

  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  turns = applyAgentChunk(turns, 'assistant-1', paused as Record<string, unknown>).turns
  assert.equal(turns[0].steps[0].status, 'awaiting', 'and the reducer cards the call the pause names')

  // A transcript that never got the resumed run is not a zombie: read back, it names what happened.
  const saved = serializeTranscript({ turns: endTurnPlan(turns, 'assistant-1'), interrupted: false })
  const reconciledTurn = rehydrateTranscript(saved).turns[0]
  assert.equal(reconciledTurn.steps[0].status, 'awaiting', 'the record still says a question was asked')
  assert.ok(RESUME_MESSAGE.length > 0, 'and there is a message the Continue button can send')
  results.push('a pause carries enough to be carded, and a stored one is a state rather than a loss')
}

// ---------------------------------------------------------------- the run

async function main() {
  await aCleanStopMidPlanAnnouncesItself()
  await aFinishedPlanEndsInSilence()
  await aCutOffTurnWithAnUnfinishedPlanNamesBoth()
  await aStoppedRunMidPlanStillSaysWhatIsLeft()
  await aPauseCarriesThePlanBackToTheResumedRun()
  await theInjectionCarriesTheDisciplineOnceAndOnlyWhenItIsAbsent()
  await aPauseIsEnoughToRenderOrToName()

  console.log(`\nplan-unfinished notice: ${results.length} checks passed`)
  for (const line of results) console.log(`  pass: ${line}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
