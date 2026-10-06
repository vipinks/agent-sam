import { spawn } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { ConveyorError } from 'electron-conveyor/main'
import {
  ENGINE_INSTALL_PATTERNS,
  ENGINE_LAUNCH_ARGS,
  expandInstallDir,
  resolveEngineSpawn,
  type EngineId,
} from '../protocol/engine'
import { codexTurnEndCause, mapCodexChunk, type CodexTurnEndCause, type CodexUpdate } from '../protocol/codex-jsonl'
import { codexTranscriptChunks, type EngineTranscriptChunk } from '../protocol/codex-turn'

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
 * turn's ending is read from rather than a message on the wire. stdout is the only stream read: the JSONL
 * dialect is stdout's, and the CLI writes its own notes ("Reading additional input from stdin...") to stderr,
 * where parsing them as events would report a line the mapper cannot read on every run.
 */

/** A child process, as this client uses it: stdout, the two events, and the two halves of a kill. */
export interface CodexChild {
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown }
  on: {
    (event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
    (event: 'close', listener: (code: number | null) => void): unknown
  }
  kill: (signal?: string) => unknown
  /** True once a kill signal has been sent. Node's own spelling, read rather than assumed. */
  readonly killed?: boolean
  readonly exitCode?: number | null
}

/** How a process is started. Arguments as an array, and no member here through which a shell could be asked for. */
export type CodexSpawnImpl = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; cwd?: string }
) => CodexChild

/** How long a child is given to die politely before it is killed outright. */
const KILL_GRACE_MS = 2000

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

export interface CodexTurnInput {
  engineId: string
  prompt: string
  cwd: string
  /** Fires when the user cancels. The turn kills the child rather than leaving it running. */
  signal?: AbortSignal
}

export interface CodexTurnDeps {
  /** Left out in the app: the real `child_process.spawn`. Supplied by the suites that watch it. */
  spawnImpl?: CodexSpawnImpl
  /** An absolute path the allowlist sanctions, resolved by the caller that owns the environment. */
  binaryOverride?: string
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
 * child receives and not a command line a shell interprets. The listeners are installed before this function
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
  const args = [...(ENGINE_LAUNCH_ARGS[input.engineId as EngineId] ?? []), input.prompt]
  const resolution = resolveEngineSpawn({
    engineId: input.engineId,
    args,
    ...(deps.binaryOverride === undefined ? {} : { binaryOverride: deps.binaryOverride }),
  })

  if (!resolution.ok) {
    return Promise.reject(new ConveyorError(resolution.code, 'The engine could not be resolved to a binary.'))
  }

  const spawnImpl: CodexSpawnImpl = deps.spawnImpl ?? (spawn as unknown as CodexSpawnImpl)

  return new Promise<CodexTurnOutcome>((resolve) => {
    let threadId: string | null = null
    let buffer = ''
    let sawText = false
    let settled = false
    let timer: unknown

    const emit = (updates: readonly CodexUpdate[]): void => {
      for (const chunk of codexTranscriptChunks(updates, input.engineId)) {
        if (chunk.type === 'text_delta' && chunk.text.trim() !== '') sawText = true
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
      })
    } catch {
      finish({ exitCode: null, cancelled: false, cause: 'stream_error' })
      return
    }

    child.stdout.on('data', (chunk) => {
      const framed = mapCodexChunk(buffer, String(chunk), threadId)
      buffer = framed.rest
      threadId = framed.threadId
      emit(framed.updates)
    })

    child.on('error', () => {
      emit([{ type: 'turn_end', sessionId: threadId ?? '', cause: 'stream_error' }])
      finish({ exitCode: null, cancelled: false, cause: 'stream_error' })
    })

    child.on('close', (code) => {
      const cause = codexTurnEndCause(code, sawText)
      emit([{ type: 'turn_end', sessionId: threadId ?? '', cause }])
      finish({ exitCode: code, cancelled: false, cause })
    })

    if (input.signal === undefined) return
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  })
}
