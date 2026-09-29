/**
 * The MCP stdio runtime: the processes this app spawns, the tools they offer, and the logs they write.
 *
 * `conveyor/modules/mcp.ts` is the part that reads and writes the config; this is the part that acts on
 * it. One module holds all of it — the registry, the lifecycle, the budgets, and the stderr buffer —
 * because each of those is a fact about the same process: an entry in the registry *is* a spawned child
 * with a client attached, and a log line is what that child wrote. Splitting them would mean three
 * places that have to agree about when a server is running, which is the state a user's click depends
 * on.
 *
 * In memory only, by design. A process cannot outlive the main process that spawned it, so persisting
 * "this server is running" would restore a claim that is false the moment the app restarts.
 *
 * Four properties are worth stating plainly, because they are what the suites hold this module to:
 *
 * - Nothing spawns untrusted. A project-scope start goes through the trust gate before a transport
 *   exists, so a refusal leaves no process behind — and the gate reads the same rule the config layer's
 *   `assertMcpTrustMatched` reads (`mcpTrustRefusal` in `protocol/mcp.ts`), so the two cannot disagree
 *   about what `matched` means.
 * - Every start and every call has a deadline (`MCP_START_TIMEOUT_MS`, `MCP_CALL_TIMEOUT_MS`), and a
 *   deadline is reported as a *code* plus a reason in the error payload — never as a message a caller
 *   would have to read.
 * - A start that fails takes its process with it. There is no path out of `startServer` that leaves a
 *   child alive: the abort closes the client, then kills the pid if closing did not settle.
 * - A log line is redacted before it is stored, not when it is read. What is in the buffer is already
 *   safe, so no later read has to remember to be careful.
 */
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { ConveyorError } from 'electron-conveyor/main'
import {
  MCP_CALL_TIMEOUT_MS,
  mcpTrustRefusal,
  MCP_PROTOCOL_ERROR,
  MCP_SPAWN_FAILED,
  MCP_START_TIMEOUT,
  MCP_START_TIMEOUT_MS,
  MCP_STDERR_MAX_LINES,
  MCP_SERVER_NOT_RUNNING,
  MCP_TOOL_ERROR,
  redactSecrets,
  type McpErrorCode,
  type McpScope,
  type McpServerConfig,
  type McpTrustState,
} from '../protocol/mcp'

/** How this app identifies itself to a server during the initialize handshake. */
const CLIENT_INFO = { name: 'sam-ai', version: '1.1.0' } as const

/**
 * How long the abort path waits for a client to close on its own before it kills the process.
 *
 * The SDK's own close already escalates — close stdin, then SIGTERM, then SIGKILL on two-second
 * timers — so this is a bound on *our* wait rather than a replacement for it: past it the runtime
 * stops waiting and kills, which is what makes "a failed start leaves no process" a fact the caller can
 * rely on rather than a hope about how a child behaves on the way out.
 */
const ABORT_GRACE_MS = 1_500

/**
 * The gate a project start must pass, as the runtime applies it.
 *
 * This is the same judgment the config layer's `assertMcpTrustMatched` applies — literally the same
 * function, `mcpTrustRefusal` — read here as well because the runtime is the last place a process can
 * be created. A caller that reached `startServer` by another road still cannot spawn a server that was
 * not trusted, and the two sites cannot drift: there is one rule and two readers of it.
 *
 * Only `matched` passes. `absent` is not a lesser failure than `mismatched` — it means nobody ever
 * trusted this server — and both are the same fact to the process that was about to start: this is not
 * the thing that was trusted. An unstated state is treated as `absent`, which is what keeps the default
 * failing closed if a caller forgets to say.
 */
function assertStartAllowed(serverId: string, trust: McpTrustState | undefined): void {
  const refusal = mcpTrustRefusal(serverId, trust ?? 'absent')
  if (refusal) throw new ConveyorError(refusal.code, refusal.message, { reason: 'failed', serverId })
}

/**
 * Everything a spawn needs, and nothing else.
 *
 * Stated as its own shape because it is the seam: a suite can observe exactly what would have been
 * spawned — the command, its arguments, its directory, and the environment its secrets ended up in —
 * without a process appearing, which is how "no transport was constructed" becomes assertable.
 */
export interface McpSpawnSpec {
  serverId: string
  command: string
  args: string[]
  cwd: string | null
  /** The plain environment merged with the server's decrypted secrets: what the child is handed. */
  env: Record<string, string>
}

/**
 * One spawned server, as the runtime sees it: a client to talk to, the process behind it, and the
 * stderr stream it writes to.
 *
 * The factory builds the pair and reports the pid through a getter, because the pid does not exist
 * until the spawn happens — which is *during* `start`, not before it. A snapshot field would be null
 * for exactly the case that needs it most: a server that never finishes starting, and therefore has to
 * be killed by pid.
 */
export interface McpConnection {
  client: Client
  readonly pid: number | null
  readonly stderr: Readable | null
  /** Spawn the process and complete the initialize handshake. */
  start(): Promise<void>
  /** Close the client and take the process down with it. */
  close(): Promise<void>
}

/** Build one connection for one spawn spec. Injectable so the suites can watch, or refuse, a spawn. */
export type McpConnectionFactory = (spec: McpSpawnSpec) => McpConnection

/** What a caller asks the runtime to start: the config, its secrets in the clear, and its scope. */
export interface McpStartRequest {
  config: McpServerConfig
  /**
   * The decrypted secrets, by name.
   *
   * They arrive decrypted and stop here: `modules/mcp.ts` reads them out of the config file, and the
   * runtime uses them for exactly two things — handing them to the child as environment variables, and
   * redacting them out of that child's log lines. No other member of this module ever sees them.
   */
  plaintextSecrets: Record<string, string>
  scope: McpScope
  /** Only a project start carries one: trust does not govern the user scope. */
  trust?: McpTrustState
}

/** One discovered tool, tagged with the server that offers it. */
export interface McpRunningTool {
  serverId: string
  tool: Tool
}

/** The knobs a suite may turn. Defaults are the documented budgets, and production passes nothing. */
export interface McpRuntimeDeps {
  startTimeoutMs?: number
  callTimeoutMs?: number
  stderrMaxLines?: number
  createConnection?: McpConnectionFactory
}

export interface McpRuntime {
  readonly startTimeoutMs: number
  readonly callTimeoutMs: number
  readonly stderrMaxLines: number
  startServer(request: McpStartRequest): Promise<Tool[]>
  stopServer(serverId: string): Promise<void>
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
  readServerLogs(serverId: string): string[]
  /** Every tool every running server offers, each tagged with its server. */
  listRunningTools(): McpRunningTool[]
  /** The pid behind one running server, or null. The registry's own answer to "is it running". */
  pidOf(serverId: string): number | null
}

/** One running server: its connection, its tools, and its log buffer. */
interface McpRunningEntry {
  connection: McpConnection
  tools: Tool[]
  /** The plaintext secrets, kept only to redact lines that arrive after this entry was built. */
  secrets: string[]
  /** The redacted log so far, oldest first, never longer than the bound. */
  logs: string[]
  /** Bytes of a line that has not been terminated yet, so a split line is not stored twice. */
  remainder: string
}

/**
 * The node error codes a failed spawn arrives as, as opposed to one a handshake could raise.
 *
 * On POSIX the OS raises one of these for a command it cannot exec. On Windows it may not — see
 * `stdioMcpConnection`, which also asks whether the server ever spoke.
 */
const SPAWN_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM'])

/** Whether an error is the spawn itself failing rather than the server refusing to talk. */
function isSpawnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error)) return false
  return SPAWN_ERROR_CODES.has(String(error.code))
}

/** A one-line reason, for the person reading the log. Never a value a caller branches on. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The failure payload: where a distinction a caller may branch on is allowed to live. */
interface McpRunIssues {
  reason: 'timeout' | 'failed'
  timeoutMs?: number
  serverId?: string
  toolName?: string
  /** The server's own JSON-RPC code, when the failure was one the server reported. */
  code?: number
}

function runError(code: McpErrorCode, message: string, issues: McpRunIssues): ConveyorError {
  return new ConveyorError(code, message, issues)
}

/** Whether the SDK gave up on a request because it outlived the timeout it was handed. */
function isRequestTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout
}

/** The message a spawn failure carries. The node code is appended only when the OS gave one. */
function spawnFailure(serverId: string, command: string, code: string | null): ConveyorError {
  return new ConveyorError(
    MCP_SPAWN_FAILED,
    code === null
      ? `The server "${serverId}" could not be started: ${command} could not be run.`
      : `The server "${serverId}" could not be started: ${command} could not be run. (${code})`,
    { reason: 'failed', serverId }
  )
}

/**
 * The real transport: an SDK stdio client, with stderr piped rather than inherited.
 *
 * `stderr: 'pipe'` is the whole reason the log buffer can exist. The SDK's default is `inherit`, which
 * writes a server's diagnostics to this app's own stderr — invisible to the user, unattachable, and
 * unredactable. Piping it is what turns "the server printed a token" from an accident into a case the
 * runtime handles.
 *
 * Naming a failed handshake. The SDK reports *both* kinds of failure the same way — `McpError` with
 * `ConnectionClosed` — because the transport it gave up on is gone either way; a command that cannot be
 * run and a server that answered with a protocol version this client refuses are indistinguishable from
 * the outside. They are not the same to a person, so the two are told apart by the one fact that does
 * differ: whether the server ever *spoke*. A server that sent a message was a server; one that sent
 * nothing, and closed, could not be run. That count is taken here, where the transport is in hand, and
 * it is the reason this is not simply a code check on the node error — `cross-spawn` on Windows spawns a
 * nonexistent command successfully and lets the child exit, so the OS never raises one.
 */
export function stdioMcpConnection(spec: McpSpawnSpec): McpConnection {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd ?? undefined,
    env: spec.env,
    stderr: 'pipe',
  })
  const client = new Client(CLIENT_INFO)
  let spoke = false

  // Chained rather than replaced: `Client.connect` wraps whatever handler is already here, so this one
  // survives the connection being established.
  transport.onmessage = () => {
    spoke = true
  }

  return {
    client,
    get pid() {
      return transport.pid
    },
    get stderr() {
      return transport.stderr as Readable | null
    },
    async start() {
      try {
        await client.connect(transport)
      } catch (error) {
        // The OS refused the exec outright: `spawn` reported it, so the code is the reason and there is
        // nothing to weigh against it.
        if (isSpawnError(error)) {
          throw spawnFailure(spec.serverId, spec.command, String((error as { code?: unknown }).code))
        }
        // Otherwise the question is whether anything was ever said: nothing, and the command never came
        // up; something, and what it offered is what the client refused.
        if (!spoke) throw spawnFailure(spec.serverId, spec.command, null)
        throw error
      }
    },
    async close() {
      await client.close()
    },
  }
}

/** Resolve after `ms`. Only used to bound a wait the runtime refuses to make unbounded. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether the OS still has this pid. Signal 0 is a check, not a signal: nothing is sent.
 *
 * The runtime uses it to decide whether a process it has finished with still needs to be killed.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The runtime, and its registry.
 *
 * One instance per main process is all the app needs, but the factory is what the suites drive: a test
 * gets its own registry, its own budgets, and its own connection seam, so no case can be affected by
 * another's leftovers.
 */
export function createMcpRuntime(deps: McpRuntimeDeps = {}): McpRuntime {
  const startTimeoutMs = deps.startTimeoutMs ?? MCP_START_TIMEOUT_MS
  const callTimeoutMs = deps.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS
  const stderrMaxLines = deps.stderrMaxLines ?? MCP_STDERR_MAX_LINES
  const createConnection = deps.createConnection ?? stdioMcpConnection

  const registry = new Map<string, McpRunningEntry>()

  /**
   * Append one line to a server's log, redacted, evicting the oldest past the bound.
   *
   * Redaction happens here and nowhere else, which is what makes the buffer safe to read without
   * thinking about it: a line that was never stored in the clear cannot be read back in it.
   */
  function appendLog(entry: McpRunningEntry, line: string): void {
    entry.logs.push(redactSecrets(line, entry.secrets))
    while (entry.logs.length > stderrMaxLines) entry.logs.shift()
  }

  /** Read whatever stderr has arrived, storing whole lines and keeping a partial one for later. */
  function attachStderr(entry: McpRunningEntry, stream: Readable): void {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      entry.remainder += chunk
      let index = entry.remainder.indexOf('\n')
      while (index !== -1) {
        appendLog(entry, entry.remainder.slice(0, index).replace(/\r$/, ''))
        entry.remainder = entry.remainder.slice(index + 1)
        index = entry.remainder.indexOf('\n')
      }
    })
    // A stream error is not a reason to lose the server: the log stops, and the connection's own
    // error path reports anything that actually broke the conversation.
    stream.on('error', () => undefined)
  }

  /**
   * Close a connection and make sure its process is gone.
   *
   * The pid is read *before* closing, because a closed transport has let go of its process and reports
   * none — and a server that refused to exit is exactly the case where the pid is still needed. The
   * kill itself is liveness-checked: signalling a pid that has already been reaped is a no-op here, and
   * a blind signal to a pid the OS had meanwhile recycled would be a worse outcome than the wait.
   *
   * Closing is what the SDK escalates with — stdin, then SIGTERM, then SIGKILL on its own timers — and
   * this only bounds *our* wait on it, so a child that ignores a polite exit cannot hold up a stop.
   */
  async function abort(connection: McpConnection): Promise<void> {
    const pid = connection.pid
    const closed = connection.close().catch(() => undefined)
    await Promise.race([closed, delay(ABORT_GRACE_MS)])
    if (pid === null || !isProcessAlive(pid)) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone between the check and the signal: the state this wanted. Nothing to report.
    }
  }

  /**
   * Discover every tool a server offers, following the cursor to the end.
   *
   * A cursor that repeats is refused rather than followed: a server stuck in a pagination loop would
   * otherwise make the start hang forever, and a truncated list would make tools silently vanish from
   * the agent's view. Neither is acceptable, so a list this runtime cannot finish is a protocol error.
   */
  async function discoverTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = []
    const seen = new Set<string>()
    let cursor: string | undefined

    for (;;) {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)

      const next = page.nextCursor
      if (!next) return tools
      if (seen.has(next)) {
        throw new ConveyorError(
          MCP_PROTOCOL_ERROR,
          `This server asks for a tool page this client has already read ("${next}"), so its tool list cannot be finished.`,
          { reason: 'failed' }
        )
      }
      seen.add(next)
      cursor = next
    }
  }

  /** The error a start or a call ran out of budget produces. Always the same shape. */
  function timeoutError(
    code: McpErrorCode,
    message: string,
    timeoutMs: number,
    extra: Partial<McpRunIssues>
  ): ConveyorError {
    return runError(code, message, { reason: 'timeout', timeoutMs, ...extra })
  }

  async function startServer(request: McpStartRequest): Promise<Tool[]> {
    const { config, plaintextSecrets, scope } = request

    // Before anything is built: a project server that is not the one that was trusted must not have a
    // transport, let alone a process. The user scope is not gated by trust, by design.
    if (scope === 'project') assertStartAllowed(config.id, request.trust)

    // A start of an already-running server is a restart: the new config is the one that was just read
    // and validated, so the old entry — and its process — go first rather than accumulating behind it.
    if (registry.has(config.id)) await stopServer(config.id)

    const spec: McpSpawnSpec = {
      serverId: config.id,
      command: config.command,
      args: [...config.args],
      cwd: config.cwd,
      env: { ...config.env, ...plaintextSecrets },
    }

    const connection = createConnection(spec)
    const entry: McpRunningEntry = {
      connection,
      tools: [],
      secrets: Object.values(plaintextSecrets),
      logs: [],
      remainder: '',
    }

    // Attached before the spawn, so output a server writes while it is still handshaking is kept: the
    // lines that say why a server never came up are exactly the ones written before it does.
    if (connection.stderr) attachStderr(entry, connection.stderr)

    const attempt = (async () => {
      await connection.start()
      return discoverTools(connection.client)
    })()
    // The race below may abandon this promise; its rejection still has to be handled somewhere, or a
    // timed-out start would surface as an unhandled rejection after the caller was already told.
    attempt.catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            timeoutError(
              MCP_START_TIMEOUT,
              `The server "${config.id}" did not finish starting within ${startTimeoutMs}ms, so it was stopped.`,
              startTimeoutMs,
              { serverId: config.id }
            )
          ),
        startTimeoutMs
      )
    })

    try {
      const tools = await Promise.race([attempt, expired])
      entry.tools = tools
      registry.set(config.id, entry)
      return tools
    } catch (error) {
      // Whatever went wrong, the process this attempt created goes with the failure.
      await abort(connection)
      if (error instanceof ConveyorError) throw error
      throw runError(MCP_PROTOCOL_ERROR, `The server "${config.id}" could not be used: ${reasonOf(error)}`, {
        reason: 'failed',
        serverId: config.id,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function stopServer(serverId: string): Promise<void> {
    const entry = registry.get(serverId)
    if (!entry) {
      throw runError(MCP_SERVER_NOT_RUNNING, `The server "${serverId}" is not running.`, {
        reason: 'failed',
        serverId,
      })
    }
    // Deleted first: from this moment the server is not running, so a concurrent call finds no entry
    // rather than a half-closed one.
    registry.delete(serverId)
    await abort(entry.connection)
  }

  async function callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = registry.get(serverId)
    if (!entry) {
      throw runError(MCP_SERVER_NOT_RUNNING, `The server "${serverId}" is not running.`, {
        reason: 'failed',
        serverId,
      })
    }

    const attempt = entry.connection.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: callTimeoutMs,
    })
    attempt.catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            timeoutError(
              MCP_TOOL_ERROR,
              `The tool "${toolName}" on "${serverId}" did not answer within ${callTimeoutMs}ms.`,
              callTimeoutMs,
              { serverId, toolName }
            )
          ),
        callTimeoutMs
      )
    })

    try {
      return await Promise.race([attempt, expired])
    } catch (error) {
      if (error instanceof ConveyorError) throw error
      // The SDK's own timeout is the second deadline behind ours, and it is a *code* too; a server that
      // errors is a failure. Both are MCP_TOOL_ERROR, and which one it was lives in the payload.
      if (isRequestTimeout(error)) {
        throw timeoutError(MCP_TOOL_ERROR, `The tool "${toolName}" on "${serverId}" did not answer.`, callTimeoutMs, {
          serverId,
          toolName,
        })
      }
      const code = error instanceof McpError ? error.code : undefined
      throw runError(MCP_TOOL_ERROR, `The tool "${toolName}" failed: ${reasonOf(error)}`, {
        reason: 'failed',
        serverId,
        toolName,
        ...(code === undefined ? {} : { code }),
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    startTimeoutMs,
    callTimeoutMs,
    stderrMaxLines,
    startServer,
    stopServer,
    callTool,

    /**
     * The stderr a running server has written, oldest line first.
     *
     * Empty for a server that is not running — its logs belong to its process, and when the process goes
     * so does the buffer. A reader is therefore a view of a live server, not an archive of a dead one.
     */
    readServerLogs(serverId: string): string[] {
      return [...(registry.get(serverId)?.logs ?? [])]
    },

    listRunningTools(): McpRunningTool[] {
      const out: McpRunningTool[] = []
      for (const [serverId, entry] of registry) {
        for (const tool of entry.tools) out.push({ serverId, tool })
      }
      return out
    },

    pidOf(serverId: string): number | null {
      return registry.get(serverId)?.connection.pid ?? null
    },
  }
}

/**
 * The runtime the app itself runs on.
 *
 * Built on first use rather than at import, so that importing this module — which the config module
 * does, for the four commands — constructs no registry and starts nothing. One per main process is all
 * the app needs, and it is deliberately the same instance every call: "which servers are running" is one
 * fact about one process, and two registries would be two answers to it.
 */
let runtime: McpRuntime | null = null

export function getMcpRuntime(): McpRuntime {
  if (!runtime) runtime = createMcpRuntime()
  return runtime
}
