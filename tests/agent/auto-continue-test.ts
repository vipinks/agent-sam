/**
 * Bounded auto-continue, through the real loop, against a mocked provider — no network, no keys.
 *
 * The pure rule is asserted in `testing/turn-end-rules.test.ts`. What can only be seen here is the
 * loop that applies it: that a model stopping mid-plan is re-invoked rather than ended, that the
 * re-invocation is bounded, and that the nudge it sends is a message to the provider and not a turn
 * in the conversation.
 *
 * Three things are the point.
 *
 * The first is the ordinary shape of the feature: a model that stops three times with work left ends
 * one turn, carrying three auto-continue chunks — so what the user reads is one answer with three
 * seams in it rather than four answers.
 *
 * The second is the ceiling. A model that stops past the budget gets continuations up to it and then
 * the card this app already had, at the same place it was before: an app that nudges forever is a loop
 * that spends the user's money to stay wrong.
 *
 * The third is that the nudge is invisible as speech. It goes out as a user-role message — that is
 * the only role the provider's API has for "the operator is speaking" — and the transcript built from
 * the same chunks has no user turn in it at all.
 *
 * Two more are about which endings the loop will pick up by itself, which is the half of the rule a
 * live session actually meets: a reply the provider cut off at its output cap is nudged exactly as a
 * stop is, and a reply that stopped arriving is not — it ends the turn with the card, because a dropped
 * connection is not something a further request can fix.
 *
 * And one is about the shape of the reply that dies that way, which is the shape the loop used to miss: a
 * capped reply is cut *inside* a tool call rather than between two of them, and a frame holding a
 * half-written call was read as work in hand — so the turn ended on the card while its plan was
 * unfinished and its budget untouched. The two tests below assert that the cut payload is discarded
 * rather than run: no call announced, no result, no permission asked, and nothing on the wire asking a
 * provider for the outcome of a call that never happened.
 *
 * And one is about the ceiling itself, which is the loop's ending rather than the model's: a segment's
 * step budget spent with work left on the plan is a turn that has not finished, so it is picked up like
 * any other unfinished ending and the counter restarts for the segment the nudge opens. The two cases
 * before the run assert it, and the bound they leave visible is the one the user reads: eight nudges on
 * one turn's plan, with a segment's worth of round-trips behind each of them.
 *
 * The chunks are fed through the real reducer and the real serializer, so what is asserted about the
 * transcript is the transcript's contents rather than the loop's intentions.
 */
import { strict as assert } from 'node:assert'
import { applyAgentChunk, endTurnPlan, type AgentTurn } from '../../app/components/workbench/agent-session'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { MAX_STEPS, runAgentLoop } from '../../conveyor/modules/agent'
import type { PlanStep } from '../../conveyor/protocol/plan'
import { AUTO_CONTINUE_MAX, autoContinueNudge } from '../../conveyor/protocol/turn-end'

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

/**
 * The same frames, on a connection that then goes away.
 *
 * The frames arrive as one chunk and the next pull fails, which is what a dropped connection is: a reply
 * that was being written and stopped arriving. Nothing follows them — no `[DONE]` — because there was
 * nothing left to send.
 */
function failingResponse(frames: string[]): Response {
  const payload = frames.map((frame) => `data: ${frame}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  let delivered = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true
        controller.enqueue(bytes)
        return
      }
      controller.error(new Error('the connection was reset'))
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
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

/**
 * A reply the provider cut off inside a tool-call payload: the death a long turn actually has.
 *
 * The model was narrating and asking for its next write when the output room ran out, so what arrives is
 * a call that was still being written — an id, a name, and arguments that never became valid JSON. The
 * finish reason says so in the provider's own words too, which is how a real capped reply dies: the cut
 * lands inside the frame rather than between two frames.
 */
function cutCallFrames(callId: string, text: string, tool: string, partialArgs: string): string[] {
  return [
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool, arguments: '' } }],
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: partialArgs } }] } }] }),
    stopFrame('length'),
    '[DONE]',
  ]
}

interface SentRequest {
  messages: Array<{ role: string; content: string; tool_calls?: unknown }>
}

/** A provider that answers each request with the next scripted round, and logs what it was sent. */
function scriptedFetch(
  rounds: Array<string[] | Response>,
  log: SentRequest[]
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
  plan?: readonly PlanStep[]
  steps?: number
  continuations?: number
}

async function runLoop(opts: RunOptions): Promise<{
  chunks: Array<Record<string, unknown>>
  sent: SentRequest[]
}> {
  const sent: SentRequest[] = []
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
      ...(opts.plan ? { plan: opts.plan } : {}),
      ...(opts.steps !== undefined ? { steps: opts.steps } : {}),
      ...(opts.continuations !== undefined ? { continuations: opts.continuations } : {}),
    })
  )
  return { chunks, sent }
}

/** Every auto-continue chunk a run emitted, in order. */
function marks(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks.filter((chunk) => chunk.type === 'auto_continue')
}

/** The notice chunk of a run, if it had one. */
function notice(chunks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === 'turn_end_notice')
}

/** Feed a run's chunks through the real reducer, end the turn, then freeze it the way a save does. */
function record(chunks: Array<Record<string, unknown>>): ReturnType<typeof serializeTranscript> {
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  return serializeTranscript({ turns: endTurnPlan(turns, 'assistant-1'), interrupted: false })
}

/** The turns the same chunks produce in the pane, before a save. */
function transcript(chunks: Array<Record<string, unknown>>): AgentTurn[] {
  let turns: AgentTurn[] = [{ id: 'assistant-1', role: 'assistant', content: '', steps: [] }]
  for (const chunk of chunks) turns = applyAgentChunk(turns, 'assistant-1', chunk).turns
  return turns
}

/** Every nudge a run put on the wire, in the order the requests carried them. */
function nudges(sent: SentRequest[]): string[] {
  return sent
    .map((request) => request.messages.at(-1))
    .filter((message): message is { role: string; content: string } => message?.role === 'user')
    .map((message) => message.content)
    .filter((content) => content.startsWith('You stopped with'))
}

/**
 * Which request each nudge opened, as an index into the request log.
 *
 * A nudge is the last message of the request that follows it and of no later one — the round-trips behind
 * it end in tool results — so one index per nudge is where a segment begins on the wire, which is what the
 * step budget's reset is visible as.
 */
function nudgePositions(sent: SentRequest[]): number[] {
  return sent.reduce<number[]>((positions, request, index) => {
    const last = request.messages.at(-1)
    if (last?.role === 'user' && last.content.startsWith('You stopped with')) positions.push(index)
    return positions
  }, [])
}

// ---------------------------------------------------------------- the ordinary shape

async function aModelThatStopsThreeTimesMidPlanEndsOneTurn() {
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
      ]),
      proseFrames('I have started on the precedence table.'),
      proseFrames('Still working on the table.'),
      proseFrames('Nearly there.'),
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
      ]),
      proseFrames('The table is updated.'),
    ],
  })

  const spent = marks(chunks)
  assert.deepEqual(
    spent.map((mark) => mark.count),
    [1, 2, 3],
    'three stops mid-plan, three auto-continuations'
  )
  for (const mark of spent) {
    assert.equal(mark.max, AUTO_CONTINUE_MAX, 'each one naming the budget it is spending')
  }

  // The turn ends once, and only when the plan has nothing left on it: the endings in between are
  // seams in one answer rather than the end of it.
  assert.equal(chunks.filter((chunk) => chunk.type === 'turn_end').length, 1, 'the turn ends once')
  assert.equal(chunks.filter((chunk) => chunk.type === 'done').length, 1, 'with one ending')
  assert.equal(
    chunks.filter((chunk) => chunk.type === 'turn_end_notice').length,
    0,
    'and nothing said about it, because the model did finish the plan'
  )
  assert.deepEqual(
    chunks.slice(-3).map((chunk) => chunk.type),
    ['text_delta', 'turn_end', 'done'],
    'so the last thing the user reads is the answer, not a card'
  )

  // The nudge is what the provider was asked with, on each round-trip after a stop — and it is the
  // last message of the request, because it is the thing the model is being asked to answer.
  assert.equal(nudges(sent).length, 3, 'the provider was nudged once per continuation')
  for (const index of [2, 3, 4]) {
    assert.deepEqual(
      sent[index]?.messages.at(-1),
      { role: 'user', content: autoContinueNudge(1) },
      `request ${index + 1} was sent with the nudge as its last message`
    )
  }
  assert.notEqual(sent[1]?.messages.at(-1)?.content, autoContinueNudge(1), 'while the first request had none')
  assert.equal(sent.length, 6, 'and a nudge bought a round-trip rather than a shortcut')

  // The transcript: one assistant turn with three seams in it, and no user turn anywhere — the nudge
  // is main's, and the pane is never told a person typed it.
  const turns = transcript(chunks)
  assert.equal(turns.length, 1, 'the whole thing is one turn')
  assert.equal(
    turns.some((turn) => turn.role === 'user'),
    false,
    'and no user message was appended to the transcript'
  )
  assert.deepEqual(
    turns[0].continuations?.map((mark) => mark.count),
    [1, 2, 3],
    'the seams are recorded on the turn, in order'
  )
  assert.equal(
    turns[0].continuations?.every((mark) => mark.afterSteps === 1),
    true,
    'each one placed where the resumed work begins: behind the one card the turn had drawn'
  )

  // And the record keeps them, so a reopened conversation shows the same seams rather than one
  // uninterrupted answer.
  const restored = rehydrateTranscript(record(chunks))
  assert.deepEqual(
    restored.turns[0].continuations?.map((mark) => mark.count),
    [1, 2, 3],
    'a saved and reopened transcript still says the turn continued itself'
  )
  assert.equal(restored.turns[0].endNotice, undefined, 'and offers nothing, because there is nothing left to continue')
  results.push('a model that stops three times mid-plan ends one turn, carrying three auto-continue chunks')
}

// ---------------------------------------------------------------- the ceiling

async function aModelThatStopsPastItsBudgetGetsTheCard() {
  // One stop more than the budget allows, so the ending under test is the one past it.
  const stops = AUTO_CONTINUE_MAX + 1
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      ...Array.from({ length: stops }, (_, index) => proseFrames(`Still working on the table, pass ${index + 1}.`)),
    ],
  })

  assert.deepEqual(
    marks(chunks).map((mark) => mark.count),
    Array.from({ length: AUTO_CONTINUE_MAX }, (_, index) => index + 1),
    'the whole budget, and not one continuation more'
  )
  assert.equal(nudges(sent).length, AUTO_CONTINUE_MAX, 'and one nudge on the wire for each of them')
  assert.equal(
    sent.length,
    1 + AUTO_CONTINUE_MAX + 1,
    'the stop past the budget pays for a round-trip and gets the card'
  )

  // The ending is today's, unchanged: the card the manual path already had, after the budget rather
  // than instead of it.
  assert.equal(chunks.at(-1)?.type, 'done', 'the turn ends the ordinary way')
  assert.equal(chunks.at(-2)?.type, 'turn_end_notice', 'with the notice it had before this feature')
  assert.equal(notice(chunks)?.cause, 'model_stop', 'naming the ending it actually had')
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'and the work that is left')
  assert.equal(notice(chunks)?.resumable, true, 'with the Continue click still the way on')
  assert.equal(
    chunks.findLastIndex((chunk) => chunk.type === 'auto_continue') <
      chunks.findIndex((chunk) => chunk.type === 'turn_end_notice'),
    true,
    'and the card comes after the last continuation, not in the middle of them'
  )

  const restored = rehydrateTranscript(record(chunks))
  assert.equal(restored.turns[0].continuations?.length, AUTO_CONTINUE_MAX, 'the seams are in the record')
  assert.equal(restored.turns[0].endNotice?.unfinishedSteps, 2, 'and so is the card it ended on')
  results.push('a model that stops past its budget gets the whole budget and then the plan-unfinished card')
}

// ---------------------------------------------------------------- the budget is per turn

async function aTurnSpendsItsOwnBudget() {
  // One turn that exhausted the budget, then a real user send: a fresh run, with a plan handed to it
  // the way a resumed or continuing turn is. Its budget starts where every turn's does, which is what
  // makes the bound a bound on one turn rather than a fuse on the session.
  const second = await runLoop({
    rounds: [proseFrames('Still working on the table.')],
    messages: [
      { role: 'user', content: 'carry on' },
      { role: 'assistant', content: 'I have started.' },
    ],
    plan: [{ id: 'edit', text: 'Change the precedence table', status: 'in_progress' }],
  })

  assert.equal(marks(second.chunks)[0]?.count, 1, 'a new send starts the count over')
  assert.deepEqual(
    marks(second.chunks).map((mark) => mark.count),
    Array.from({ length: AUTO_CONTINUE_MAX }, (_, index) => index + 1),
    'and spends the whole budget again before the card'
  )
  assert.equal(notice(second.chunks)?.cause, 'model_stop', 'ending at the card, as the previous turn did')
  results.push('the budget belongs to one turn, so a new send starts it over')

  // And a resumed turn is not a new turn: an approval that came back with a fresh budget would let a
  // model that asks for a permission between every stretch of work continue itself without limit.
  const resumed = await runLoop({
    rounds: [proseFrames('Still working on the table.')],
    messages: [
      { role: 'user', content: 'refactor the parser' },
      { role: 'assistant', content: 'I have started.' },
    ],
    plan: [{ id: 'edit', text: 'Change the precedence table', status: 'in_progress' }],
    continuations: AUTO_CONTINUE_MAX,
  })

  assert.deepEqual(marks(resumed.chunks), [], 'a turn that has spent the budget is not nudged again')
  assert.equal(
    resumed.sent.length,
    1,
    'it goes straight to the card, which is the one round-trip a spent budget still pays for'
  )
  assert.equal(notice(resumed.chunks)?.resumable, true, 'with the Continue click as the way on')
  results.push('and resumes with it, so an approval does not refund the turn its budget')
}

// ---------------------------------------------------------------- the endings a nudge can answer

async function aTruncatedTurnPicksItselfUpMidPlan() {
  // The death a long turn actually has: the provider stops writing at its output cap, twice, with the
  // plan unfinished. Nobody clicks anything — the loop is the only party that acts here — and the turn
  // finishes the work it was doing rather than handing the user a card about half a paragraph.
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      proseFrames('I have started on the precedence table, and the first arm is', 'length'),
      proseFrames('The table is most of the way rewritten; what is left is', 'length'),
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
        { id: 'tests', text: 'Add tests for it', status: 'done' },
      ]),
      proseFrames('The precedence table is updated.'),
    ],
  })

  const spent = marks(chunks)
  assert.deepEqual(
    spent.map((mark) => mark.count),
    [1, 2],
    'two capped replies, two continuations'
  )
  assert.equal(
    spent.every((mark) => mark.cause === 'truncated'),
    true,
    'each of them naming the output cap as the reason, because that is why the machine kept going'
  )
  assert.equal(nudges(sent).length, 2, 'and the provider was nudged both times')
  const nudge = autoContinueNudge(2)
  assert.deepEqual(
    [sent[2]?.messages.at(-1), sent[3]?.messages.at(-1)],
    // The same sentence twice, and that is not a slip: the plan had not changed between the two capped
    // replies, so the work described to the model was the same work both times.
    [
      { role: 'user', content: nudge },
      { role: 'user', content: nudge },
    ],
    'the nudge went out as the last message of the request that followed it'
  )
  assert.equal(
    chunks.some((chunk) => chunk.type === 'awaiting_approval'),
    false,
    'and no permission card was raised: nothing here needed a person'
  )

  // The turn is one turn: the capped replies were kept, and the work that followed them is in the same
  // answer rather than in a new one.
  const turns = transcript(chunks)
  assert.equal(turns.length, 1, 'still one turn')
  assert.equal(
    turns.some((turn) => turn.role === 'user'),
    false,
    'with no user message in it, the nudge being main\u2019s own'
  )
  assert.equal(turns[0].content.includes('the first arm is'), true, 'the capped reply was kept, not discarded')
  assert.equal(turns[0].content.includes('is updated'), true, 'and the finished work followed it')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'turn_end_notice'),
    false,
    'and there is nothing to announce, because the plan got done'
  )
  assert.equal(chunks.at(-1)?.type, 'done', 'the turn ends the ordinary way')
  results.push('two capped replies mid-plan are nudged twice, with no click, and the turn finishes the work')
}

async function aCappedReplyCutInsideAToolCallPicksItselfUpMidPlan() {
  // The same ending as the test above, in the shape it actually arrives in. The provider's cap does not
  // land neatly between two calls: it lands inside one, so the frame holds a call that was still being
  // written — and that partial call used to be read as work in hand, which ended the turn on the card
  // with the plan unfinished and the budget unspent.
  const first = 'I have the first arm measured, and what is left is '
  const second = 'The table is half written, and what is left is '
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      cutCallFrames('cut1', first, 'write_file', '{"path":"src/parser.ts","content":"const table = ['),
      cutCallFrames('cut2', second, 'write_file', '{"path":"src/parser.ts","content":"const table = [1,'),
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
        { id: 'tests', text: 'Add tests for it', status: 'done' },
      ]),
      proseFrames('The precedence table is updated.'),
    ],
  })

  const spent = marks(chunks)
  assert.deepEqual(
    spent.map((mark) => mark.count),
    [1, 2],
    'two capped replies inside a tool call, two auto-continuations'
  )
  assert.equal(
    spent.every((mark) => mark.cause === 'truncated'),
    true,
    'each of them naming the output cap, because that is the ending it was'
  )
  assert.equal(nudges(sent).length, 2, 'and the provider was nudged rather than the user being carded')

  // Neither cut payload ever became a call: nothing was announced for it, nothing executed, nothing was
  // answered. The only calls that ran are the two plans the model declared in full, which is the whole
  // claim of discarding a cut frame's calls instead of running half of one.
  for (const callId of ['cut1', 'cut2']) {
    assert.equal(
      chunks.some((chunk) => chunk.callId === callId),
      false,
      `${callId} was never announced, never run, and never answered`
    )
  }
  const ran = [
    ...new Set(
      chunks
        .filter((chunk) => chunk.type === 'tool_call_start' || chunk.type === 'tool_result')
        .map((chunk) => chunk.callId)
    ),
  ]
  assert.deepEqual(ran, ['p1', 'p2'], 'and the calls that did run are the ones the model declared in full')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'awaiting_approval'),
    false,
    'with no permission asked for a call that does not exist'
  )

  // The request that followed the first capped reply: the reply was kept as the assistant turn, with no
  // calls on it. Its call was never run, so no result for it will ever be sent — and an assistant turn
  // asking for results that never come is a request the provider refuses.
  const afterCut = sent[2]?.messages ?? []
  assert.equal(
    afterCut.filter((message) => message.role === 'assistant').at(-1)?.tool_calls,
    undefined,
    'so the cut reply reached the provider carrying no tool call'
  )
  assert.deepEqual(
    afterCut.at(-1),
    { role: 'user', content: autoContinueNudge(2) },
    'with the nudge as its last message'
  )

  // One turn, no user message: the nudge is main's, and the pane is never told a person typed it.
  const turns = transcript(chunks)
  assert.equal(turns.length, 1, 'still one turn')
  assert.equal(
    turns.some((turn) => turn.role === 'user'),
    false,
    'with no user message in it'
  )
  assert.equal(turns[0].content.includes(first), true, 'the capped text was kept, not discarded')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'turn_end_notice'),
    false,
    'and there is no card, because the loop took the click the user would have made'
  )
  assert.equal(chunks.at(-1)?.type, 'done', 'the turn ends the ordinary way')

  // The seams, with the reason and the budget the pane draws its lines from — and with where in the prose
  // each one was made, which is what puts the line between the capped text and the work that resumed it
  // rather than above the answer.
  assert.deepEqual(
    turns[0].continuations?.map((mark) => `${mark.count} of ${mark.max} after ${mark.cause}`),
    ['1 of 8 after truncated', '2 of 8 after truncated'],
    'two seams, each naming the output cap as the reason the machine kept going'
  )
  const offsets = turns[0].continuations?.map((mark) => mark.afterChars ?? -1) ?? []
  assert.equal(turns[0].content.slice(0, offsets[0]), first, 'the first seam sits after the text the cut left')
  assert.equal(offsets[1] > offsets[0], true, 'and the second one further along the prose it ended')
  results.push('a reply capped inside a tool call is nudged twice, and the partial call is never run')
}

async function aCappedReplyCutInsideAToolCallSpendsTheBudgetThenGetsTheCard() {
  // The same death, one reply past the budget. The loop nudges while it has room to and the card is what
  // is left when it does not — which is the claim the live check rests on: under a truncated turn, a card
  // now means the budget rather than the shape of the reply that died.
  const stops = AUTO_CONTINUE_MAX + 1
  const { chunks } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      ...Array.from({ length: stops }, (_, index) =>
        cutCallFrames(
          `cut${index + 1}`,
          `Pass ${index + 1}, and what is left is `,
          'write_file',
          `{"path":"src/parser.ts","content":"const table = [${index},`
        )
      ),
    ],
  })

  assert.deepEqual(
    marks(chunks).map((mark) => mark.count),
    Array.from({ length: AUTO_CONTINUE_MAX }, (_, index) => index + 1),
    'the whole budget, spent on replies that were each capped inside a tool call'
  )
  assert.equal(
    marks(chunks).every((mark) => mark.cause === 'truncated'),
    true,
    'every one of them naming the output cap'
  )
  // The ending a cut-off reply gets is the one it already had, and it is not the `done` an ordinary
  // answer ends with: this path has no reason to report, so the notice is the last thing the run says.
  assert.equal(chunks.at(-2)?.type, 'turn_end', 'the turn ends when the budget is spent')
  assert.equal(chunks.at(-1)?.type, 'turn_end_notice', 'with the notice a spent budget leaves behind')
  assert.equal(notice(chunks)?.cause, 'truncated', 'naming the ending it actually had')
  assert.equal(notice(chunks)?.unfinishedSteps, 2, 'and the work still on the plan')
  assert.equal(notice(chunks)?.resumable, true, 'with the Continue click the way on')
  assert.equal(
    chunks.some((chunk) => String(chunk.callId ?? '').startsWith('cut')),
    false,
    'and not one of the cut payloads was ever run'
  )
  results.push('a reply capped inside a tool call spends the budget and then gets the card, like any stop past it')
}

async function aDroppedConnectionEndsTheTurnWithTheCard() {
  // The one ending a further request cannot fix. The reply stopped arriving, so the app stops and asks
  // the person rather than spending their money on a connection that is not there.
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
      ]),
      failingResponse([
        JSON.stringify({ choices: [{ delta: { content: 'I have started on the precedence table, and' } }] }),
      ]),
    ],
  })

  assert.deepEqual(marks(chunks), [], 'a dropped connection is never nudged')
  assert.equal(sent.length, 2, 'and the model is not asked again')
  assert.equal(notice(chunks)?.cause, 'stream_error', 'the turn ends naming the ending it had')
  assert.equal(notice(chunks)?.unfinishedSteps, 1, 'with the work that is left')
  assert.equal(notice(chunks)?.resumable, true, 'and the Continue click the user still has')
  assert.equal(chunks.at(-1)?.type, 'turn_end_notice', 'the card is the last thing the run says')
  assert.equal(
    transcript(chunks)[0]?.content,
    'I have started on the precedence table, and',
    'and the part of the reply that did arrive was kept'
  )
  results.push('a dropped connection ends the turn with the card, and no nudge is spent on it')
}

// ---------------------------------------------------------------- the step ceiling

/**
 * A round-trip that declares the plan again, so a segment's budget drains with work still on it.
 *
 * A plan declaration per round-trip rather than prose, because the step ceiling is what these cases are
 * about: the turn has to reach it with an unfinished plan, and it has to do that the way a long turn does
 * — by working — rather than by stopping and being nudged for a different reason.
 */
function workingFrames(callId: string): string[] {
  return planFrames(callId, [
    { id: 'read', text: 'Read the parser', status: 'done' },
    { id: 'edit', text: 'Change the precedence table', status: 'in_progress' },
  ])
}

/** One segment's worth of work: MAX_STEPS round-trips, each declaring the plan with a call id of its own. */
function aSegment(prefix: string): string[][] {
  return Array.from({ length: MAX_STEPS }, (_, index) => workingFrames(`${prefix}${index + 1}`))
}

async function theStepCeilingIsNudgedAndItsBudgetStartsOver() {
  // Two segments spent at the ceiling with the plan unfinished, then a third that finishes it. Before this
  // phase the first ceiling ended the turn on the card with the auto-continue budget untouched, because the
  // exit passed `continuable = false` and the guard short-circuited before the rule was ever asked.
  const { chunks, sent } = await runLoop({
    rounds: [
      ...aSegment('a'),
      ...aSegment('b'),
      planFrames('finish', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
      ]),
      proseFrames('The precedence table is updated.'),
    ],
  })

  const spent = marks(chunks)
  assert.deepEqual(
    spent.map((mark) => mark.count),
    [1, 2],
    'two segments spent at the ceiling, two continuations'
  )
  assert.equal(
    spent.every((mark) => mark.cause === 'model_stop'),
    true,
    'each naming the ending it had: the last reply arrived complete, and it was the loop that stopped'
  )
  assert.equal(
    spent.every((mark) => mark.max === AUTO_CONTINUE_MAX),
    true,
    'against the one bound the user reads, which the ceiling does not raise'
  )

  // The reset, as the wire shows it: a nudge opens a segment, and that segment is as long as the first. The
  // first request carrying a nudge is request MAX_STEPS and the second is two segments in, so there is a
  // whole segment of round-trips between the two ceilings rather than none. Without the reset the second
  // nudge would arrive with no request behind it, which is a round-trip paid to re-hit the same wall.
  assert.deepEqual(
    nudgePositions(sent),
    [MAX_STEPS, MAX_STEPS * 2],
    'each nudge opened a segment of its own, MAX_STEPS round-trips long'
  )
  assert.equal(sent.length, MAX_STEPS * 2 + 2, 'and the run asked for every round-trip it made')

  // One turn, ended complete, and with no user message in it: the nudges are main's own, so the pane is
  // never told a person typed them, however many of them the loop spent.
  assert.equal(chunks.filter((chunk) => chunk.type === 'turn_end').length, 1, 'the turn ends once')
  const last = chunks.at(-1)
  assert.equal(last?.type, 'done', 'with one ending')
  assert.equal(last?.reason, 'complete', 'and it is the ordinary one, because the plan got finished')
  assert.equal(
    last?.steps,
    2,
    'counted from the nudge that opened the last segment rather than from the start of the turn'
  )
  const turns = transcript(chunks)
  assert.equal(turns.length, 1, 'still one turn')
  assert.equal(
    turns.some((turn) => turn.role === 'user'),
    false,
    'and no user message was appended to the transcript'
  )
  assert.deepEqual(
    turns[0].continuations?.map((mark) => mark.count),
    [1, 2],
    'the two seams are recorded on the one turn they split'
  )
  results.push('a step-budget ceiling with work left is nudged, and the step budget starts over per segment')
}

async function aTurnThatHitsTheStepCeilingNineTimesGetsTheCard() {
  const ceilings = AUTO_CONTINUE_MAX + 1
  const { chunks, sent } = await runLoop({
    // Nine segments of work with the plan still unfinished: the ceiling, nine times, with nothing in
    // between that could have ended the turn any other way.
    rounds: Array.from({ length: ceilings }, (_, segment) => aSegment(`s${segment + 1}-`)).flat(),
  })

  assert.deepEqual(
    marks(chunks).map((mark) => mark.count),
    Array.from({ length: AUTO_CONTINUE_MAX }, (_, index) => index + 1),
    'the whole budget, spent at the ceiling rather than at the model'
  )

  // The card, which is what a spent budget leaves, and it carries the ending the ceiling has: the last
  // reply arrived complete and it was the loop that stopped, so the cause copy says nothing and the plan
  // is what the card is about.
  assert.equal(chunks.at(-1)?.type, 'done', 'the run ends')
  assert.equal(chunks.at(-1)?.reason, 'max_steps', 'at the budget, which is what it hit')
  assert.equal(notice(chunks)?.cause, 'model_stop', 'naming the ending it actually had')
  assert.equal(notice(chunks)?.unfinishedSteps, 1, 'with the work still on the plan')
  assert.equal(notice(chunks)?.resumable, true, 'and the Continue click as the way on')

  // And that is what a reopened conversation reads: the record keeps the cause beside the count, so the
  // pane that never saw this run says the same two things about it.
  const saved = record(chunks)
  assert.equal(saved.turns[0].endNotice?.cause, 'model_stop', 'the ending is stored with the turn')
  assert.equal(saved.turns[0].endNotice?.unfinishedSteps, 1, 'and so is the work it stopped on')

  // Nine ceilings, nine whole segments: the ceiling is not reached sooner for having been reached before,
  // which is the same property the two-nudge case asserts, measured at the edge of the budget.
  assert.equal(sent.length, MAX_STEPS * ceilings, 'every segment was as long as the first one')
  assert.equal(nudges(sent).length, AUTO_CONTINUE_MAX, 'and the whole budget went on the wire')
  results.push('a turn that hits the step ceiling past its budget gets the card, cause and work stored')
}

// ---------------------------------------------------------------- the run

async function main() {
  await aModelThatStopsThreeTimesMidPlanEndsOneTurn()
  await aModelThatStopsPastItsBudgetGetsTheCard()
  await aTurnSpendsItsOwnBudget()
  await aTruncatedTurnPicksItselfUpMidPlan()
  await aCappedReplyCutInsideAToolCallPicksItselfUpMidPlan()
  await aCappedReplyCutInsideAToolCallSpendsTheBudgetThenGetsTheCard()
  await aDroppedConnectionEndsTheTurnWithTheCard()
  await theStepCeilingIsNudgedAndItsBudgetStartsOver()
  await aTurnThatHitsTheStepCeilingNineTimesGetsTheCard()

  console.log(`\nbounded auto-continue: ${results.length} checks passed`)
  for (const line of results) console.log(`  pass: ${line}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
