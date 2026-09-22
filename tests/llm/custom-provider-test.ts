/**
 * Verifies that a turn routed to a custom provider reaches the endpoint the descriptor names, with
 * that descriptor's credential and in the dialect the descriptor declares — and that listing a
 * custom provider's models fails in a way a caller can branch on.
 *
 * Loads the real `conveyor/modules/llm-engine.ts`, `conveyor/modules/agent.ts`, and
 * `conveyor/modules/provider.ts`, so what is tested is what ships: the mocked fetch stands in for the
 * socket, and nothing else is doubled. No network, no API key, no Electron.
 */
import { strict as assert } from 'node:assert'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { buildRequest, streamChat, type FetchLike } from '../../conveyor/modules/llm-engine'
import { listProviderModels } from '../../conveyor/modules/provider'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

/** A provider a user added: a local server, reachable only on this machine. */
const LOCAL = {
  id: 'local-llama',
  name: 'Local Llama',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'sk-local',
  dialect: 'openai' as const,
  models: ['llama-3.1-8b'],
}

function sse(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

type Mocked = { fn: FetchLike; calls: Array<{ url: string; init: RequestInit }> }

function mockFetch(response: Response | (() => Promise<Response>)): Mocked {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return typeof response === 'function' ? response() : response
  }
  return { fn, calls }
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A reply as a stream, rebuilt per call: a `Response` body can be read once, and two checks stream from
 * one, so a shared instance would hand the second an already-locked body.
 */
function replyStream(): ReadableStream<Uint8Array> {
  return sse(
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n'
  )
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

// ----------------------------------------------------------------- the request a descriptor shapes

function theDescriptorShapesTheRequest() {
  const request = buildRequest(
    'local-llama',
    'unused-when-a-descriptor-is-present',
    'llama-3.1-8b',
    [{ role: 'user', content: 'hi' }],
    undefined,
    LOCAL
  )

  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer sk-local')
  // The OpenAI dialect, not Anthropic's: the messages stay whole and the system turn is not hoisted.
  assert.equal(request.body.stream, true)
  assert.equal(request.body.model, 'llama-3.1-8b')
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hi' }])
  assert.ok(!('x-api-key' in request.headers))

  // A keyless local server is the ordinary case for a custom provider, and it is asked without a bearer
  // header rather than with an empty one.
  const keyless = buildRequest('local-llama', 'ignored', 'llama-3.1-8b', [{ role: 'user', content: 'hi' }], undefined, {
    ...LOCAL,
    apiKey: '',
  })
  assert.equal('authorization' in keyless.headers, false)
  results.push('a descriptor supplies the URL, the bearer header, and the openai body')
}

function theBuiltInDescriptorsAreUntouched() {
  assert.equal(buildRequest('openai', 'sk-test', 'gpt-4o-mini', []).url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(
    buildRequest('anthropic', 'sk-ant', 'claude-3-5-sonnet-latest', []).url,
    'https://api.anthropic.com/v1/messages'
  )
  results.push('predefined providers keep their built-in endpoints')
}

function anUnusableDescriptorFailsByCode() {
  // Present but not a descriptor: a half-written object, a dialect this build does not speak, a
  // missing base URL. All one fact to the caller, and that fact is the code.
  const rejects = (provider: unknown): boolean => {
    try {
      buildRequest('local-llama', 'k', 'm', [], undefined, provider)
      return false
    } catch (err) {
      return (err as { code?: string }).code === 'INVALID_PROVIDER'
    }
  }

  assert.equal(rejects({ id: 'local-llama', name: 'Local Llama' }), true, 'a missing baseUrl')
  assert.equal(rejects({ ...LOCAL, dialect: 'anthropic' }), true, 'a dialect this build cannot speak')
  assert.equal(rejects({ ...LOCAL, baseUrl: 42 }), true, 'a baseUrl that is not even text')
  assert.equal(rejects({ ...LOCAL, models: 'llama-3.1-8b' }), true, 'a model list that is not a list')

  // And an id that is neither predefined nor described stays what it always was.
  try {
    buildRequest('nobody-home', 'k', 'm', [], undefined, undefined)
    assert.fail('an unknown provider with no descriptor must not be accepted')
  } catch (err) {
    assert.equal((err as { code?: string }).code, 'UNKNOWN_PROVIDER')
  }
  results.push('an absent or invalid descriptor fails with a code, never a message')
}

// ----------------------------------------------------------------- the stream

async function theTurnStreamsFromTheCustomEndpoint() {
  const mock = mockFetch(new Response(replyStream(), { status: 200 }))

  const out = await collect(
    streamChat({
      providerId: 'local-llama',
      apiKey: '',
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      fetchImpl: mock.fn,
      provider: LOCAL,
    })
  )

  assert.equal(out, 'Hello')
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions')
  const headers = mock.calls[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer sk-local')
  const body = JSON.parse(String(mock.calls[0].init.body)) as { stream: boolean; messages: unknown[] }
  assert.equal(body.stream, true)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
  results.push('a streamed turn goes to the descriptor endpoint and comes back as text')
}

async function theAgentLoopHandsTheDescriptorThrough() {
  const mock = mockFetch(new Response(replyStream(), { status: 200 }))

  const chunks: string[] = []
  for await (const chunk of runAgentLoop({
    providerId: 'local-llama',
    apiKey: '',
    model: 'llama-3.1-8b',
    workspaceRoot: null,
    messages: [{ role: 'user', content: 'hi' }],
    autoApprove: false,
    signal: new AbortController().signal,
    platform: 'linux',
    fetchImpl: mock.fn,
    provider: LOCAL,
  })) {
    if (chunk.type === 'text_delta') chunks.push(chunk.text)
  }

  assert.equal(chunks.join(''), 'Hello')
  assert.equal(mock.calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal((mock.calls[0].init.headers as Record<string, string>).authorization, 'Bearer sk-local')
  results.push('the agent loop runs its turn against the descriptor it was handed')
}

// ----------------------------------------------------------------- listing models

async function aCatalogueIsReadFromTheEndpoint() {
  const mock = mockFetch(
    jsonResponse(
      200,
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'qwen2.5-coder', object: 'model' },
          { id: 'llama-3.1-8b', object: 'model' },
          { id: 'llama-3.1-8b', object: 'model' },
        ],
      })
    )
  )

  const models = await listProviderModels(LOCAL.baseUrl, LOCAL.apiKey, { fetchImpl: mock.fn })

  assert.deepEqual(models, ['llama-3.1-8b', 'qwen2.5-coder'], 'ids, deduplicated and stable in order')
  assert.equal(mock.calls[0].url, 'http://127.0.0.1:1234/v1/models')
  assert.equal(mock.calls[0].init.method, 'GET')
  assert.equal((mock.calls[0].init.headers as Record<string, string>).authorization, 'Bearer sk-local')
  results.push('a catalogue is fetched from the base url and read as model ids')
}

async function aKeylessServerIsAskedWithoutABearer() {
  const mock = mockFetch(jsonResponse(200, JSON.stringify({ data: [{ id: 'llama-3.1-8b' }] })))

  await listProviderModels('http://localhost:1234/v1', '', { fetchImpl: mock.fn })

  assert.equal(
    'authorization' in (mock.calls[0].init.headers as Record<string, string>),
    false,
    'a local server with no key is asked without a header it would reject'
  )
  results.push('an empty key sends no bearer header')
}

async function aRefusedRequestCarriesItsStatusInThePayload() {
  for (const status of [500, 404]) {
    const mock = mockFetch(jsonResponse(status, '{"error":{"message":"no such route"}}'))

    await assert.rejects(
      listProviderModels(LOCAL.baseUrl, LOCAL.apiKey, { fetchImpl: mock.fn }),
      (err: { code?: string; message?: string; issues?: unknown }) => {
        assert.equal(err.code, 'PROVIDER_LIST_FAILED')
        // The status travels beside the code, where a caller can read it without parsing prose.
        assert.deepEqual(err.issues, { status })
        assert.equal((err.message ?? '').includes(String(status)), false, 'and not in the message')
        return true
      }
    )
  }
  results.push('a refused catalogue yields PROVIDER_LIST_FAILED with the status in the payload')
}

async function anEndpointThatNeverAnswersYieldsUnreachable() {
  // A request that is never answered, rather than one that is refused: the timeout the command sets
  // is the only thing that ends it. The keep-alive timer is what makes this testable at all — the
  // deadline signal's own timer is unref'd, so in a suite with nothing else pending the process would
  // exit instead of observing the abort. A real request holds a socket, which is why the app never sees
  // that.
  const hanging: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => undefined, 1000)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(new Error('the request was aborted'))
      })
    })

  const started = Date.now()
  await assert.rejects(
    listProviderModels(LOCAL.baseUrl, LOCAL.apiKey, { fetchImpl: hanging, timeoutMs: 25 }),
    (err: { code?: string }) => err.code === 'PROVIDER_UNREACHABLE'
  )
  assert.ok(Date.now() - started < 2000, 'the timeout is what ended it, not the suite')
  results.push('an unanswered request yields PROVIDER_UNREACHABLE')
}

async function anUnreadableCatalogueYieldsListFailed() {
  const mock = mockFetch(jsonResponse(200, 'not json at all'))

  await assert.rejects(
    listProviderModels(LOCAL.baseUrl, LOCAL.apiKey, { fetchImpl: mock.fn }),
    (err: { code?: string }) => err.code === 'PROVIDER_LIST_FAILED'
  )
  results.push('a catalogue this app cannot read yields PROVIDER_LIST_FAILED')
}

async function main() {
  await step('descriptor shapes the request', theDescriptorShapesTheRequest)
  await step('built-in descriptors', theBuiltInDescriptorsAreUntouched)
  await step('invalid descriptor', anUnusableDescriptorFailsByCode)
  await step('custom stream', theTurnStreamsFromTheCustomEndpoint)
  await step('agent loop pass-through', theAgentLoopHandsTheDescriptorThrough)
  await step('catalogue', aCatalogueIsReadFromTheEndpoint)
  await step('keyless', aKeylessServerIsAskedWithoutABearer)
  await step('refused', aRefusedRequestCarriesItsStatusInThePayload)
  await step('timeout', anEndpointThatNeverAnswersYieldsUnreachable)
  await step('unreadable', anUnreadableCatalogueYieldsListFailed)

  console.log(`\ncustom providers (routing + model list): ${results.length} checks passed`)
}

void main()
