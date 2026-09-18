import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFileSync, realpathSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, stream } from '../init'
import { EXIT_MARKER, STDERR_MARKER } from '../protocol/terminal'

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
 * Spawn a command and yield its output as it arrives.
 *
 * Chunks are yielded as they come, with stderr carrying a prefix rather than a wrapper so a partial
 * line is still attributed to the right stream. The exit code is always the last chunk, including
 * after a kill — a cancelled run reports its code rather than stopping mid-line.
 *
 * `spawnImpl` is injected so this can be driven by a fake process without running a real shell.
 */
export async function* runCommand(options: {
  command: string
  cwd: string
  platform?: NodeJS.Platform
  signal: AbortSignal
  spawnImpl?: typeof spawn
}): AsyncGenerator<string, void, undefined> {
  const { command, cwd, signal } = options
  const platform = options.platform ?? process.platform
  const doSpawn = options.spawnImpl ?? spawn

  if (signal.aborted) return

  const child = doSpawn(command, {
    cwd,
    shell: shellFor(platform),
    windowsHide: true,
  } as never) as ChildProcessWithoutNullStreams

  // An abort has two jobs. The kill stops the process; the wake is what makes it prompt, because a
  // command that has been silent leaves the read loop parked on `await`, and a parked `await`
  // cannot be interrupted from outside — abandoning the iterator only takes effect once the
  // generator resumes. The escalation covers a child that ignores SIGTERM: without it the stream
  // would never see `close` and the caller would wait forever on a process that will not die.
  let escalate: ReturnType<typeof setTimeout> | null = null
  const onAbort = () => {
    if (!child.killed) child.kill('SIGTERM')
    wake?.()
    escalate = setTimeout(() => {
      if (exitCode === null) child.kill('SIGKILL')
    }, 2000)
    // Do not hold the event loop open just for the escalation timer.
    escalate.unref?.()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  // Both streams feed one queue, which preserves the interleaving a terminal is expected to show;
  // buffering them separately would reorder the output.
  const queue: string[] = []
  let wake: (() => void) | null = null
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
  let exitCode: number | null = null
  child.on('close', (code: number | null) => {
    exited = true
    exitCode = code
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

    yield `${EXIT_MARKER}${exitCode ?? -1}]`
  } finally {
    if (escalate) clearTimeout(escalate)
    signal.removeEventListener('abort', onAbort)
    // If the consumer abandons the generator, the process must not be left running.
    if (!child.killed && exitCode === null) child.kill('SIGTERM')
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
