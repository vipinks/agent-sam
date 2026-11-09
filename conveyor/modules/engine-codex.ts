import { spawn } from 'child_process'
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { delimiter, dirname, isAbsolute, join } from 'path'
import { app } from 'electron'
import { ConveyorError } from 'electron-conveyor/main'
import {
  ENGINE_INSTALL_PATTERNS,
  ENGINE_SPAWN_CODES,
  engineLaunchArgs,
  expandInstallDir,
  resolveEngineSpawn,
  type EngineId,
} from '../protocol/engine'
import { codexTurnEndCause, mapCodexChunk, type CodexTurnEndCause, type CodexUpdate } from '../protocol/codex-jsonl'
import { codexTranscriptChunks, type EngineTranscriptChunk } from '../protocol/codex-turn'
import { isResumable } from '../protocol/turn-end'

/**
 * The Codex engine, as a process: the binary the install pattern finds, the turn that runs it, and the cancel
 * that ends it.
 *
 * Main-only. The dialect lives in `conveyor/protocol/codex-jsonl.ts` and the words a chunk is drawn with in
 * `conveyor/protocol/codex-turn.ts`, both pure; this file is what needs a pipe. That split is the ACP client's,
 * for the same reason: everything that can be decided without starting anything is decided where a suite can
 * state it without starting anything.
 *
 * The turn is one child and one prompt. `codex exec` is a non-interactive surface: the prompt is an argument,
 * the events are JSONL on stdout, and the process ends when the answer does — which is why the exit is what the
 * turn's ending is read from rather than a message on the wire. stdout is the only stream parsed: the JSONL
 * dialect is stdout's, and the CLI writes its own notes ("Reading additional input from stdin...") to stderr,
 * where parsing them as events would report a line the mapper cannot read on every run. stderr is still read,
 * into a bounded tail, because when the child dies that tail is the only evidence left of why — it is never
 * parsed as a turn event, and it is carried only by a failure chunk.
 *
 * stdin is not a stream this client holds open, and that is load-bearing rather than tidy. `codex exec` appends
 * a *piped* stdin to the prompt it was given and waits for that pipe to end before it prints anything, so a
 * child spawned with the default pipe is a turn that never starts: measured against `codex-cli 0.160.1` with
 * this file's own argument array, stdin a pipe answered nothing in 45 seconds with the process alive at 0
 * percent CPU, while the same binary with stdin closed streamed `thread.started` to `turn.completed` and exited
 * 0 in 12.4 seconds. A turn that never answers never ends and never reaps its child, which is how four live
 * `codex.exe` accumulate behind two panes stuck on Thinking. `CODEX_STDIO` below is that rule, stated once.
 */

/** A child process, as this client uses it: stdout, the two events, and the two halves of a kill. */
export interface CodexChild {
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown }
  /** Present on a real child; absent on a fake that has nothing to say. Read only for the failure tail. */
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown }
  on: {
    (event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
    (event: 'close', listener: (code: number | null) => void): unknown
  }
  kill: (signal?: string) => unknown
  /** True once a kill signal has been sent. Node's own spelling, read rather than assumed. */
  readonly killed?: boolean
  readonly exitCode?: number | null
}

/**
 * The three streams a turn's child is given.
 *
 * stdin is closed rather than piped: the prompt travels as an argument, and `codex exec` waits for a *piped*
 * stdin to end before it speaks — see the note in this file's header for the measurement. stdout carries the
 * JSONL dialect and stays piped. stderr is piped rather than inherited so the CLI's own notes are not written
 * into the app's console as if the app had said them.
 */
export const CODEX_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

/** How a process is started. Arguments as an array, and no member here through which a shell could be asked for. */
export type CodexSpawnImpl = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; cwd?: string; stdio: ['ignore', 'pipe', 'pipe'] }
) => CodexChild

/** How long a child is given to die politely before it is killed outright. */
const KILL_GRACE_MS = 2000

/**
 * How much of stderr a failed turn carries: the last five lines, capped at 500 bytes.
 *
 * Both bounds are stated because either alone is the wrong shape. A line bound keeps a log-shaped tail
 * readable and cannot grow with a single enormous line; a byte bound keeps that one line from becoming the
 * whole transcript. The smaller of the two wins, which is why they are applied together rather than as a
 * choice. The tail is evidence, not the turn: it travels on a failure chunk and in the engine log, and it
 * is never parsed.
 */
export const CODEX_STDERR_TAIL_LINES = 5
export const CODEX_STDERR_TAIL_BYTES = 500

/** The engine's own failure log, beside the updater's: `userData/logs/engine-codex.log`. */
const CODEX_FAILURE_LOG_DIR = 'logs'
export const CODEX_FAILURE_LOG_FILE = 'engine-codex.log'

/** What a failed turn carries before it becomes a chunk: the code it ended on and what stderr said. */
export interface CodexFailure {
  exitCode: number | null
  code?: string
  tail: string
}

/**
 * Keep the last five lines, capped at 500 bytes.
 *
 * Applied to the whole accumulated tail on every read rather than to each chunk, because a chunk boundary
 * is not a line boundary: a cap applied per chunk would keep five fragments of five lines rather than five
 * lines. The byte cut can split a multi-byte character; the replacement that results is still evidence,
 * and a decoder dependency would be more machinery than a diagnostic tail is worth.
 */
function boundedStderrTail(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const bounded =
    bytes.length > CODEX_STDERR_TAIL_BYTES ? bytes.subarray(bytes.length - CODEX_STDERR_TAIL_BYTES) : bytes
  const lines = bounded
    .toString('utf8')
    .replace(/[\r\n]+$/, '')
    .split(/\r?\n/)
  return lines.slice(-CODEX_STDERR_TAIL_LINES).join('\n')
}

/**
 * The code word for a spawn that was refused.
 *
 * A `ConveyorError` is the law's own refusal and its code is the branch. A native spawn error is the OS's,
 * and its `code` (`ENOENT`, `EACCES`) is the only stable thing it says — the message is a sentence that
 * changes by platform and must never be branched on. A value with neither is the generic spawn failure.
 */
function spawnFailureCode(error: unknown): string {
  if (error instanceof ConveyorError) return error.code
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : ENGINE_SPAWN_CODES.ENGINE_SPAWN_FAILED
}

/**
 * Append one line per failed Codex turn to the engine log.
 *
 * The precedent is the updater's logger: a packaged Windows app has nowhere to show a console line, and a
 * failed turn is exactly what a user cannot reproduce on request. One line, bounded by the tail's own
 * bound and collapsed to a single line so the log stays a log; a write that fails is swallowed, because a
 * diagnostic that could not be written is not a reason for the turn to fail again.
 */
export function appendCodexFailureLog(failure: CodexFailure): void {
  try {
    const file = join(app.getPath('userData'), CODEX_FAILURE_LOG_DIR, CODEX_FAILURE_LOG_FILE)
    mkdirSync(dirname(file), { recursive: true })
    const status = failure.exitCode === null ? `code=${failure.code ?? 'unknown'}` : `exit=${failure.exitCode}`
    const tail = failure.tail.replace(/\s+/g, ' ').trim().slice(0, CODEX_STDERR_TAIL_BYTES)
    appendFileSync(file, `${new Date().toISOString()} ${status} tail=${tail}\n`)
  } catch {
    // A diagnostic that could not be written is not a reason for the turn to fail again.
  }
}

export interface CodexKillDeps {
  graceMs?: number
  /** Left out in the app: the real `setTimeout`. Supplied by the suites that watch the escalation. */
  setTimer?: (listener: () => void, ms: number) => unknown
}

/**
 * End a child, politely and then not.
 *
 * The spawn layer's escalation, and the reason a cancel exists at all: a CLI mid-turn is waiting on a model, and
 * a signal it ignores would leave an orphan holding a pipe — so a SIGTERM is followed by a SIGKILL once the
 * child has had its moment. A child that has already exited is not signalled and no timer is armed: a signal to
 * a process that is gone is a message to nobody, and on a platform that reuses pids it is worse than that.
 *
 * The timer handle is answered so the caller can disarm it when the child's own close arrives first.
 */
export function killCodexChild(child: CodexChild, deps: CodexKillDeps = {}): unknown {
  if (child.exitCode !== null && child.exitCode !== undefined) return undefined
  if (child.killed === true) return undefined

  child.kill('SIGTERM')

  const setTimer = deps.setTimer ?? ((listener: () => void, ms: number) => setTimeout(listener, ms))
  return setTimer(() => {
    if (child.exitCode !== null && child.exitCode !== undefined) return
    child.kill('SIGKILL')
  }, deps.graceMs ?? KILL_GRACE_MS)
}

/**
 * Every absolute path the install pattern says an engine's binary could be at.
 *
 * A wildcard segment is a directory to read, so the count of candidates is the count of directories the install
 * keeps — which is what makes this a read rather than a guess. Reading a directory that is not there answers
 * nothing rather than throwing: an engine that is not installed is the ordinary case, and the picker's own row
 * is what says so.
 */
export function engineInstallCandidates(
  engineId: string,
  env: Readonly<Record<string, string | undefined>>,
  readdir: (dir: string) => string[]
): string[] {
  const patterns = ENGINE_INSTALL_PATTERNS[engineId as EngineId] ?? []
  const extension = process.platform === 'win32' ? '.exe' : ''
  const candidates: string[] = []

  for (const pattern of patterns) {
    const dir = expandInstallDir(pattern.dir, env)
    if (dir === null) continue

    const file = `${pattern.binary}${extension}`
    const [head = '', tail = ''] = dir.split('*')
    const suffix = tail === '' ? '' : tail.replace(/\/$/, '')

    if (tail === '' && !dir.includes('*')) {
      candidates.push(`${dir.replace(/\/$/, '')}/${file}`)
      continue
    }

    const parent = head.replace(/\/$/, '')
    let entries: string[]
    try {
      entries = readdir(parent)
    } catch {
      continue
    }
    for (const entry of [...entries].sort()) candidates.push(`${parent}/${entry}${suffix}/${file}`)
  }

  return candidates
}

/** Where an engine is installed, if it is: the first candidate the pattern produces that is really there. */
export function installedBinaryFor(
  engineId: string,
  deps: {
    env?: Readonly<Record<string, string | undefined>>
    readdir?: (dir: string) => string[]
    exists?: (path: string) => boolean
  } = {}
): string | undefined {
  const env = deps.env ?? process.env
  const readdir = deps.readdir ?? ((dir: string) => readdirSync(dir))
  // A file rather than a directory, and not a broken link: the spawn is what would discover the difference, and
  // it would discover it as a failed turn rather than as a row that says "not installed".
  const exists = deps.exists ?? ((path: string) => isFile(path))

  return engineInstallCandidates(engineId, env, readdir).find((candidate) => exists(candidate))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The Codex binary a turn starts: the saved path, then the install pattern, then the probe's own fallback.
 *
 * The stored path is asked first because it is the user's answer about this machine, but only after `isFile`
 * says something is really there. That guard is load-bearing: a stale saved path must fall through to the
 * pattern and then to the no-spawn notice, rather than reproducing the ENOENT the saved value would cause.
 *
 * The fallback is the one at `engine.ts:142-149` made explicit: when neither the saved path nor the pattern
 * answers, the probe hands `resolveEngineSpawn` no override, so the law names the allowlisted `codex` and the
 * OS would search `PATH` at spawn time. This side performs that same PATH lookup itself and returns the
 * absolute `.exe` it finds. It never returns a bare name, and on Windows it never returns an extensionless
 * shim or a `.cmd`: neither can be started under the no-shell law. A machine with only those files therefore
 * has no Codex binary this app can run, which is a state the turn reports by code rather than by ENOENT.
 */
export function resolveCodexTurnBinary(
  savedPath: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  if (savedPath !== null && isAbsolute(savedPath) && isFile(savedPath)) return savedPath

  const installed = installedBinaryFor('codex', { env })
  if (installed !== undefined && isAbsolute(installed)) return installed

  const fallback = resolveEngineSpawn({ engineId: 'codex', args: [] })
  if (!fallback.ok) return undefined
  if (isAbsolute(fallback.command)) return isFile(fallback.command) ? fallback.command : undefined
  if (fallback.command.includes('/') || fallback.command.includes('\\')) return undefined

  const executable = process.platform === 'win32' ? `${fallback.command.replace(/\.exe$/i, '')}.exe` : fallback.command
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''

  for (const entry of pathValue.split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || !isAbsolute(dir)) continue

    const candidate = join(dir, executable)
    if (isAbsolute(candidate) && isFile(candidate)) return candidate
  }

  return undefined
}

export interface CodexTurnInput {
  engineId: string
  prompt: string
  cwd: string
  /**
   * The mode this turn runs under, from the engine's stored preference.
   *
   * Read by the caller — main, which owns the store — and carried as the raw value rather than narrowed
   * here: `engineLaunchArgs` is the boundary that decides what a mode is, so a value no rule offers falls
   * back to the default inside the one function that builds the flags, and this file never has to know.
   */
  permissionMode?: unknown
  /**
   * The model a caller named for this turn. Carried here, and not read: this runner names no model to the CLI.
   *
   * The field belongs to the one turn-input shape every engine's turn crosses the boundary as, so it arrives with
   * the rest of the turn — and it becomes no argument, because Codex resolves its own model from its own
   * configuration, which is the whole of what a turn runs under this runner. `tests/engines/engine-codex-test.ts`
   * states the absence over every state this field can be in.
   */
  model?: string
  /** Fires when the user cancels. The turn kills the child rather than leaving it running. */
  signal?: AbortSignal
}

export interface CodexTurnDeps {
  /** Left out in the app: the real `child_process.spawn`. Supplied by the suites that watch it. */
  spawnImpl?: CodexSpawnImpl
  /**
   * The absolute path the caller resolved, or `null`/absent when the resolver found nothing this app may start.
   * Both absences are normalized to `undefined` at the runner seam, so this is never a nullable string.
   *
   * The explicit absence is the missing binary: it must become a coded notice, never a bare-name spawn, so the
   * runner never falls back to the OS search that would reach an extensionless shim or a `.cmd`.
   */
  binaryOverride?: string | null
  graceMs?: number
  setTimer?: (listener: () => void, ms: number) => unknown
}

export interface CodexTurnOutcome {
  exitCode: number | null
  /** True when the user stopped the turn, which is not an ending the app has anything to say about. */
  cancelled: boolean
  cause: CodexTurnEndCause
}

/**
 * Run one turn, and stream its chunks as they arrive.
 *
 * The prompt is the last argument — an array, so a prompt containing spaces, quotes or a `;` is a string the
 * child receives and not a command line a shell interprets. Nothing else is appended to the shipped launch
 * config, whatever the turn's input carries: the model a Codex turn runs is the one its own configuration
 * resolves, so there is no flag this side could state it with. The listeners are installed before this function
 * returns, so a child that answers immediately cannot answer into nothing.
 *
 * A cancel kills the child and ends the turn silently: the user stopped it, and a notice saying the stream
 * ended early would be reporting their own click back to them. A child that ends on its own is read through
 * `codexTurnEndCause`, which is the one place an exit becomes an ending this app words.
 */
export function runCodexTurn(
  input: CodexTurnInput,
  deps: CodexTurnDeps,
  onChunk: (chunk: EngineTranscriptChunk) => void
): Promise<CodexTurnOutcome> {
  // The sandbox value is the chosen mode's, and the mode is the only part of the array that a preference can
  // reach: the dialect verbs come from the protocol's table, so a setting cannot add a flag.
  const args = [...engineLaunchArgs(input.engineId as EngineId, input.permissionMode)]
  // The prompt, and nothing between the launch config and the prompt: the model this turn runs is Codex's own to
  // resolve, so no flag is built here from `input.model` — see that field's note above.
  args.push(input.prompt)

  // The caller's resolver answers `null` (or nothing for Codex) when there is no file this app may start.
  // Both absences are normalized here, at the seam: the spawn law's override is a string or nothing, and a
  // nullable value must not reach a request whose field is `string | undefined`. Every later decision is a
  // test of this one value, so the spawn path can only ever be handed a string.
  const binaryOverride = deps.binaryOverride ?? undefined

  const spawnImpl: CodexSpawnImpl = deps.spawnImpl ?? (spawn as unknown as CodexSpawnImpl)

  return new Promise<CodexTurnOutcome>((resolve) => {
    let threadId: string | null = null
    let buffer = ''
    let sawText = false
    let sawCompletion = false
    let stderrTail = ''
    let spawnError: NodeJS.ErrnoException | null = null
    let childExitCode: number | null = null
    let settled = false
    /**
     * The ending this turn has already put on the wire, when there is one.
     *
     * A `turn.failed` update reaches `emit` as a bare `turn_end`: the mapper forwards the ending the child
     * declared (codex-jsonl.ts:244-248), and the process closes a moment later. Remembering that cause is what
     * tells the exit path below that the turn is already ended, so a close cannot add a second ending to a turn
     * that named its own — the close only supplies the exit code. The cause is kept rather than a boolean
     * because it is also the outcome the exit still has to report.
     */
    let settledCause: CodexTurnEndCause | null = null
    let timer: unknown

    const emit = (updates: readonly CodexUpdate[]): void => {
      for (const chunk of codexTranscriptChunks(updates, input.engineId)) {
        if (chunk.type === 'text_delta' && chunk.text.trim() !== '') sawText = true
        // `turn.completed` is the only update that carries usage, so the usage chunk is also the turn's
        // completion marker. A failure seen after it is a failure after the answer, not an answer lost.
        if (chunk.type === 'usage') sawCompletion = true
        // A notice or an ending is the turn saying how it stopped; from that moment the exit is only a
        // confirmation, never a second ending.
        if (chunk.type === 'turn_end' || chunk.type === 'turn_end_notice') settledCause = chunk.cause
        onChunk(chunk)
      }
    }

    const finish = (outcome: CodexTurnOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer as ReturnType<typeof setTimeout>)
      input.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    /**
     * Report one failed turn: a visible chunk, one log line, and an ending.
     *
     * This is the replacement for the three paths that used to call `finish` alone. A chunk is written
     * before the ending so the pane has the cause when the stream's finally block runs; the log line is
     * written even in a packaged app where stderr has nowhere to go.
     */
    const emitFailure = (failure: CodexFailure): void => {
      if (settled) return
      onChunk({ type: 'turn_end_notice', cause: 'stream_error', resumable: true, failure })
      appendCodexFailureLog(failure)
      emit([{ type: 'turn_end', sessionId: threadId ?? '', cause: 'stream_error' }])
      finish({ exitCode: failure.exitCode, cancelled: false, cause: 'stream_error' })
    }

    // D3: a resolver that answered nothing is the missing binary, and it is stated here — before the law is
    // asked and before a child exists. `resolveEngineSpawn` is deliberately not consulted for an absence: it
    // would name the allowlisted bare binary, which is the PATH search this turn must never fall back to.
    // The named code is what lets a shims-only machine draw a card instead of a raw ENOENT.
    if (binaryOverride === undefined) {
      const code =
        input.engineId === 'codex' ? ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED : ENGINE_SPAWN_CODES.ENGINE_UNKNOWN
      emitFailure({ exitCode: null, code, tail: '' })
      return
    }

    const resolution = resolveEngineSpawn({ engineId: input.engineId, args, binaryOverride })
    if (!resolution.ok) {
      // A refusal is still an ending the user has to see. It never reaches a child, so there is no exit code
      // and no stderr: the code word itself is the evidence, and it stays a code (never a message) because
      // that is the only part of a refusal that is stable enough to branch on in the pane.
      const failure: CodexFailure = { exitCode: null, code: resolution.code, tail: '' }
      onChunk({ type: 'turn_end_notice', cause: 'stream_error', resumable: true, failure })
      appendCodexFailureLog(failure)
      finish({ exitCode: null, cancelled: false, cause: 'stream_error' })
      return
    }

    function onAbort(): void {
      timer = killCodexChild(child, {
        ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
        ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      })
      // No `turn_end` chunk: the ending is the user's own, and the vocabulary's four causes all describe a turn
      // that stopped without being asked to.
      finish({ exitCode: null, cancelled: true, cause: codexTurnEndCause(null, sawText) })
    }

    let child: CodexChild
    try {
      child = spawnImpl(resolution.command, resolution.args, {
        shell: false,
        windowsHide: true,
        cwd: input.cwd,
        // Stated on every turn rather than left to the default, because the default is the defect: an open
        // stdin is a `codex exec` waiting for a pipe that will never end.
        stdio: CODEX_STDIO,
      })
    } catch (error) {
      emitFailure({ exitCode: null, code: spawnFailureCode(error), tail: '' })
      return
    }

    // stderr is evidence, not input: it is accumulated only so a failure can carry the last thing the child
    // said, and it is read through the same bounded tail on every chunk so a chatty child cannot grow it.
    child.stderr?.on('data', (chunk) => {
      stderrTail = boundedStderrTail(`${stderrTail}${String(chunk)}`)
    })

    child.stdout.on('data', (chunk) => {
      const framed = mapCodexChunk(buffer, String(chunk), threadId)
      buffer = framed.rest
      threadId = framed.threadId
      emit(framed.updates)
    })

    child.on('error', (error) => {
      spawnError = error
      emitFailure({ exitCode: null, code: spawnFailureCode(error), tail: stderrTail })
    })

    child.on('close', (code) => {
      if (settled) return
      childExitCode = code
      // A non-zero exit before the completion marker is the case this chunk exists for. The child may have
      // said something on stderr, or nothing at all; either way the code and the tail travel together.
      if (!sawCompletion && code !== 0) {
        const codeWord = spawnError === null ? undefined : spawnFailureCode(spawnError)
        emitFailure({
          exitCode: childExitCode,
          ...(codeWord === undefined ? {} : { code: codeWord }),
          tail: stderrTail,
        })
        return
      }
      // The turn may already have named its ending — a `turn.failed` update, forwarded by the mapper as a
      // bare `turn_end`. That ending is the turn's: the close confirms it and supplies the exit code, and a
      // second ending invented here would show the user an ending the turn never had.
      if (settledCause !== null) {
        finish({ exitCode: childExitCode, cancelled: false, cause: settledCause })
        return
      }
      const cause = codexTurnEndCause(code, sawText)
      // Main says an ending out loud before it ends the turn (agent.ts:1155-1164), and the engine path owes
      // the pane the same sentence. A bare `turn_end` is read by nobody on this path, so without the notice a
      // child that exited 0 without an answer would end on silence — or, with tools behind it, on the
      // mid-work card. The ordinary ending stays silent, exactly as it does on main.
      if (cause !== 'model_stop') {
        onChunk({ type: 'turn_end_notice', cause, resumable: isResumable(cause) })
      }
      emit([{ type: 'turn_end', sessionId: threadId ?? '', cause }])
      finish({ exitCode: childExitCode, cancelled: false, cause })
    })

    if (input.signal === undefined) return
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  })
}
