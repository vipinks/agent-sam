import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { SquareTerminal } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { useThemeStore } from '@/app/shell'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'
import { terminalHost, type TerminalStatus } from './terminal-host'
import { terminalThemeFor } from './terminal-theme'
import { useWorkbenchStore } from './store'
import '@xterm/xterm/css/xterm.css'

/**
 * The terminal, as a resident of the right rail.
 *
 * The pane is a view and nothing else. The shell is a process in main, keyed by the open folder; the
 * xterm instance and the element it draws into belong to `terminal-host.ts`, one level up, because the
 * pane is something a click puts away and the same click brings back, and because a maximize remounts
 * every pane under the workbench's layout groups. A pane that owned a terminal would take the
 * scrollback with it and, worse, ask main to open a *second* shell in the same folder on the way back.
 *
 * So what this component does is four things, all of them effects: hand the host an element to draw in,
 * tell it which folder is open, hand it the document's current colours, and give the element back on
 * the way out. Keystrokes, output and the exit line never pass through React — chunks are written into
 * xterm by the host — so nothing here re-renders per byte. What it does re-render for is the status:
 * which folder's shell, and whether it is opening, live, ended or failed.
 */
export function TerminalPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  const mode = useThemeStore((state) => state.theme)
  const themeId = useWorkbenchStore((state) => state.themeId)
  const brightness = useWorkbenchStore((state) => state.brightness)

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

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={SquareTerminal} title="Terminal">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground"
          title={rootPath ?? undefined}
        >
          {rootPath ?? 'no folder open'}
        </span>
        <PanelExpandControl />
        <PanelCollapseControl />
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

      <div className="shrink-0 border-t border-border p-2.5">
        <p className="font-mono text-[10.5px] text-muted-foreground">{describe(status)}</p>
      </div>
    </div>
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
      return `The shell ended — exit code ${status.exitCode ?? 0}. Opening the folder again starts a new one.`
    case 'failed':
      return status.message ?? 'The terminal could not be opened.'
    default:
      return 'Open a folder to start a shell in it.'
  }
}
