/**
 * Verifies that a request measures itself as it is built — the snapshot the loop hands to main.
 *
 * Failing-first: `runAgentLoop` computes no snapshot and `setContextSnapshotSink` does not exist, so
 * this suite cannot even bundle. What it pins is that the measurement is taken from the parts that
 * actually went out (the tool schemas, the three standing messages, the conversation), that an image's
 * bytes are never counted as text, and — the regression rule of the whole phase — that a run which
 * measures itself sends byte-for-byte what a run which does not would have sent.
 *
 * The provider is stubbed at the fetch boundary and the images are resolved by injection, so nothing
 * here touches a store, a disk, or a network: the assertions are about the request, and the request is
 * the artifact under test.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop, setContextSnapshotSink } from '../../conveyor/modules/agent'
import { agentSystemPrompt } from '../../conveyor/protocol/context'
import { estimateTokens, IMAGE_REF_TOKENS, type ContextSnapshot } from '../../conveyor/protocol/context-window'
import type { HistoryMessage } from '../../conveyor/modules/llm-engine'

const results: string[] = []
const roots: string[] = []

function makeWorkspace(instructions?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-context-snapshot-'))
  roots.push(root)
  if (instructions !== undefined) writeFileSync(join(root, 'SAMAI.md'), instructions, 'utf8')
  return root
}

const SESSION = '11111111-2222-4333-8444-777777777777'
const INSTRUCTIONS = 'Prefer small commits, and run the narrow suite before the full one.'

/** A provider that answers in prose, which is one round-trip and no tool call. */
function proseFetch(log: Array<Record<string, unknown>>): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    log.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Measured.' } }] })}\n\n`)
        )
        controller.close()
      },
    })
    return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iter) {
    // Drained: the assertions are on what the run handed the sink, and on the request it made.
  }
}

/** One run, with a sink installed, and the bodies it sent. */
async function run(
  snapshotSink: ((payload: { sessionId: string; snapshot: ContextSnapshot }) => void) | null,
  options: {
    workspaceRoot: string
    messages: HistoryMessage[]
    sessionId?: string
    resolveImage?: (image: { id: string; name: string; mimeType: string; size: number }) => Promise<{
      ref: unknown
      dataUrl: string
    }>
  }
): Promise<{
  bodies: Array<Record<string, unknown>>
  snapshots: Array<{ sessionId: string; snapshot: ContextSnapshot }>
}> {
  const bodies: Array<Record<string, unknown>> = []
  const snapshots: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  // The caller's sink is notified as well as this helper's own list, so a case can assert on the array
  // it declared while the returned list stays the same shape for every case.
  setContextSnapshotSink(
    snapshotSink === null
      ? null
      : (payload) => {
          snapshots.push(payload)
          snapshotSink(payload)
        }
  )

  try {
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: options.workspaceRoot,
        messages: options.messages,
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: proseFetch(bodies) as never,
        platform: 'linux',
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.resolveImage !== undefined ? { resolveImage: options.resolveImage as never } : {}),
      })
    )
  } finally {
    setContextSnapshotSink(null)
  }

  return { bodies, snapshots }
}

const planSink = (seen: Array<{ sessionId: string; snapshot: ContextSnapshot }>) => ({
  seen,
  sink: (payload: { sessionId: string; snapshot: ContextSnapshot }) => seen.push(payload),
})

// ----------------------------------------------------------------- the categories

async function theSnapshotMatchesThePartsItMeasured(): Promise<void> {
  const seen: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  const helper = planSink(seen)
  const workspace = makeWorkspace(INSTRUCTIONS)

  const { bodies } = await run(helper.sink, {
    workspaceRoot: workspace,
    sessionId: SESSION,
    messages: [{ role: 'user', content: 'what does this repo do' }],
  })

  assert.equal(seen.length, 1, 'a completed round-trip measures itself exactly once')
  const snapshot = seen[0].snapshot
  assert.equal(seen[0].sessionId, SESSION, 'the measurement names the conversation it was built for')

  const body = bodies[0]
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>
  const systemTexts = messages.filter((m) => m.role === 'system').map((m) => String(m.content))
  const conversation = messages.filter((m) => m.role !== 'system')

  // The tool schemas, measured as the body carries them: this is the category a snapshot is most
  // likely to get wrong, because it is the part nobody thinks of as context.
  assert.equal(snapshot.tools, estimateTokens(JSON.stringify(body.tools)), 'the tool schemas are measured')
  assert.ok(snapshot.tools > 0, 'this app always sends tools, so the category is never empty')

  // The standing context: the agent's own instruction, this workspace's instructions file, and the
  // skills section, each recognized by the text the app wrote for it.
  const agentPrompt = agentSystemPrompt('linux')
  assert.ok(systemTexts.includes(agentPrompt), 'the standing instruction went out')
  assert.equal(snapshot.systemPrompt, estimateTokens(agentPrompt))

  const fromFile = systemTexts.find((text) => text.includes(INSTRUCTIONS))
  assert.ok(fromFile, 'the instructions file went out as a system message')
  assert.equal(snapshot.projectInstructions, estimateTokens(String(fromFile)))

  // No skill is active in this run, so the section measured nothing — which is not an error and must not
  // be turned into a share of the total.
  assert.equal(snapshot.skills, 0, 'a run with no skills measures no skills section')

  // The conversation, text only on this turn.
  assert.equal(snapshot.messages, estimateTokens(JSON.stringify(conversation)))
  assert.equal(snapshot.other, 0, 'nothing outside the named categories, and no image, measures nothing')

  // And the total is the categories added up rather than a second estimate of the whole.
  assert.equal(
    snapshot.used,
    snapshot.tools +
      snapshot.systemPrompt +
      snapshot.projectInstructions +
      snapshot.skills +
      snapshot.messages +
      snapshot.other
  )
  assert.ok(typeof snapshot.at === 'number' && snapshot.at > 0, 'the measurement is stamped')
  results.push('the snapshot matches the parts the request carried')
}

async function anImageCostsItsAllowanceAndNotItsBytes(): Promise<void> {
  const seen: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  const helper = planSink(seen)
  const workspace = makeWorkspace()
  const ref = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'shot.png', mimeType: 'image/png', size: 4096 }
  // A data URL the size of a real screenshot, which is what the wire carries and what a character count
  // must never be asked to price.
  const dataUrl = `data:image/png;base64,${'A'.repeat(5400)}`

  const history: HistoryMessage[] = [{ role: 'user', content: 'what is wrong in this screenshot', images: [ref] }]

  const { bodies } = await run(helper.sink, {
    workspaceRoot: workspace,
    sessionId: SESSION,
    messages: history,
    resolveImage: async (image) => ({ ref: image, dataUrl }),
  })

  assert.equal(seen.length, 1)
  const snapshot = seen[0].snapshot

  assert.equal(snapshot.other, IMAGE_REF_TOKENS, 'one image reference is charged its flat allowance')
  // The conversation is measured as the text and the reference, not as the bytes the provider is handed:
  // the same turn's wire body is thousands of characters longer than what the snapshot counted.
  assert.equal(
    snapshot.messages,
    estimateTokens(JSON.stringify([{ role: 'user', content: history[0].content, images: [ref] }]))
  )
  const wireTokens = estimateTokens(JSON.stringify(bodies[0].messages))
  assert.ok(
    wireTokens > snapshot.messages + 1000,
    'the resolved bytes never reach the count, or a screenshot would read as a context of its own'
  )
  results.push('an image costs a flat allowance rather than its bytes')
}

async function twoImagesCostTwoAllowances(): Promise<void> {
  const seen: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  const helper = planSink(seen)
  const first = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'one.png', mimeType: 'image/png', size: 8 }
  const second = { id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'two.png', mimeType: 'image/png', size: 8 }

  await run(helper.sink, {
    workspaceRoot: makeWorkspace(),
    sessionId: SESSION,
    messages: [{ role: 'user', content: 'both of these', images: [first, second] }],
    resolveImage: async (image) => ({ ref: image, dataUrl: `data:image/png;base64,${image.name}` }),
  })

  assert.equal(seen[0].snapshot.other, 2 * IMAGE_REF_TOKENS, 'the allowance is per reference, not per turn')
  results.push('two images cost two allowances')
}

// ----------------------------------------------------------------- the regression rule

async function measuringChangesNothingOnTheWire(): Promise<void> {
  const workspace = makeWorkspace(INSTRUCTIONS)
  const messages: HistoryMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ]

  const seen: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  const measured = await run(planSink(seen).sink, { workspaceRoot: workspace, sessionId: SESSION, messages })
  const unmeasured = await run(null, { workspaceRoot: workspace, sessionId: SESSION, messages })

  // The phase's regression rule, asserted as bytes rather than as fields: a request that is measured
  // must be the same request it was before anything measured it.
  assert.equal(
    JSON.stringify(measured.bodies[0]),
    JSON.stringify(unmeasured.bodies[0]),
    'the wire body is byte-identical with and without the snapshot'
  )
  assert.ok(seen.length >= 1, 'and the run that was measured did measure itself')
  assert.ok(
    !JSON.stringify(measured.bodies[0]).includes('contextSnapshot'),
    'a measurement is never a field of the request'
  )
  results.push('measuring changes nothing on the wire')
}

async function aRunWithNoConversationMeasuresNothing(): Promise<void> {
  const seen: Array<{ sessionId: string; snapshot: ContextSnapshot }> = []
  const helper = planSink(seen)

  const { bodies } = await run(helper.sink, {
    workspaceRoot: makeWorkspace(),
    messages: [{ role: 'user', content: 'no session to report to' }],
  })

  assert.equal(bodies.length, 1, 'the request was still made')
  assert.equal(seen.length, 0, 'a run told no conversation has nothing to report to, and reports nothing')
  results.push('a run with no conversation measures nothing')
}

// ----------------------------------------------------------------- main

async function main(): Promise<void> {
  try {
    await theSnapshotMatchesThePartsItMeasured()
    await anImageCostsItsAllowanceAndNotItsBytes()
    await twoImagesCostTwoAllowances()
    await measuringChangesNothingOnTheWire()
    await aRunWithNoConversationMeasuresNothing()

    console.log(`context snapshot request: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    setContextSnapshotSink(null)
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('CONTEXT SNAPSHOT REQUEST TEST FAILED:', err)
  process.exit(1)
})
