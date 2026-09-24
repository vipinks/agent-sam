import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Loader2, Square, SquareTerminal } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'
import { createTerminalSession, exitMessage } from './terminal-session'
import '@xterm/xterm/css/xterm.css'

/** The colours xterm uses, following the app's tokens rather than the library defaults. */
const THEME = {
  background: '#08090a',
  foreground: '#f2f3f3',
  cursor: '#ff5c3a',
  selectionBackground: 'rgba(255, 92, 58, 0.25)',
}

/**
 * A local terminal.
 *
 * The input row is the Phase 5 contract: you type a command and it runs, rather than driving a
 * persistent shell. That is the safer shape for now — a long-lived pty is a different problem, with
 * its own permissions story — and it keeps the stream one-shot, which is what `execute` models.
 *
 * xterm owns the transcript and React does not re-render it: chunks are written straight to the
 * terminal instance, so nothing here re-renders per token the way the chat transcript does.
 */
export function TerminalPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const iteratorRef = useRef<AsyncIterator<string> | null>(null)

  const [command, setCommand] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  // The command history, so the transcript carries what was run next to its output.
  const [history, setHistory] = useState<string[]>([])

  // ---- xterm lifecycle -------------------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
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
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // The panel is inside a resizable group, so the host changes size without a window resize.
    // Observing the element itself is what makes FitAddon run at the right moment.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // A zero-sized box during a collapse throws; the next resize settles it.
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // ---- running ---------------------------------------------------------------------------------

  const stop = useCallback(() => {
    void iteratorRef.current?.return?.(undefined)
    iteratorRef.current = null
    setIsRunning(false)
  }, [])

  const run = useCallback(async () => {
    const text = command.trim()
    const term = termRef.current
    if (!text || !term || isRunning) return

    if (!rootPath) {
      term.write('\r\n\u001b[31mOpen a folder first — commands run inside the workspace.\u001b[0m\r\n')
      return
    }

    setCommand('')
    setIsRunning(true)
    setHistory((prev) => [...prev, text])
    // Echo the command the way a shell would, so the output has a subject.
    term.write(`\r\n\u001b[90m${`>`} ${text}\u001b[0m\r\n`)

    const session = createTerminalSession(
      (chunk) => term.write(chunk),
      (code) => term.write(exitMessage(code))
    )

    const stream = conveyor.terminal.execute({
      command: text,
      cwd: rootPath,
      workspaceRoot: rootPath,
    })
    const iterator = stream[Symbol.asyncIterator]()
    iteratorRef.current = iterator

    try {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        session.consume(value)
      }
    } catch (err) {
      // Branch on the code, never the message text.
      term.write(`\r\n\u001b[31m${terminalErrorMessage(err)}\u001b[0m\r\n`)
    } finally {
      iteratorRef.current = null
      setIsRunning(false)
    }
  }, [command, isRunning, rootPath])

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={SquareTerminal} title="Terminal">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={rootPath ?? undefined}>
          {rootPath ?? 'no folder open'}
        </span>
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      {/* The transcript. xterm writes into this element directly. */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-[#08090a] px-2 py-1.5" />

      <div className="shrink-0 border-t border-border p-2.5">
        <div className="flex items-center gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void run()
              }
            }}
            disabled={isRunning}
            aria-label="Command"
            placeholder={rootPath ? 'Type a command, e.g. ls -la' : 'Open a folder to run commands'}
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono text-[12px]"
          />
          {isRunning ? (
            <Button size="sm" variant="outline" onClick={stop} aria-label="Stop command">
              <Square />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => void run()} disabled={!command.trim() || !rootPath}>
              {isRunning && <Loader2 className="animate-spin" />}
              Run
            </Button>
          )}
        </div>

        <p className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
          {history.length > 0 ? `${history.length} run this session` : 'Phase 5: one command per run'}
        </p>
      </div>
    </div>
  )
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
