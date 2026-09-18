import { EXIT_PATTERN, STDERR_MARKER } from '@/conveyor/protocol/terminal'

/**
 * Turns the terminal module's chunk protocol into xterm writes.
 *
 * Kept apart from the component because it is the part with logic in it — the marker parsing and
 * the ANSI colouring — and because it is the part that can be tested without a DOM or a real
 * process. The component only calls `session.consume(chunk)` per streamed chunk.
 *
 * The protocol, as `terminal.ts` emits it:
 *   - stdout arrives verbatim;
 *   - stderr arrives prefixed with `[STDERR]`;
 *   - the last chunk is `[EXIT_CODE:n]`.
 */

/** xterm honouring these is how a chunk gets one colour for its whole length. */
const RED = '\u001b[31m'
const RESET = '\u001b[0m'

export interface TerminalSession {
  /** Feed one streamed chunk, writing whatever xterm should show. */
  consume: (chunk: string) => void
  /** True once the exit marker has been seen. */
  readonly ended: boolean
  /** The exit code, or null before the process ends. */
  readonly exitCode: number | null
}

/**
 * Build a session that writes through `write`. `onExit` fires once, when the process ends, so the
 * component can print its own closing line and re-enable its input.
 */
export function createTerminalSession(write: (text: string) => void, onExit?: (code: number) => void): TerminalSession {
  let ended = false
  let exitCode: number | null = null

  return {
    get ended() {
      return ended
    },
    get exitCode() {
      return exitCode
    },

    consume(chunk: string) {
      if (ended) return

      // The exit marker is the whole chunk by construction, so this is an equality check rather
      // than a search — which matters, because a command may legitimately print that text itself.
      const exit = EXIT_PATTERN.exec(chunk)
      if (exit) {
        ended = true
        exitCode = Number(exit[1])
        onExit?.(exitCode)
        return
      }

      if (chunk.startsWith(STDERR_MARKER)) {
        // The marker is a prefix, so strip exactly its length and keep any trailing newline intact —
        // trimming would swallow the line break and run the next chunk onto the same line.
        const body = chunk.slice(STDERR_MARKER.length)
        write(`${RED}${body}${RESET}`)
        return
      }

      write(chunk)
    },
  }
}

/** The line the panel prints when a process finishes, so the code is legible rather than raw. */
export function exitMessage(code: number): string {
  const tone = code === 0 ? '\u001b[32m' : RED
  return `\r\n${tone}Process exited with code ${code}${RESET}\r\n`
}
