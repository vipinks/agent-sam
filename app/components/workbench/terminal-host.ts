import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ConveyorError } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import {
  isTerminalEventFor,
  TERMINAL_NOT_FOUND,
  TERMINAL_SPAWN_FAILED,
  type TerminalDataPayload,
  type TerminalExitPayload,
} from '@/conveyor/protocol/terminal-pty'
import { DEFAULT_FONT_SIZE } from '@/conveyor/protocol/terminal-preferences'

/**
 * The terminal, kept above the pane that shows it.
 *
 * The shell itself is main's: `terminal-pty.ts` owns one persistent process per folder, with its
 * scrollback, its `cd` and anything it exported. What this module owns is the *renderer's* half of
 * looking at that shell — the xterm instance, the element it drew into, the fit addon, and the
 * subscription that turns pushed output into writes.
 *
 * That half has to outlive the pane, and it is the reason this is a module rather than a component. A
 * pane is put away by a click and brought back by the same click, and the workbench keys its groups on
 * the window state, so a maximize or a restore unmounts and remounts every pane beneath them. A pane
 * that owned its terminal would build a new one each time: a new empty screen, and a second `create`
 * for a folder whose shell was already running.
 *
 * Three things follow from that, and each is a decision rather than a consequence.
 *
 * The element is created here, detached, and re-parented into whichever pane is on screen: xterm binds
 * a terminal to one container for its life, so the container is the host's and the pane lends it a
 * parent. A `ResizeObserver` lives here beside it for the same reason — what it watches is the host's
 * element, which changes size when the pane is re-parented into a differently sized slot.
 *
 * The event subscription is installed once and never removed, so output that arrives while no pane is
 * on screen is still written into the retained terminal. `read` then covers the gap this cannot: a
 * renderer reload, or anything emitted before this module was loaded at all.
 *
 * Every attach re-seeds from `terminal.read` after clearing the screen. That is not a repair for a
 * broken buffer — the buffer is intact — it is the answer to "what did I miss", and it is idempotent,
 * which is what makes it safe to do on every mount rather than on a suspicion. Main's transcript is the
 * source of truth; the screen is a view of it. The cost is real and named in the suite: the transcript
 * keeps whole lines, so a full-screen program's cursor positioning is not replayed, only its lines.
 */

/** How long a resize waits before it is told to the shell. */
export const FIT_DEBOUNCE_MS = 120

/** Where the pane is in its lifecycle, as the footer states it. */
export type TerminalPhase = 'idle' | 'opening' | 'ready' | 'ended' | 'failed'

/** What the pane re-renders for. */
export interface TerminalStatus {
  /** The folder whose shell this is, or null when no folder is open. */
  rootPath: string | null
  phase: TerminalPhase
  /** The shell's process id, once main has reported one. */
  pid: number | null
  /** How the shell ended, when it has. */
  exitCode: number | null
  /** Why it could not be opened, in the operator's terms. */
  message: string | null
}

/** The session the pane draws from. Every method is safe to call while no pane is on screen. */
export interface TerminalHost {
  /** Move the retained terminal into a pane, creating it the first time it is asked for. */
  attach(parent: HTMLElement): void
  /** Take it out of the document without ending anything. */
  detach(): void
  /** Follow the open folder: null ends the binding, a path attaches to that folder's shell. */
  setRoot(rootPath: string | null): void
  /** Re-paint with the colours the document is currently using. */
  setTheme(theme: ITheme): void
  /**
   * Draw at this size, in pixels, from now on.
   *
   * Held on the host rather than passed at construction because the terminal outlives the pane that
   * shows it: the value has to be here before the instance is built, and a change made while the pane
   * is away — which is every change, since the control lives in Settings — has to reach the retained
   * instance rather than the next one.
   */
  setFontSize(pixels: number): void
  /**
   * Start a new shell for the folder this host is bound to, after the previous one ended.
   *
   * `setRoot` deliberately does not do this: a pane that mounts a second time wants the shell it left,
   * not a new one. This is the other case, and it has to ask for a new shell even though this renderer
   * has asked for this folder before — main has already forgotten the exited session, so the request
   * starts one rather than returning a dead pid.
   */
  restart(): void
  /** Measure the box and tell the shell how large it is. Debounced. */
  fit(): void
  /** Put the keyboard on the terminal, so a click into the pane starts typing. */
  focus(): void
  /** Subscribe to the status changing. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** The status as a stable object, for `useSyncExternalStore`. */
  status(): TerminalStatus
}

let instance: TerminalHost | null = null

/** The session's host, created on first ask and the same object for the life of the renderer. */
export function terminalHost(): TerminalHost {
  return (instance ??= createHost())
}

function createHost(): TerminalHost {
  let term: XTerm | null = null
  let fitter: FitAddon | null = null
  let element: HTMLDivElement | null = null
  let theme: ITheme | null = null
  let fontSize = DEFAULT_FONT_SIZE

  let rootPath: string | null = null
  let phase: TerminalPhase = 'idle'
  let pid: number | null = null
  let exitCode: number | null = null
  let message: string | null = null

  /** The folders this renderer has already asked main to open. */
  const opened = new Set<string>()
  /** Output that arrived while a transcript replay was being assembled, in arrival order. */
  let pending: string[] = []
  let seeding = false
  /** Bumped on every binding, so a reply for a folder the user has left is discarded rather than drawn. */
  let generation = 0
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let listening = false

  const listeners = new Set<() => void>()
  // Replaced only when the status changes, because `useSyncExternalStore` compares by identity and a
  // fresh object per call would re-render forever.
  let snapshot: TerminalStatus = { rootPath: null, phase: 'idle', pid: null, exitCode: null, message: null }

  const publish = () => {
    snapshot = { rootPath, phase, pid, exitCode, message }
    for (const listener of listeners) listener()
  }

  /**
   * Listen to main, once, for the life of the renderer.
   *
   * Not a hook, and not tied to the pane: `terminal-host` is above React precisely so that output which
   * arrives while the pane is away is kept. A subscription that died with the pane would make the
   * transcript replay the *only* route, and would leave a terminal that is undocked for a long build
   * blank on return.
   *
   * Every window receives every folder's output, so the payload's own `rootPath` is what decides
   * whether it belongs here.
   */
  const listen = () => {
    if (listening) return
    listening = true
    conveyor.terminalPty.data.subscribe((payload: TerminalDataPayload) => receive(payload))
    conveyor.terminalPty.exit.subscribe((payload: TerminalExitPayload) => ended(payload))
  }

  const receive = (payload: TerminalDataPayload) => {
    const terminal = term
    if (terminal === null || rootPath === null) return
    if (!isTerminalEventFor(payload, rootPath)) return
    // Held back rather than written while a replay is in flight: the replay clears the screen first, so
    // a chunk written into the old screen would be wiped by it and lost.
    if (seeding) pending.push(payload.chunk)
    else terminal.write(payload.chunk)
  }

  const ended = (payload: TerminalExitPayload) => {
    const terminal = term
    if (terminal === null || rootPath === null) return
    if (!isTerminalEventFor(payload, rootPath)) return

    exitCode = payload.exitCode
    pid = null
    phase = 'ended'
    // Written into the scrollback rather than into a notice above it, so the line lands after the last
    // thing the shell printed — which is where someone looking for the reason will already be looking.
    terminal.write(exitLine(payload.exitCode))
    publish()
  }

  /**
   * Replay main's transcript, after clearing the screen.
   *
   * The clear is what makes this idempotent: without it a second mount would append a second copy of a
   * shell's whole history. Chunks that arrive while this is in flight are held in `pending` and written
   * after the replay, so the order the shell produced is the order the screen shows — reading the
   * transcript is asynchronous, and a build's output does not pause to let it finish.
   */
  const seed = async (root: string, mark: number): Promise<void> => {
    seeding = true
    pending = []

    let snapshot: { pid: number; lines: string[] }
    try {
      snapshot = await conveyor.terminalPty.read({ rootPath: root })
    } catch (err) {
      seeding = false
      if (mark !== generation) return
      // A folder whose shell has gone is not a failure to report: either it exited, in which case the
      // exit event already said so, or it was never opened. Both leave the screen as it is.
      if (!isMissingSession(err)) fail(err)
      return
    }

    if (mark !== generation) return
    const terminal = term
    if (terminal === null) {
      seeding = false
      return
    }

    pid = snapshot.pid
    if (phase !== 'ended') phase = 'ready'

    terminal.reset()
    // Joined with a carriage return and a newline, and no trailing one: the last entry may be a prompt
    // the shell has not finished writing, and a trailing break would push the cursor off its line.
    if (snapshot.lines.length > 0) terminal.write(snapshot.lines.join('\r\n'))
    for (const chunk of pending) terminal.write(chunk)
    pending = []
    seeding = false
    publish()
  }

  /**
   * Bind to a folder's shell: open it if this renderer has not, then catch up from its transcript.
   *
   * `create` is what is gated on having been asked before, and `read` is not. That is the whole of the
   * re-attach rule — a folder opened earlier in this renderer's life already has a shell, and asking
   * again would either answer with it (main is idempotent per root) or, on a root that had been
   * forgotten, start a second one. Reading is safe to repeat and is how a pane that was away catches up.
   *
   * `fresh` is the one caller that is not that rule: a shell that has *ended* is forgotten by main, so
   * the next shell in that folder is the one that was asked for — and the `opened` set, which records
   * what this renderer has asked for, is deliberately left as it is. It records the same thing either
   * way, and a reply that arrives after the pane left is still discarded by the generation mark.
   */
  const open = (root: string, fresh = false): void => {
    generation += 1
    const mark = generation
    const first = fresh || !opened.has(root.toLowerCase())

    rootPath = root
    exitCode = null
    message = null
    if (first) {
      phase = 'opening'
      publish()
    }

    void (async () => {
      try {
        if (first) {
          const created = await conveyor.terminalPty.create({ rootPath: root })
          opened.add(root.toLowerCase())
          if (mark !== generation) return
          pid = created.pid
        }
      } catch (err) {
        if (mark !== generation) return
        fail(err)
        return
      }
      await seed(root, mark)
    })()
  }

  const fail = (err: unknown) => {
    phase = 'failed'
    pid = null
    message = terminalErrorMessage(err)
    publish()
  }

  /** The one place a resize is reported, after the debounce that keeps a drag from being a flood. */
  const scheduleResize = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      const terminal = term
      // Only a shell that is known to exist: a resize arriving for a folder main has no session for is
      // refused with `TERMINAL_NOT_FOUND`, and one thrown from a timer has nowhere to be reported.
      if (terminal === null || rootPath === null || phase !== 'ready') return
      conveyor.terminalPty.resize({ rootPath, cols: terminal.cols, rows: terminal.rows })
    }, FIT_DEBOUNCE_MS)
  }

  /** Measure, then report. A zero-sized box throws, which is a pane mid-collapse rather than an error. */
  const measure = () => {
    if (fitter === null) return
    try {
      fitter.fit()
    } catch {
      return
    }
    scheduleResize()
  }

  /**
   * The keys the terminal cannot be left to handle.
   *
   * Two chords, and both are about the clipboard the browser owns rather than the shell. Ctrl+C is a
   * copy *only* when something is selected; with nothing selected it must stay the interrupt, which is
   * the byte xterm's own default sends — so this returns true and lets it, rather than sending `\u0003`
   * itself. That keeps an interrupt on the same path as a keystroke instead of making it a second
   * implementation of input.
   *
   * Ctrl+V is refused and performed here, from the renderer's clipboard. Refused for a reason: leaving
   * it to xterm would let the DOM's own paste fire as well, and one press would write the text twice.
   */
  const handleKey = (event: KeyboardEvent): boolean => {
    const terminal = term
    if (terminal === null) return true
    if (event.type !== 'keydown') return true
    if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true

    const key = event.key.toLowerCase()

    if (key === 'c') {
      if (!terminal.hasSelection()) return true
      const selection = terminal.getSelection()
      // Cleared, so the next Ctrl+C interrupts: a copy that stayed armed would leave the user with no
      // way to stop what is running.
      terminal.clearSelection()
      void copyToClipboard(selection)
      return false
    }

    if (key === 'v') {
      event.preventDefault()
      void pasteFromClipboard()
      return false
    }

    return true
  }

  const pasteFromClipboard = async (): Promise<void> => {
    // Read before the await: the folder can change while the clipboard is being asked, and the text
    // belongs to the shell that was on screen when the user pressed the chord.
    const root = rootPath
    if (root === null) return
    let text = ''
    try {
      text = (await globalThis.navigator?.clipboard?.readText()) ?? ''
    } catch {
      return
    }
    if (text === '') return
    conveyor.terminalPty.write({ rootPath: root, data: text })
  }

  const create = (box: HTMLDivElement): void => {
    const terminal = new XTerm({
      ...(theme ? { theme } : {}),
      fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
      fontSize,
      lineHeight: 1.4,
      cursorBlink: true,
      // Off, deliberately. A previous terminal here ran a command per run and translated its line
      // endings for it; a pty already emits carriage returns, and `convertEol` on a pty's output
      // rewrites every line the shell draws — a full-screen program's cursor moves included.
      convertEol: false,
      scrollback: 5000,
    })
    const fitting = new FitAddon()
    terminal.loadAddon(fitting)
    terminal.open(box)

    term = terminal
    fitter = fitting
    element = box

    terminal.onData((data) => {
      const root = rootPath
      // The schema refuses an empty write, and xterm does emit one for some chords; a keystroke that is
      // nothing is not a keystroke to send.
      if (root === null || data === '') return
      conveyor.terminalPty.write({ rootPath: root, data })
    })
    terminal.attachCustomKeyEventHandler(handleKey)

    measure()

    // Never disconnected: it watches the host's own element, which is exactly the thing that outlives
    // the pane. The pane resizes inside a resizable group, so a window resize would never report this.
    const observer = new ResizeObserver(() => measure())
    observer.observe(box)
  }

  return {
    attach(parent) {
      let box = element
      if (box === null) {
        box = document.createElement('div')
        box.className = 'h-full w-full'
        // In the document before `open`, because xterm measures the element it is given and a detached
        // box measures nothing.
        parent.appendChild(box)
        element = box
        create(box)
      } else if (box.parentElement !== parent) {
        parent.appendChild(box)
      }
      measure()
    },

    detach() {
      element?.remove()
    },

    setRoot(next) {
      listen()
      if (next === null) {
        // Anything in flight for the folder that closed is abandoned rather than drawn: bumping the
        // generation is what tells its reply to stop.
        generation += 1
        rootPath = null
        pid = null
        exitCode = null
        message = null
        phase = 'idle'
        publish()
        return
      }
      open(next)
    },

    setTheme(next) {
      theme = next
      if (term) term.options.theme = next
    },

    setFontSize(next) {
      fontSize = next
      // The retained instance, when there is one: a size changed in Settings is a re-paint of the
      // terminal that is already on screen rather than a promise about the next one. `fit` is not called
      // here — the box has not moved, and the pane's own observer reports the change a wider font
      // causes.
      if (term) term.options.fontSize = next
    },

    restart() {
      const root = rootPath
      if (root === null) return
      open(root, true)
    },

    fit: measure,

    focus() {
      term?.focus()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    status: () => snapshot,
  }
}

/** The renderer's clipboard, which a headless document does not have. A refusal is not a failure here. */
async function copyToClipboard(text: string): Promise<void> {
  if (text === '') return
  try {
    await globalThis.navigator?.clipboard?.writeText(text)
  } catch {
    // The clipboard can be refused (no permission, no focused document). The terminal keeps working.
  }
}

/**
 * The line the scrollback is left with when a shell ends.
 *
 * A sentence rather than a bare number, and named as a code: what a user types at a prompt does not end
 * as a command does, so the pane cannot say "finished" and leave it there. Coloured green for a clean
 * exit and red otherwise, which is the one thing about an exit a reader wants at a glance.
 */
function exitLine(code: number): string {
  const tone = code === 0 ? '\u001b[32m' : '\u001b[31m'
  return `\r\n${tone}The shell ended — exit code ${code}\u001b[0m\r\n`
}

/** Whether a failed read means there is no session rather than that the call failed. */
function isMissingSession(error: unknown): boolean {
  return error instanceof ConveyorError && error.code === TERMINAL_NOT_FOUND
}

/** A failed open, in the operator's terms, branched on the code rather than on the message text. */
function terminalErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case TERMINAL_SPAWN_FAILED:
        return 'The shell for this folder could not be started.'
      case TERMINAL_NOT_FOUND:
        return 'This folder has no shell open.'
      default:
        return 'The terminal could not be opened.'
    }
  }
  return 'The terminal could not be opened.'
}
