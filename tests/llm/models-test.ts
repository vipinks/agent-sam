/**
 * Exercises the model-catalogue engine against mocked `/v1/models` responses — no network, no keys.
 * Loads the real `conveyor/modules/models-engine.ts` so what is tested is what ships.
 */
import { strict as assert } from 'node:assert'
import { fetchModels, parseModels, ANTHROPIC_CURATED_MODELS } from '../../conveyor/modules/models-engine'

const results: string[] = []

/** A fetch double, recording the URL and init it was called with. */
function mockFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return typeof response === 'function' ? response() : response
  }
  return { fn, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ---------------------------------------------------------------- OpenAI-format parsing

function openAiFormat() {
  // The canonical OpenAI shape.
  const parsed = parseModels('openai', {
    object: 'list',
    data: [
      { id: 'gpt-4o-mini', object: 'model', created: 1 },
      { id: 'gpt-4o', object: 'model', created: 2 },
      { id: 'o3-mini', object: 'model', created: 3 },
    ],
  })
  assert.deepEqual(
    parsed.map((m) => m.id),
    ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    'ids should be extracted and sorted'
  )
  // `object`/`created` are not labels, so no name is invented.
  assert.equal(parsed[0].name, undefined)

  results.push('OpenAI { data: [{ id }] } parsing')
}

// ---------------------------------------------------------------- Anthropic-format parsing

function anthropicFormat() {
  // Anthropic answers the same envelope but labels with display_name — the parser must carry it
  // through, because the ids alone are unreadable in a list.
  const parsed = parseModels('anthropic', {
    data: [
      { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' },
      { id: 'claude-3-5-haiku-latest', display_name: 'Claude 3.5 Haiku', type: 'model' },
    ],
    has_more: false,
  })
  assert.equal(parsed.length, 2)
  const sonnet = parsed.find((m) => m.id === 'claude-sonnet-4-5')
  assert.equal(sonnet?.name, 'Claude Sonnet 4.5', 'display_name should become the label')

  results.push('Anthropic { data: [{ id, display_name }] } parsing')
}

// ---------------------------------------------------------------- other accepted shapes

function tolerantShapes() {
  // OpenRouter labels with `name`.
  const openrouter = parseModels('openrouter', { data: [{ id: 'anthropic/claude-3.5', name: 'Claude 3.5' }] })
  assert.equal(openrouter[0].name, 'Claude 3.5')

  // A bare array of ids, which some gateways return.
  assert.deepEqual(parseModels('deepseek', ['deepseek-chat', 'deepseek-reasoner']).map((m) => m.id), [
    'deepseek-chat',
    'deepseek-reasoner',
  ])

  // `{ models: [...] }` instead of `{ data: [...] }`.
  assert.deepEqual(parseModels('opencode', { models: [{ id: 'deepseek-v4-flash' }] }).map((m) => m.id), [
    'deepseek-v4-flash',
  ])

  // Duplicates collapse, and entries with no id are dropped rather than becoming blanks.
  const messy = parseModels('openai', { data: [{ id: 'a' }, { id: 'a' }, { object: 'model' }, null, 'b'] })
  assert.deepEqual(messy.map((m) => m.id), ['a', 'b'])

  results.push('tolerates name-maps, bare arrays, duplicates and junk rows')
}

// ---------------------------------------------------------------- an unrecognised shape is an error

function unrecognisedShape() {
  assert.throws(
    () => parseModels('openai', { unexpected: true }),
    (e: { code?: string }) => e.code === 'PROVIDER_ERROR',
    'a response with no rows should be a typed error, not an empty list'
  )
  results.push('unrecognised payload raises PROVIDER_ERROR')
}

// ---------------------------------------------------------------- Anthropic never hits the network

async function anthropicNeedsNoNetwork() {
  const mock = mockFetch(json({ data: [] }))
  const models = await fetchModels('anthropic', null, mock.fn)
  assert.equal(mock.calls.length, 0, 'Anthropic must not make a request')
  assert.deepEqual(
    models.map((m) => m.id),
    ANTHROPIC_CURATED_MODELS.map((m) => m.id),
    'Anthropic should return the curated list'
  )
  // Structured identically to fetched rows: an id, and a label.
  assert.ok(models.every((m) => typeof m.id === 'string' && m.id.length > 0))
  assert.ok(models.some((m) => typeof m.name === 'string'))

  // And it works with no key at all, unlike the HTTP providers.
  results.push('Anthropic returns the curated list without a request or a key')
}

// ---------------------------------------------------------------- the HTTP providers

async function httpProviders() {
  for (const [providerId, expectedUrl] of [
    ['deepseek', 'https://api.deepseek.com/v1/models'],
    ['openai', 'https://api.openai.com/v1/models'],
    ['opencode', 'https://opencode.ai/zen/v1/models'],
    ['openrouter', 'https://openrouter.ai/api/v1/models'],
  ]) {
    const mock = mockFetch(json({ data: [{ id: 'm-1' }, { id: 'm-2' }] }))
    const models = await fetchModels(providerId, 'sk-test', mock.fn)
    assert.equal(mock.calls[0].url, expectedUrl, `${providerId} url`)
    assert.equal((mock.calls[0].init.headers as Record<string, string>).authorization, 'Bearer sk-test')
    assert.deepEqual(models.map((m) => m.id), ['m-1', 'm-2'])
  }
  results.push('each OpenAI-compatible provider hits its own /v1/models with the bearer key')
}

// ---------------------------------------------------------------- failure modes

async function failures() {
  // A missing key never reaches the network.
  const noCall = mockFetch(json({ data: [] }))
  await assert.rejects(
    () => fetchModels('openai', null, noCall.fn),
    (e: { code?: string }) => e.code === 'NO_API_KEY'
  )
  assert.equal(noCall.calls.length, 0, 'a missing key must fail before the request')

  // 401 -> AUTH_FAILED, with the provider's own words kept as detail.
  await assert.rejects(
    () => fetchModels('openai', 'bad', mockFetch(json({ error: { message: 'Invalid key' } }, 401)).fn),
    (e: { code?: string; message?: string }) => e.code === 'AUTH_FAILED' && /Invalid key/.test(e.message ?? '')
  )

  // 429 -> RATE_LIMITED
  await assert.rejects(
    () => fetchModels('deepseek', 'k', mockFetch(json({ error: { message: 'slow down' } }, 429)).fn),
    (e: { code?: string }) => e.code === 'RATE_LIMITED'
  )

  // 500 -> PROVIDER_ERROR
  await assert.rejects(
    () => fetchModels('openai', 'k', mockFetch(json({}, 500)).fn),
    (e: { code?: string }) => e.code === 'PROVIDER_ERROR'
  )

  // Transport failure -> NETWORK_ERROR
  await assert.rejects(
    () =>
      fetchModels(
        'openai',
        'k',
        mockFetch(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND'))).fn
      ),
    (e: { code?: string; message?: string }) =>
      e.code === 'NETWORK_ERROR' && /api\.openai\.com/.test(e.message ?? '')
  )

  // A body that is not JSON -> PROVIDER_ERROR rather than a crash.
  await assert.rejects(
    () => fetchModels('openai', 'k', mockFetch(new Response('<html>', { status: 200 })).fn),
    (e: { code?: string }) => e.code === 'PROVIDER_ERROR'
  )

  // An unknown provider is refused before anything is read.
  await assert.rejects(
    () => fetchModels('nope', 'k', mockFetch(json({})).fn),
    (e: { code?: string }) => e.code === 'UNKNOWN_PROVIDER'
  )

  results.push('missing key, 401, 429, 500, transport failure and bad body all map to typed codes')
}

async function main() {
  openAiFormat()
  anthropicFormat()
  tolerantShapes()
  unrecognisedShape()
  await anthropicNeedsNoNetwork()
  await httpProviders()
  await failures()
  console.log('models engine: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('MODELS ENGINE TEST FAILED:', err)
  process.exit(1)
})
