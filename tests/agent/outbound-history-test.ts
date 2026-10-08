/**
 * The outbound history a provider is handed: what may not be in it, and what the app does to a
 * transcript that contains it.
 *
 * The defect this pins is a transcript shape rather than a component: a turn that died without
 * writing anything — a reply cut off at the output cap, a stream that broke, an ending that arrived
 * with nothing in it — leaves an assistant turn with empty content and no tool calls behind, and a
 * provider refuses the whole request for it (`... the message at position 16 with role 'assistant'
 * must not be empty`). The refusal names one position and the same one on every rebuild, which is
 * where the shape gives it away: the empty turn is in stored history, so every continue re-sends it
 * and every continue fails the same way.
 *
 * So the subject here is the wire, not the pane: the messages array a run actually puts in a request
 * body, captured from the mocked provider beside the loop — plus the invariant every request of every
 * run has to satisfy, checked across the whole scripted history rather than at one ending.
 */
import { strict as assert } from 'node:assert'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { EMPTY_ASSISTANT_MARKER, sanitizeOutboundHistory } from '../../conveyor/protocol/history'
import { toHistory, type AgentTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

// ---------------------------------------------------------------- the harness

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
 * A reply that says nothing at all: no prose, no tool call, an ordinary finish reason.
 *
 * Every fact the loop collects about it is ordinary, so it ends on the model-stop path with an empty
 * frame and no work asked for — the ending that has nothing to record and, before this phase, recorded
 * an empty assistant turn anyway.
 */
function silentFrames(): string[] {
  return [stopFrame('stop'), '[DONE]']
}

/** A `set_plan` call, declared the way the model declares one. */
function planFrames(callId: string, steps: Array<{ id: string; text: string; status: string }>): string[] {
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
 * A reply the provider cut off inside a tool-call payload, with no prose in it at all.
 *
 * The dominant death of a long turn, in the shape it arrives in: the cap lands inside a call rather
 * than between two of them, so the frame holds a call that was still being written. The reply's calls
 */
function cutCallFrames(callId: string, tool: string, partialArgs: string): string[] {
  return [
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

/** The same reply, on a connection that then goes away — the ending no further request can fix. */
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

type SentMessages = Array<{ role: string; content: string; tool_calls?: Array<{ id: string }> }>

interface SentRequest {
  messages: SentMessages
}

/** A provider that answers each request with the next scripted round, and logs what it was sent. */
function scriptedFetch(
  rounds: Array<string[] | Response>,
  log: SentRequest[]
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push(JSON.parse(String(init.body)) as SentRequest)
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
    })
  )
  return { chunks, sent }
}

// ---------------------------------------------------------------- what the wire may not carry

/** Every assistant message in a request that says nothing and asks for nothing. */
function emptyAssistantMessages(messages: SentMessages): SentMessages {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      // A turn that carries tool calls is not this: the dialects allow an empty string there, and the
      // loop has shipped that shape since it could call a tool at all. What is left is the turn with
      // nothing in it at either end, which is the one a provider refuses the whole request for.
      (message.tool_calls ?? []).length === 0 &&
      String(message.content ?? '').trim() === ''
  )
}

/**
 * Two turns of one role side by side, among the roles that have to alternate.
 *
 * `system` stands above the conversation and `tool` answers a call, so the alternation that matters is
 * the conversation's: two user turns with no assistant between them, or two assistant turns with no
 * user between them, is a history a dialect refuses outright.
 */
function adjacentSameRole(messages: SentMessages): string[] {
  const pairs: string[] = []
  for (let index = 1; index < messages.length; index++) {
    const before = messages[index - 1].role
    const after = messages[index].role
    if (before === after && (before === 'user' || before === 'assistant')) pairs.push(`${index - 1}/${index}`)
  }
  return pairs
}

/** Tool results whose call no assistant turn in the same request announces. */
function orphanToolResults(messages: SentMessages): number[] {
  const announced = new Set<string>()
  const orphans: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) announced.add(call.id)
    const answers = (message as { tool_call_id?: string }).tool_call_id
    if (message.role === 'tool' && (answers === undefined || !announced.has(answers))) orphans.push(index)
  }
  return orphans
}

/** Every invariant a single request has to satisfy, as the failing sentence when one does not. */
function assertRequestIsLegal(request: SentRequest, where: string): void {
  assert.deepEqual(
    emptyAssistantMessages(request.messages).map((message) => message.content),
    [],
    `${where}: an assistant message with empty content was sent`
  )
  assert.deepEqual(adjacentSameRole(request.messages), [], `${where}: two turns of one role sat side by side`)
  assert.deepEqual(orphanToolResults(request.messages), [], `${where}: a tool result answers a call nobody made`)
}

// ---------------------------------------------------------------- the shapes from disk

/**
 * The turns of a stored transcript that carries the defect, read off a real one.
 *
 * `%APPDATA%\era\sessions\a2c6b844-ad49-4349-bc9d-c9dd9586e515.json` holds exactly this shape — a
 * question, an answer, a question, then an assistant turn with nothing in it and no steps, then
 * another question and another empty turn — which is what every failed continue of the live session
 * re-sent. Copied here rather than read from disk, because a suite must not depend on one machine's
 * app data: the shape is the subject and the shape is what is written down.
 */
function storedShapeTurns(): AgentTurn[] {
  return [
    { id: 'user-1', role: 'user', content: 'What is inside the current directory?', steps: [] },
    { id: 'assistant-2', role: 'assistant', content: 'This is a Laravel (PHP) web application.', steps: [] },
    { id: 'user-3', role: 'user', content: 'Which AI model are you? Deepseek or GPT??', steps: [] },
    { id: 'assistant-4', role: 'assistant', content: '', steps: [] },
    { id: 'user-5', role: 'user', content: 'Are you stuck somewhere?', steps: [] },
    { id: 'assistant-6', role: 'assistant', content: '', steps: [] },
  ]
}

// ---------------------------------------------------------------- the cases

/**
 * The stored shape, sent again.
 *
 * This is the whole defect in one request: the read site hands the transcript over as it stands, and
 * the empty assistant turn reaches the provider at a position that is fixed by where it sits in the
 * transcript. Nothing about the run is unusual — an ordinary question — so the refusal is about the
 * history and about nothing else.
 */
async function theStoredShapeIsNotSentAgain() {
  const messages = toHistory(storedShapeTurns())

  // The premise, pinned rather than assumed: the projection is the transcript's own, and it carries
  // the empty turns through. Whether it *should* is this phase's question; that it does is the state
  // every failed continue was built on.
  assert.deepEqual(
    messages.filter((message) => message.role === 'assistant' && message.content === '').length,
    2,
    'the stored transcript has two empty assistant turns and the read site passes both through'
  )

  const { sent } = await runLoop({ rounds: [proseFrames('Still here.')], messages: messages as never })

  assert.equal(sent.length, 1, 'one round-trip was needed')
  assertRequestIsLegal(sent[0], 'a continue of the stored shape')

  // And the repair is a repair of the *wire*, not of the conversation: what the user typed and what
  // the model answered are still there, in order, with the turn that had nothing in it standing between
  // the two questions rather than taken out and leaving them side by side.
  assert.deepEqual(
    sent[0].messages
      .filter((message) => message.role === 'user' || message.role === 'tool')
      .map((message) => message.role),
    ['user', 'user', 'user'],
    'every turn the user actually wrote is still in the request'
  )
  assert.equal(
    sent[0].messages.filter((message) => message.role === 'assistant' && message.content === EMPTY_ASSISTANT_MARKER)
      .length,
    1,
    'and the turn that had nothing in it stands between the two questions, saying so'
  )
  results.push('a continue rebuilt from the stored shape reaches the provider without an empty assistant turn')
}

/**
 * The death that makes the empty turn in the first place, in the same run.
 *
 * A reply cut off inside a tool call, with no prose in it: Phase 36's rule empties the frame's calls,
 * so the round-trip ends with nothing spoken and nothing asked for. The loop records the assistant
 * turn anyway — that is the write site — and the nudge that follows it re-sends the history on the
 * very next request, which is the refusal the user sees before any tool has run.
 */
async function aCutReplyLeavesNothingEmptyOnTheWire() {
  const { sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'edit', text: 'Change the precedence table', status: 'pending' },
      ]),
      cutCallFrames('cut1', 'write_file', '{"path":"src/parser.ts","content":"const table = ['),
      // The plan reconciled and the answer that ends the turn. Written out rather than left to the
      // scripted fallback, because what a nudged turn ends on is not this suite's subject — the requests
      // it made before it ended are.
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
      ]),
      proseFrames('The table is rewritten.'),
    ],
  })

  assert.equal(sent.length, 4, 'the plan, the capped reply, the reconciled plan, and the answer')
  for (const [index, request] of sent.entries()) assertRequestIsLegal(request, `request ${index + 1}`)
  results.push('a reply cut off with no prose in it is nudged without an empty assistant turn on the wire')
}

/**
 * The other ending that writes nothing: a stop that arrived with nothing in it.
 *
 * No prose, no call, an ordinary finish reason — so the diagnosis reads it as the model stopping and
 * the plan, not the frame, decides whether the app continues. It does. What it must not do is put an
 * empty assistant turn on the wire between the user's message and its own nudge.
 */
async function aSilentStopLeavesNothingEmptyOnTheWire() {
  const { sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'edit', text: 'Change the precedence table', status: 'pending' },
      ]),
      silentFrames(),
      planFrames('p2', [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'edit', text: 'Change the precedence table', status: 'done' },
      ]),
      proseFrames('Both steps are done.'),
    ],
  })

  assert.equal(sent.length, 4, 'the plan, the silent stop, the reconciled plan, and the answer')
  for (const [index, request] of sent.entries()) assertRequestIsLegal(request, `request ${index + 1}`)
  results.push('a stop that arrived with nothing in it is nudged without an empty assistant turn on the wire')
}

/**
 * The whole history of a hard run, checked request by request.
 *
 * The three endings the live session suffered in one turn — a plan, a cap, a dropped line — so the
 * invariants are asserted against every request the run made rather than against the ending that
 * happened to be under the microscope.
 */
async function everyRequestOfAHardRunIsLegal() {
  const { chunks, sent } = await runLoop({
    rounds: [
      planFrames('p1', [
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'edit', text: 'Change the precedence table', status: 'pending' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ]),
      cutCallFrames('cut1', 'write_file', '{"path":"src/parser.ts","content":"const table = ['),
      failingResponse([JSON.stringify({ choices: [{ delta: {} }] })]),
    ],
  })

  assert.equal(sent.length, 3, 'the plan, the capped reply, and the line that then went away')
  for (const [index, request] of sent.entries()) assertRequestIsLegal(request, `request ${index + 1}`)
  assert.equal(
    chunks.some((chunk) => chunk.type === 'turn_end_notice' && chunk.cause === 'stream_error'),
    true,
    'and the ending a further request cannot fix is still the card it was'
  )
  results.push('every request of a run that was capped and then dropped is legal as it stands')
}

/**
 * A refused request stays a refused request.
 *
 * The provider that answers 400 is refusing the whole body, and the app reports that rather than
 * treating it as a turn to retry: a second request built out of the same history would be refused the
 * same way, which is exactly the loop the live session was in. Only the *history* is repaired here,
 * never the request that was already refused.
 */
async function aRefusedRequestIsNotRetried() {
  const refusal = {
    ok: false,
    status: 400,
    body: null,
    text: async () =>
      JSON.stringify({ error: { message: "the message at position 16 with role 'assistant' must not be empty" } }),
  } as unknown as Response

  const sent: SentRequest[] = []
  let threw = false
  try {
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: null,
        messages: [{ role: 'user', content: 'continue' }] as never,
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: scriptedFetch([refusal], sent) as never,
      })
    )
  } catch {
    threw = true
  }

  assert.equal(threw, true, 'a refused request is reported rather than swallowed')
  assert.equal(sent.length, 1, 'and it is not asked again with the same history')
  results.push('a request the provider refused is reported, and no second one is built from it')
}

// ---------------------------------------------------------------- the rule itself

/** A message as the rule's own tests write one down, without the loop in the way. */
interface RuleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** A tool call, spelled the way the wire spells it. */
function call(id: string, name = 'read_file'): NonNullable<RuleMessage['tool_calls']>[number] {
  return { id, type: 'function', function: { name, arguments: '{}' } }
}

/** Whether two turns of one role sit side by side among the roles that must alternate. */
function adjacentTurns(messages: RuleMessage[]): string[] {
  const pairs: string[] = []
  for (let index = 1; index < messages.length; index++) {
    const before = messages[index - 1]
    const after = messages[index]
    if (before.role === after.role && (before.role === 'user' || before.role === 'assistant')) {
      pairs.push(`${index - 1}/${index}`)
    }
  }
  return pairs
}

/** Tool results left addressing a call no assistant turn in the history announces. */
function unpairedResults(messages: RuleMessage[]): number[] {
  const announced = new Set<string>()
  const unpaired: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') for (const entry of message.tool_calls ?? []) announced.add(entry.id)
    if (message.role === 'tool' && (message.tool_call_id === undefined || !announced.has(message.tool_call_id))) {
      unpaired.push(index)
    }
  }
  return unpaired
}

function rolesOf(messages: RuleMessage[]): string[] {
  return messages.map((message) => message.role)
}

/**
 * The rule against the shapes a real transcript can hold, and its two invariants over every one of them.
 *
 * The expected sequences are the rule's decisions, and the invariants are the reason it had to make
 * them: no two turns of one role side by side, and no tool result left answering a call that is gone. The
 * second is structural rather than lucky — a turn that carries calls is never a candidate for the drop —
 * and it is asserted here anyway, because the day it stops being structural is the day a conversation
 * starts being refused for a reason nobody predicted.
 */
function theRuleItself() {
  const shapes: Array<{ what: string; input: RuleMessage[]; expected: string[] }> = [
    {
      what: 'a turn with nothing in it between two questions',
      input: [
        { role: 'user', content: 'what is in here?' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'are you stuck?' },
      ],
      expected: ['user', 'assistant', 'user'],
    },
    {
      what: 'a turn with nothing in it between an answer and its follow-up',
      input: [
        { role: 'user', content: 'what is in here?' },
        { role: 'assistant', content: 'A Laravel app.' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'thanks' },
      ],
      expected: ['user', 'assistant', 'user'],
    },
    {
      what: 'nothing but an empty turn',
      input: [{ role: 'assistant', content: '' }],
      expected: [],
    },
    {
      what: 'two empty turns in a row between two questions',
      input: [
        { role: 'user', content: 'hello?' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'hello?' },
      ],
      expected: ['user', 'assistant', 'user'],
    },
    {
      what: 'an empty turn after a tool result',
      input: [
        { role: 'user', content: 'read a.txt' },
        { role: 'assistant', content: '', tool_calls: [call('c1')] },
        { role: 'tool', tool_call_id: 'c1', content: 'hello\n' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'and now?' },
      ],
      expected: ['user', 'assistant', 'tool', 'user'],
    },
    {
      what: 'a turn holding only spaces',
      input: [
        { role: 'user', content: 'hello?' },
        { role: 'assistant', content: '   \n  ' },
        { role: 'user', content: 'hello?' },
      ],
      expected: ['user', 'assistant', 'user'],
    },
  ]

  for (const shape of shapes) {
    const output = sanitizeOutboundHistory(shape.input)
    assert.deepEqual(rolesOf(output), shape.expected, `${shape.what}: the turns that stayed are not the turns it keeps`)
    assert.deepEqual(adjacentTurns(output), [], `${shape.what}: two turns of one role were left side by side`)
    assert.deepEqual(unpairedResults(output), [], `${shape.what}: a tool result was left answering a call nobody made`)
  }

  // The marker's wording is the rule's own claim, so it is asserted rather than assumed: a turn that
  // stood between two questions still has a `content` field with a string in it, and a provider reads a
  // sentence rather than an empty string.
  const marked = sanitizeOutboundHistory<RuleMessage>([
    { role: 'user', content: 'hello?' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'hello?' },
  ])
  assert.equal(marked[1].content, EMPTY_ASSISTANT_MARKER, 'the turn that had to stay says what it is')
  results.push('the outbound rule drops a silent turn, or marks it when dropping would break the alternation')
}

/**
 * A turn that asked for tools and wrote no prose keeps its calls, and keeps them with the content the
 * dialects allow beside them.
 *
 * The empty string is not this phase's defect: a turn that asks for a tool and narrates nothing is most
 * turns, and this app has been sending that shape since it could call a tool at all — so the rule must
 * leave it exactly as it is, calls and all, or the results that come back would answer a call the
 * request no longer contains.
 */
function aTurnThatAskedForAToolIsLeftAlone() {
  const history: RuleMessage[] = [
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2', 'write_file')] },
    { role: 'tool', tool_call_id: 'c1', content: 'hello\n' },
    { role: 'tool', tool_call_id: 'c2', content: 'written' },
  ]

  assert.deepEqual(sanitizeOutboundHistory(history), history, 'the turn and both its results went through untouched')
  results.push('an assistant turn with calls and no prose keeps its calls, which is the shape the dialects accept')
}

/**
 * An ending the app reports is not an ending the model said.
 *
 * A turn that died carries its error on the pane's own turn, and that turn is not conversation: what the
 * provider is sent is the text of what was said. So the shape the read site hands over for an error
 * ending is a history with no assistant message in it at all — which is also why an error needs no
 * repair of its own, and why the repair belongs where the other shapes are rather than beside the throw.
 */
function anErrorEndingIsNotConversation() {
  const messages = toHistory([
    { id: 'user-1', role: 'user', content: 'hello', steps: [] },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      steps: [],
      error:
        "The provider refused the request (400). Invalid request: the message at position 16 with role 'assistant' must not be empty",
    },
    { id: 'user-3', role: 'user', content: 'continue', steps: [] },
  ])

  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'user'],
    'the turn that died is reported to the user and never sent'
  )
  results.push('a turn that ended in an error is the pane\u2019s own, and reaches no provider')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('a continue of the stored shape', theStoredShapeIsNotSentAgain)
  await step('a reply cut off with no prose', aCutReplyLeavesNothingEmptyOnTheWire)
  await step('a stop with nothing in it', aSilentStopLeavesNothingEmptyOnTheWire)
  await step('a hard run, request by request', everyRequestOfAHardRunIsLegal)
  await step('a refused request', aRefusedRequestIsNotRetried)
  await step('the rule itself', theRuleItself)
  await step('a turn that asked for a tool', aTurnThatAskedForAToolIsLeftAlone)
  await step('an error ending', anErrorEndingIsNotConversation)

  console.log('outbound history: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('OUTBOUND HISTORY TEST FAILED:', err)
  process.exit(1)
})
