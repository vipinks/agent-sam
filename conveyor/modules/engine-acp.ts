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
  acpRefusal,
  acpRefusalSentence,
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

/**
 * How long one ACP call may stay unanswered before the turn ends with a traced cause.
 *
 * Generous on purpose, and stated rather than derived from a hunch: the live two-sequence probe measured
 * `session/new` answering in 22 to 24 seconds against `opencode 1.4.7`, so a bound tight enough to feel
 * comfortable would fail a working engine. What it exists for is the other end of the range — the call that is
 * never answered at all, which used to leave the pane on Thinking with nothing in the terminal to read.
 */
export const ACP_CALL_BOUND_MS = 120_000

/**
 * How long the child is given to die politely before its tree is killed outright.
 *
 * The Codex child's own grace, stated here for this client: the same two seconds, for the same reason — a CLI
 * mid-turn is waiting on a model, and a kill that never escalates is an orphan holding a pipe.
 */
export const ACP_KILL_GRACE_MS = 2000

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
  /**
   * The budget one call is given.
   *
   * Left out in the app, where `ACP_CALL_BOUND_MS` is the product's answer; a suite states a small one so a call
   * that is never answered fails an assertion inside its own bound rather than waiting the product's out.
   */
  callBoundMs?: number
  /** The grace before the child's tree is killed outright. Left out in the app. */
  killGraceMs?: number
  /**
   * How the child's whole tree is ended, by the pid it was started with.
   *
   * Left out in the app, where the platform's own tool is used; supplied by a suite that would rather observe the
   * pid than kill something real.
   */
  killTree?: (pid: number | undefined) => void
  /** Left out in the app: the real `setTimeout`. Supplied by the suites that watch the escalation. */
  setTimer?: (listener: () => void, ms: number) => AcpTimer
  /** Left out in the app: the real `clearTimeout`. */
  clearTimer?: (timer: AcpTimer) => void
}

/** A timer handle, as this client uses it: the escalation only ever unrefs one, and a call only ever clears one. */
export interface AcpTimer {
  unref?: () => void
}

/** The client's child, as the kill needs it: the pid, the signal, and whether it has already ended. */
export interface AcpKillable {
  readonly pid?: number
  /** Node's own signals, so the process this client spawned satisfies it as it stands. */
  kill: (signal?: NodeJS.Signals) => unknown
  readonly exitCode?: number | null
}

/**
 * End a child's whole tree, by the pid it was started with, using the platform's own tool.
 *
 * Named and exported rather than inlined into `killAcpTree`, so a suite can observe the request *and* let it
 * happen: what has to be provable is that the tree — not merely the process in hand — is what a turn's ending
 * asks for, and a spy that replaced the behaviour entirely would prove only that a callback was called.
 *
 * Windows is the platform with a tool for this, and the one the leak was measured on. Elsewhere the escalation
 * below is the whole answer: there is no portable way to name a child's descendants, and this app's own process
 * group is the one the child shares, so nothing here may signal a group.
 */
export function killTreeByPlatform(pid: number | undefined): void {
  if (process.platform !== 'win32' || pid === undefined) return
  const tree = spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    // Never a shell, and never a line of words for one to read.
    shell: false,
    windowsHide: true,
  })
  // A killer that could not start is not this turn's problem: the escalation below still runs.
  tree.on('error', () => undefined)
  tree.unref?.()
}

/**
 * End the child and everything it started.
 *
 * The direct child of an ACP engine is not necessarily the process that holds the engine's state, and that is
 * measured rather than supposed: `opencode` on `PATH` here is a shim that starts `tools\opencode.exe acp`, the
 * real one binds the CLI's own fixed `127.0.0.1:4096`, and after `child.kill()` had been sent to the shim a live
 * probe still listed the shim, the real binary and the CLI's own `serve` helper running. What a shim leaves behind
 * is an engine still holding its port, and a child still holding it is what the next turn then waits on — the
 * second and third prompts of a session, hanging with no error to read. So the tree is what a turn's ending asks
 * for, not merely the process in hand.
 *
 * The tree is ended first, while the process it hangs off is still there to enumerate — a killed parent leaves its
 * child behind, and a child whose parent is gone cannot be found through it afterwards. Then the escalation the
 * Codex child is ended by: a signal now, and `SIGKILL` once the grace is up, with the timer unref'd because a
 * child being ended must never be the reason the app stays alive.
 *
 * What this does *not* reach, measured rather than guessed: a descendant that deliberately detached itself. The
 * suite's fixture starts its own child with `detached: true` and the platform's tree kill does not find it, so a
 * vendor CLI that leaks one is beyond any kill this client could send. That case is why the bound below
 * (`ACP_CALL_BOUND_MS`) is the floor rather than a nicety: a turn whose engine was left holding a port ends with
 * a cause in words, and never on Thinking.
 */
export function killAcpTree(
  child: AcpKillable,
  deps: Pick<AcpClientDeps, 'killGraceMs' | 'killTree' | 'setTimer'> = {}
): void {
  const killTree = deps.killTree ?? killTreeByPlatform
  killTree(child.pid)

  child.kill('SIGTERM')

  const setTimer = deps.setTimer ?? ((listener: () => void, ms: number) => setTimeout(listener, ms))
  const escalation = setTimer(() => {
    if (child.exitCode !== null && child.exitCode !== undefined) return
    child.kill('SIGKILL')
  }, deps.killGraceMs ?? ACP_KILL_GRACE_MS)
  escalation.unref?.()
}

export interface AcpClient {
  /** The agent's session id, held here so a prompt is addressed without the caller carrying it. */
  readonly sessionId: string | null
  initialize(): Promise<AcpInitializeResult>
  newSession(): Promise<string>
  prompt(text: string): Promise<AcpPromptResult>
  close(): void
}

/** One call the client is waiting on, and the three ways it can end: an answer, a refusal, or its own budget. */
interface Waiting {
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  /** Disarms the call's budget, so no timer outlives the call it was armed for. */
  disarm: () => void
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

  const callBoundMs = deps.callBoundMs ?? ACP_CALL_BOUND_MS
  const setTimer =
    deps.setTimer ?? ((listener: () => void, ms: number) => setTimeout(listener, ms) as unknown as AcpTimer)
  const clearTimer =
    deps.clearTimer ?? ((timer: AcpTimer) => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>))

  /** Refuse everything still in flight, by code, so no caller is left on a promise nothing will answer. */
  const abandon = (code: string, message: string): void => {
    const outstanding = [...waiting.values()]
    waiting.clear()
    for (const entry of outstanding) {
      entry.disarm()
      entry.reject(new ConveyorError(code, message))
    }
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
        // The agent's own refusal, kept as the agent stated it. The code and the sentence it chose are the
        // whole of what a refusal is for — a session it does not know, a login it does not have — so both are
        // carried: in the wrapper's `issues`, where a caller can assert them, and in the sentence, so the
        // cause reaches a user who reads no logs. The caller still branches on our code and never on this.
        const refused = acpRefusal(failure)
        entry.reject(
          new ConveyorError(
            ACP_CODES.ACP_REFUSED,
            acpRefusalSentence(refused, 'The engine refused the request:'),
            refused
          )
        )
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

  /**
   * Send one request and wait for its own response, addressed by id — or for its budget to run out.
   *
   * The budget is the whole of the legibility here: a peer that neither answers nor closes leaves the entry in
   * `waiting` for the life of the process, and a caller with no timer waits on it forever — which is what the
   * second prompt of a session did, with no chunk, no error and no `[engine]` line to read. It is armed per call
   * rather than over the turn, so an engine that is slow but working is not punished for the call before it, and
   * it is disarmed the moment the call is answered, refused, or abandoned.
   */
  function call(method: string, params: unknown): Promise<unknown> {
    if (closed) {
      return Promise.reject(new ConveyorError(ACP_CODES.ACP_CLOSED, 'The engine process is no longer running.'))
    }
    const id = nextId
    nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const budget = setTimer(() => {
        const entry = waiting.get(id)
        if (entry === undefined) return
        waiting.delete(id)
        // The sentence names the call and the budget, because that is the whole of what a user can act on: an
        // engine that answers its handshake and then goes quiet is usually one nobody has signed in to.
        entry.reject(
          new ConveyorError(
            ACP_CODES.ACP_CALL_TIMEOUT,
            `The engine did not answer ${method} within ${Math.round(callBoundMs / 1000)} seconds. Check that the engine is signed in, then try again.`
          )
        )
      }, callBoundMs)
      const disarm = (): void => clearTimer(budget)
      waiting.set(id, {
        resolve: (result) => {
          disarm()
          resolve(result)
        },
        reject: (error) => {
          disarm()
          reject(error)
        },
        disarm,
      })
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
        // to be had, and the code says so rather than the agent's own sentence about it. What is kept is the
        // cause — the agent's words and its code — because a handshake refused for a missing login and one
        // refused for a wrong protocol version are two different things to tell a user.
        if (error instanceof ConveyorError && error.code === ACP_CODES.ACP_REFUSED) {
          throw new ConveyorError(ACP_CODES.ACP_HANDSHAKE_FAILED, error.message, error.issues)
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
      // The whole tree, not merely the process in hand: what a shim leaves behind is the engine holding its own
      // port, and a child still holding it is what the next turn waits on forever.
      killAcpTree(child, {
        ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
        ...(deps.killTree === undefined ? {} : { killTree: deps.killTree }),
        ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      })
    },
  }
}
