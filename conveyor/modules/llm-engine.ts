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
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Present on an assistant turn that asked for tools. */
  tool_calls?: ToolCall[]
  /** Present on a `tool` turn: which call it answers. */
  tool_call_id?: string
}

/** A tool invocation the model asked for. */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** An OpenAI-compatible tool definition. */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
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
  messages: ChatMessage[],
  tools?: ToolDefinition[]
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

  return {
    url,
    headers,
    body: {
      model,
      stream: true,
      messages,
      // Only sent when there are tools: some gateways reject an empty array, and omitting the keys
      // entirely is what keeps an ordinary chat request shaped exactly as it was before tools.
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
    },
  }
}

/**
 * One decoded frame: the text it may carry, and any tool-call fragments it may carry.
 *
 * Tool calls stream in pieces — an id in one frame, the function name perhaps in the same or the
 * next, then the JSON arguments over many — so the parser reports raw fragments and the caller
 * accumulates them. Trying to interpret a partial fragment here would mean guessing at JSON that is
 * still being written.
 */
export interface StreamDelta {
  text?: string
  /**
   * Every tool-call fragment in the frame, not just the first.
   *
   * A provider may put several calls in one `tool_calls` array. Reading only index 0 silently drops
   * the others, and a dropped call is never answered — which is what makes the next request fail the
   * provider's "every tool_call_id must be answered" contract.
   */
  toolCalls?: ToolCallFragment[]
  /**
   * Why the provider stopped, on the frames that carry it.
   *
   * The last thing a reply says and the first thing anyone diagnosing it needs: `stop` and
   * `tool_calls` mean the model finished, `length` means the provider ran out of output room and cut
   * the reply off mid-sentence. Reported raw and mapped nowhere here — the vocabulary differs per
   * provider, and the one place that knows what a value means is `protocol/turn-end.ts`.
   */
  finishReason?: string
}

/** One call's fragment within a frame. */
export interface ToolCallFragment {
  /** Position in the response's tool_calls array; the only stable key while streaming. */
  index: number
  id?: string
  name?: string
  /** A JSON fragment, not a complete document. */
  argumentsDelta?: string
}

/**
 * Pull everything useful out of one decoded SSE `data:` payload. Returns null for payloads that
 * carry nothing — pings, role openers, the terminating `[DONE]`, and Anthropic's non-delta events.
 */
export function extractDelta(providerId: string, payload: string): StreamDelta | null {
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
      if (delta && typeof delta.text === 'string') return { text: delta.text }
    }
    // Anthropic says why it stopped on a `message_delta` of its own, after the text is done.
    if (e.type === 'message_delta') {
      const delta = e.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') return { finishReason: delta.stop_reason }
    }
    return null
  }

  // OpenAI dialect. Some gateways emit an error frame mid-stream, on a 200 response.
  if (e.error) throw inStreamError(e.error)

  const choices = e.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const delta = choice?.delta as Record<string, unknown> | undefined
  if (!delta && !choice) return null

  const result: StreamDelta = {}
  // The finish reason sits on the choice rather than in the delta, and the frame that closes the
  // reply usually carries an empty delta beside it — so it is read before the delta is, and a frame
  // with one and no delta at all is still a frame worth reporting.
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
    result.finishReason = choice.finish_reason
  }

  if (typeof delta?.content === 'string' && delta.content) result.text = delta.content

  const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
  if (calls?.length) {
    result.toolCalls = calls.map((call) => {
      const fn = call.function as Record<string, unknown> | undefined
      return {
        index: typeof call.index === 'number' ? call.index : 0,
        ...(typeof call.id === 'string' && call.id ? { id: call.id } : {}),
        ...(typeof fn?.name === 'string' && fn.name ? { name: fn.name } : {}),
        ...(typeof fn?.arguments === 'string' && fn.arguments ? { argumentsDelta: fn.arguments } : {}),
      }
    })
  }

  return result.text !== undefined || result.toolCalls !== undefined || result.finishReason !== undefined
    ? result
    : null
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
 * Walk an SSE byte stream and yield its deltas. Frames are separated by a blank line and may carry
 * `event:`/`id:` lines, which are skipped: every provider here puts what we need in `data:`.
 *
 * The reader is released in a `finally` so an aborted or errored stream does not leak the body.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  providerId: string
): AsyncGenerator<StreamDelta, void, undefined> {
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
 * Run one chat completion and yield its deltas, tool-call fragments included.
 *
 * The caller owns `signal`; aborting it aborts the request and ends the generator quietly, which is
 * what a cancelled stream should look like. This is the level the agent loop needs, because a
 * request answered with tool calls carries no text at all.
 */
export async function* streamDeltas(options: {
  providerId: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal: AbortSignal
  fetchImpl?: FetchLike
}): AsyncGenerator<StreamDelta, void, undefined> {
  const { providerId, apiKey, model, messages, tools, signal } = options
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const request = buildRequest(providerId, apiKey, model, messages, tools)

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

  // Everything past the response being accepted is the reply arriving rather than the provider
  // deciding about the request, and a failure there is a different fact with a different next step:
  // the request went through and the answer stopped. `STREAM_ERROR` is that fact, and it exists so
  // the caller can branch on a code — `NETWORK_ERROR` and `PROVIDER_ERROR` are also what a refused
  // request produces, and telling the two apart by reading the message is what the codes are for.
  try {
    yield* parseSse(response.body, providerId)
  } catch (err) {
    // An abort is the user's own doing and has nothing to report.
    if (signal.aborted) return
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('STREAM_ERROR', `${hostOf(request.url)} stopped sending the reply. ${reason}`)
  }
}

/**
 * Run one chat completion and yield only its text.
 *
 * A thin filter over `streamDeltas`, kept as the plain-chat surface: `llm.chat` streams tokens to
 * the UI and has no use for tool fragments, so it should not have to look inside them.
 */
export async function* streamChat(options: {
  providerId: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal: AbortSignal
  fetchImpl?: FetchLike
}): AsyncGenerator<string, void, undefined> {
  for await (const delta of streamDeltas(options)) {
    if (delta.text) yield delta.text
  }
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
