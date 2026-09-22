/**
 * Verifies the turn-end diagnosis through the real loop, against a mocked provider — no network, no
 * keys.
 *
 * Three things are the point, and none of them is visible from the pure rules alone.
 *
 * The first is the provider contract itself, logged rather than assumed. What a stream actually
 * reports about its own ending is the whole basis of the mapping in `protocol/turn-end.ts`, so this
 * suite prints the raw values the parser extracts, per dialect, before it asserts anything about
 * them. A mapping keyed on a value no provider sends would pass its unit test and be wrong in the
 * app, and only an observed value can tell the difference.
 *
 * The second is that a reply the provider cut off ends the turn *with* something said about it: the
 * notice chunk arrives, and the turn's plan is written down with nothing left claiming to be in
 * progress. The chunks are fed through the real reducer and the real serializer, so what is asserted
 * is the transcript's contents rather than the loop's intentions.
 *
 * The third is the ordinary ending. A model that stopped on its own yields `model_stop` and no
 * notice at all — the card exists for the endings that need explaining, and a card under every
 * answer would be the noise that makes the real one invisible.
 */
import { strict as assert } from 'node:assert'
import {
  applyAgentChunk,
  currentEndNotice,
  endTurnPlan,
  type AgentTurn,
} from '../../app/components/workbench/agent-session'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { extractDelta } from '../../conveyor/modules/llm-engine'
import type { PlanStep } from '../../conveyor/protocol/plan'
import { TURN_END_CAUSES } from '../../conveyor/protocol/turn-end'

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
 * A response whose body breaks partway through, as a dropped connection does.
 *
 * The frame that got through is delivered first, so the failure lands mid-reply rather than before
 * it — which is the case the loop has to tell apart from a provider refusing the request.
 */
function brokenResponse(): Response {
  let delivered = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"half a "}}]}\n\n'))
    },
    // The break lands after the frame above has been read, which is what a dropped connection looks
    // like from the reader's side: the bytes that made it through are delivered, and the next read
    // fails. Erroring the controller from `start` instead would discard the queued frame and model
    // the wrong event — a connection that died before the reply began.
    pull(controller) {
      delivered += 1
      if (delivered >= 1) controller.error(new Error('socket hang up'))
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** One frame reporting where the reply ended, as both dialects send it. */
function stopFrame(reason: string, dialect: 'openai' | 'anthropic' = 'openai'): string {
  return dialect === 'anthropic'
    ? JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })
    : JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })
}

function proseFrames(text: string, reason: string, dialect: 'openai' | 'anthropic' = 'openai'): string[] {
  return [JSON.stringify({ choices: [{ delta: { content: text } }] }), stopFrame(reason, dialect), '[DONE]']
}

/** A `set_plan` call that declares one step in progress and one pending. */
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

/**
 * A tool call whose arguments stop mid-JSON, with no finish reason to explain it.
 *
 * The provider never said why it stopped writing, so the only evidence left is the payload itself —
 * which is exactly the second half of the truncation rule.
 */
function cutToolCallFrames(callId: string): string[] {
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
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x.tx' } }] } }] }),
    '[DONE]',
  ]
}

/** A provider that answers each request with the next scripted round. */
function scriptedFetch(
  rounds: Array<string[] | Response>,
  log: unknown[]
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push(JSON.parse(String(init.body)))
    const round = rounds[Math.min(call - 1, rounds.length - 1)]
    // A scripted frame list is wrapped as an SSE body; anything else is handed over as it is, which
    // is how a body that breaks mid-stream gets into the run without a network.
    return Array.isArray(round) ? sseResponse(round) : round
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

/** Run one scripted conversation through the real loop. */
async function runLoop(rounds: Array<string[] | Response>): Promise<Array<Record<string, unknown>>> {
  const log: unknown[] = []
  return collect(
    runAgentLoop({
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      // No folder is open: planning and diagnosis are not actions, so neither needs one.
      workspaceRoot: null,
      messages: [{ role: 'user', content: 'refactor the parser' }],
      autoApprove: false,
      signal: new AbortController().signal,
      fetchImpl: scriptedFetch(rounds, log) as never,
    })
  )
}

/** Feed a run's chunks through the real reducer, end the turn, then freeze it the way a save does. */
function record(chunks: Array<Record<string, unknown>>): ReturnType<typeof serializeTranscript> {
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  return serializeTranscript({ turns: endTurnPlan(turns, 'assistant-1'), interrupted: false })
}

/** The last chunk's cause, whichever of the two endings it arrived as. */
function causeOf(chunks: Array<Record<string, unknown>>): unknown {
  return chunks.at(-1)?.cause
}

// ---------------------------------------------------------------- the observed contract

/**
 * Print the raw finish reasons the parser extracts, per dialect.
 *
 * The evidence for the mapping, produced rather than quoted: every value below is what
 * `extractDelta` returns for a frame shaped the way that provider documents, which is the whole
 * vocabulary `protocol/turn-end.ts` has to decide on. Logged before the assertions so a failure
 * still leaves the observed values in the output.
 */
function logObservedFinishReasons() {
  const observed = {
    openai: ['stop', 'tool_calls', 'length', 'content_filter', ''].map((reason) => ({
      reason,
      parsed: extractDelta('openai', stopFrame(reason))?.finishReason ?? null,
    })),
    anthropic: ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'refusal'].map((reason) => ({
      reason,
      parsed: extractDelta('anthropic', stopFrame(reason, 'anthropic'))?.finishReason ?? null,
    })),
    // A reply that ends without saying why: providers do this, and nothing here may read it as a
    // failure the user has to be told about.
    silent: [
      extractDelta('openai', '[DONE]')?.finishReason ?? null,
      extractDelta('openai', JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] }))?.finishReason ?? null,
    ],
  }

  console.log('  finish_reason values observed through the parser (mocked provider):')
  for (const [dialect, values] of Object.entries(observed)) {
    console.log(`    ${dialect}: ${JSON.stringify(values)}`)
  }

  // Only the two the mapping keys on are carried through; an empty string is not a reason.
  assert.equal(observed.openai.find((v) => v.reason === 'length')?.parsed, 'length')
  assert.equal(observed.anthropic.find((v) => v.reason === 'max_tokens')?.parsed, 'max_tokens')
  assert.equal(observed.openai.find((v) => v.reason === '')?.parsed, null, 'an empty finish_reason is no reason')
  assert.deepEqual(observed.silent, [null, null], 'a reply with no finish_reason reports none')
  results.push('the observed finish_reason contract is logged, not assumed')
}

// ---------------------------------------------------------------- the loop's endings

async function cutOffByTheOutputLimit() {
  const steps: PlanStep[] = [
    { id: 'read', text: 'Read the parser', status: 'in_progress' },
    { id: 'tests', text: 'Add tests for it', status: 'pending' },
  ]

  const chunks = await runLoop([planFrames('call_1', steps), proseFrames('The parser works by ', 'length')])

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['tool_call_start', 'tool_result', 'plan', 'text_delta', 'turn_end', 'turn_end_notice'],
    `unexpected chunk sequence: ${JSON.stringify(chunks.map((c) => c.type))}`
  )

  // The diagnosis, and then the announcement: the cause is named on both, and the last thing the
  // turn says is that it stopped.
  assert.equal(causeOf(chunks.slice(0, -1)), 'truncated', 'the turn-end cause is the truncation')
  const notice = chunks.at(-1) as { cause?: unknown; resumable?: unknown }
  assert.equal(notice.cause, 'truncated')
  assert.equal(notice.resumable, true, 'a cut-off reply is something the user can continue')

  // And the turn's own record: the plan it declared is written down with nothing still running, and
  // the ending is stored with it. Both read back, because a conversation reopened tomorrow should
  // still say that its last answer stopped in the middle.
  const snapshot = record(chunks)
  assert.deepEqual(
    snapshot.turns[0].plan,
    [
      { id: 'read', text: 'Read the parser', status: 'interrupted' },
      { id: 'tests', text: 'Add tests for it', status: 'pending' },
    ],
    `a turn cut off mid-plan must record it as interrupted: ${JSON.stringify(snapshot.turns[0].plan)}`
  )
  assert.equal(snapshot.turns[0].endNotice?.cause, 'truncated', 'the ending is part of the record')

  // Read back as history: the card shows the reason, and it is not actionable.
  const reopened = rehydrateTranscript(snapshot)
  assert.equal(currentEndNotice(reopened.turns)?.cause, 'truncated')
  assert.equal(currentEndNotice(reopened.turns)?.resumable, false, 'a stored notice offers no button')

  // The live turn, by contrast, is actionable — which is what the Continue button reads.
  let live: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) live = applyAgentChunk(live, 'assistant-1', chunk).turns
  assert.equal(currentEndNotice(live)?.resumable, true)

  results.push('a reply cut off at the output limit ends the turn with a notice and a reconciled plan')
}

async function cutOffMidPayload() {
  // No finish reason at all, and a tool call whose arguments stop mid-JSON. The provider said
  // nothing, so the payload is the only evidence there is — and half a tool call is not a call.
  const chunks = await runLoop([cutToolCallFrames('call_1')])

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['turn_end', 'turn_end_notice'],
    `unexpected chunk sequence: ${JSON.stringify(chunks.map((c) => c.type))}`
  )
  assert.equal(causeOf(chunks.slice(0, -1)), 'truncated', 'a cut payload is a truncated reply')
  assert.equal((chunks.at(-1) as { resumable?: unknown }).resumable, true)
  // The half-written call is never announced as a call being made: it was never a call.
  assert.ok(!chunks.some((c) => c.type === 'tool_call_start'))

  results.push('a tool-call payload cut mid-JSON reads as truncated')
}

async function theReplyStopsArriving() {
  const chunks = await runLoop([brokenResponse()])

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['text_delta', 'turn_end', 'turn_end_notice'],
    `unexpected chunk sequence: ${JSON.stringify(chunks.map((c) => c.type))}`
  )
  assert.equal(causeOf(chunks.slice(0, -1)), 'stream_error')
  const notice = chunks.at(-1) as { cause?: unknown; resumable?: unknown }
  assert.equal(notice.cause, 'stream_error')
  assert.equal(notice.resumable, true)

  // The half-reply that did arrive is kept, which is what makes continuing coherent rather than a
  // second attempt at a question the model has already half answered.
  assert.equal(chunks[0].text, 'half a ')

  results.push('a reply that stops arriving mid-stream ends the turn with a notice')
}

async function refusedRequestsStillThrow() {
  // A provider that refused the request never started a reply, so there is no turn to diagnose: the
  // error keeps its own code and its own wording rather than becoming a Continue card.
  const log: unknown[] = []
  const chunks: Array<Record<string, unknown>> = []
  let code: string | undefined

  try {
    for await (const chunk of runAgentLoop({
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      workspaceRoot: null,
      messages: [{ role: 'user', content: 'hello' }],
      autoApprove: false,
      signal: new AbortController().signal,
      fetchImpl: scriptedFetch([new Response('{"error":{"message":"bad key"}}', { status: 401 })], log) as never,
    })) {
      chunks.push(chunk as Record<string, unknown>)
    }
  } catch (err) {
    code = (err as { code?: string }).code
  }

  assert.equal(code, 'AUTH_FAILED', 'a refused request stays a failure to report, not a turn to continue')
  assert.deepEqual(chunks, [], 'and nothing is announced about a reply that never began')
  assert.equal(log.length, 1, 'the request was made once and refused')

  results.push('a refused request still throws rather than ending a turn')
}

async function aCleanStopSaysSoAndShowsNothing() {
  const chunks = await runLoop([proseFrames('The parser is fine.', 'stop')])

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['text_delta', 'turn_end', 'done'],
    `unexpected chunk sequence: ${JSON.stringify(chunks.map((c) => c.type))}`
  )
  // Diagnosed all the same: the ordinary ending is a cause too, and it is the one the renderer must
  // be able to tell apart from the two that need a card.
  assert.equal(causeOf(chunks.slice(0, -1)), 'model_stop')
  assert.ok(!chunks.some((c) => c.type === 'turn_end_notice'), 'nothing to announce about a finished reply')

  const snapshot = record(chunks)
  assert.equal(snapshot.turns[0].endNotice, undefined, 'a clean stop is stored as no notice at all')
  assert.equal('endNotice' in (snapshot.turns[0] as object), false, 'and carries no key')
  // Read back the way a reopen reads it, so the assertion is on the card's own input.
  assert.equal(currentEndNotice(rehydrateTranscript(snapshot).turns), null, 'so a reopened conversation shows no card')

  results.push('a clean stop yields model_stop and no card')
}

function everyCauseIsAccountedFor() {
  // The vocabulary is closed, and this suite exercised all of it: a cause added later without a case
  // here would leave a transcript that could store an ending nothing knows how to word.
  const seen = ['model_stop', 'truncated', 'stream_error']
  assert.deepEqual([...TURN_END_CAUSES].sort(), [...seen].sort())
  results.push('the causes exercised here are the whole vocabulary')
}

async function main() {
  const suites: Array<[string, () => void | Promise<void>]> = [
    ['the observed finish_reason contract', logObservedFinishReasons],
    ['cut off at the output limit', cutOffByTheOutputLimit],
    ['cut off mid-payload', cutOffMidPayload],
    ['the reply stops arriving', theReplyStopsArriving],
    ['a refused request is not a dead turn', refusedRequestsStillThrow],
    ['a clean stop', aCleanStopSaysSoAndShowsNothing],
    ['the cause vocabulary', everyCauseIsAccountedFor],
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
    console.error(`\n${failed} of ${suites.length} turn-end suite(s) failed`)
    process.exit(1)
  }
  console.log(`\nall ${suites.length} turn-end checks passed`)
}

void main()
