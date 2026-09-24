import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Square, SquareTerminal } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'
import { terminalHost } from './terminal-host'
import '@xterm/xterm/css/xterm.css'

/**
 * The terminal, as a resident of the right rail.
 *
 * The input row is the Phase 5 contract: you type a command and it runs, rather than driving a
 * persistent shell. That is the safer shape for now — a long-lived pty is a different problem, with its
 * own permissions story — and it keeps the stream one-shot, which is what `execute` models.
 *
 * What this pane does *not* own any more is the terminal itself. The xterm instance, the element it drew
 * into, the run in flight and the command history all live in `terminal-host.ts`, one level up, because
 * Phase 39 made this pane something a click puts away and the same click brings back: a pane that owned
 * the transcript would take the scrollback with it every time it was closed, and would start a second
 * `execute` for a command that was still running. The pane lends the host a parent while it is on screen
 * and hands it back when it goes, and the host draws wherever it is put.
 *
 * xterm still owns the transcript and React still does not re-render it: chunks are written straight to
 * the terminal instance, so nothing here re-renders per token the way the chat transcript does. What
 * this component does re-render for is the status — one boolean and a count, published by the host.
 */
export function TerminalPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)

  const host = terminalHost()
  const { running, history } = useSyncExternalStore(host.subscribe, host.status)
  const paneRef = useRef<HTMLDivElement>(null)
  const [command, setCommand] = useState('')

  // The pane's whole relationship with the session: lend it this element while the pane is mounted, take
  // it back on the way out. Nothing is disposed here, which is the difference between this and the pane
  // that used to `term.dispose()` — the terminal belongs to the host, and the host is not going anywhere.
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    host.attach(pane)
    return () => host.detach()
  }, [host])

  const send = () => {
    const text = command.trim()
    if (text === '' || running) return
    host.run(text, rootPath)
    // The box keeps what was typed when there was no folder to run it in: the host wrote the reason into
    // the transcript, and clearing the input as well would make the user type it again to act on it.
    if (rootPath !== null) setCommand('')
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
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      {/* The transcript. The host's own element is moved in here, and out again when the pane goes. */}
      <div ref={paneRef} className="min-h-0 flex-1 overflow-hidden bg-[#08090a] px-2 py-1.5" />

      <div className="shrink-0 border-t border-border p-2.5">
        <div className="flex items-center gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
            disabled={running}
            aria-label="Command"
            placeholder={rootPath ? 'Type a command, e.g. ls -la' : 'Open a folder to run commands'}
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono text-[12px]"
          />
          {running ? (
            <Button size="sm" variant="outline" onClick={() => host.stop()} aria-label="Stop command">
              <Square />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={send} disabled={!command.trim() || !rootPath}>
              Run
            </Button>
          )}
        </div>

        {/*
          The count is the session's, not this mount's: it is read from the host rather than kept in
          state here, so reopening the pane reports the runs that happened before it was closed too.
        */}
        <p className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
          {history.length > 0 ? `${history.length} run this session` : 'Phase 5: one command per run'}
        </p>
      </div>
    </div>
  )
}
