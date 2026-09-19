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
      assert.ok(
        answered.includes(id),
        `${where}: no tool message answers '${id}' (got ${answered.join(', ')})`
      )
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
        choices: [
          { delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] } },
        ],
      })
    )
  })
  frames.push('[DONE]')
  return frames
}

function answers(...texts: string[]): string[] {
  return [
    ...texts.map((t) => JSON.stringify({ choices: [{ delta: { content: t } }] })),
    '[DONE]',
  ]
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
 * Two commands, both needing approval, in one assistant turn. Approve the first, deny the second.
 *
 * Every request the loop makes is validated, so if the second model call goes out with the second
 * call still unanswered, this fails with the provider's own complaint.
 */
async function twoGatedCallsApproveOneDenyOne() {
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

    // Round 1: both calls need approval, so the run pauses.
    const first = await collect(
      runAgentLoop({ ...base, messages: [{ role: 'user', content: 'run two commands' }] })
    )
    const pause = first.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, `expected a pause, got ${JSON.stringify(first.map((c) => c.type))}`)

    // One decision covers the whole gated batch, so a single resume must answer both calls. Denying
    // here exercises the denial path: every call still needs its tool message.
    const second = await collect(
      runAgentLoop({
        ...base,
        messages: pause.messages as never,
        steps: pause.steps as number,
        pending: { calls: pause.calls as never, denied: true },
      })
    )

    assert.equal(second.at(-1)?.type, 'done', `the run should finish: ${JSON.stringify(second.at(-1))}`)

    // Every request passed the validator, so reaching here means both calls were answered before any
    // model request went out. Assert the shape explicitly too, since that is the reported symptom.
    const last = seen[seen.length - 1]
    const toolTurns = last.filter((m) => m.role === 'tool')
    assert.equal(toolTurns.length, 2, `expected 2 tool messages, got ${toolTurns.length}`)
    assert.deepEqual(
      toolTurns.map((m) => m.tool_call_id).sort(),
      ['c1', 'c2'],
      'both call ids must be answered'
    )
    // Both were denied by the one decision.
    for (const turn of toolTurns) {
      assert.match(String(turn.content), /denied/i, `call ${turn.tool_call_id} must report the denial`)
    }

    results.push('a batch of two gated calls is fully answered by one decision')
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
  assert.throws(() =>
    assertToolContract([{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] }], 'control')
  )
  assert.throws(() =>
    assertToolContract(
      [{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] }, { role: 'tool', tool_call_id: 'a' }],
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
  await step('two gated calls', twoGatedCallsApproveOneDenyOne)

  console.log(`tool protocol: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('PROTOCOL TEST FAILED:', err)
  process.exit(1)
})
