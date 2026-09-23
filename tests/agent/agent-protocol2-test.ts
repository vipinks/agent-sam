/**
 * Reproduces the provider 400: "An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'".
 *
 * The trigger, established by reading the loop rather than guessing: when one assistant turn asks
 * for several calls that each need approval, only the gated one is answered before the next model
 * request goes out, so the batch is left partly unanswered.
 *
 * `validatedFetch` is the teeth of this test — every request body is checked against the protocol
 * before the mocked provider would answer, so a violation fails here rather than in production.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../../conveyor/modules/agent'

const results: string[] = []

interface WireMessage {
  role: string
  content?: string
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

/**
 * The provider's contract: every assistant turn carrying `tool_calls` must be followed immediately
 * by exactly one tool message per call id — no more, no fewer, and matching ids.
 */
function assertToolContract(messages: WireMessage[], where: string): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    const calls = message.tool_calls
    if (message.role !== 'assistant' || !calls?.length) continue

    const ids = calls.map((c) => c.id)
    const answered: string[] = []
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j].role !== 'tool') break
      answered.push(String(messages[j].tool_call_id))
    }

    assert.equal(
      answered.length,
      ids.length,
      `${where}: assistant tool_calls [${ids.join(', ')}] must be followed by ${ids.length} tool messages, found ${answered.length}`
    )
    for (const id of ids) {
      assert.ok(answered.includes(id), `${where}: no tool message answers '${id}' (got ${answered.join(', ')})`)
    }
  }
}

/** A fetch that validates the contract on every request, as the provider would. */
function validatedFetch(
  responder: (call: number, body: { messages: WireMessage[] }) => Response | Promise<Response>,
  seen: WireMessage[][]
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    const body = JSON.parse(String(init.body)) as { messages: WireMessage[] }
    seen.push(body.messages)
    // Throwing here is the provider's 400: the request never reaches the model.
    assertToolContract(body.messages, `request ${call}`)
    return responder(call, body)
  }
}

function sse(frames: string[]): Response {
  const payload = frames.map((f) => `data: ${f}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 48) controller.enqueue(bytes.slice(i, i + 48))
        controller.close()
      },
    }),
    text: async () => '',
  } as unknown as Response
}

/** One assistant turn requesting several calls, each with its arguments complete. */
function toolCallFrames(calls: Array<{ id: string; name: string; args: unknown }>): string[] {
  const frames = [
    JSON.stringify({
      choices: [
        {
          delta: {
            role: 'assistant',
            tool_calls: calls.map((c, index) => ({
              index,
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: '' },
            })),
          },
        },
      ],
    }),
  ]
  calls.forEach((c, index) => {
    frames.push(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] } }],
      })
    )
  })
  frames.push('[DONE]')
  return frames
}

function answers(...texts: string[]): string[] {
  return [...texts.map((t) => JSON.stringify({ choices: [{ delta: { content: t } }] })), '[DONE]']
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- the reproduction

/**
 * Two commands, both needing approval, in one assistant turn: each is decided on its own, in the
 * frame's own order, and the model is asked again only once the frame is settled.
 *
 * Every request the loop makes is validated, so if the frame were left partly unanswered before the
 * next model call went out, this would fail with the provider's own complaint.
 */
async function twoGatedCallsAreDecidedOneAtATime() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto2-'))
  try {
    const seen: WireMessage[][] = []
    const fetchImpl = validatedFetch(async (call) => {
      if (call === 1) {
        return sse(
          toolCallFrames([
            { id: 'c1', name: 'run_command', args: { command: 'echo one' } },
            { id: 'c2', name: 'run_command', args: { command: 'echo two' } },
          ])
        )
      }
      return sse(answers('Both decided.'))
    }, seen)

    const signal = new AbortController().signal
    const base = {
      providerId: 'deepseek',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: root,
      autoApprove: false,
      signal,
      fetchImpl: fetchImpl as never,
    }

    // Round 1: both calls need approval, so the run pauses on the first.
    const first = await collect(runAgentLoop({ ...base, messages: [{ role: 'user', content: 'run two commands' }] }))
    const pause = first.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, `expected a pause, got ${JSON.stringify(first.map((c) => c.type))}`)
    assert.equal(pause.callId, 'c1', 'the first call is the one being asked about')
    assert.deepEqual(
      (pause.calls as Array<{ id: string }>).map((c) => c.id),
      ['c1', 'c2'],
      'the queue behind it is carried, so the next pause knows what is left'
    )

    // Decision one: approve c1. The loop must run it and come back asking about c2 — not about both,
    // and not about neither.
    const second = await collect(
      runAgentLoop({
        ...base,
        messages: pause.messages as never,
        steps: pause.steps as number,
        pending: { calls: pause.calls as never, denied: false },
      })
    )
    assert.equal(seen.length, 1, 'the model must not be asked anything while a call is undecided')
    const secondPause = second.find((c) => c.type === 'awaiting_approval')
    assert.ok(secondPause, `expected a second pause, got ${JSON.stringify(second.map((c) => c.type))}`)
    assert.equal(secondPause.callId, 'c2', 'the second call is presented on its own')
    assert.deepEqual(
      (secondPause.calls as Array<{ id: string }>).map((c) => c.id),
      ['c2'],
      'and it is alone in the queue now'
    )
    assert.ok(
      second.some((c) => c.type === 'tool_result' && c.callId === 'c1'),
      'the approved call reported its result before the next prompt'
    )

    // Decision two: approve c2 as well, which settles the frame and lets the model be asked again.
    const third = await collect(
      runAgentLoop({
        ...base,
        messages: secondPause.messages as never,
        steps: secondPause.steps as number,
        pending: { calls: secondPause.calls as never, denied: false },
      })
    )

    assert.equal(third.at(-1)?.type, 'done', `the run should finish: ${JSON.stringify(third.at(-1))}`)

    // Every request passed the validator, so reaching here means both calls were answered before the
    // model was contacted again. Assert the shape explicitly too, since that is the reported symptom.
    assert.equal(seen.length, 2, 'the model is contacted once, after the whole frame is settled')
    const last = seen[seen.length - 1]
    const toolTurns = last.filter((m) => m.role === 'tool')
    assert.equal(toolTurns.length, 2, `expected 2 tool messages, got ${toolTurns.length}`)
    assert.deepEqual(toolTurns.map((m) => m.tool_call_id).sort(), ['c1', 'c2'], 'both call ids must be answered')

    results.push('a batch of two gated calls is answered one decision at a time, in full')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The other half of a decision: refusing one ends the turn where the frame stood.
 *
 * Nothing behind the refused call is run — not the second gated call, and not an exempt one that
 * happened to sit between them — and the model is asked nothing, because a turn that has ended asks
 * nothing. The refusal is the answer to this frame rather than a result the model has to explain.
 */
async function aRefusalEndsTheFrameWhereItStood() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto2-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'body\n')
    const seen: WireMessage[][] = []
    const fetchImpl = validatedFetch(
      async () =>
        sse(
          toolCallFrames([
            { id: 'c1', name: 'run_command', args: { command: 'echo one' } },
            { id: 'r2', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'c3', name: 'run_command', args: { command: 'echo three' } },
          ])
        ),
      seen
    )

    const base = {
      providerId: 'deepseek',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: root,
      autoApprove: false,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as never,
    }

    const first = await collect(runAgentLoop({ ...base, messages: [{ role: 'user', content: 'run the batch' }] }))
    const pause = first.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, `expected a pause, got ${JSON.stringify(first.map((c) => c.type))}`)
    assert.equal(pause.callId, 'c1', 'the first gated call is the one asked about')
    assert.ok(
      !first.some((c) => c.type === 'tool_result' && c.callId === 'r2'),
      'the exempt call behind it must not have run either'
    )

    const refused = await collect(
      runAgentLoop({
        ...base,
        messages: pause.messages as never,
        steps: pause.steps as number,
        pending: { calls: pause.calls as never, denied: true },
      })
    )

    assert.deepEqual(
      refused.map((c) => c.type),
      ['tool_result', 'turn_end'],
      `a refusal ends the turn: ${JSON.stringify(refused.map((c) => c.type))}`
    )
    assert.equal(refused[0].code, 'DENIED', 'the refused call carries its refusal')
    assert.equal(seen.length, 1, 'and nothing further is asked of the model')
    assert.equal(
      refused.some((c) => c.type === 'tool_result' && c.callId !== 'c1'),
      false,
      'no call behind the refusal ran, the exempt one included'
    )

    results.push('a refusal ends the turn where the frame stood, running nothing behind it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Three calls, none needing approval: the existing path. Guards against a fix that breaks the
 * batch that already worked.
 */
async function batchWithoutGating() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto2-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'body\n')
    const seen: WireMessage[][] = []
    const fetchImpl = validatedFetch(async (call) => {
      if (call === 1) {
        return sse(
          toolCallFrames([
            { id: 'r1', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'r2', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'r3', name: 'read_file', args: { path: 'a.txt' } },
          ])
        )
      }
      return sse(answers('Read three times.'))
    }, seen)

    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'read a.txt three times' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as never,
      })
    )

    assert.equal(chunks.at(-1)?.type, 'done')
    const last = seen[seen.length - 1]
    // All three must be answered, and the parser must have seen all three: this is the case that a
    // first-entry-only parse silently drops, leaving two calls unanswered and the next request 400ing.
    assert.equal(last.filter((m) => m.role === 'tool').length, 3, 'all three reads answered')
    const assistantTurn = last.find((m) => m.role === 'assistant' && m.tool_calls?.length)
    assert.equal(assistantTurn?.tool_calls?.length, 3, 'the assistant turn must declare all three calls')
    results.push('a batch needing no approval is answered in full')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * A write that needs approval alongside a read that does not. The read runs immediately; the write
 * waits. The read's result must not be lost, and the write must be answered once decided.
 */
async function mixedBatch() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto2-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'body\n')
    const seen: WireMessage[][] = []
    const fetchImpl = validatedFetch(async (call) => {
      if (call === 1) {
        return sse(
          toolCallFrames([
            { id: 'rd', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'wr', name: 'write_file', args: { path: 'out.txt', content: 'x' } },
          ])
        )
      }
      return sse(answers('Done.'))
    }, seen)

    const signal = new AbortController().signal
    const base = {
      providerId: 'deepseek',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: root,
      autoApprove: false,
      signal,
      fetchImpl: fetchImpl as never,
    }

    const first = await collect(runAgentLoop({ ...base, messages: [{ role: 'user', content: 'read then write' }] }))
    const pause = first.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, 'the write must gate')

    const second = await collect(
      runAgentLoop({
        ...base,
        messages: pause.messages as never,
        steps: pause.steps as number,
        pending: { calls: pause.calls as never, denied: false },
      })
    )
    assert.equal(second.at(-1)?.type, 'done')

    const last = seen[seen.length - 1]
    const toolTurns = last.filter((m) => m.role === 'tool')
    assert.deepEqual(toolTurns.map((m) => m.tool_call_id).sort(), ['rd', 'wr'])
    results.push('a mixed batch answers the read and the approved write')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- the validator itself

function validatorHasTeeth() {
  // Negative controls, so a green suite above cannot be a validator that accepts anything.
  assert.throws(() => assertToolContract([{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] }], 'control'))
  assert.throws(() =>
    assertToolContract(
      [
        { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
        { role: 'tool', tool_call_id: 'a' },
      ],
      'control'
    )
  )
  assert.throws(() =>
    assertToolContract(
      [
        { role: 'assistant', tool_calls: [{ id: 'a' }] },
        { role: 'tool', tool_call_id: 'wrong' },
      ],
      'control'
    )
  )
  // The good shape passes.
  assertToolContract(
    [
      { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a' },
      { role: 'tool', tool_call_id: 'b' },
      { role: 'user', content: 'ok' },
    ],
    'control'
  )
  results.push('the protocol validator rejects short, mismatched, and missing tool messages')
}

// ---------------------------------------------------------------- report

async function main() {
  await step('validator negative controls', validatorHasTeeth)
  await step('batch without gating', batchWithoutGating)
  await step('mixed batch', mixedBatch)
  await step('two gated calls', twoGatedCallsAreDecidedOneAtATime)
  await step('a refusal ends the frame', aRefusalEndsTheFrameWhereItStood)

  console.log(`tool protocol: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('PROTOCOL TEST FAILED:', err)
  process.exit(1)
})
