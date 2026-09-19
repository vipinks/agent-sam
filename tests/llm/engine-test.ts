/**
 * Exercises the streaming engine against mocked fetch responses — no network, no API keys.
 * Loads the real `conveyor/modules/llm-engine.ts` so what is tested is what ships.
 */
import { strict as assert } from 'node:assert'
import { buildRequest, extractDelta, mapHttpError, streamChat } from '../../conveyor/modules/llm-engine'

const results: string[] = []

function sse(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

// ----------------------------------------------------------------- request shaping

function requestShaping() {
  const openai = buildRequest('openai', 'sk-test', 'gpt-4o-mini', [{ role: 'user', content: 'hi' }])
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(openai.headers.authorization, 'Bearer sk-test')
  assert.equal(openai.body.stream, true)

  assert.equal(buildRequest('deepseek', 'k', 'deepseek-chat', []).url, 'https://api.deepseek.com/v1/chat/completions')

  const openrouter = buildRequest('openrouter', 'k', 'm', [])
  assert.equal(openrouter.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(openrouter.headers['x-title'], 'Sam AI')

  assert.equal(buildRequest('opencode', 'k', 'm', []).url, 'https://opencode.ai/zen/v1/chat/completions')

  // Anthropic: system is hoisted out of the message list and auth is a header, not a bearer token.
  const anthropic = buildRequest('anthropic', 'sk-ant', 'claude-3-5-sonnet-latest', [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropic.headers['x-api-key'], 'sk-ant')
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.body.system, 'be brief')
  assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: 'hi' }])
  assert.equal(anthropic.body.stream, true)
  assert.ok(!('authorization' in anthropic.headers))

  assert.throws(
    () => buildRequest('nope', 'k', 'm', []),
    (e: { code?: string }) => e.code === 'UNKNOWN_PROVIDER'
  )
  results.push('request shaping')
}

// ----------------------------------------------------------------- delta extraction

function deltaExtraction() {
  // Since Phase 6 a delta carries text, tool-call fragments, or both, so the assertions are on the
  // object rather than on a bare string.
  assert.deepEqual(extractDelta('openai', '{"choices":[{"delta":{"content":"He"}}]}'), { text: 'He' })
  assert.equal(extractDelta('openai', '{"choices":[{"delta":{"role":"assistant"}}]}'), null)
  assert.equal(extractDelta('openai', '[DONE]'), null)
  assert.equal(extractDelta('openai', 'not json'), null)
  assert.equal(extractDelta('openai', '{"choices":[]}'), null)

  assert.deepEqual(
    extractDelta('anthropic', '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}'),
    { text: 'Hi' }
  )
  assert.equal(extractDelta('anthropic', '{"type":"message_start"}'), null)
  assert.equal(extractDelta('anthropic', '{"type":"message_stop"}'), null)

  // A tool call arrives in fragments: the id and name with the first frame, the JSON arguments
  // spread over the ones after it.
  assert.deepEqual(
    extractDelta(
      'openai',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}'
    ),
    { toolCalls: [{ index: 0, id: 'call_1', name: 'read_file' }] }
  )
  // Built with JSON.stringify rather than hand-escaped: a frame is nested JSON, and hand-escaping
  // it is exactly the kind of thing that produces a malformed payload and a misleading failure.
  const argsFrame = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
  })
  assert.deepEqual(extractDelta('openai', argsFrame), { toolCalls: [{ index: 0, argumentsDelta: '{"path":' }] })

  // Several calls in one frame. Every entry must come back: dropping all but the first leaves calls
  // unanswered, and the provider then rejects the next request with "insufficient tool messages
  // following tool_calls". This is the regression guard for that bug.
  const batched = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'c0', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { index: 1, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
            { index: 2, id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{}' } },
          ],
        },
      },
    ],
  })
  assert.deepEqual(extractDelta('openai', batched), {
    toolCalls: [
      { index: 0, id: 'c0', name: 'read_file', argumentsDelta: '{}' },
      { index: 1, id: 'c1', name: 'write_file', argumentsDelta: '{}' },
      { index: 2, id: 'c2', name: 'run_command', argumentsDelta: '{}' },
    ],
  })

  // An empty content string is not a text delta, and a frame with neither is not a delta at all.
  assert.equal(extractDelta('openai', '{"choices":[{"delta":{"content":""}}]}'), null)
  assert.equal(extractDelta('openai', '{"choices":[{"delta":{}}]}'), null)

  // An error frame inside a 200 stream must surface, not be swallowed.
  assert.throws(
    () => extractDelta('openai', '{"error":{"message":"quota exceeded"}}'),
    (e: { code?: string }) => e.code === 'PROVIDER_ERROR'
  )
  results.push('delta extraction, text and tool-call fragments')
}

// ----------------------------------------------------------------- http error mapping

function errorMapping() {
  assert.equal(mapHttpError(401, '').code, 'AUTH_FAILED')
  assert.equal(mapHttpError(403, '').code, 'AUTH_FAILED')
  assert.equal(mapHttpError(429, '').code, 'RATE_LIMITED')
  assert.equal(mapHttpError(402, '').code, 'RATE_LIMITED')
  assert.equal(mapHttpError(503, '').code, 'PROVIDER_ERROR')
  assert.equal(mapHttpError(400, 'bad model').code, 'PROVIDER_ERROR')
  assert.match(mapHttpError(400, 'bad model').message, /bad model/)
  results.push('http error mapping')
}

// ----------------------------------------------------------------- mocked streams

/** A fetch double returning one prepared Response, recording the init it was called with. */
function mockFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return typeof response === 'function' ? response() : response
  }
  return { fn, calls }
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

async function openAiStreamParsing() {
  // Chunk boundaries deliberately split mid-JSON and mid-CRLF: real sockets do not align frames.
  const body = sse(
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"cont',
    'ent":"lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n'
  )
  const mock = mockFetch(new Response(body, { status: 200 }))

  const out = await collect(
    streamChat({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      fetchImpl: mock.fn,
    })
  )
  assert.equal(out, 'Hello')
  assert.equal(mock.calls.length, 1)
  assert.equal(JSON.parse(String(mock.calls[0].init.body)).stream, true)
  results.push('openai sse stream (split chunks, crlf)')
}

async function anthropicStreamParsing() {
  const body = sse(
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  )
  const mock = mockFetch(new Response(body, { status: 200 }))

  const out = await collect(
    streamChat({
      providerId: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      fetchImpl: mock.fn,
    })
  )
  assert.equal(out, 'Hi there')
  const headers = mock.calls[0].init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], 'sk-ant')
  results.push('anthropic sse stream (event lines, lf)')
}

async function httpFailures() {
  const unauthorized = mockFetch(jsonResponse(401, '{"error":{"message":"Invalid key"}}'))
  await assert.rejects(
    collect(
      streamChat({
        providerId: 'openai',
        apiKey: 'bad',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        fetchImpl: unauthorized.fn,
      })
    ),
    (e: { code?: string; message?: string }) => e.code === 'AUTH_FAILED' && /Invalid key/.test(e.message ?? '')
  )

  const limited = mockFetch(jsonResponse(429, '{"error":{"message":"slow down"}}'))
  await assert.rejects(
    collect(
      streamChat({
        providerId: 'deepseek',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        fetchImpl: limited.fn,
      })
    ),
    (e: { code?: string }) => e.code === 'RATE_LIMITED'
  )
  results.push('http failures map to typed codes')
}

async function networkFailure() {
  const mock = mockFetch(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')))
  await assert.rejects(
    collect(
      streamChat({
        providerId: 'openai',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        fetchImpl: mock.fn,
      })
    ),
    (e: { code?: string }) => e.code === 'NETWORK_ERROR'
  )
  results.push('network failure maps to NETWORK_ERROR')
}

async function emptyBody() {
  const mock = mockFetch(new Response(null, { status: 200 }))
  await assert.rejects(
    collect(
      streamChat({
        providerId: 'openai',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        fetchImpl: mock.fn,
      })
    ),
    (e: { code?: string }) => e.code === 'NETWORK_ERROR'
  )
  results.push('empty response body rejected')
}

async function cancellation() {
  const controller = new AbortController()
  // A stream that never ends on its own: only the consumer's return can stop it.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
    },
  })
  const mock = mockFetch(new Response(body, { status: 200 }))

  const iterator = streamChat({
    providerId: 'openai',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    signal: controller.signal,
    fetchImpl: mock.fn,
  })

  const first = await iterator.next()
  assert.equal(first.value, 'a')
  // Cancelling the consumer must release the reader rather than hang.
  await iterator.return(undefined)
  results.push('cancellation releases the stream')
}

async function abortDuringFetch() {
  const controller = new AbortController()
  const mock = mockFetch(async () => {
    controller.abort()
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  })
  // An abort is a user action: the generator should end quietly, not throw.
  const out = await collect(
    streamChat({
      providerId: 'openai',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      fetchImpl: mock.fn,
    })
  )
  assert.equal(out, '')
  results.push('abort during fetch ends quietly')
}

async function main() {
  requestShaping()
  deltaExtraction()
  errorMapping()
  await openAiStreamParsing()
  await anthropicStreamParsing()
  await httpFailures()
  await networkFailure()
  await emptyBody()
  await cancellation()
  await abortDuringFetch()
  console.log('engine tests: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('ENGINE TEST FAILED:', err)
  process.exit(1)
})
