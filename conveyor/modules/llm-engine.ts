import { ConveyorError } from 'electron-conveyor/main'
import { chatCompletionsUrl, customProviderSchema, type CustomProvider } from '../protocol/custom-provider'
import {
  buildMessageContent,
  type ImageAttachmentRef,
  type MessageContentPart,
  type ResolvedAttachment,
} from '../protocol/image-attachments'
import { parseUsage, type UsageCounters } from '../protocol/session-usage'

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
  /**
   * The message's text, or the dialect's parts when it carries images.
   *
   * A union rather than always-parts, and that is the regression rule rather than a convenience: every
   * message this app has ever sent was a string, and a body that rewrote all of them as a one-element
   * array would change every existing conversation at once. The text-only case stays a string on the
   * wire, and only a message with images becomes an array.
   */
  content: string | MessageContentPart[]
  /** Present on an assistant turn that asked for tools. */
  tool_calls?: ToolCall[]
  /** Present on a `tool` turn: which call it answers. */
  tool_call_id?: string
}

/**
 * A history message as it crosses into main: its text, and references to the images it attached.
 *
 * The renderer's own shape for a turn, and deliberately not the wire one. A transcript records where an
 * image's bytes are — an id, a name, a media type, a size — and this is that record beside the words it
 * was sent with; the parts array a provider is handed is built from it at the moment a request is made,
 * by `withResolvedImages`. Keeping the two apart is what makes it impossible to send a reference: the
 * wire type has no field to carry one, so a message that reached `buildRequest` unresolved is a
 * compile error rather than a key a provider rejects.
 */
export interface HistoryMessage {
  role: ChatMessage['role']
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  images?: ImageAttachmentRef[]
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
 * A history as the provider must see it: every reference resolved to the bytes it names, once per call.
 *
 * The one step between a transcript's references and the dialect's content parts, and it lives here
 * rather than in the loop because this is the layer that already owns what a wire message is: the loop
 * holds the conversation, and the engine holds the request. A caller that rebuilt the parts itself
 * would be a second answer to what a message goes out as, and the two would drift the first time the
 * dialect changed.
 *
 * Resolution is per call rather than cached across calls, because a reference is resolved at a
 * *request*: the bytes are read when the send happens, which is what makes an image attached ten
 * minutes ago and a file swept since behave differently from one that is still there. The loop
 * remembers what it resolved for the length of one run, so a turn that takes several round-trips does
 * not encode the same images again for each of them.
 *
 * The order is the references' own, which is the order the user attached them in: a sentence that says
 * "the second one is the bug" means what the user meant only if the second image is where they put it.
 * The resolver is awaited one reference at a time for the same reason — a batch that came back in
 * completion order would reorder the parts — and a refusal or a miss anywhere aborts the whole call,
 * because a request that went out without an image it named would put a message in the conversation
 * the model never saw.
 */
export async function withResolvedImages(
  messages: readonly HistoryMessage[],
  resolve: (image: ImageAttachmentRef) => Promise<ResolvedAttachment>
): Promise<ChatMessage[]> {
  const resolved: ChatMessage[] = []

  for (const message of messages) {
    // Destructured rather than deleted in place: the loop hands its own history in, and a history that
    // lost the references it is still holding would resolve them for nothing on the next round-trip.
    const { images, ...rest } = message

    if (!images || images.length === 0) {
      resolved.push(rest)
      continue
    }

    const attachments: ResolvedAttachment[] = []
    for (const image of images) attachments.push(await resolve(image))

    resolved.push({ ...rest, content: buildMessageContent(rest.content, attachments) })
  }

  return resolved
}

/**
 * Shape the HTTPS request for a provider. Anthropic is its own dialect: the system prompt is a
 * top-level field rather than a message, and auth is a header instead of a bearer token.
 *
 * `provider` is the descriptor a turn was handed for a custom provider, and it wins when it is there: a
 * descriptor is a statement about *this* turn's provider, while `providerId` names one the built-in
 * table might also know. Absent, invalid, or present-but-not-a-descriptor are three different facts,
 * and two of them are failures — `UNKNOWN_PROVIDER` for an id nothing describes, `INVALID_PROVIDER` for
 * a descriptor that cannot be run.
 */
export function buildRequest(
  providerId: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  provider?: unknown
): ProviderRequest {
  // A provider the user added, which the built-in table knows nothing about. It speaks the OpenAI
  // dialect — that is what the descriptor says, and the only dialect this build can speak for one.
  const custom = resolveCustomProvider(provider)
  if (custom) {
    return {
      url: chatCompletionsUrl(custom.baseUrl),
      headers: openAiHeaders(custom.apiKey),
      body: openAiBody(model, messages, tools),
    }
  }

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

  const headers = openAiHeaders(apiKey)
  // OpenRouter attributes traffic by referer; harmless elsewhere but only sent where it means
  // something.
  if (providerId === 'openrouter') headers['x-title'] = 'Agent Sam'

  return { url, headers, body: openAiBody(model, messages, tools) }
}

/**
 * The descriptor a turn was handed, or null when it was handed none.
 *
 * A malformed descriptor throws rather than reading as absent: an object that is not a descriptor is not
 * the same fact as no object at all, and the caller has to be told which one it is. The failure carries
 * a code — `INVALID_PROVIDER` — so a caller branches on that rather than on the sentence, which is what
 * the rest of this engine's errors are for.
 */
export function resolveCustomProvider(provider: unknown): CustomProvider | null {
  if (provider === undefined || provider === null) return null

  const parsed = customProviderSchema.safeParse(provider)
  if (!parsed.success) {
    throw new ConveyorError(
      'INVALID_PROVIDER',
      'This turn names a custom provider, but its descriptor is not one this app can run.'
    )
  }
  return parsed.data
}

/**
 * The headers every OpenAI-dialect request carries.
 *
 * The bearer is only sent when there is a key to send: a custom provider may be a server on the user's
 * own machine that wants no credential, and `Bearer ` with nothing after it is a header such a server
 * may reject. A predefined provider always has a key by the time a request is built, so this is their
 * header exactly as it was.
 */
function openAiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

/**
 * The OpenAI-dialect body.
 *
 * Tools are sent only when there are some: some gateways reject an empty array, and omitting the keys
 * entirely is what keeps an ordinary chat request shaped exactly as it was before tools.
 *
 * `stream_options` asks the provider to close the reply with what it cost. Only this dialect takes it —
 * Anthropic reports usage on events of its own and refuses a parameter it does not document — and it is
 * the whole reason a session can be priced at all, so it is sent on every request rather than only when
 * someone is watching.
 */
function openAiBody(model: string, messages: ChatMessage[], tools?: ToolDefinition[]): Record<string, unknown> {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
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
  /**
   * What this reply cost, as the provider counted it.
   *
   * The only place a provider reports its own accounting, and it arrives on the frame that closes the
   * reply — after the text, usually after the frame carrying the finish reason, and with no delta at all
   * beside it. The parser therefore has to be able to report a frame whose whole content is this.
   *
   * Absent on every other frame, and absent on a provider that reports nothing: a turn that says nothing
   * about cost has to arrive here as nothing, so the total it feeds is not moved by it.
   */
  usage?: UsageCounters
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

  // Read before the emptiness check below, which would otherwise swallow it: the accounting frame that
  // closes an OpenAI-dialect reply carries no choice and no delta at all, so a parser that returned
  // early here would drop the only frame that knows what the reply cost.
  const usage = parseUsage(e)
  if (!delta && !choice) return usage ? { usage } : null

  const result: StreamDelta = usage ? { usage } : {}
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

  return result.text !== undefined ||
    result.toolCalls !== undefined ||
    result.finishReason !== undefined ||
    result.usage !== undefined
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
  /**
   * The custom provider this turn runs against, when it runs against one. Validated here rather than
   * trusted: this is where a turn's provider is decided, so a descriptor that cannot be run has to fail
   * at the same boundary as an id nothing describes — and it fails with a code, not a sentence.
   */
  provider?: unknown
}): AsyncGenerator<StreamDelta, void, undefined> {
  const { providerId, apiKey, model, messages, tools, signal, provider } = options
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const request = buildRequest(providerId, apiKey, model, messages, tools, provider)

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
  /** See `streamDeltas`: the same descriptor, for the same turn. */
  provider?: unknown
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
