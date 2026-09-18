import { ConveyorError } from 'electron-conveyor/main'

/**
 * Provider plumbing for the chat stream: where each provider lives, how to shape a request for it,
 * and how to read its SSE response back.
 *
 * Deliberately pure — no electron, no fs, and `fetch` is injected rather than reached for — so the
 * request shaping and the SSE parsing can be exercised against a mocked response without a network
 * or a key. `llm.ts` supplies the real settings lookup and the global fetch.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Providers that speak the OpenAI `/chat/completions` dialect. */
const OPENAI_COMPATIBLE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  // OpenCode Zen is an AI gateway; its OpenAI-compatible models live under this path.
  opencode: 'https://opencode.ai/zen/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * Shape the HTTPS request for a provider. Anthropic is its own dialect: the system prompt is a
 * top-level field rather than a message, and auth is a header instead of a bearer token.
 */
export function buildRequest(
  providerId: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): ProviderRequest {
  if (providerId === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
    const turns = messages.filter((m) => m.role !== 'system')
    return {
      url: ANTHROPIC_URL,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: {
        model,
        max_tokens: 4096,
        stream: true,
        ...(system.length ? { system: system.join('\n\n') } : {}),
        messages: turns,
      },
    }
  }

  const url = OPENAI_COMPATIBLE_URLS[providerId]
  if (!url) throw new ConveyorError('UNKNOWN_PROVIDER', `No endpoint configured for '${providerId}'.`)

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }
  // OpenRouter attributes traffic by referer; harmless elsewhere but only sent where it means
  // something.
  if (providerId === 'openrouter') headers['x-title'] = 'Sam AI'

  return { url, headers, body: { model, stream: true, messages } }
}

/**
 * Pull the text out of one decoded SSE `data:` payload. Returns null for payloads that carry no
 * text — pings, role openers, the terminating `[DONE]`, and Anthropic's non-delta events.
 */
export function extractDelta(providerId: string, payload: string): string | null {
  if (payload === '[DONE]') return null

  let event: unknown
  try {
    event = JSON.parse(payload)
  } catch {
    return null // A malformed frame is skipped rather than killing the stream.
  }
  if (!event || typeof event !== 'object') return null
  const e = event as Record<string, unknown>

  if (providerId === 'anthropic') {
    if (e.type === 'content_block_delta') {
      const delta = e.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.text === 'string') return delta.text
    }
    return null
  }

  // OpenAI dialect. Some gateways emit an error frame mid-stream, on a 200 response.
  if (e.error) throw inStreamError(e.error)

  const choices = e.choices as Array<Record<string, unknown>> | undefined
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
  if (delta && typeof delta.content === 'string') return delta.content
  return null
}

/** An error object embedded in a 200 response body, e.g. `{"error":{"message":"..."}}`. */
function inStreamError(error: unknown): ConveyorError {
  const message =
    error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
      ? ((error as Record<string, unknown>).message as string)
      : 'The provider reported an error mid-stream.'
  return new ConveyorError('PROVIDER_ERROR', message)
}

/**
 * Walk an SSE byte stream and yield the text deltas. Frames are separated by a blank line and may
 * carry `event:`/`id:` lines, which are skipped: every provider here puts what we need in `data:`.
 *
 * The reader is released in a `finally` so an aborted or errored stream does not leak the body.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  providerId: string
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Frames end on a blank line; \r\n\r\n is what most SSE servers actually send.
      let boundary = findBoundary(buffer)
      while (boundary.index !== -1) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)

        const text = readDataLines(frame)
        if (text !== null) {
          const delta = extractDelta(providerId, text)
          if (delta) yield delta
        }

        boundary = findBoundary(buffer)
      }
    }

    // A final frame without a trailing blank line still counts.
    const tail = readDataLines(buffer)
    if (tail !== null) {
      const delta = extractDelta(providerId, tail)
      if (delta) yield delta
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function findBoundary(buffer: string): { index: number; length: number } {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return { index: -1, length: 0 }
  if (crlf !== -1 && (crlf < lf || lf === -1)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** Join a frame's `data:` lines, per the SSE spec, or null when the frame carries none. */
function readDataLines(frame: string): string | null {
  const parts: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) parts.push(line.slice(5).trimStart())
  }
  return parts.length ? parts.join('\n') : null
}

/**
 * Translate an HTTP failure into a typed error. Status is the only reliable signal across
 * providers, so the mapping is on status and the body is used for wording, not for branching.
 */
export function mapHttpError(status: number, detail: string): ConveyorError {
  const trimmed = detail.trim().slice(0, 400)
  const suffix = trimmed ? ` ${trimmed}` : ''

  if (status === 401 || status === 403) {
    return new ConveyorError('AUTH_FAILED', `The provider rejected this API key.${suffix}`)
  }
  if (status === 429) {
    return new ConveyorError('RATE_LIMITED', `The provider is rate limiting this key.${suffix}`)
  }
  if (status === 402) {
    return new ConveyorError('RATE_LIMITED', `This key is out of credit.${suffix}`)
  }
  if (status >= 500) {
    return new ConveyorError('PROVIDER_ERROR', `The provider had a server error (${status}).${suffix}`)
  }
  // Everything else — a bad model id, a malformed body — is the provider refusing the request.
  return new ConveyorError('PROVIDER_ERROR', `The provider refused the request (${status}).${suffix}`)
}

/** A `fetch`-shaped function, so the stream can be driven from a test without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Run one chat completion and yield its text deltas. The caller owns `signal`; aborting it aborts
 * the request and ends the generator quietly, which is what a cancelled stream should look like.
 */
export async function* streamChat(options: {
  providerId: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal: AbortSignal
  fetchImpl?: FetchLike
}): AsyncGenerator<string, void, undefined> {
  const { providerId, apiKey, model, messages, signal } = options
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const request = buildRequest(providerId, apiKey, model, messages)

  let response: Response
  try {
    response = await doFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    })
  } catch (err) {
    // An abort is a user action, not a failure to report.
    if (signal.aborted) return
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('NETWORK_ERROR', `Could not reach ${hostOf(request.url)}. ${reason}`)
  }

  if (!response.ok) {
    throw mapHttpError(response.status, await readSafely(response))
  }
  if (!response.body) {
    throw new ConveyorError('NETWORK_ERROR', `${hostOf(request.url)} returned an empty response.`)
  }

  yield* parseSse(response.body, providerId)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the provider'
  }
}

/** Read an error body without letting a stream failure mask the HTTP status we already have. */
async function readSafely(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | undefined
      if (error && typeof error.message === 'string') return error.message
      if (typeof parsed.message === 'string') return parsed.message
    } catch {
      // Not JSON — the raw text is still useful as detail.
    }
    return text
  } catch {
    return ''
  }
}
