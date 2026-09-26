/**
 * The PTY foundation's rules, and the codes a PTY call is refused under.
 *
 * Pure and shared rather than main-only, the same way `protocol/recent-roots.ts` is: main owns the
 * process and does the spawning, but the *decisions* — which shell a platform prefers, and what a
 * bounded transcript looks like after one more line — are things a test must be able to make without
 * a PTY, a native binary, or a window. `conveyor/modules/terminal-pty.ts` asks these rules and acts
 * on the answers.
 *
 * Nothing here imports `node-pty`, `fs`, or `electron`. The one thing this layer cannot decide alone
 * is whether a shell actually exists, so that question arrives as an injected predicate rather than as
 * a `stat` — which is what keeps the rule a function of its arguments.
 *
 * The wire's two payloads live here for the same reason the session rules do. Main builds them, the
 * renderer reads them, and both need one declaration of what a pushed chunk is — which is not a line,
 * and not a frame: it is whatever the shell emitted, carried whole.
 */

import { sameRoot } from './recent-roots'

/**
 * A PTY that could not be spawned: no such shell, no permission, no pty device.
 *
 * What the user is told is the renderer's business, so it branches on this rather than on the text of
 * the underlying error, which is the OS's and differs per platform.
 */
export const TERMINAL_SPAWN_FAILED = 'TERMINAL_SPAWN_FAILED'

/**
 * A PTY call naming a root with no session — writing, resizing, killing or reading one that is not
 * open. Distinct from a spawn failure on purpose: nothing failed to start, the caller named a
 * terminal that does not exist.
 */
export const TERMINAL_NOT_FOUND = 'TERMINAL_NOT_FOUND'

/** How many lines a session retains when the caller does not say. */
export const DEFAULT_BUFFER_LINES = 1000

/** A shell to launch: the executable, and the arguments it takes. */
export interface ShellSpec {
  /** The executable to hand the pty. A bare name on Windows, an absolute path on Unix. */
  file: string
  /** Arguments. Empty for a plain interactive shell, which is what a terminal pane wants. */
  args: string[]
}

/** The part of the environment shell detection reads. */
export interface ShellEnv {
  /** Unix's `$SHELL`, when the platform set one. */
  SHELL?: string | undefined
}

/**
 * The shells to try for a platform, in preference order.
 *
 * Windows comes first with PowerShell, then the classic prompt: PowerShell is the one that ships on
 * every supported Windows and behaves like a shell rather than like `cmd`'s quirks, and `cmd.exe`
 * remains for a machine where it has been removed or is not on `PATH`.
 *
 * Unix starts from `$SHELL` because that is the shell the user actually lives in — its aliases, its
 * prompt, its startup file — and only then falls back. `bash` before `sh` because `sh` on a modern
 * Unix is usually `bash` or `dash` in disguise, and on the platforms where it is not, `bash` is still
 * the richer prompt; `sh` is last because it is the one shell POSIX guarantees to be present.
 */
function shellCandidates(platform: NodeJS.Platform, env: ShellEnv): ShellSpec[] {
  if (platform === 'win32') {
    return [
      { file: 'powershell.exe', args: [] },
      { file: 'cmd.exe', args: [] },
    ]
  }

  const preferred = env.SHELL?.trim()
  return [
    ...(preferred ? [{ file: preferred, args: [] }] : []),
    { file: '/bin/bash', args: [] },
    { file: '/bin/sh', args: [] },
  ]
}

/**
 * The shell this machine should be given, and the arguments to launch it with.
 *
 * The first candidate that `exists` accepts wins, so a missing `$SHELL` or a machine without
 * PowerShell lands on the next name rather than on a process that cannot start. `exists` is a
 * parameter rather than an import because existence is a fact about a disk, and this function is
 * about a preference.
 *
 * With nothing present at all, the last candidate is named — the POSIX shell, `cmd.exe` on Windows.
 * A guess, deliberately, and the conservative one: the spawn then fails for the real reason and
 * reports `TERMINAL_SPAWN_FAILED`, rather than this rule inventing a shell that was never there.
 */
export function detectShell(platform: NodeJS.Platform, env: ShellEnv, exists: (file: string) => boolean): ShellSpec {
  const candidates = shellCandidates(platform, env)
  return candidates.find((candidate) => exists(candidate.file)) ?? candidates[candidates.length - 1]
}

/**
 * Append a line to a buffer that keeps at most `max` of them.
 *
 * The oldest line goes when the cap is reached, which is what makes the retention a session's *last*
 * lines rather than its first — the ones a reader reconnecting to a long-running shell needs, and the
 * only ones that fit a bounded amount of memory.
 *
 * A cap of zero or less retains nothing, spelled out rather than left to the arithmetic: at zero,
 * `slice(-max)` is `slice(-0)`, which is `slice(0)` and would keep the entire buffer — a cap of zero
 * silently meaning "unbounded" is exactly the kind of wrong the caller would never see.
 */
export function appendLine(buffer: readonly string[], line: string, max: number): string[] {
  if (max <= 0) return []
  const next = [...buffer, line]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Output the shell produced, on its way to whichever windows are showing that root. */
export interface TerminalDataPayload {
  /** The root the shell belongs to, exactly as it was opened. */
  rootPath: string
  /**
   * The chunk, verbatim.
   *
   * Not a line, not trimmed, and not re-encoded: a pty chunk boundary falls wherever the shell's own
   * writes did, so it can hold half a line, several lines, a bare carriage return redrawing one, an
   * escape sequence mid-colour, or nothing at all. The renderer hands it to xterm unchanged, which is
   * the only property this field has to keep.
   */
  chunk: string
}

/** The shell ending — `exit`, a crash, or a kill. */
export interface TerminalExitPayload {
  rootPath: string
  exitCode: number
}

/** Build the output payload main pushes. Here rather than at the emit site so its shape has one home. */
export function terminalDataFor(rootPath: string, chunk: string): TerminalDataPayload {
  return { rootPath, chunk }
}

/** Build the exit payload main pushes. */
export function terminalExitFor(rootPath: string, exitCode: number): TerminalExitPayload {
  return { rootPath, exitCode }
}

/**
 * Whether a pushed payload belongs to the root a reader is showing.
 *
 * The comparison is `sameRoot`, so it is the same one the registry makes when it decides which shell a
 * root gets: a folder reached two ways — one window opening `C:\work`, another `c:\Work` — is one root,
 * and the payload keyed by one spelling must reach the terminal keyed by the other.
 *
 * Exact rather than a prefix, deliberately. `/work/notes` and `/work/notes/deeper` are two roots with
 * two shells, and a containment test would let one root's output into the other's terminal — the one
 * failure on this wire a renderer has no way to notice.
 */
export function isTerminalEventFor(payload: { rootPath: string }, rootPath: string): boolean {
  return sameRoot(payload.rootPath, rootPath)
}
