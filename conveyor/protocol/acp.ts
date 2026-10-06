/**
 * The Agent Client Protocol, as rules: how a message is framed on a pipe, which message is a request and
 * which is a notification, what a permission question is made of, and what an agent's update means.
 *
 * Pure by necessity, and predicted by the MCP rail's own split: the parts that decide something are here,
 * where a suite can state them without spawning anything, and `conveyor/modules/engine-acp.ts` owns the
 * process and imports this. It declares no imports at all, so the framing answers from the bytes it was
 * handed and nothing else — not a clock, not a store, not a path.
 *
 * ACP is JSON-RPC 2.0 over a line-delimited stream: one message per line, in both directions. That is the
 * whole of the transport, which is why the framer below is the only thing here that touches bytes: a chunk
 * may carry half a message, several messages, or a line that is not a message at all, and each of those is
 * a state the client has to survive rather than a case it may assume away.
 */

/** The protocol version this client speaks. Answered to `initialize`, and compared with what the agent says. */
export const ACP_PROTOCOL_VERSION = 1

/** The methods the client sends, and the two the agent sends. Named so no call site spells one. */
export const ACP_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  requestPermission: 'session/request_permission',
} as const

/** The updates that carry something this app draws or records. Anything else is `other`. */
export const ACP_UPDATE_KINDS = {
  messageChunk: 'agent_message_chunk',
  toolCall: 'tool_call',
  toolCallUpdate: 'tool_call_update',
} as const

/**
 * The option kinds a permission request may offer.
 *
 * The kind, never the label: an agent writes "Allow once" in whatever language or style it likes, and the
 * only thing that says whether an option grants consent is the kind. That is why `acpOptionApproves` reads
 * this closed set and nothing else.
 */
export const ACP_PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const

/**
 * The refusals this client raises, by code.
 *
 * Codes rather than sentences, so a caller branches on the state rather than reading it: `ACP_CLOSED` is
 * what a write into a dead pipe is, `ACP_HANDSHAKE_FAILED` is an agent that answered no, and the two are
 * different things the surface says differently.
 */
export const ACP_CODES = {
  /** The agent answered `initialize` with an error, so there is no session to be had. */
  ACP_HANDSHAKE_FAILED: 'ACP_HANDSHAKE_FAILED',
  /** A session was asked for something before the handshake, which the protocol does not allow. */
  ACP_NOT_INITIALIZED: 'ACP_NOT_INITIALIZED',
  /** The client was closed: the process is gone and nothing may be written to it. */
  ACP_CLOSED: 'ACP_CLOSED',
  /** The agent refused a request with an error of its own, which travels as this code plus nothing else. */
  ACP_REFUSED: 'ACP_REFUSED',
  /** The process could not be started at all. */
  ACP_SPAWN_FAILED: 'ACP_SPAWN_FAILED',
} as const

export type AcpCode = (typeof ACP_CODES)[keyof typeof ACP_CODES]

// ---------------------------------------------------------------- framing

/** What a chunk left behind: the messages it completed, what is still partial, and any line that was not JSON. */
export interface AcpFramed {
  messages: unknown[]
  /** The tail of an unterminated line, handed back to be prefixed to the next chunk. */
  rest: string
  /** Every line that did not parse. Reported rather than thrown: one bad line is not the end of a conversation. */
  malformed: string[]
}

/**
 * Split a stream chunk into messages, keeping whatever is still partial.
 *
 * The three shapes are all handled here and none of them is assumed away: a chunk carrying a whole message,
 * a chunk splitting one across two reads (the remainder is handed back rather than dropped), and a chunk
 * carrying several — which is the ordinary case for a pipe, where two writes often arrive as one read. Blank
 * lines are skipped, because a trailing newline is framing rather than a message.
 */
export function parseAcpChunk(buffer: string, chunk: string): AcpFramed {
  const messages: unknown[] = []
  const malformed: string[] = []
  let pending = buffer + chunk
  let index = pending.indexOf('\n')

  while (index !== -1) {
    const line = pending.slice(0, index)
    pending = pending.slice(index + 1)
    if (line.trim() !== '') {
      try {
        messages.push(JSON.parse(line))
      } catch {
        malformed.push(line)
      }
    }
    index = pending.indexOf('\n')
  }

  return { messages, rest: pending, malformed }
}

/** One message as the line it is written as. The newline is the transport, so it is added here, once. */
export function encodeAcpMessage(message: unknown): string {
  return JSON.stringify(message) + '\n'
}

/** A request: an id, a method, and params. What the client sends to the agent. */
export function acpRequest(id: number, method: string, params: unknown): unknown {
  return { jsonrpc: '2.0', id, method, params }
}

/** A notification: a method and params, and deliberately no id — it is not answered. */
export function acpNotification(method: string, params: unknown): unknown {
  return { jsonrpc: '2.0', method, params }
}

/** The answer to a request the agent made of us. */
export function acpSuccess(id: number, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result }
}

/** The refusal of a request the agent made of us, by JSON-RPC code rather than by prose. */
export function acpFailure(id: number, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** What a message is, read from its shape: an id and a method is a request, a method alone a notification. */
export type AcpMessageKind = 'request' | 'notification' | 'response' | 'invalid'

export function acpKind(message: unknown): AcpMessageKind {
  if (typeof message !== 'object' || message === null) return 'invalid'
  const candidate = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
  if (typeof candidate.method === 'string') {
    return candidate.id === undefined ? 'notification' : 'request'
  }
  if (candidate.id === undefined) return 'invalid'
  if (candidate.result !== undefined || candidate.error !== undefined) return 'response'
  return 'invalid'
}

// ---------------------------------------------------------------- consent

/** One way to answer a permission question, as the agent declared it. */
export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

/**
 * A `session/request_permission` as this app reads it.
 *
 * `requestId` is a string, and deliberately: the id is JSON-RPC's — a number the agent chose — but what
 * crosses the IPC boundary to the shield is the answer's key, and an id is a name rather than arithmetic.
 * The client keeps the original number and puts it back on the way out.
 */
export interface AcpPermissionRequest {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  options: AcpPermissionOption[]
}

/**
 * Read a message as a permission request, or answer null.
 *
 * Null rather than a throw for every other message on the wire, because this is called for every inbound
 * request and an agent asks many things: a notification that is not this is not an error, it is a message
 * this client has no opinion about.
 */
export function acpPermissionRequest(message: unknown): AcpPermissionRequest | null {
  if (acpKind(message) !== 'request') return null
  const request = message as { id?: unknown; method?: unknown; params?: unknown }
  if (request.method !== ACP_METHODS.requestPermission) return null

  const params = (request.params ?? {}) as { sessionId?: unknown; toolCall?: unknown; options?: unknown }
  const toolCall = (params.toolCall ?? {}) as { toolCallId?: unknown; title?: unknown }
  const offered = Array.isArray(params.options) ? params.options : []

  return {
    requestId: String(request.id),
    sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
    toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
    title: typeof toolCall.title === 'string' ? toolCall.title : '',
    options: offered.map((option) => {
      const candidate = option as { optionId?: unknown; name?: unknown; kind?: unknown }
      return {
        optionId: typeof candidate.optionId === 'string' ? candidate.optionId : '',
        name: typeof candidate.name === 'string' ? candidate.name : '',
        kind: typeof candidate.kind === 'string' ? candidate.kind : '',
      }
    }),
  }
}

/** The answer the agent is waiting for: the option that was picked, by its own id. */
export function acpPermissionAnswer(id: number, optionId: string): unknown {
  return { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } }
}

/**
 * End the question without an option — what a question nobody could put to the user gets.
 *
 * `cancelled` rather than a fabricated rejection: an engine that never reached the user must not be told
 * the user said no, which is why this is a separate outcome and not a `reject` option id.
 */
export function acpPermissionCancelled(id: number): unknown {
  return { jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }
}

/**
 * Whether an option grants consent, read from its kind and never from its label.
 *
 * The label is the agent's prose and may say anything; the kind is the protocol's, and it is the only thing
 * that decides. An option whose kind is unknown does not approve: consent is not something to infer from a
 * word an engine chose.
 */
export function acpOptionApproves(option: AcpPermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

// ---------------------------------------------------------------- the event stream

/**
 * What an agent's update means to this app.
 *
 * A closed union rather than the raw notification, because everything downstream draws from it: a `tool_call`
 * is a card, a `tool_call_update` settles that card, and a `message_chunk` is prose. An update the app has
 * no opinion about is `other` and carries its own kind — reported rather than dropped, so a reader of the
 * stream can see that the agent said something this build does not act on.
 */
export type AcpEvent =
  | { type: 'tool_call'; sessionId: string; toolCallId: string; title: string; kind: string; status: string }
  | { type: 'tool_call_update'; sessionId: string; toolCallId: string; status: string }
  | { type: 'message_chunk'; sessionId: string; text: string }
  | { type: 'other'; sessionId: string; kind: string }

/**
 * Read a message as an event, or answer null.
 *
 * Only `session/update` carries events, and only its `update` member says which one: the same shape carries
 * the call announcement, its outcome and the prose, so the discriminant is a field inside the payload rather
 * than the method. Anything else — a response, a request, a notification of another kind — has no event in it.
 */
export function acpEvent(message: unknown): AcpEvent | null {
  if (acpKind(message) !== 'notification') return null
  const notification = message as { method?: unknown; params?: unknown }
  if (notification.method !== ACP_METHODS.update) return null

  const params = (notification.params ?? {}) as { sessionId?: unknown; update?: unknown }
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  const update = (params.update ?? {}) as {
    sessionUpdate?: unknown
    toolCallId?: unknown
    title?: unknown
    kind?: unknown
    status?: unknown
    content?: unknown
  }
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
  const text = (update.content ?? {}) as { text?: unknown }

  if (kind === ACP_UPDATE_KINDS.toolCall) {
    return {
      type: 'tool_call',
      sessionId,
      toolCallId: typeof update.toolCallId === 'string' ? update.toolCallId : '',
      title: typeof update.title === 'string' ? update.title : '',
      kind: typeof update.kind === 'string' ? update.kind : '',
      status: typeof update.status === 'string' ? update.status : '',
    }
  }

  if (kind === ACP_UPDATE_KINDS.toolCallUpdate) {
    return {
      type: 'tool_call_update',
      sessionId,
      toolCallId: typeof update.toolCallId === 'string' ? update.toolCallId : '',
      status: typeof update.status === 'string' ? update.status : '',
    }
  }

  if (kind === ACP_UPDATE_KINDS.messageChunk) {
    return { type: 'message_chunk', sessionId, text: typeof text.text === 'string' ? text.text : '' }
  }

  return { type: 'other', sessionId, kind }
}
