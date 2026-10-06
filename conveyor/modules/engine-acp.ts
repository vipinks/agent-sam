import {
  spawn as spawnProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process'
import { ConveyorError } from 'electron-conveyor/main'
import {
  ACP_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  acpEvent,
  acpFailure,
  acpKind,
  acpPermissionAnswer,
  acpPermissionCancelled,
  acpPermissionRequest,
  acpRequest,
  encodeAcpMessage,
  parseAcpChunk,
  type AcpEvent,
  type AcpPermissionRequest,
} from '../protocol/acp'

/**
 * The ACP client: one engine process, spoken to over its stdio.
 *
 * Main-only, and the only place in the app that writes to an engine's stdin. The protocol's rules live in
 * `conveyor/protocol/acp.ts` — framing, what a permission question is, what an update means — and this file
 * is the other half: the process, the request ids, and the promises a caller waits on. That split is the MCP
 * rail's, for the same reason: what can be decided without a process is decided where a suite can state it
 * without spawning anything.
 *
 * Every call here is a request with an id, and the id is what a response is matched back to. Nothing is
 * matched on a method name or on a message: a response arrives addressed, and a client that guessed which
 * call it answered would be a client that eventually answers the wrong one.
 *
 * The permission question is the one inbound request this client routes anywhere. It is handed to
 * `onPermissionRequest`, which is where the consent bridge lives, and the option that comes back is what the
 * agent is told. A question nobody could be asked — no window, no shield — is answered `cancelled` rather
 * than as a rejection, because an engine must not be told the user refused something the user never saw.
 */

/**
 * How a process is started.
 *
 * Exactly node's own `spawn`, injectable so a suite can drive a fixture and observe what reached the OS. The
 * signature is the house one: arguments as an array, and the options a caller may set say nothing about a
 * shell — there is no way to ask for one through this type, which is the only kind of guarantee that lasts.
 */
export type AcpSpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams

/** What to start: the command, its arguments as an array, and where it runs. */
export interface AcpSpawnSpec {
  command: string
  args: string[]
  cwd?: string
}

/** What a completed handshake answered: the version the agent speaks, its name, and whether we speak it too. */
export interface AcpInitializeResult {
  protocolVersion: number
  agentName: string | null
  /**
   * True when the agent answered a protocol version this build does not speak.
   *
   * A refusal of the *handshake* is thrown, with `ACP_HANDSHAKE_FAILED`, because there is no session to be
   * had and no honest result to return. This flag is the other case: the agent is alive and answered, and
   * what it answered is a version we cannot use — a state the surface says out loud rather than a failure.
   */
  refused: boolean
}

/** How a turn ended, in the agent's own word for it. */
export interface AcpPromptResult {
  stopReason: string
}

export interface AcpClientDeps {
  spawn: AcpSpawnSpec
  /** Left out in the app: the real `child_process.spawn`. Supplied by the suites that need to watch it. */
  spawnImpl?: AcpSpawnImpl
  /** Every update the agent wrote, in the order it wrote them. */
  onEvent?: (event: AcpEvent) => void
  /**
   * Put one permission question to whoever can answer it, and answer with the option id they picked.
   *
   * A rejection means nobody could be asked, which the agent is told as `cancelled`.
   */
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<string>
  /** A line that was not JSON. Reported rather than swallowed, because a bad line is a fact about the peer. */
  onMalformedLine?: (line: string) => void
}

export interface AcpClient {
  /** The agent's session id, held here so a prompt is addressed without the caller carrying it. */
  readonly sessionId: string | null
  initialize(): Promise<AcpInitializeResult>
  newSession(): Promise<string>
  prompt(text: string): Promise<AcpPromptResult>
  close(): void
}

/** One call the client is waiting on, and the two ways it can end. */
interface Waiting {
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
}

/**
 * Start an engine and speak ACP to it.
 *
 * The process is started here and owned here: one client, one child, and a `close()` that ends it. The read
 * side is wired before the first write, so an agent that answers immediately cannot answer into nothing.
 */
export function createAcpClient(deps: AcpClientDeps): AcpClient {
  const spawnImpl: AcpSpawnImpl = deps.spawnImpl ?? spawnProcess
  const child = spawnImpl(deps.spawn.command, deps.spawn.args, {
    ...(deps.spawn.cwd === undefined ? {} : { cwd: deps.spawn.cwd }),
    // Pipes, and never a shell: the two things this client needs from the OS.
    shell: false,
    windowsHide: true,
  })

  let nextId = 1
  let buffer = ''
  let sessionId: string | null = null
  let initialized = false
  let closed = false
  const waiting = new Map<number, Waiting>()

  /** Refuse everything still in flight, by code, so no caller is left on a promise nothing will answer. */
  const abandon = (code: string, message: string): void => {
    const outstanding = [...waiting.values()]
    waiting.clear()
    for (const entry of outstanding) entry.reject(new ConveyorError(code, message))
  }

  child.stdout.on('data', (chunk) => {
    const framed = parseAcpChunk(buffer, String(chunk))
    buffer = framed.rest
    for (const line of framed.malformed) deps.onMalformedLine?.(line)
    for (const message of framed.messages) route(message)
  })

  child.on('error', () => {
    // A process that never started is not a process that ended: everything in flight is refused with the
    // start code, because there is no session to be had and no answer is coming.
    abandon(ACP_CODES.ACP_SPAWN_FAILED, 'The engine process could not be started.')
  })

  child.on('close', () => {
    closed = true
    abandon(ACP_CODES.ACP_CLOSED, 'The engine process ended before it answered.')
  })

  /** One inbound message, routed by what it is rather than by what it says. */
  function route(message: unknown): void {
    const kind = acpKind(message)

    if (kind === 'notification') {
      const event = acpEvent(message)
      if (event) deps.onEvent?.(event)
      return
    }

    if (kind === 'request') {
      const request = acpPermissionRequest(message)
      const id = (message as { id: number }).id
      if (!request) {
        // The only inbound request this client answers. Refusing the rest with a code is what a peer needs
        // to stop waiting; leaving one unanswered would be the hang a protocol error exists to avoid.
        write(acpFailure(id, -32601, 'this client answers no other request'))
        return
      }
      void ask(request, id)
      return
    }

    if (kind === 'response') {
      const id = (message as { id: number }).id
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      const failure = (message as { error?: unknown }).error
      if (failure !== undefined) {
        // The agent's own refusal: a code of ours, and never its sentence, because the caller branches.
        entry.reject(new ConveyorError(ACP_CODES.ACP_REFUSED, 'The engine refused the request.'))
        return
      }
      entry.resolve((message as { result?: unknown }).result)
    }
  }

  /** Put a question to the consent bridge, and tell the agent what came back. */
  async function ask(request: AcpPermissionRequest, id: number): Promise<void> {
    try {
      const optionId = await deps.onPermissionRequest(request)
      write(acpPermissionAnswer(id, optionId))
    } catch {
      write(acpPermissionCancelled(id))
    }
  }

  function write(message: unknown): void {
    if (closed) return
    child.stdin.write(encodeAcpMessage(message))
  }

  /** Send one request and wait for its own response, addressed by id. */
  function call(method: string, params: unknown): Promise<unknown> {
    if (closed) {
      return Promise.reject(new ConveyorError(ACP_CODES.ACP_CLOSED, 'The engine process is no longer running.'))
    }
    const id = nextId
    nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      write(acpRequest(id, method, params))
    })
  }

  /**
   * The session a call must be addressed by.
   *
   * A closed client is refused first, and by its own code: once the process is gone, "the handshake has not
   * been completed" would be a true sentence about the wrong thing — the work cannot happen because the
   * client is closed, which is the state the caller has to branch on.
   */
  function requireSession(): string {
    if (closed) {
      throw new ConveyorError(ACP_CODES.ACP_CLOSED, 'The engine process is no longer running.')
    }
    if (!initialized || sessionId === null) {
      throw new ConveyorError(ACP_CODES.ACP_NOT_INITIALIZED, 'The engine session has not been opened.')
    }
    return sessionId
  }

  return {
    get sessionId() {
      return sessionId
    },

    async initialize(): Promise<AcpInitializeResult> {
      let result: unknown
      try {
        result = await call(ACP_METHODS.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
      } catch (error) {
        // A handshake the agent refused is a state of its own rather than a refused call: there is no session
        // to be had, and the code says so rather than the agent's own sentence about it.
        if (error instanceof ConveyorError && error.code === ACP_CODES.ACP_REFUSED) {
          throw new ConveyorError(ACP_CODES.ACP_HANDSHAKE_FAILED, 'The engine refused the handshake.')
        }
        throw error
      }

      const answer = (result ?? {}) as { protocolVersion?: unknown; agentInfo?: { name?: unknown } }
      const spoken = typeof answer.protocolVersion === 'number' ? answer.protocolVersion : ACP_PROTOCOL_VERSION
      initialized = true

      return {
        protocolVersion: spoken,
        agentName: typeof answer.agentInfo?.name === 'string' ? answer.agentInfo.name : null,
        refused: spoken !== ACP_PROTOCOL_VERSION,
      }
    },

    async newSession(): Promise<string> {
      if (closed) {
        throw new ConveyorError(ACP_CODES.ACP_CLOSED, 'The engine process is no longer running.')
      }
      if (!initialized) {
        throw new ConveyorError(ACP_CODES.ACP_NOT_INITIALIZED, 'The engine handshake has not been completed.')
      }
      const result = await call(ACP_METHODS.newSession, {
        cwd: deps.spawn.cwd ?? process.cwd(),
        // No servers are handed over this turn: what an engine may reach is the MCP rail's decision, and that
        // rail is not this phase's subject.
        mcpServers: [],
      })
      const answer = (result ?? {}) as { sessionId?: unknown }
      sessionId = typeof answer.sessionId === 'string' ? answer.sessionId : ''
      return sessionId
    },

    async prompt(text: string): Promise<AcpPromptResult> {
      const open = requireSession()
      const result = await call(ACP_METHODS.prompt, { sessionId: open, prompt: [{ type: 'text', text }] })
      const answer = (result ?? {}) as { stopReason?: unknown }
      return { stopReason: typeof answer.stopReason === 'string' ? answer.stopReason : '' }
    },

    close(): void {
      if (closed) return
      closed = true
      abandon(ACP_CODES.ACP_CLOSED, 'The engine process was closed.')
      child.kill()
    },
  }
}
