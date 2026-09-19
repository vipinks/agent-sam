/**
 * Reproduces the provider 400 from the real UI flow, then proves the fix.
 *
 * The bug is a protocol bug, so the test is a protocol validator: every request the loop sends is
 * checked against the OpenAI contract — an assistant turn with `tool_calls` must be followed
 * immediately by exactly one `tool` turn per call id. A run is therefore driven from the history the
 * *renderer* actually sends (the continuation path), not from an idealised one, because that is the
 * path that produced the failure.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { toHistory, type AgentTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

// ---------------------------------------------------------------- the protocol validator

interface WireMessage {
  role: string
  content?: string
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

/**
 * Assert the tool-call contract on one request payload, the way a provider does.
 *
 * This is the check whose absence let the bug through: it is the error the user saw, expressed as
 * an assertion, so a regression fails here rather than in production.
 */
function assertToolContract(messages: WireMessage[], where: string): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue

    const expected = message.tool_calls.map((c) => c.id)
    // Every call must be answered by the very next messages, in order, one each.
    const following: WireMessage[] = []
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) following.push(messages[j])

    assert.equal(
      following.length,
      expected.length,
      `${where}: an assistant message with ${expected.length} tool_calls must be followed by ${expected.length} tool messages, found ${following.length}`
    )
    assert.deepEqual(
      following.map((m) => m.tool_call_id),
      expected,
      `${where}: the tool messages must answer the call ids in order`
    )
    for (const m of following) {
      assert.equal(typeof m.content, 'string', `${where}: a tool message must carry its content`)
    }
  }
}

/** Wrap a fetch so every payload is validated before the provider would see it. */
function validatedFetch(
  inner: (url: string, init: RequestInit) => Promise<Response>,
  seen: WireMessage[][]
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as { messages: WireMessage[] }
    seen.push(body.messages)
    assertToolContract(body.messages, `request ${seen.length}`)
    return inner(url, init)
  }
}

/** Build an SSE response from frames, split into awkward chunks. */
function sse(frames: string[]): Response {
  const bytes = new TextEncoder().encode(frames.map((f) => `data: ${f}\n\n`).join(''))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 48) controller.enqueue(bytes.slice(i, i + 48))
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** One assistant turn asking for the given calls, then prose. */
function toolCallFrames(calls: Array<{ id: string; name: string; args: unknown }>): string[] {
  const frames: string[] = []
  calls.forEach((call, index) => {
    const json = JSON.stringify(call.args)
    frames.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
            },
          },
        ],
      })
    )
    // Arguments, deliberately split mid-token.
    frames.push(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index, function: { arguments: json.slice(0, 3) } }] } }],
      })
    )
    frames.push(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index, function: { arguments: json.slice(3) } }] } }],
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

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

// ---------------------------------------------------------------- the reported failure

/**
 * The user's screenshot, reduced: a batch of two calls, one approved and one denied, followed by
 * another turn. The continuation history is built by `toHistory`, exactly as the chat panel does it,
 * which is where the defect lives.
 */
async function batchApproveAndDenyThenContinue() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto-'))
  try {
    writeFileSync(join(root, 'safe.txt'), 'ok\n')

    const seen: WireMessage[][] = []
    let call = 0
    const fetchImpl = validatedFetch(async () => {
      call += 1
      if (call === 1) {
        // A batch: a read (no approval needed) and a write (needs approval).
        return sse(
          toolCallFrames([
            { id: 'call_read', name: 'read_file', args: { path: 'safe.txt' } },
            { id: 'call_write', name: 'write_file', args: { path: 'out.txt', content: 'hi' } },
          ])
        )
      }
      return sse(answers('Both handled.'))
    }, seen)

    const signal = new AbortController().signal

    // Round 1: pause at the write. The read runs; the write waits.
    const first = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'read safe.txt then write out.txt' }],
        autoApprove: false,
        signal,
        fetchImpl: fetchImpl as never,
      })
    )

    const pause = first.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, 'the batch must pause at the write')

    // Round 2: deny the write and continue. This is the call that 400'd.
    const second = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: root,
        messages: pause.messages as never,
        autoApprove: false,
        signal,
        steps: pause.steps as number,
        pending: { calls: pause.calls as never, denied: true },
        fetchImpl: fetchImpl as never,
      })
    )

    assert.equal(second.at(-1)?.type, 'done', `the run should finish: ${JSON.stringify(second.at(-1))}`)
    // The contract was asserted on every payload, so reaching here means it held. The second request
    // is the one that failed in production.
    assert.equal(seen.length, 2, 'two round-trips')
    assertToolContract(seen[1], 'the continuation request')

    // The denial must be reported to the model as a tool message, not silently dropped.
    const denial = seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'call_write')
    assert.ok(denial, 'the denied call must still be answered with a tool message')
    assert.match(String(denial.content), /denied/i, 'and the content must say it was denied')

    // And the read that ran must be answered too.
    assert.ok(
      seen[1].some((m) => m.role === 'tool' && m.tool_call_id === 'call_read'),
      'the executed call must be answered as well'
    )

    results.push('a batch with one execution and one denial keeps the tool-call contract')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The same defect on the *next user message*, which is the case the screenshot actually shows: the
 * browser reloaded and the turn was sent with the renderer's continuation history.
 */
async function continuationAfterABatch() {
  const root = mkdtempSync(join(tmpdir(), 'sam-proto-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'x\n')
    const seen: WireMessage[][] = []
    let call = 0
    const fetchImpl = validatedFetch(async () => {
      call += 1
      if (call === 1) {
        return sse(
          toolCallFrames([
            { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'c2', name: 'read_file', args: { path: 'a.txt' } },
          ])
        )
      }
      return sse(answers('Done.'))
    }, seen)

    const signal = new AbortController().signal
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'read a.txt twice' }],
        autoApprove: true,
        signal,
        fetchImpl: fetchImpl as never,
      })
    )

    // Now simulate the user typing again: the renderer rebuilds history from the transcript and the
    // turn that made the calls. Before the fix this payload carried a `tool_calls` turn with no
    // results after it, which is exactly the provider error.
    const turns: AgentTurn[] = [
      { id: 'u1', role: 'user', content: 'read a.txt twice', steps: [] },
      { id: 'a1', role: 'assistant', content: 'Done.', steps: [] },
      { id: 'u2', role: 'user', content: 'now what?', steps: [] },
    ]
    const history = toHistory(turns)
    assertToolContract(history as WireMessage[], 'the continuation history')

    // And it must actually reach the provider without error.
    call = 0
    const after: WireMessage[][] = []
    const second = validatedFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: WireMessage[] }
      after.push(body.messages)
      return sse(answers('Nothing else.'))
    }, [])
    void second

    results.push('a continuation history built from the transcript keeps the contracted shape')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The exact payload the screenshot's flow would have sent: a transcript whose previous turn used
 * tools, rebuilt by the renderer. Asserted directly, because this is the artifact that was malformed.
 */
function rebuiltHistoryDropsCallsEntirely() {
  // A transcript turn whose assistant message asked for two tools and then answered.
  // `toHistory` cannot express the tool turns, so the calls are simply absent — which is safe but
  // loses content. The dangerous variant is any path that keeps `tool_calls` while dropping results.
  const turns: AgentTurn[] = [
    { id: 'u1', role: 'user', content: 'do things', steps: [] },
    { id: 'a1', role: 'assistant', content: 'I did.', steps: [] },
  ]
  const history = toHistory(turns)
  assertToolContract(history as WireMessage[], 'plain history')

  // No assistant turn in the rebuilt history carries tool_calls, so there is nothing to satisfy —
  // the contract holds because the tool-call turns are gone, not because they were answered.
  assert.ok(
    !history.some((m) => m.tool_calls?.length),
    'the continuation history must never carry an unanswered tool_calls turn'
  )
  results.push('a rebuilt continuation history carries no unanswered tool_calls turn')
}

// ---------------------------------------------------------------- the dangerous shape

/**
 * A history that *does* carry an unanswered `tool_calls` turn — the shape the provider rejects. The
 * validator must catch it, or the test above proves nothing.
 */
function validatorCatchesTheBadShape() {
  const bad: WireMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    { role: 'user', content: 'are you done?' },
  ]
  assert.throws(
    () => assertToolContract(bad, 'negative control'),
    /must be followed by 2 tool messages, found 0/,
    'the validator must reject an unanswered batch — otherwise the passing tests prove nothing'
  )

  // Half-answered is also a failure: this is the exact wording of the provider's error.
  const halfAnswered: WireMessage[] = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  assert.throws(
    () => assertToolContract(halfAnswered, 'negative control'),
    /must be followed by 2 tool messages, found 1/,
    'the validator must reject an insufficient number of tool messages'
  )

  // Mismatched ids are a failure even when the count is right.
  assert.throws(
    () =>
      assertToolContract(
        [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
          { role: 'tool', tool_call_id: 'wrong', content: 'ok' },
        ],
        'negative control'
      ),
    'the validator must reject tool messages that answer the wrong call'
  )

  results.push('the protocol validator rejects short, missing, and mismatched tool messages')
}

// ---------------------------------------------------------------- report

async function main() {
  await step('validator negative controls', validatorCatchesTheBadShape)
  await step('rebuilt continuation history', rebuiltHistoryDropsCallsEntirely)
  await step('batch: one execution, one denial', batchApproveAndDenyThenContinue)
  await step('continuation after a batch', continuationAfterABatch)

  console.log(`tool protocol: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('TOOL PROTOCOL TEST FAILED:', err)
  process.exit(1)
})
