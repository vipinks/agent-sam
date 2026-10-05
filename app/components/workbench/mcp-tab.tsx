/**
 * The MCP servers tab: the tools panel's second surface, and for the servers this app runs what the Skills
 * tab is for the skills it works from.
 *
 * The panel is the place to *find* a server, and to work the two things about one that a list this narrow
 * can do well: the switch on a row, which dispatches the settings section's own `mcp.setEnabled` with the
 * payload that section sends, scope and all, and the one stateful control beside it, whose glyph *is* the
 * status — a play when nothing answers for the server, a stop when a process does, a spinner while that is
 * being changed, and a retry when the last start refused. Which of the four is drawn, and which conveyor
 * command the click sends, is a rule of `conveyor/protocol/mcp-panel.ts`, asserted without a render. Trusting,
 * secrets, logs, adding and deleting stay on the settings screen, which is the advanced surface and the only
 * one with room to say what those writes will do; the button at the foot of this list is the door to it.
 *
 * Nothing here is a rule about a listing. Which rows the two reads become, which of them a query and a status
 * keep, and which page is showing are `conveyor/protocol/mcp-panel.ts`'s, asserted without a render; what is
 * left here is the state a reader moves — kept by the panel, so a switch of tabs does not lose it — and the
 * one command.
 *
 * A row states what a reader scanning a list needs: which server it is, which scope it came from, how many
 * tools a process is offering when one answers, that it needs trust when it does, and the one control it has
 * over its process. No row states a status in words — the glyph is the status, and the control's label names
 * the action and the server, for everything that cannot see a glyph. The command line is deliberately not
 * among them; the settings row carries it, and at this width it would push the marks that fit.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import {
  MCP_PANEL_STATUS_FILTERS,
  MCP_PANEL_STATUS_LABELS,
  planMcpPanelView,
  planMcpServerButton,
  type McpPanelProcessPhase,
  type McpPanelRow,
  type McpPanelStatusFilter,
  type McpServerButtonGlyph,
} from '@/conveyor/protocol/mcp-panel'
import { useMcpServersStore } from '@/conveyor/stores/mcp-servers'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { actionErrorMessage, readErrorMessage } from './mcp-notices'
import type { PanelNarrowing } from './panel-narrowing'
import { useWorkbenchStore } from './store'

/**
 * The MCP servers tab: the second tab's whole body.
 *
 * The read is the mirror's rather than this tab's own, and it is refreshed here on every mount, which is
 * every time the tab is shown: the panel reads the same mirror when it opens, for the count in the tab row,
 * and a tab that is not showing is not in the document — so a reader who went to Settings, started or
 * deleted a server there and came back is looking at a visit that asks again rather than at the answer their
 * last visit left behind.
 *
 * A failed whole-listing read is drawn above the list rather than as a row: nothing is wrong with any one
 * server, and the sentence is the settings section's own — one code, one explanation, whichever surface
 * asked. A failed switch, and a failed start or stop, are drawn beside the list for the same kind of reason:
 * the row still says what it said, because the write did not happen — and a row that has gone back to its
 * glyph is not the place to explain why.
 */
export function McpServersTabBody({ narrowing }: { narrowing: PanelNarrowing<McpPanelStatusFilter> }) {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const listing = useMcpServersStore((s) => s.listing)
  const running = useMcpServersStore((s) => s.running)
  const loading = useMcpServersStore((s) => s.loading)
  const readError = useMcpServersStore((s) => s.error)
  const refresh = useMcpServersStore((s) => s.refresh)
  const openSettingsAt = useWorkbenchStore((s) => s.openSettingsAt)

  /** What the last write that failed had to say, in the shared words for its code. */
  const [actionFailure, setActionFailure] = useState<string | null>(null)

  const setEnabled = conveyor.mcp.setEnabled.useMutation()

  useEffect(() => {
    void refresh(rootPath)
  }, [refresh, rootPath])

  const view = useMemo(
    () => planMcpPanelView({ listing, running }, narrowing.query, narrowing.status, narrowing.page),
    [listing, running, narrowing.query, narrowing.status, narrowing.page]
  )

  /**
   * Switch one server on or off, and nothing else.
   *
   * The flag's write, and it is the settings section's: the same command, the same whole payload — the row's
   * own scope, the folder that is open, the id, and the flag turned over. It is not the process control
   * beside it and it never starts or stops anything: the flag says whether a server *may* run, and the two
   * are deliberately two writes, because one that merged them would make flagging a server look like
   * starting one.
   */
  async function toggle(row: McpPanelRow): Promise<void> {
    try {
      await setEnabled.mutateAsync({
        scope: row.server.scope,
        rootPath,
        serverId: row.server.id,
        enabled: !row.server.enabled,
      })
      setActionFailure(null)
      // The list is the disk's answer, so it is asked for again rather than patched here.
      void refresh(rootPath)
    } catch (error) {
      setActionFailure(actionErrorMessage(error))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Search MCP servers"
          data-slot="tools-mcp-search"
          value={narrowing.query}
          onChange={(event) => narrowing.setQuery(event.target.value)}
          placeholder="Search servers"
          className="h-7 min-w-0 flex-1 text-[12.5px]"
        />
        <Select value={narrowing.status} onValueChange={narrowing.setStatusValue}>
          <SelectTrigger
            aria-label="Filter by status"
            data-slot="tools-mcp-status"
            className="h-7 w-[9.5rem] shrink-0 text-[12.5px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MCP_PANEL_STATUS_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {MCP_PANEL_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && listing === null && (
        <p data-slot="tools-mcp-reading" className="text-[12.5px] text-muted-foreground">
          Reading the server configs…
        </p>
      )}

      {readError != null && (
        <p role="status" data-slot="tools-mcp-read-error" className="text-[12.5px] leading-relaxed text-destructive">
          {readErrorMessage(readError)}
        </p>
      )}

      {actionFailure && (
        <p role="status" data-slot="tools-mcp-write-error" className="text-[12.5px] leading-relaxed text-destructive">
          {actionFailure}
        </p>
      )}

      {view.rows.length === 0 ? (
        <p data-slot="tools-mcp-nomatch" className="px-1 py-2 text-[12.5px] text-muted-foreground">
          {emptyLine(narrowing.query, narrowing.status)}
        </p>
      ) : (
        <ul data-slot="mcp-panel-list" className="flex flex-col gap-1.5">
          {view.rows.map((row) => (
            <McpRowView
              key={`${row.server.scope}:${row.server.id}`}
              row={row}
              rootPath={rootPath}
              pending={setEnabled.isPending}
              onToggle={toggle}
              onChanged={() => {
                setActionFailure(null)
                void refresh(rootPath)
              }}
              onFailed={setActionFailure}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <span data-slot="tools-mcp-range" className="text-[11.5px] text-muted-foreground tabular-nums">
          {view.range}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous page"
            disabled={view.page <= 1}
            onClick={() => narrowing.setPage(view.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next page"
            disabled={view.page >= view.pageCount}
            onClick={() => narrowing.setPage(view.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {/*
       * The door to the advanced surface. Adding, deleting, trusting, secrets, logs and the two process
       * controls are not things this pane can do well in a column this narrow, and the panel-first rule says
       * as much: what is left here is what a reader does while scanning, and everything else is one section
       * away.
       */}
      <Button
        type="button"
        variant="outline"
        data-slot="tools-mcp-manage"
        onClick={() => openSettingsAt('mcp-servers')}
        className="w-full text-[12.5px]"
      >
        Manage MCPs
      </Button>
    </div>
  )
}

/**
 * One line for a list that came out empty, saying which of the narrowings did it.
 *
 * The four are said apart rather than as one sentence because they call for different things: a query the
 * reader can clear, a status they can widen, and a folder that configures no servers at all — which they can
 * only answer on the settings screen, and that is what the button under this list is for.
 */
function emptyLine(query: string, status: McpPanelStatusFilter): string {
  const typed = query.trim()
  if (typed !== '') return `No MCP servers match “${typed}”.`
  if (status === 'running') return 'No server is running.'
  if (status === 'stopped') return 'No server is stopped.'
  if (status === 'disabled') return 'No server is switched off.'
  if (status === 'needs-trust') return 'No server needs trust.'
  return 'No MCP servers were found in your own settings or in this project.'
}

/**
 * One server, and the two things this panel may do to it: flag it, and start or stop it.
 *
 * The id is the title and the whole of the text: a server record has no summary, and inventing one from a
 * command line would put words about a process in a row that is not running one. The scope is a badge rather
 * than a second list, because the panel is one flat list a reader pages through — the settings section is
 * where the two scopes are drawn apart. What a process is offering is stated the way the settings row states
 * it, so one server does not read as two different things depending on which surface is open, and what is
 * *not* stated is which of the two states the server is in: the control beside it draws that.
 *
 * The control's two mutations belong to the row rather than to the list, which is the whole reason the state
 * lives here: a spinner is about the server it is drawn on, and a refusal is remembered against the row that
 * made it. One pair of mutations for the list would leave every row waiting because one row's start was in
 * flight, and would answer "Retry" on rows that never tried.
 */
function McpRowView({
  row,
  rootPath,
  pending,
  onToggle,
  onChanged,
  onFailed,
}: {
  row: McpPanelRow
  rootPath: string | null
  pending: boolean
  onToggle: (row: McpPanelRow) => void
  /** Both reads again, and the failure line cleared: what a landed call leaves the panel saying. */
  onChanged: () => void
  onFailed: (notice: string) => void
}) {
  const { server } = row

  const start = conveyor.mcp.startServer.useMutation()
  const stop = conveyor.mcp.stopServer.useMutation()

  /**
   * Where this row's own call has got to, and whether its last start was refused.
   *
   * `start.error` is that second fact rather than a field this file keeps: react-query clears it when the
   * next attempt begins and sets it when one refuses, which is exactly "the last start this row made failed".
   */
  const phase: McpPanelProcessPhase = start.isPending ? 'starting' : stop.isPending ? 'stopping' : 'idle'
  const control = planMcpServerButton({ status: row.status, phase, failed: start.error !== null })

  /**
   * Dispatch the action the control names, then ask main what happened.
   *
   * The payloads are the settings section's own, command for command — a start carries the scope and the
   * folder a config is read from, and a stop carries the id alone. Nothing here guesses at the outcome: the
   * read that follows is what the glyph draws, so a server that started shows its Stop and a server the
   * refresh cannot see stays the play it was.
   */
  async function run(action: 'start' | 'stop'): Promise<void> {
    try {
      if (action === 'start') {
        await start.mutateAsync({ scope: server.scope, rootPath, serverId: server.id })
      } else {
        await stop.mutateAsync({ serverId: server.id })
      }
      onChanged()
    } catch (error) {
      // Which server it was about travels in the sentence, the way the settings row says it: this line is
      // one for the whole panel, and a reader looking at nine rows needs to know which one it is about.
      onFailed(`${server.id}: ${actionErrorMessage(error)}`)
    }
  }

  return (
    <li
      data-slot="mcp-panel-row"
      data-row-id={server.id}
      data-row-scope={server.scope}
      data-row-status={row.status}
      className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-tight" title={server.id}>
          {server.id}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">
            {server.scope === 'user' ? 'User' : 'Project'}
          </Badge>
          {/*
           * What a process is offering, and only while one answers: a count with no process behind it is a
           * number about nothing. The state itself is drawn rather than written — the control at the end of
           * this row is the one place the rail says it.
           */}
          {row.running && row.toolCount !== null && (
            <span
              data-slot="mcp-panel-running"
              data-state="running"
              className="text-[11px] leading-tight text-muted-foreground tabular-nums"
            >
              {row.toolCount} {row.toolCount === 1 ? 'tool' : 'tools'}
            </span>
          )}
          {/*
           * The chip is drawn from the trust fact rather than from the status, because the two answer
           * different questions: a switched-off project server whose grant is missing is classified as
           * disabled — that is what the flag decides — and still needs trusting before it can run at all.
           */}
          {row.needsTrust && (
            <Badge
              data-slot="mcp-panel-trust-chip"
              variant="secondary"
              className="px-1 py-0 text-[10px] font-normal text-muted-foreground"
            >
              Needs trust
            </Badge>
          )}
        </div>
      </div>
      {/*
       * The row's one control over its process, and the switch that decides whether the server *may* run. Two
       * controls, in that order, because they are two answers: this one dispatches `startServer` or
       * `stopServer` and nothing else, and the switch beside it dispatches `setEnabled`. The glyph is the
       * status, so no word about it is written here, and the label says what the click will do to which
       * server for everything that cannot see a glyph.
       */}
      <Button
        data-slot="mcp-panel-process"
        data-glyph={control.glyph}
        data-action={control.action ?? 'none'}
        size="icon-xs"
        variant="ghost"
        aria-label={`${control.word} ${server.id}`}
        title={`${control.word} ${server.id}`}
        disabled={!control.enabled}
        onClick={() => {
          // A disabled button is handed no pointer in the first place; reading the action here is what keeps
          // a click that arrives anyway — a synthetic one, or a keyboard activation — from dispatching while
          // a call is in flight, when there is no action to dispatch.
          if (control.action) void run(control.action)
        }}
        className="mt-0.5 shrink-0"
      >
        {controlGlyph(control.glyph)}
      </Button>

      <Switch
        data-slot="mcp-panel-enabled"
        size="sm"
        aria-label={`${server.id} is enabled`}
        checked={server.enabled}
        disabled={pending}
        onCheckedChange={() => onToggle(row)}
        className="mt-0.5 shrink-0"
      />
    </li>
  )
}

/**
 * The four glyphs the rule names, as the marks this app already draws them with.
 *
 * The rule answers with a name and this maps it, which is what keeps the protocol layer free of components: a
 * status, a phase and a failure are decided in `conveyor/protocol/mcp-panel.ts`, and which icon that is is a
 * fact about this bundle.
 *
 * The spinner turns, and both it and the retry carry an existing token rather than a shade of their own: the
 * muted ink the row's own meta uses, which is what tells a reader that the control is waiting rather than
 * pressable, and the destructive ink the panel's failure line already uses, which is what tells them the
 * last attempt did not land. Both are the same difference in either theme, because both are tokens rather
 * than colours.
 */
function controlGlyph(glyph: McpServerButtonGlyph) {
  switch (glyph) {
    case 'play':
      return <Play />
    case 'stop':
      return <Square />
    case 'spinner':
      return <Loader2 className="animate-spin text-muted-foreground" />
    case 'retry':
      return <RotateCw className="text-destructive" />
  }
}
