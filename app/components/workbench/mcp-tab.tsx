/**
 * The MCP servers tab: the tools panel's second surface, and for the servers this app runs what the Skills
 * tab is for the skills it works from.
 *
 * The panel is the place to *find* a server, not the place to run one. It draws what the mirror store
 * already read — the two config files, and the live tool list the running set is derived from — and what it
 * offers is exactly one write: the switch on a row, which dispatches the settings section's own
 * `mcp.setEnabled` with the payload that section sends, scope and all. Starting, stopping, trusting, secrets,
 * logs, adding and deleting stay on the settings screen, which is the advanced surface and the only one with
 * room to say what a write will do; the button at the foot of this list is the door to it.
 *
 * Nothing here is a rule about a listing. Which rows the two reads become, which of them a query and a status
 * keep, and which page is showing are `conveyor/protocol/mcp-panel.ts`'s, asserted without a render; what is
 * left here is the state a reader moves — kept by the panel, so a switch of tabs does not lose it — and the
 * one command.
 *
 * A row states the four things a reader scanning a list needs: which server it is, which scope it came from,
 * whether a process is answering for it and with how many tools, and — for a project server whose grant is
 * absent or no longer matches — that it needs trust. The command line is deliberately not among them; the
 * settings row carries it, and at this width it would push the marks that fit.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import {
  MCP_PANEL_STATUS_FILTERS,
  MCP_PANEL_STATUS_LABELS,
  planMcpPanelView,
  type McpPanelRow,
  type McpPanelStatusFilter,
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
 * asked. A failed switch is drawn beside the list for the same kind of reason: the row still says what it
 * said, because the write did not happen.
 */
export function McpServersTabBody({ narrowing }: { narrowing: PanelNarrowing<McpPanelStatusFilter> }) {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const listing = useMcpServersStore((s) => s.listing)
  const running = useMcpServersStore((s) => s.running)
  const loading = useMcpServersStore((s) => s.loading)
  const readError = useMcpServersStore((s) => s.error)
  const refresh = useMcpServersStore((s) => s.refresh)
  const openSettingsAt = useWorkbenchStore((s) => s.openSettingsAt)

  /** What the last switch that failed had to say, in the shared words for its code. */
  const [writeFailure, setWriteFailure] = useState<string | null>(null)

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
   * The one write this panel makes, and it is the settings section's: the same command, the same whole
   * payload — the row's own scope, the folder that is open, the id, and the flag turned over. It never
   * starts and never stops anything: the flag says whether a server *may* run, and a panel that started a
   * process would be doing the one thing the panel-first rule keeps on the advanced surface.
   */
  async function toggle(row: McpPanelRow): Promise<void> {
    try {
      await setEnabled.mutateAsync({
        scope: row.server.scope,
        rootPath,
        serverId: row.server.id,
        enabled: !row.server.enabled,
      })
      setWriteFailure(null)
      // The list is the disk's answer, so it is asked for again rather than patched here.
      void refresh(rootPath)
    } catch (error) {
      setWriteFailure(actionErrorMessage(error))
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

      {writeFailure && (
        <p role="status" data-slot="tools-mcp-write-error" className="text-[12.5px] leading-relaxed text-destructive">
          {writeFailure}
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
              pending={setEnabled.isPending}
              onToggle={toggle}
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
 * One server, and the one thing this panel may do to it.
 *
 * The id is the title and the whole of the text: a server record has no summary, and inventing one from a
 * command line would put words about a process in a row that is not running one. The scope is a badge rather
 * than a second list, because the panel is one flat list a reader pages through — the settings section is
 * where the two scopes are drawn apart. The running line is stated the way the settings row states it, so one
 * server does not read as two different things depending on which surface is open.
 */
function McpRowView({
  row,
  pending,
  onToggle,
}: {
  row: McpPanelRow
  pending: boolean
  onToggle: (row: McpPanelRow) => void
}) {
  const { server } = row

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
          <span
            data-slot="mcp-panel-running"
            data-state={row.running ? 'running' : 'stopped'}
            className="text-[11px] leading-tight text-muted-foreground tabular-nums"
          >
            {row.running ? `Running · ${row.toolCount} ${row.toolCount === 1 ? 'tool' : 'tools'}` : 'Stopped'}
          </span>
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
