/**
 * The failover walk, driven through the real loop with a mocked transport.
 *
 * The walk lives in the agent loop rather than in the executor because eligibility needs the history,
 * the tools, the estimate and the registry. So this suite drives `runAgentLoop` with two custom
 * providers — a keyless custom provider is legitimately runnable, which keeps the suite off the OS
 * keychain — and asserts the chunks the pane would fold: who served, who was passed over, and the
 * ending when nobody could.
 */
import { strict as assert } from 'node:assert'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { buildComboRegistrySnapshot, setComboRegistrySource } from '../../conveyor/modules/combos'
import type { Combo } from '../../conveyor/protocol/combos'
import type { CustomProvider } from '../../conveyor/protocol/custom-provider'

const results: string[] = []

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const HEAD: CustomProvider = {
  id: 'head',
  name: 'Head',
  baseUrl: 'http://head.test/v1',
  apiKey: '',
  dialect: 'openai',
  models: ['head-model'],
}
const BACKUP: CustomProvider = {
  id: 'backup',
  name: 'Backup',
  baseUrl: 'http://backup.test/v1',
  apiKey: '',
  dialect: 'openai',
  models: ['backup-model'],
}

const COMBO: Combo = {
  id: 'fast',
  name: 'Fast answers',
  members: [
    { providerId: 'head', modelId: 'head-model' },
    { providerId: 'backup', modelId: 'backup-model' },
  ],
  enabled: true,
}

function installRegistry(headEnabled: string[] = ['head-model']): void {
  setComboRegistrySource(() =>
    buildComboRegistrySnapshot({
      providers: [],
      custom: [HEAD, BACKUP],
      defaults: {},
      configs: { head: { enabledModels: headEnabled, fetchedModels: [] } },
      configured: [],
    })
  )
}

/** A 200 SSE reply with one piece of prose. */
function sseResponse(text: string): Response {
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
    '[DONE]',
  ]
  const payload = frames.map((frame) => `data: ${frame}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** A refusal with an HTTP status and a body string. */
function failure(status: number, detail: string): Response {
  return { ok: false, status, body: null, text: async () => detail } as unknown as Response
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

function run(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
): AsyncGenerator<unknown, void, undefined> {
  return runAgentLoop({
    providerId: COMBO.members[0].providerId,
    apiKey: '',
    model: COMBO.members[0].modelId,
    workspaceRoot: null,
    messages: [{ role: 'user', content: 'hello' }],
    autoApprove: true,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as never,
    combo: COMBO,
  })
}

// ---------------------------------------------------------------- scenarios

async function theHeadIsRateLimitedAndTheSecondAnswers(): Promise<void> {
  installRegistry()
  const log: string[] = []
  const chunks = await collect(
    run(async (url) => {
      log.push(url)
      return url.includes('head.test') ? failure(429, 'slow down') : sseResponse('Answered by the backup.')
    })
  )

  assert.equal(log.length, 2, 'the head was attempted and the second member answered')
  const notice = chunks.find((chunk) => chunk.type === 'turn_end_notice')
  assert.ok(notice, `a failed-over turn says so (chunk types: ${chunks.map((chunk) => String(chunk.type)).join(', ')})`)
  assert.equal(notice?.cause, 'model_stop')
  const combo = notice?.combo as { requests: unknown[]; attempts: Array<Record<string, unknown>> }
  assert.deepEqual(combo.requests, [{ providerId: 'backup', modelId: 'backup-model' }])
  assert.deepEqual(combo.attempts, [
    { kind: 'failed', providerId: 'head', modelId: 'head-model', code: 'RATE_LIMITED' },
  ])
  const text = chunks.filter((chunk) => chunk.type === 'text_delta').map((chunk) => chunk.text)
  assert.equal(text.join(''), 'Answered by the backup.')
  results.push('429 on the head: the second member answers, the notice names both')
}

async function everyMemberFailsAndTheTurnEndsOnTheCombo(): Promise<void> {
  installRegistry()
  const chunks = await collect(run(async () => failure(500, 'server error')))

  const notice = chunks.find((chunk) => chunk.type === 'turn_end_notice')
  assert.ok(notice, 'the turn ends with a notice rather than throwing')
  assert.equal(notice?.cause, 'combo_failed')
  const combo = notice?.combo as { requests: unknown[]; attempts: Array<Record<string, unknown>> }
  assert.deepEqual(combo.requests, [])
  assert.deepEqual(
    combo.attempts.map((attempt) => attempt.code),
    ['PROVIDER_ERROR', 'PROVIDER_ERROR']
  )
  assert.ok(chunks.some((chunk) => chunk.type === 'turn_end' && chunk.cause === 'combo_failed'))
  results.push('all fail: combo_failed notice with every member and code, no throw')
}

async function anIneligibleHeadIsSkippedWithAReason(): Promise<void> {
  installRegistry(['backup-model'])
  const log: string[] = []
  const chunks = await collect(
    run(async (url) => {
      log.push(url)
      return sseResponse('Backup answered.')
    })
  )

  assert.equal(log.length, 1, 'the ineligible head never reached the transport')
  const notice = chunks.find((chunk) => chunk.type === 'turn_end_notice')
  const combo = notice?.combo as { attempts: Array<Record<string, unknown>> }
  assert.deepEqual(combo.attempts, [
    { kind: 'skipped', providerId: 'head', modelId: 'head-model', reason: 'model-not-enabled' },
  ])
  results.push('ineligible head: skipped with a code, never attempted')
}

async function main(): Promise<void> {
  await step('429 head, second answers', theHeadIsRateLimitedAndTheSecondAnswers)
  await step('every member fails', everyMemberFailsAndTheTurnEndsOnTheCombo)
  await step('ineligible head is skipped', anIneligibleHeadIsSkippedWithAReason)

  console.log(`combo failover: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

void main().catch((err) => {
  console.error('COMBO FAILOVER TEST FAILED:', err)
  process.exit(1)
})
