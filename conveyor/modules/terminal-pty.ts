import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { command, defineModule, query } from '../init'
import { sameRoot } from '../protocol/recent-roots'
import {
  appendLine,
  DEFAULT_BUFFER_LINES,
  detectShell,
  TERMINAL_NOT_FOUND,
  TERMINAL_SPAWN_FAILED,
  type ShellEnv,
  type ShellSpec,
} from '../protocol/terminal-pty'

/**
 * The live shells — one persistent terminal per workspace root, owned by main.
 *
 * Why main owns them at all: a terminal is a process, and a process outlives any pane that draws it.
 * The renderer used to hold the whole thing close: `execute` streamed a command's output into a pane,
 * and closing the pane abandoned the run. A *session* is the other half of that — a shell that keeps
 * running, keeps its scrollback, and keeps the long-lived state (a dev server, a `cd`, an exported
 * variable) across panes, panels and window reloads. That cannot live in the renderer, so what lives
 * here is the process and its retained transcript, and the renderer is a view onto it.
 *
 * Keyed by root rather than by window: the shell is *the* terminal for that folder, so two windows
 * looking at one workspace reconnect to the same shell instead of starting a second one, and a second
 * `create` for a root that is already open answers with the session that exists.
 *
 * Nothing here is a UI. There is no renderer import, no xterm.js, and no stream: this turn lands the
 * foundation — spawn, write, resize, kill, read, list — and the pane that consumes it is a later one.
 */

/** The PTY calls this module makes, structurally. Injected, so no test loads a native binary. */
export interface PtyProcess {
  /** The outer process id, as `node-pty` reports it. */
  readonly pid: number
  /** Send input: keystrokes, a pasted line, a control sequence. */
  write(data: string): void
  /** Tell the pty how large the view is, so the shell and its full-screen programs lay out for it. */
  resize(cols: number, rows: number): void
  /** End the shell. */
  kill(signal?: string): void
  /** Output as it arrives. */
  onData(listener: (data: string) => void): { dispose(): void }
  /** The shell ending — an `exit`, a crash, a kill. */
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
}

/** What a fresh pty is created with. */
export interface PtySpawnOptions {
  /** The folder the shell starts in. */
  cwd: string
  cols: number
  rows: number
}

/** Launches a shell. `node-pty`'s `spawn` in the app; a fake in every test. */
export type PtySpawner = (
  file: string,
  args: readonly string[],
  options: PtySpawnOptions
) => PtyProcess | Promise<PtyProcess>

/** Everything the registry reads from outside itself. All of it injected, none of it imported. */
export interface TerminalDeps {
  spawnPty: PtySpawner
  /** Whether a candidate shell is present. Answers `detectShell`'s one question about the disk. */
  shellExists: (file: string) => boolean
  platform: NodeJS.Platform
  env: ShellEnv
  /** Lines retained per session. Defaults to `DEFAULT_BUFFER_LINES`. */
  bufferLines?: number
  /** The size a session starts at, before a pane measures itself and resizes it. */
  initialSize?: { cols: number; rows: number }
}

/** What a caller gets back about one session: enough to draw it, and the transcript to catch up on. */
export interface TerminalSnapshot {
  /** The root the session belongs to, exactly as it was opened. */
  rootPath: string
  pid: number
  /** The folder the shell is running in. */
  cwd: string
  /** The retained transcript, oldest line first. */
  lines: string[]
}

/** A session with no transcript: what `list` reports, so a listing does not ship every buffer. */
export interface TerminalListing {
  rootPath: string
  pid: number
  cwd: string
}

/** One live shell, as this module tracks it. */
interface Session {
  pty: PtyProcess
  rootPath: string
  cwd: string
  /** The last `bufferLines` complete lines, oldest first. */
  buffer: string[]
  /**
   * Output that has arrived without a newline yet.
   *
   * Held separately rather than pushed as a line because a pty chunk is not a line: the shell writes
   * `C:\work>` and then stops, and a reader reconnecting has to see that prompt. Appending it as it
   * arrived would leave half a prompt as its own line once the rest of it followed, so the tail waits
   * here until a newline completes it.
   */
  pending: string
}

/** The terminal family, as the rest of main uses it. */
export interface TerminalRegistry {
  /**
   * Open the root's shell, or describe the one that is already open.
   *
   * Idempotent per root on purpose: a pane that mounts a second time wants the session it left, not a
   * second shell in the same folder — two shells would fight over the same files and the first one's
   * transcript would be lost to a pane that could no longer reach it.
   */
  create(rootPath: string): Promise<TerminalSnapshot>
  write(rootPath: string, data: string): void
  resize(rootPath: string, cols: number, rows: number): void
  /** End the root's shell and forget it. */
  kill(rootPath: string): void
  /** The retained transcript, for a pane coming back to a shell that kept running. */
  read(rootPath: string): TerminalSnapshot
  list(): TerminalListing[]
  /** End every shell. For the process exit handler, where nothing can be reported to a user. */
  killAll(): void
  /** End the root's shell only if one is running. Called when a root leaves the recents list. */
  killIfActive(rootPath: string): void
}

/** The default PTY size: the classic 80x24, replaced by the pane's first fit. */
const INITIAL_SIZE = { cols: 80, rows: 24 }

/**
 * The key a root's session is stored under.
 *
 * Lower-cased to match `sameRoot` in `protocol/recent-roots.ts`, which is how the rest of the app
 * compares two roots: main resolves a path before it is stored, so case is the only spelling
 * difference left, and one folder reached two ways must not end up with two shells.
 */
function keyFor(rootPath: string): string {
  return rootPath.toLowerCase()
}

/**
 * The registry itself.
 *
 * A factory rather than a module-level singleton so the session bookkeeping can be driven by a fake
 * PTY — there is no way to assert that `resize` reached the pty, or that a second `create` did not
 * spawn, against a real shell. The app's own instance is built at the bottom of this file.
 */
export function createTerminalRegistry(deps: TerminalDeps): TerminalRegistry {
  const sessions = new Map<string, Session>()
  const bufferLines = deps.bufferLines ?? DEFAULT_BUFFER_LINES
  const size = deps.initialSize ?? INITIAL_SIZE
  // Resolved once: the platform and its shells do not change while the app runs, and probing for each
  // `create` would re-`stat` the same paths for an answer that cannot have moved.
  const shell: ShellSpec = detectShell(deps.platform, deps.env, deps.shellExists)

  const snapshot = (session: Session): TerminalSnapshot => ({
    rootPath: session.rootPath,
    pid: session.pty.pid,
    cwd: session.cwd,
    // The unterminated tail is part of what a reconnecting reader must see, so it is reported as the
    // last line. It is not in the buffer, because it is not a line yet.
    lines: session.pending === '' ? [...session.buffer] : [...session.buffer, session.pending],
  })

  const notFound = (rootPath: string): ConveyorError =>
    new ConveyorError(TERMINAL_NOT_FOUND, `No terminal is open for ${rootPath}.`)

  /** The session for a root, or the typed refusal. */
  const sessionFor = (rootPath: string): Session => {
    const session = sessions.get(keyFor(rootPath))
    if (!session) throw notFound(rootPath)
    return session
  }

  /** End a session and take it out of the map. The one place a kill is performed. */
  const end = (key: string, session: Session): void => {
    // Removed before the kill, so the exit handler that the kill provokes cannot race the removal —
    // and so a `create` arriving mid-kill starts a new shell rather than finding a dying one.
    sessions.delete(key)
    session.pty.kill()
  }

  return {
    async create(rootPath) {
      const key = keyFor(rootPath)
      const existing = sessions.get(key)
      if (existing) return snapshot(existing)

      let pty: PtyProcess
      try {
        pty = await deps.spawnPty(shell.file, shell.args, { cwd: rootPath, cols: size.cols, rows: size.rows })
      } catch (err) {
        // Branch on the code, never the message: the OS's wording for a failed spawn differs per
        // platform and per cause, and the renderer words this itself.
        throw new ConveyorError(TERMINAL_SPAWN_FAILED, err instanceof Error ? err.message : String(err))
      }

      const session: Session = { pty, rootPath, cwd: rootPath, buffer: [], pending: '' }
      sessions.set(key, session)

      pty.onData((chunk) => {
        // Split on the line breaks and keep the remainder: the shell's next chunk usually continues it.
        const parts = `${session.pending}${chunk}`.split(/\r?\n/)
        session.pending = parts.pop() ?? ''
        for (const line of parts) session.buffer = appendLine(session.buffer, line, bufferLines)
      })

      // A shell the user exits with `exit`, or one that crashes, must not be left recorded: a stale
      // entry would make the next `create` for that root answer with a pid that is already dead.
      pty.onExit(() => {
        if (sessions.get(key) === session) sessions.delete(key)
      })

      return snapshot(session)
    },

    write(rootPath, data) {
      sessionFor(rootPath).pty.write(data)
    },

    resize(rootPath, cols, rows) {
      sessionFor(rootPath).pty.resize(cols, rows)
    },

    kill(rootPath) {
      const key = keyFor(rootPath)
      end(key, sessionFor(rootPath))
    },

    read(rootPath) {
      return snapshot(sessionFor(rootPath))
    },

    list() {
      return [...sessions.values()].map((session) => ({
        rootPath: session.rootPath,
        pid: session.pty.pid,
        cwd: session.cwd,
      }))
    },

    killAll() {
      for (const [key, session] of [...sessions]) {
        try {
          end(key, session)
        } catch {
          // An exit handler runs last, when there is nothing left to report to: one shell that
          // refuses to die must not take the other shells' cleanup with it.
        }
      }
    },

    killIfActive(rootPath) {
      const key = keyFor(rootPath)
      const session = sessions.get(key)
      if (session) end(key, session)
    },
  }
}

/**
 * Whether a shell candidate is present.
 *
 * Two questions in one, because the candidates are two kinds of name. A path — every Unix candidate —
 * is asked of the filesystem directly. A bare name — the Windows ones — is what the OS loader
 * resolves through `PATH`, so the honest probe is the same lookup: a machine whose `PATH` cannot find
 * `powershell.exe` cannot launch it either.
 */
function shellExistsOnDisk(file: string): boolean {
  if (file.includes('/') || file.includes('\\')) return existsSync(file)
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, file)))
}

/**
 * The app's own registry: the real spawner, the real platform, the real disk.
 *
 * `node-pty` is imported here, at the point of a spawn, rather than at the top of the file. It is a
 * native module whose binary is built or prebuilt per platform, and importing it is the one operation
 * that can fail for a reason that has nothing to do with this code — on a machine with no build, a
 * plain `import` would take down every module the router loads. Loading it where it is used means the
 * failure surfaces as `TERMINAL_SPAWN_FAILED` on the terminal the user tried to open, and it is why
 * the suite can exercise this file without a native binary at all.
 */
export const ptySessions = createTerminalRegistry({
  spawnPty: async (file, args, options) => {
    const pty = await import('node-pty')
    return pty.spawn(file, [...args], options)
  },
  shellExists: shellExistsOnDisk,
  platform: process.platform,
  env: { SHELL: process.env.SHELL },
})

/**
 * Every shell dies with the app.
 *
 * A PTY is a child process, and a child outlives the parent that forgot it: without this, quitting
 * the app leaves the shells it opened running with nothing attached to them — invisible, still
 * holding the working directory, and still listening on any port a dev server was started on.
 *
 * Registered on `process` rather than on Electron's `app:will-quit` because the shells belong to the
 * process, not to the app object, and because `exit` is the one that fires even when the quit came
 * from outside: a signalled process, or a window-all-closed shutdown on another platform.
 */
process.on('exit', () => {
  ptySessions.killAll()
})

/**
 * Kill the shell of a root that has been forgotten.
 *
 * When a folder leaves the recents list the user is saying they are done with it, and a shell left
 * running in it is a process they no longer have any way to reach — the entry that would have shown
 * it is gone. The list is read through a function and changes arrive through a subscription because
 * the workspace store lives in the router, which is imported *by* this module: reaching for it here
 * would close the cycle, so main installs this instead, the way `router.ts` installs the other sinks.
 *
 * Only a root that actually left is killed. A store notification is not a removal — the list is also
 * written on every open, and on the cap dropping its oldest entry — so the previous list is kept and
 * the difference is taken, rather than ending a shell for a folder the user still has open.
 */
export function killOnRootRemoval(
  registry: TerminalRegistry,
  readRoots: () => readonly string[],
  subscribe: (listener: (roots: readonly string[]) => void) => () => void
): () => void {
  let previous = [...readRoots()]
  return subscribe((next) => {
    for (const root of previous) {
      if (!next.some((candidate) => sameRoot(candidate, root))) registry.killIfActive(root)
    }
    previous = [...next]
  })
}

export const terminalPtyModule = defineModule({
  /**
   * Open the root's terminal, or hand back the one it already has.
   *
   * A command rather than a query because it can start a process, and the first call for a root is a
   * real side effect that must not be repeated by a re-render.
   */
  create: command(z.object({ rootPath: z.string().min(1) }), async ({ input }) => ptySessions.create(input.rootPath)),

  /** Send input to the shell. The echo comes back through the pty, not from here. */
  write: command(z.object({ rootPath: z.string().min(1), data: z.string().min(1) }), ({ input }) => {
    ptySessions.write(input.rootPath, input.data)
  }),

  /** Tell the shell how large its view is, so it and its full-screen programs lay out for it. */
  resize: command(
    z.object({
      rootPath: z.string().min(1),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    ({ input }) => {
      ptySessions.resize(input.rootPath, input.cols, input.rows)
    }
  ),

  /** End the shell and forget it — the user closing the terminal, or the folder going away. */
  kill: command(z.object({ rootPath: z.string().min(1) }), ({ input }) => {
    ptySessions.kill(input.rootPath)
  }),

  /** The retained transcript, so a pane that comes back is filled in rather than blank. */
  read: query(z.object({ rootPath: z.string().min(1) }), ({ input }) => ptySessions.read(input.rootPath)),

  /** Every live shell. Roots and pids only: a list must not ship every session's buffer. */
  list: query(() => ptySessions.list()),
})
