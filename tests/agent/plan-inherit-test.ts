/**
 * Verifies the two halves of a turn that used to end in silence: a nudge turn that inherited a plan it
 * never declared, and a turn that was aborted rather than finished.
 *
 * Turn A's diagnosis found two ways the plan-unfinished card could fail to appear even though the
 * checklist on screen still had work on it, and both are asserted here rather than reasoned about.
 *
 * The first is inheritance. A plan is a fact about the *transcript*, and the pane reads it from the
 * newest turn that declared one — but a turn end used to be judged against the ending turn's own plan
 * alone. A nudge turn (the ordinary send that picks work back up) declares nothing, so the ending read
 * as a turn with no plan and owed the user nothing, while the plan it was nudged about sat one turn
 * above it. `endTurn` now reconciles the plan the conversation actually has in hand, and the case below
 * is that exact shape: turn one declares, turn two is nudged, turn two stops mid-plan.
 *
 * The second is the abort. Every way out of the loop except an abort passes through `finishTurn`, so a
 * run whose window closed — or which was stopped mid-stream — dropped the plan's state with nothing
 * said about it. The abort exits now end the turn with an `interrupted` cause, and the case below
 * aborts the reply mid-stream and asserts the `turn_end` and the notice that come back.
 *
 * The second case is also how the new cause is held to the rest of the vocabulary: the notice chunk and
 * the reducer both read it, so a cause the closed set did not carry would fail here twice over.
 *
 * Turn B adds the planless half of the same ending. The Stop button closes the renderer's iterator,
 * so main never gets to yield its `turn_end_notice`; the pane's `endTurn` is the only place left to
 * say the run was stopped. Before this it only spoke when a plan existed, which left a planless turn
 * with tool work on screen and no explanation that the work had ended.
 */
import { strict as assert } from 'node:assert'
import {
  applyAgentChunk,
  currentEndNotice,
  endTurn,
  type AgentTurn,
} from '../../app/components/workbench/agent-session'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { reconcilePlanOnTurnEnd, type PlanStep } from '../../conveyor/protocol/plan'

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
 * A reply that is aborted while it is still arriving.
 *
 * The abort lands at a named frame boundary rather than on a timer, because that is the determinism the
 * case needs: the stream hands over one frame per pull, and the pull that takes the frame at `abortAt`
 * aborts the run's signal first. What the loop then sees is the thing being asserted — a delta that
 * arrived after the run was cancelled — and not a race between a timer and a stream.
 */
function abortingResponse(frames: string[], signal: AbortController, abortAt: number): Response {
  const encoded = frames.map((frame) => new TextEncoder().encode(`data: ${frame}\n\n`))
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= encoded.length) {
        controller.close()
        return
      }
      if (index === abortAt) signal.abort()
      controller.enqueue(encoded[index])
      index += 1
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

/** A reply asking for several tools at once, as the fragment stream delivers them. */
function toolFrames(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string[] {
  return [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
    }),
    stopFrame('tool_calls'),
    '[DONE]',
  ]
}

/** Run the loop against a scripted provider: each round is the reply to one request. */
function scriptedFetch(
  rounds: Array<string[] | ((signal: AbortController) => Response)>,
  signal: AbortController,
  log: Array<{ messages: Array<{ role: string; content: string }> }>
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push(JSON.parse(String(init.body)))
    const round = rounds[Math.min(call - 1, rounds.length - 1)]
    return typeof round === 'function' ? round(signal) : sseResponse(round)
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

interface RunOptions {
  rounds: Array<string[] | ((signal: AbortController) => Response)>
  messages?: Array<Record<string, unknown>>
  plan?: readonly PlanStep[]
  /** Aborts the run, which is the event the second case is about. */
  controller?: AbortController
}

async function runLoop(opts: RunOptions): Promise<{ chunks: Array<Record<string, unknown>> }> {
  const sent: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const signal = opts.controller ?? new AbortController()
  const chunks = await collect(
    runAgentLoop({
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      // No folder is open: planning and diagnosis are not actions, so neither needs one.
      workspaceRoot: null,
      messages: (opts.messages ?? [{ role: 'user', content: 'refactor the parser' }]) as never,
      autoApprove: false,
      signal: signal.signal,
      fetchImpl: scriptedFetch(opts.rounds, signal, sent) as never,
      ...(opts.plan ? { plan: opts.plan } : {}),
    })
  )
  return { chunks }
}

/** The notice chunk of a run, if it had one. */
function notice(chunks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === 'turn_end_notice')
}

/** The plan the model declared in the first round of every case below. */
const DECLARED: PlanStep[] = [
  { id: 'read', text: 'Read the parser', status: 'done' },
  { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
  { id: 'tests', text: 'Add tests for it', status: 'pending' },
]

// ---------------------------------------------------------------- the nudge turn

async function aNudgeTurnInheritsThePlanItIsBeingNudgedAbout() {
  // The transcript a nudge turn is written into: one turn that declared the plan and stopped, and the
  // turn the nudge opened, which declares nothing of its own. This is the ordinary shape after a model
  // stops mid-plan and the user says "continue" — the plan is one turn up, and the pane is showing it.
  const turns: AgentTurn[] = [
    { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I have started on the precedence table.',
      steps: [],
      plan: reconcilePlanOnTurnEnd(DECLARED),
    },
    { id: 'user-2', role: 'user', content: 'continue', steps: [] },
    { id: 'assistant-2', role: 'assistant', content: '', steps: [] },
  ]

  const ended = endTurn(turns, 'assistant-2')
  const inherited = currentEndNotice(ended)

  assert.ok(inherited, 'a nudge turn that stops mid-plan announces the work it inherited')
  assert.equal(inherited?.unfinishedSteps, 2, 'counting what is left of the plan above it, not nothing')
  assert.equal(inherited?.cause, 'model_stop', 'naming the ending it actually had')
  assert.equal(inherited?.resumable, true, 'as work that can be picked up again')

  // The turn above is a record of its own ending, and reconciling this one must not rewrite it.
  assert.deepEqual(
    ended[1].plan?.map((step) => step.status),
    ['done', 'interrupted', 'pending'],
    'the declaring turn keeps its own reconciled plan'
  )

  // And the loop's half of the same inheritance: handed the plan the pane holds, a run that stops
  // again reports the same work rather than starting from an empty plan of its own.
  const { chunks } = await runLoop({
    rounds: [proseFrames('Still working on it.')],
    plan: reconcilePlanOnTurnEnd(DECLARED),
  })
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'a run seeded with the inherited plan reports it')
  results.push('a nudge turn inherits the plan it is being nudged about, in the pane and in the loop')
}

// ---------------------------------------------------------------- the abort

async function anAbortedTurnEndsWithAnInterruptedNotice() {
  const controller = new AbortController()
  const { chunks } = await runLoop({
    controller,
    rounds: [
      planFrames('p1', DECLARED),
      // The reply arrives, then the run is cancelled while the stream is still open — what a window
      // closing mid-answer looks like to the loop.
      (signal) => abortingResponse(proseFrames('I am halfway through the ta'), signal, 1),
    ],
  })

  const ending = chunks.filter((chunk) => chunk.type === 'turn_end')
  assert.equal(ending.length, 1, 'an aborted turn still ends with a turn_end rather than stopping silently')
  assert.equal(ending[0]?.cause, 'interrupted', 'naming the ending an abort actually is')
  assert.equal(notice(chunks)?.cause, 'interrupted', 'and the notice carries the same cause')
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'with the work the plan still had on it')
  assert.equal(notice(chunks)?.resumable, true, 'as work a person can pick up')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'done'),
    false,
    'and no completion is claimed for a turn nobody finished'
  )

  // The cause is in the closed set the reducer reads, so the card survives the boundary it crosses.
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  assert.equal(turns[0].endNotice?.cause, 'interrupted', 'the reducer records the ending it was handed')
  assert.equal(turns[0].endNotice?.unfinishedSteps, 2, 'with the count the loop diagnosed it with')
  results.push('an aborted turn yields an interrupted turn_end with the plan-unfinished notice')
}

// ---------------------------------------------------------------- C2 / T-D2 in the loop

async function aPlanlessModelStopAfterThreeStepsGetsTheGenericNotice() {
  const calls = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `read-${index}`,
      name: 'read_file',
      args: { path: `file-${index}.txt` },
    }))

  const three = await runLoop({
    rounds: [toolFrames(calls(3)), proseFrames('I looked at the files.')],
  })
  const midWork = notice(three.chunks)
  assert.ok(midWork, 'three tool steps and a complete model stop earn the generic mid-work notice')
  assert.equal(midWork?.cause, 'model_stop', 'under the ordinary cause, not a new one')
  assert.equal(midWork?.midWork, true, 'and carrying the generic flag rather than a plan count')
  assert.equal(midWork?.unfinishedSteps, undefined, 'with no plan count to invent')
  assert.equal(
    three.chunks.some((chunk) => chunk.type === 'auto_continue'),
    false,
    'the app never auto-continues this notice'
  )

  // The fence: two steps are an ordinary short answer, not a mid-work death.
  const two = await runLoop({ rounds: [toolFrames(calls(2)), proseFrames('I looked at the files.')] })
  assert.equal(notice(two.chunks), undefined, 'two steps stay silent')
  results.push('C2/T-D2: a planless model stop earns the mid-work notice at three steps and not at two')
}

// ---------------------------------------------------------------- the planless stop

async function aPlanlessStopStillSaysItWasStopped() {
  const turns: AgentTurn[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      steps: [
        {
          callId: 'call-1',
          tool: 'run_command',
          args: { command: 'npm test' },
          status: 'ok',
          output: 'tests passed',
        },
      ],
    },
  ]

  const stopped = endTurn(turns, 'assistant-1', 'interrupted')
  const notice = currentEndNotice(stopped)
  assert.ok(notice, 'a planless stop still announces that the run ended early')
  assert.equal(notice?.cause, 'interrupted', 'naming the ending the Stop button produced')
  assert.equal(notice?.resumable, true, 'as work a person can pick up')
  assert.equal(notice?.unfinishedSteps, undefined, 'with no plan count to invent')

  // The ordinary ending keeps the old silence: a turn the model finished with no plan is not an incident.
  assert.equal(currentEndNotice(endTurn(turns, 'assistant-1')), null, 'a plain finish still says nothing')
  results.push('a planless stop gets an interrupted notice, while an ordinary finish still says nothing')
}

// ---------------------------------------------------------------- the run

async function main() {
  // Each case is run under its own catch so a failure names itself and the other cases still report:
  // the two halves of this suite fail independently, and a run that stopped at the first would say
  // nothing about the second.
  const cases: Array<[string, () => Promise<void>]> = [
    ['a nudge turn inherits the plan it is being nudged about', aNudgeTurnInheritsThePlanItIsBeingNudgedAbout],
    ['an aborted turn ends with an interrupted notice', anAbortedTurnEndsWithAnInterruptedNotice],
    ['a planless stop still says it was stopped', aPlanlessStopStillSaysItWasStopped],
    [
      'a planless model stop after three steps gets the generic notice',
      aPlanlessModelStopAfterThreeStepsGetsTheGenericNotice,
    ],
  ]

  let failed = 0
  for (const [name, run] of cases) {
    try {
      await run()
    } catch (err) {
      failed += 1
      console.error(`  FAIL: ${name}`)
      console.error(err)
    }
  }

  if (failed > 0) {
    console.error(`\nplan inheritance and aborted endings: ${failed} of ${cases.length} cases failed`)
    process.exit(1)
  }

  console.log(`\nplan inheritance and aborted endings: ${results.length} checks passed`)
  for (const line of results) console.log(`  pass: ${line}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
