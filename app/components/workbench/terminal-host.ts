import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ConveyorError } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { createTerminalSession, exitMessage } from './terminal-session'

/**
 * The terminal's session, kept above the pane that shows it.
 *
 * The transcript and the run in flight belong to the shell, not to the box the shell is drawn in. Phase
 * 5 put both inside the panel, which was true while the panel was a view the user left open; Phase 39
 * makes it a resident of the right rail, so the pane is now put away and brought back by a click, and a
 * pane that owns the terminal would rebuild it every time — the same shell, a new empty scrollback, and
 * a second `execute` for a command that was already running. This module is the lift: the xterm
 * instance, the element it drew into, the iterator for a run in flight, and the command history outlive
 * every mount and unmount of the pane. What the pane does is move the element in and out of itself.
 *
 * The backend was never the pane's to kill, and this does not move it: `execute` spawns in the main
 * process and streams back, and the renderer's side of that is only this iterator. What the old panel
 * did destroy on unmount was the *renderer's* half — `term.dispose()` took the scrollback with it, and
 * the abandoned loop went on writing into a disposed terminal. Both are what this module holds now, so a
 * run that is in flight when the pane closes carries on being consumed, and reopening the pane shows the
 * output that arrived while it was away.
 *
 * The element is created detached rather than inside the pane, and opened exactly once: xterm's `open`
 * binds a terminal to one container for its life, so the container is the host's and the pane lends it a
 * parent. That is also why a ResizeObserver lives here — what it watches is the element, which changes
 * size when the pane is re-parented into a differently sized slot.
 *
 * The host is a module-level singleton, and deliberately not React state: it has to outlive the tree. A
 * relaunch is a fresh module graph, so a new window starts with an empty transcript, which is what "the
 * session lasts as long as the window does" means.
 *
 * The element is the host's, and it is attached to a pane before `open` rather than created inside one:
 * xterm measures what it is handed, so it wants an element in a document, and it binds a terminal to one
 * container for its life. What the pane lends is a parent, which is why a reopen is a re-parent rather
 * than a rebuild.
 */

/** The colours xterm uses, following the app's tokens rather than the library defaults. */
const THEME = {
  background: '#08090a',
  foreground: '#f2f3f3',
  cursor: '#ff5c3a',
  selectionBackground: 'rgba(255, 92, 58, 0.25)',
}

/** What the pane re-renders for: whether a command is in flight, and the commands run this session. */
export interface TerminalStatus {
  running: boolean
  history: readonly string[]
}

/** The session the pane draws from. Every method is safe to call while no pane is on screen. */
export interface TerminalHost {
  /** Move the retained terminal into a pane, creating it the first time it is asked for. */
  attach(parent: HTMLElement): void
  /** Take it out of the document without ending anything. */
  detach(): void
  /** Subscribe to the status changing. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** The status as a stable object, for `useSyncExternalStore`. */
  status(): TerminalStatus
  /** Everything the terminal still has scrollback for, as plain text. */
  transcript(): string
  /** Run one command. The result streams into the transcript wherever the pane happens to be. */
  run(command: string, rootPath: string | null): void
  /** Abandon the run in flight, which abandons the generator and lets main kill the child. */
  stop(): void
}

let instance: TerminalHost | null = null

/** The session's host, created on first ask and the same object for the life of the renderer. */
export function terminalHost(): TerminalHost {
  return (instance ??= createHost())
}

function createHost(): TerminalHost {
  let term: XTerm | null = null
  let fit: FitAddon | null = null
  let element: HTMLDivElement | null = null
  let iterator: AsyncIterator<string> | null = null
  let running = false
  let history: readonly string[] = []

  const listeners = new Set<() => void>()
  // The snapshot a reader is handed is replaced only when the status changes, because
  // `useSyncExternalStore` compares by identity and a fresh object per call would re-render forever.
  let snapshot: TerminalStatus = { running: false, history: [] }

  const publish = () => {
    snapshot = { running, history }
    for (const listener of listeners) listener()
  }

  /**
   * The one place a terminal is made, and the only place `open` is called.
   *
   * Called with the element already inside the pane, because xterm measures the element it is given and a
   * detached box measures nothing — the caller creates the element and attaches it, and this binds the
   * two. The initial fit is guarded because a zero-sized box throws, not because a failure is expected:
   * the ResizeObserver below settles the size as soon as there is one to settle.
   */
  const create = (box: HTMLDivElement): void => {
    const terminal = new XTerm({
      theme: THEME,
      fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      // Output comes from commands, not keystrokes, so the terminal itself takes no input.
      disableStdin: true,
      scrollback: 5000,
      convertEol: true,
    })
    const fitting = new FitAddon()
    terminal.loadAddon(fitting)
    terminal.open(box)

    term = terminal
    fit = fitting
    element = box

    try {
      fitting.fit()
    } catch {
      // Nothing to measure yet; the observer fits it once the pane has given the box a size.
    }

    // The pane is inside a resizable group, so the box changes size without a window resize. Observing
    // the element is what makes FitAddon run at the right moment, and the observer is never disconnected:
    // it watches the host's own element, which is exactly the thing that outlives the pane.
    const observer = new ResizeObserver(() => {
      try {
        fitting.fit()
      } catch {
        // A zero-sized box during a collapse throws; the next resize settles it.
      }
    })
    observer.observe(box)
  }

  const notify = (message: string) => term?.write(`\r\n\u001b[31m${message}\u001b[0m\r\n`)

  return {
    attach(parent) {
      let box = element
      if (box === null) {
        box = document.createElement('div')
        box.className = 'h-full w-full'
        // In the document before `open`, because xterm measures the element it is given and a detached box
        // has no size to measure. The element is the host's from here on, whatever the pane does.
        parent.appendChild(box)
        element = box
        create(box)
      } else if (box.parentElement !== parent) {
        parent.appendChild(box)
      }

      try {
        fit?.fit()
      } catch {
        // The pane's box is not measurable yet; the observer fires when it is.
      }
    },

    detach() {
      element?.remove()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    status: () => snapshot,

    transcript() {
      const buffer = term?.buffer.active
      if (!buffer) return ''
      const lines: string[] = []
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    },

    run(command, rootPath) {
      const terminal = term
      const text = command.trim()
      // A run is one at a time, and there is nothing to write into before the pane has ever been shown —
      // which cannot happen, because the input that starts one lives in the pane.
      if (terminal === null || running || text === '') return

      if (rootPath === null) {
        notify('Open a folder first — commands run inside the workspace.')
        return
      }

      history = [...history, text]
      running = true
      publish()

      // Echo the command the way a shell would, so the output has a subject.
      terminal.write(`\r\n\u001b[90m${`>`} ${text}\u001b[0m\r\n`)

      const session = createTerminalSession(
        (chunk) => terminal.write(chunk),
        (code) => terminal.write(exitMessage(code))
      )

      const stream = conveyor.terminal.execute({
        command: text,
        cwd: rootPath,
        workspaceRoot: rootPath,
      })
      const cursor = stream[Symbol.asyncIterator]()
      iterator = cursor

      // Consumed outside React on purpose: closing the pane unmounts the component, and the loop that
      // reads the stream has to outlive it. The writes land in the retained terminal, so output that
      // arrives while the pane is away is in the transcript when it comes back.
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await cursor.next()
            if (done) break
            session.consume(value)
          }
        } catch (err) {
          // Branch on the code, never the message text.
          notify(terminalErrorMessage(err))
        } finally {
          if (iterator === cursor) iterator = null
          running = false
          publish()
        }
      })()
    },

    stop() {
      void iterator?.return?.(undefined)
      iterator = null
      running = false
      publish()
    },
  }
}

/** A failed run, in the operator's terms, branched on the code rather than on the message text. */
function terminalErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'CWD_REQUIRED':
        return 'No working directory — open a folder first.'
      case 'CWD_NOT_FOUND':
        return 'That working directory does not exist.'
      case 'CWD_OUTSIDE_WORKSPACE':
        return 'Refused: that directory is outside the open folder.'
      case 'SPAWN_FAILED':
        return 'The command could not be started.'
      default:
        return 'The command failed to run.'
    }
  }
  return 'The command failed to run.'
}
