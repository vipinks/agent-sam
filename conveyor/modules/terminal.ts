import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFileSync, realpathSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, stream } from '../init'
import { EXIT_MARKER, STDERR_MARKER } from '../protocol/terminal'
import { notifyWorkspaceChanged } from '../events'

/**
 * Local command execution — the only place in the app that spawns a process.
 *
 * Commands are deliberately unrestricted for now; a permission model is a later phase. What is
 * enforced here is *where* a command runs: the working directory is validated against the open
 * workspace, so this cannot be pointed at the rest of the disk.
 */

/** The shell for the platform, as the phase brief specifies. */
export function shellFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'powershell.exe' : '/bin/bash'
}

/**
 * Resolve a working directory and refuse to leave the workspace.
 *
 * Symlinks are resolved before the comparison, so a link *inside* the workspace pointing outside it
 * cannot be used as a side door. Comparing against `root + sep` also rejects a sibling whose name
 * merely starts with the root's (`/workspace-2` when the root is `/workspace`).
 */
export function resolveCwd(requested: string, workspaceRoot: string | null): string {
  const candidate = requested.trim()
  if (!candidate) {
    throw new ConveyorError('CWD_REQUIRED', 'Open a folder before running commands — there is no working directory.')
  }

  let resolved: string
  try {
    resolved = realpathSync(resolve(candidate))
  } catch {
    throw new ConveyorError('CWD_NOT_FOUND', `The working directory does not exist: ${candidate}`)
  }

  if (!statSync(resolved).isDirectory()) {
    throw new ConveyorError('CWD_NOT_FOUND', `Not a directory: ${candidate}`)
  }

  if (workspaceRoot) {
    let root: string
    try {
      root = realpathSync(workspaceRoot)
    } catch {
      // The workspace is gone, so containment cannot be checked. Allowing the run would be worse
      // than refusing it.
      throw new ConveyorError(
        'CWD_OUTSIDE_WORKSPACE',
        'The open folder no longer exists, so commands cannot be run inside it.'
      )
    }
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new ConveyorError(
        'CWD_OUTSIDE_WORKSPACE',
        `That directory is outside the open folder (${root}). Run commands from inside the workspace.`
      )
    }
  }

  return resolved
}

/**
 * The workspace root, read from the persisted store file.
 *
 * Modules cannot import the router, and this is a plain JSON file main already owns, so reading it
 * is simpler than threading a handle through. A missing file means no folder is open.
 */
export function workspaceRootFromStoreFile(userDataDir: string): string | null {
  try {
    const raw = readFileSync(resolve(userDataDir, 'conveyor-stores', 'workspace.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { rootPath?: unknown }).rootPath === 'string') {
      return (parsed as { rootPath: string }).rootPath
    }
    return null
  } catch {
    return null
  }
}

/**
 * How long a run waits for `close` after it has asked the process to stop.
 *
 * SIGTERM is a request, not a fact, and `close` is not the same thing as a process ending: a child can
 * ignore the signal, and a grandchild that inherited the pipes can hold them open after its parent is
 * gone, in which case `close` never arrives at all. Two seconds is the backstop that makes every ending
 * unconditional — the SIGKILL escalation for a child that ignored the signal, and, for a deadline, the
 * coded failure itself. A constant rather than an option, because the number is part of the contract
 * and a suite that waited on a shorter one would be proving a different guarantee than the one shipped.
 */
export const WEDGE_GUARD_MS = 2000

/**
 * End a child's whole tree, by the pid it was started with, with the platform's own tool.
 *
 * Windows is the platform with a tool for this, and the one the leak was measured on: the direct child
 * is a shell, so killing it can leave the command it started alive — still holding the pipes, still
 * running, with nothing left to stop it. `taskkill /T /F` names the tree rather than the process.
 * Elsewhere this does nothing: there is no portable way to name a child's descendants, and the direct
 * child shares this process's group, so a signal is the whole answer there.
 *
 * Exported rather than inlined, so a suite can observe the request without killing something real;
 * the pid is the fact that has to be provable.
 */
export function killTreeByPlatform(
  pid: number | undefined,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn = spawn
): void {
  if (platform !== 'win32' || pid === undefined) return
  const tree = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    // Never a shell, and never a line of words for one to read.
    shell: false,
    windowsHide: true,
  })
  // A killer that could not start is not this run's problem: the wedge guard still settles it.
  tree.on('error', () => undefined)
  tree.unref?.()
}

/**
 * Spawn a command and yield its output as it arrives.
 *
 * Chunks are yielded as they come, with stderr carrying a prefix rather than a wrapper so a partial
 * line is still attributed to the right stream. The exit code is always the last chunk, including
 * after a kill — a cancelled run reports its code rather than stopping mid-line.
 *
 * A stop is about the tree, not the process: on win32 the platform's own `taskkill /T /F` names the
 * shell and everything it started, and elsewhere the direct child takes SIGTERM and then SIGKILL. A
 * deadline is a failure rather than a cancellation, so it is thrown as `COMMAND_TIMED_OUT`; the wedge
 * guard is what makes that throw unconditional, because the child — or a grandchild holding the pipes
 * — may never report its ending.
 *
 * `spawnImpl` and `killTreeImpl` are injected so this can be driven by a fake process, and a fake
 * killer, without touching a real shell.
 */
export async function* runCommand(options: {
  command: string
  cwd: string
  platform?: NodeJS.Platform
  signal: AbortSignal
  /** A wall-clock ceiling for this run. Omitted for the user's own terminal, which is unbounded. */
  timeoutMs?: number
  spawnImpl?: typeof spawn
  /**
   * How the spawned tree is ended on win32. Left out in the app, where the platform's own tool is
   * used; supplied by a suite that would rather observe the pid than kill something real.
   */
  killTreeImpl?: (pid: number | undefined) => void
}): AsyncGenerator<string, void, undefined> {
  const { command, cwd, signal } = options
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs
  const doSpawn = options.spawnImpl ?? spawn
  const killTree = options.killTreeImpl ?? ((pid: number | undefined) => killTreeByPlatform(pid, platform))

  if (signal.aborted) return

  const child = doSpawn(command, {
    cwd,
    shell: shellFor(platform),
    windowsHide: true,
  } as never) as ChildProcessWithoutNullStreams

  // Cancellation and the deadline share the same jobs. The stop ends the process tree; the wake is what
  // makes the read loop prompt, because a command that has been silent leaves the loop parked on
  // `await`, and a parked `await` cannot be interrupted from outside. The wedge guard is the third: it
  // covers a child that ignores the signal, or a descendant that holds the inherited pipes open after
  // its parent is gone, and settles the run whether or not `close` ever arrives.
  let wedge: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let wake: (() => void) | null = null
  let exitCode: number | null = null
  let timedOut = false
  /** Set by the wedge guard when `close` did not arrive: the run's ending is this process's to state. */
  let settled = false
  /** The failure the wedge guard settles with, built there so a pipe-holding child cannot defeat it. */
  let wedgeError: ConveyorError | null = null

  const timeoutFailure = () =>
    new ConveyorError(
      'COMMAND_TIMED_OUT',
      `The command was stopped after ${Math.ceil((timeoutMs ?? 0) / 1000)} seconds because it exceeded the run_command time limit.`
    )

  const stopChild = () => {
    // Windows: the direct child is a shell, so killing it can leave the command it started running and
    // holding the pipes. The tree is what a stop is about. POSIX keeps the direct child — it shares this
    // process's group, and there is no portable way to name its descendants.
    if (platform === 'win32') {
      killTree(child.pid)
    } else if (!child.killed) {
      child.kill('SIGTERM')
    }
    wake?.()
    // Armed once per run, however many endings ask for it: the deadline and an abort share one stop.
    if (wedge) return
    wedge = setTimeout(() => {
      wedge = null
      if (exitCode !== null) return
      // The process has not ended after SIGTERM. Escalate once — on win32 `taskkill /F` already did —
      // and settle the run: a deadline becomes its coded failure without waiting on a `close` that may
      // never come, and an abort ends here rather than hanging the caller.
      if (platform !== 'win32') child.kill('SIGKILL')
      settled = true
      if (timedOut) wedgeError = timeoutFailure()
      wake?.()
    }, WEDGE_GUARD_MS)
    // Do not hold the event loop open just for the wedge.
    wedge.unref?.()
  }

  const onAbort = () => stopChild()
  signal.addEventListener('abort', onAbort, { once: true })

  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    deadline = setTimeout(() => {
      deadline = null
      timedOut = true
      stopChild()
    }, timeoutMs)
    deadline.unref?.()
  }

  // Both streams feed one queue, which preserves the interleaving a terminal is expected to show;
  // buffering them separately would reorder the output.
  const queue: string[] = []
  const push = (chunk: string) => {
    queue.push(chunk)
    wake?.()
  }

  child.stdout?.on('data', (data: Buffer) => push(data.toString()))
  child.stderr?.on('data', (data: Buffer) => push(`${STDERR_MARKER}${data.toString()}`))

  // A spawn failure — no such shell, not permitted — arrives as an event, not a throw.
  let spawnError: Error | null = null
  child.on('error', (err: Error) => {
    spawnError = err
    wake?.()
  })

  let exited = false
  child.on('close', (code: number | null) => {
    exited = true
    exitCode = code
    // A process that closed before its deadline has no timeout left to fire. If the deadline already
    // fired, `timedOut` stays true and the caller still reads the run as the timeout it was.
    if (deadline) {
      clearTimeout(deadline)
      deadline = null
    }
    // And a close that did arrive is the ending the wedge exists to stand in for, so it retires the
    // guard. Disarmed here rather than left to fire: a settled run announces once, and a second, late
    // ending is exactly what the "announces once" cases are about.
    if (wedge) {
      clearTimeout(wedge)
      wedge = null
    }
    wake?.()
  })

  try {
    for (;;) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (spawnError) throw new ConveyorError('SPAWN_FAILED', (spawnError as Error).message)
      if (exited) break
      // The wedge guard's ending: `close` never came, so nothing else will wake this loop.
      if (settled) {
        if (wedgeError) throw wedgeError
        break
      }
      await new Promise<void>((res) => {
        wake = res
      })
      wake = null
    }

    // Output produced between the last read and the close event still belongs to the caller.
    let pending = queue.shift()
    while (pending !== undefined) {
      yield pending
      pending = queue.shift()
    }

    if (spawnError) throw new ConveyorError('SPAWN_FAILED', (spawnError as Error).message)

    // The ordinary deadline path: the process did close, and the run is still read as the timeout it
    // was. The wedge guard's path threw above, before this point, so both end as the same code.
    if (timedOut) throw timeoutFailure()

    yield `${EXIT_MARKER}${exitCode ?? -1}]`
  } finally {
    if (wedge) clearTimeout(wedge)
    if (deadline) clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
    // If the consumer abandons the generator, the process must not be left running.
    if (!child.killed && exitCode === null) child.kill('SIGTERM')

    // Announced in `finally`, so it fires exactly once per run whatever ended it — a clean exit, a
    // non-zero one, an abort, or a spawn failure that threw. A command can create files as easily as
    // a write can, and guarding on the in-band exit marker would miss the abort and failure paths,
    // which are precisely the ones that leave a half-finished command's output on disk.
    notifyWorkspaceChanged({ kind: 'command-exited' })
  }
}

export const terminalModule = defineModule({
  /** The platform shell, so the UI can say what will run the command. */
  shell: query(() => shellFor(process.platform)),

  /**
   * Run one command in the workspace and stream its output. `cwd` is optional: a missing value falls
   * back to the workspace root, and a missing root is a clear failure rather than a surprise.
   */
  execute: stream(
    z.object({
      command: z.string().min(1, 'A command is required'),
      cwd: z.string().optional(),
      /** The open folder, so containment can be checked without reading another module's state. */
      workspaceRoot: z.string().nullable().optional(),
    }),
    async function* ({ input, signal }) {
      const workspaceRoot = input.workspaceRoot ?? null
      const resolved = resolveCwd(input.cwd ?? workspaceRoot ?? '', workspaceRoot)
      yield* runCommand({ command: input.command, cwd: resolved, signal })
    }
  ),
})
