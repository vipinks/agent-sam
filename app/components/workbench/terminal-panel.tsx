import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { PanelBottomClose, RotateCw, SquareTerminal } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { terminalPreferencesStore } from '@/conveyor/stores/terminal-preferences'
import { useThemeStore } from '@/app/shell'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { terminalHost, type TerminalStatus } from './terminal-host'
import { terminalThemeFor } from './terminal-theme'
import { useWorkbenchStore } from './store'
import '@xterm/xterm/css/xterm.css'

/**
 * The terminal, as the bottom panel under the chat column.
 *
 * The pane is a view and nothing else. The shell is a process in main, keyed by the open folder; the
 * xterm instance and the element it draws into belong to `terminal-host.ts`, one level up, because the
 * pane is something a click puts away and the same click brings back, and because a maximize remounts
 * every pane under the workbench's layout groups. A pane that owned a terminal would take the
 * scrollback with it and, worse, ask main to open a *second* shell in the same folder on the way back.
 *
 * So what this component does is five things, all of them effects: hand the host an element to draw in,
 * tell it which folder is open, hand it the document's current colours, hand it the size the preferences
 * ask for, and give the element back on the way out. Keystrokes, output and the exit line never pass
 * through React — chunks are written into xterm by the host — so nothing here re-renders per byte. What
 * it does re-render for is the status: which folder's shell, and whether it is opening, live, ended or
 * failed — which is also when the action out of an ended shell appears.
 *
 * Where it is mounted is the layout's business and not this pane's: the workbench nests its column's
 * group under the chat and renders this into the panel below the conversation, so a move of the panel
 * is a change in one file's JSX and nothing in this one. What it does own is the way out from where the
 * reader's pointer already is — its header's close glyph, which is the title bar's own toggle reached
 * from the other end.
 */
export function TerminalPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  const mode = useThemeStore((state) => state.theme)
  const themeId = useWorkbenchStore((state) => state.themeId)
  const brightness = useWorkbenchStore((state) => state.brightness)
  const fontSize = useConveyorStore(terminalPreferencesStore, (s) => s.fontSize)

  const host = terminalHost()
  const status = useSyncExternalStore(host.subscribe, host.status)
  const paneRef = useRef<HTMLDivElement>(null)

  // The colours first, and in a layout effect: the terminal is built on the first attach, and a theme
  // applied in a passive effect would be a frame of the previous palette on a switch. The three
  // dependencies are the three `theme-apply.ts` resolves the document's own variables from, so a
  // theme, a mode flip and a brightness step all reach the terminal by the route they reach the
  // stylesheet — there is no fourth place for a theme to be decided.
  useLayoutEffect(() => {
    host.setTheme(terminalThemeFor(themeId, mode, brightness))
  }, [host, themeId, mode, brightness])

  // The size before the terminal is built, and on every re-bind. Declared ahead of the attach effect
  // for the reason the colours are: the instance is constructed *inside* that effect, so a size applied
  // after it would be a frame — on the first mount, a whole terminal — drawn at the wrong size. A change
  // made while this pane is on screen reaches the same instance through the Settings section's own call;
  // this is the half that outlives the pane.
  useLayoutEffect(() => {
    host.setFontSize(fontSize)
  }, [host, fontSize])

  // The pane's whole relationship with the session. `rootPath` is a dependency rather than a value read
  // once, because a folder switch is a *different* shell: the host re-attaches, reads that folder's
  // transcript and shows it in the same retained terminal. A remount re-runs this too, which is the
  // reseed that makes maximize and restore lossless.
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    host.attach(pane)
    host.setRoot(rootPath)
    host.fit()
    return () => host.detach()
  }, [host, rootPath])

  /**
   * Start a new shell in the folder that just lost one.
   *
   * The fit is the half that is easy to forget: a new shell is a process that has never heard how
   * large the pane is, so it starts at the pty's own 80x24 and is told the real size by the same
   * debounced resize a dock uses. Everything else is the ordinary open — `create`, then the read that
   * reseeds the screen — reached through the host rather than through React, because the terminal being
   * drawn into belongs to the host and not to this pane.
   */
  const startNewShell = (): void => {
    host.restart()
    host.fit()
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={SquareTerminal} title="Terminal">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground"
          title={rootPath ?? undefined}
        >
          {rootPath ?? 'no folder open'}
        </span>
        <BottomPanelCloseControl />
      </PaneHeader>

      {/*
        The terminal. The host's own element is moved in here, and out again when the pane goes; the
        slot holds nothing else, which is why the element is the only child a test can find.
      */}
      <div
        ref={paneRef}
        // A click anywhere in the box puts the caret in the shell, which is what a terminal does.
        onMouseDown={() => host.focus()}
        aria-label="Terminal pane"
        data-slot="terminal"
        className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1.5"
      />

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-2.5">
        <p className="min-w-0 font-mono text-[10.5px] text-muted-foreground">{describe(status)}</p>
        {/*
          The way out of an ended shell, offered where the news is. Opening the folder again would also
          start a new one, but a reader who did nothing except type `exit` should not have to leave the
          folder and come back — and the pane is what they are looking at.
        */}
        {status.phase === 'ended' && (
          <Button data-slot="terminal-restart" size="sm" variant="outline" onClick={startNewShell}>
            <RotateCw aria-hidden="true" />
            Start a new shell
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Put the bottom panel away from inside it.
 *
 * The title bar's glyph is how this panel is opened and closed, and this is that same toggle reached
 * from the other end of the panel: a reader whose pointer is already in the shell should not have to
 * travel to the top of the window to put it away. It is not the rail's collapse glyph and neither offers
 * the other's move — a resident docked *beside* the chat and a panel *under* it are two different
 * things, and one control meaning both would be a control whose effect depends on which is open.
 *
 * There is no expand control beside it, deliberately. The viewer's expansion is about a column taking the
 * chat's width, and this panel is the chat column's own height; the control that offers that expansion
 * is still offered by every resident of the rail.
 */
function BottomPanelCloseControl() {
  const closeBottomPanel = useWorkbenchStore((s) => s.closeBottomPanel)

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Close terminal panel"
      title="Hide the terminal panel"
      onClick={closeBottomPanel}
    >
      <PanelBottomClose />
    </Button>
  )
}

/**
 * The session, in one line.
 *
 * The shell's own output is the transcript and says what it says; what a reader needs from the pane is
 * the one fact the transcript cannot state — whether what they are looking at is still a live process,
 * and why not when it is not. The exit code is named here as well as written into the scrollback,
 * because the scrollback may have been pushed past it by the time it matters.
 */
function describe(status: TerminalStatus): string {
  if (status.rootPath === null) return 'Open a folder to start a shell in it.'

  switch (status.phase) {
    case 'opening':
      return `Opening the shell in ${status.rootPath}…`
    case 'ready':
      return `Live shell in ${status.rootPath} — keystrokes go straight to it.`
    case 'ended':
      return `The shell ended — exit code ${status.exitCode ?? 0}.`
    case 'failed':
      return status.message ?? 'The terminal could not be opened.'
    default:
      return 'Open a folder to start a shell in it.'
  }
}
