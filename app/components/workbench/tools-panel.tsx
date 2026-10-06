/**
 * Tools: the right rail's fourth resident, and the panel its dock holds.
 *
 * The panel is the quick surface for the skills the app can work from — find them, narrow them, and switch
 * one on or off — and it is deliberately not the whole story. Creating, copying, deleting, editing, secrets
 * and trust stay on the settings screen's Skills section, which is the advanced surface and the only one
 * with room to say what a write will do. What this pane owns is the *view*: a count in the tab row, a
 * search box, a status filter, five rows at a time, one switch per row, and a way through to the rest.
 *
 * The row toggle is not a second way to switch a skill off. It dispatches the same `setSkillAvailability`
 * command the settings card does, with the same whole record and behind the same confirm dialog, which both
 * surfaces import rather than each keeping a copy — a skill's availability has one implementation and one
 * explanation.
 *
 * The tab row states two tabs, and each count sits inside its trigger rather than beside a heading: the
 * skills the listing holds, and the servers the mirror holds. Both counts are the panel's, so both reads are
 * the panel's — a body that owned a read could only report its total upwards, and the tab whose body did
 * would state its count a visit later than the other. Skills came first and stays first: appending a tab is
 * the change this row was written to take, and reordering it to match the settings sections' order would be
 * a change this turn has no reason to make.
 *
 * Which tab a reader is looking at is the panel's state, and so is the narrowing inside it: the query, the
 * status and the page. A tab that is not showing is not in the document, so state held inside a pane would
 * be state a reader loses by glancing at the other one. Held here, each tab's own search and page survive
 * the switch, and neither can overwrite the other's.
 *
 * MCP servers is the tab the panel opens on, while a tab the reader has chosen outranks it for as long as
 * the panel is mounted: the first thing someone opening Tools is looking for is the servers the agent can
 * reach, and the memory of their own choice is the selection they already had rather than a preference
 * written anywhere. The row's order is unchanged — Skills first, the servers second.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, TriangleAlert, Wrench } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { MCP_PANEL_STATUS_FILTERS } from '@/conveyor/protocol/mcp-panel'
import {
  planSkillPanelView,
  SKILL_PANEL_STATUS_FILTERS,
  SKILL_PANEL_STATUS_LABELS,
  type SkillPanelRow,
  type SkillPanelStatusFilter,
} from '@/conveyor/protocol/skill-panel'
import { tierKindOf, type SkillListing, type SkillLoadError, type SkillSummary } from '@/conveyor/protocol/skills'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { useMcpServersStore } from '@/conveyor/stores/mcp-servers'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { PaneHeader } from './pane-header'
import { usePanelNarrowing, type PanelNarrowing } from './panel-narrowing'
import { McpServersTabBody } from './mcp-tab'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'
import { WriteConfirm, type PendingConfirm } from './skills-confirm'
import { listingFailure, writeFailure } from './skills-notices'
import { useWorkbenchStore } from './store'

/**
 * The tools panel.
 *
 * The listing is read here rather than inside the tab so that the tab row can state its count: the count
 * belongs to the row of tabs, not to the body under it, and a body that owned the read could only report
 * its total upwards. One read, two places that state it.
 */
export function ToolsPanel() {
  const listing = conveyor.skills.listSkills.useQuery()
  const mcpListing = useMcpServersStore((s) => s.listing)
  const refreshMcp = useMcpServersStore((s) => s.refresh)
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const skillsNarrowing = usePanelNarrowing(SKILL_PANEL_STATUS_FILTERS)
  const mcpNarrowing = usePanelNarrowing(MCP_PANEL_STATUS_FILTERS)

  // The count in the MCP tab is the mirror's, so the read behind it is the panel's: made when the tab row is
  // drawn rather than when that tab is opened, which is what lets both counts be stated from the first
  // paint. The tab asks again for its own visit — see `McpServersTabBody` — because the panel stays mounted
  // while it is docked, and the settings screen can start, stop or delete a server in the meantime.
  useEffect(() => {
    void refreshMcp(rootPath)
  }, [refreshMcp, rootPath])

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={Wrench} title="Tools">
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      {/*
       * The tab row, and the panel's own body under it. `gap-0` because the row's bottom border is the
       * separator: a themed gap between them would draw a second one.
       */}
      <Tabs defaultValue="mcp" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border px-3 py-2">
          <TabsList data-slot="tools-tabs">
            <TabsTrigger value="skills" data-slot="tools-tab-skills">
              Skills
              {listing.data && (
                <span data-slot="tools-skills-count" className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">
                  {listing.data.counts.total}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="mcp" data-slot="tools-tab-mcp">
              MCP servers
              {mcpListing && (
                <span data-slot="tools-mcp-count" className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">
                  {mcpListing.user.length + mcpListing.project.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="skills" data-slot="tools-skills" className="min-h-0 flex-1 overflow-auto p-3">
          {listing.isPending && (
            <p data-slot="tools-skills-reading" className="text-[12.5px] text-muted-foreground">
              Reading the skill folders…
            </p>
          )}
          {/*
           * The whole-listing failure, in the settings section's own words: `listingFailure` is shared
           * rather than restated, so one code cannot end up with two explanations depending on which
           * surface happened to be open when the read failed.
           */}
          {listing.isError && (
            <p
              role="status"
              data-slot="tools-skills-read-error"
              className="text-[12.5px] leading-relaxed text-destructive"
            >
              {listingFailure(listing.error)}
            </p>
          )}
          {listing.data && (
            <SkillsTabBody
              listing={listing.data}
              narrowing={skillsNarrowing}
              onWritten={() => void listing.refetch()}
            />
          )}
        </TabsContent>

        {/*
         * The second tab: the same shell, and a body of its own, because what it draws comes from a
         * different read. Its rows, its filter and its page are `protocol/mcp-panel.ts`'s rules; what is
         * here is only the pane they are drawn in.
         */}
        <TabsContent value="mcp" data-slot="tools-mcp" className="min-h-0 flex-1 overflow-auto p-3">
          <McpServersTabBody narrowing={mcpNarrowing} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * One line for a list that came out empty, saying which of the two narrowings did it.
 *
 * The three are said apart rather than as one sentence because they call for different things: a query the
 * reader can clear, a status they can widen, and a project with no skills yet that they can only answer by
 * creating one — which is on the settings screen, and is what the button under this list is for.
 */
function emptyLine(query: string, status: SkillPanelStatusFilter): string {
  const typed = query.trim()
  if (typed !== '') return `No skills match “${typed}”.`
  if (status === 'load-error') return 'No skill failed to load.'
  if (status === 'hidden') return 'Every skill is available.'
  if (status === 'available') return 'No skill is available.'
  return 'No skills were found in this project or your skills folder.'
}

/** A stable key per row: an id is unique within a tier, and the tier is what makes it unique overall. */
function rowKey(row: SkillPanelRow): string {
  return row.status === 'load-error'
    ? `error:${row.error.tier}:${row.error.id}`
    : `skill:${row.skill.tier}:${row.skill.id}`
}

/**
 * The Skills tab: the quick surface's whole body.
 *
 * Which rows to show is `planSkillPanelView`'s decision, computed in one pass and memoised on its four
 * inputs; the narrowing it is computed from belongs to the panel rather than to this pane, because a tab's
 * search has to outlive the pane the tab is drawn in; and what is left here is the one write. The page it
 * *renders* is the view's rather than the state's, because the view clamps: a list that shortened under a
 * reader leaves a page number that no longer exists, and the honest answer is the last page there is.
 */
function SkillsTabBody({
  listing,
  narrowing,
  onWritten,
}: {
  listing: SkillListing
  narrowing: PanelNarrowing<SkillPanelStatusFilter>
  onWritten: () => void
}) {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const openSettingsAt = useWorkbenchStore((s) => s.openSettingsAt)

  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const availability = conveyor.skills.setSkillAvailability.useMutation()
  const view = useMemo(
    () => planSkillPanelView(listing, narrowing.query, narrowing.status, narrowing.page),
    [listing, narrowing.query, narrowing.status, narrowing.page]
  )

  const holders = pending ? sessions.filter((session) => session.activeSkillIds?.includes(pending.skill.id)).length : 0

  async function writeAvailability(): Promise<void> {
    if (!pending) return
    const { kind, skill } = pending
    try {
      await availability.mutateAsync({
        scope: skill.scope,
        tier: tierKindOf(skill.tier),
        skillId: skill.id,
        disabled: kind === 'disable',
      })
      setPending(null)
      setFailure(null)
      // The list is the disk's answer, so it is asked for again rather than patched here.
      onWritten()
    } catch (error) {
      // The confirm stays open: the write did not happen, and the row behind it still says what it said.
      setFailure(writeFailure(error))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Search skills"
          data-slot="tools-skills-search"
          value={narrowing.query}
          onChange={(event) => narrowing.setQuery(event.target.value)}
          placeholder="Search skills"
          className="h-7 min-w-0 flex-1 text-[12.5px]"
        />
        <Select value={narrowing.status} onValueChange={narrowing.setStatusValue}>
          <SelectTrigger
            aria-label="Filter by status"
            data-slot="tools-skills-status"
            className="h-7 w-[9.5rem] shrink-0 text-[12.5px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_PANEL_STATUS_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {SKILL_PANEL_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {view.rows.length === 0 ? (
        <p data-slot="tools-skills-nomatch" className="px-1 py-2 text-[12.5px] text-muted-foreground">
          {emptyLine(narrowing.query, narrowing.status)}
        </p>
      ) : (
        <ul data-slot="skill-panel-list" className="flex flex-col gap-1.5">
          {view.rows.map((row) => (
            <SkillPanelRowView key={rowKey(row)} row={row} onAsk={setPending} />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <span data-slot="tools-skills-range" className="text-[11.5px] text-muted-foreground tabular-nums">
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
       * The way out to the advanced surface. Creating, copying, deleting and editing a skill are not things
       * this pane can do well in a column this narrow, and the panel-first rule says as much: a new setting
       * lives here first, and settings keeps only what this surface cannot carry. So this is a door rather
       * than a row of controls, and it opens on the section that has them.
       */}
      <Button
        type="button"
        variant="outline"
        data-slot="tools-manage"
        onClick={() => openSettingsAt('skills')}
        className="w-full text-[12.5px]"
      >
        Manage Skills
      </Button>

      <WriteConfirm
        pending={pending}
        failure={failure}
        holders={holders}
        projectDir={null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null)
            setFailure(null)
          }
        }}
        onConfirm={() => void writeAvailability()}
      />
    </div>
  )
}

/** One row of the list: a skill with its switch, or a file that would not load. */
function SkillPanelRowView({ row, onAsk }: { row: SkillPanelRow; onAsk: (pending: PendingConfirm) => void }) {
  if (row.status === 'load-error') return <SkillErrorRow error={row.error} />
  return <SkillRow skill={row.skill} status={row.status} onAsk={onAsk} />
}

/**
 * One skill.
 *
 * The summary is one truncated line rather than absent, because it is how a reader who does not remember
 * the id recognises the skill — and the whole of it travels in `title` for the reason the pane headers do
 * that: a truncated string nobody can recover is a truncated string nobody can read. The two badges are
 * the scope and the tier kind, which is what says where the row came from and who may change it.
 */
function SkillRow({
  skill,
  status,
  onAsk,
}: {
  skill: SkillSummary
  status: 'available' | 'hidden'
  onAsk: (pending: PendingConfirm) => void
}) {
  const hidden = status === 'hidden'

  return (
    <li
      data-slot="skill-panel-row"
      data-row-status={status}
      data-row-id={skill.id}
      className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-tight" title={skill.title}>
          {skill.title}
        </p>
        <p className="truncate text-[11px] leading-tight text-muted-foreground" title={skill.summary}>
          {skill.summary || skill.id}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal">
            {skill.scope}
          </Badge>
          <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">
            {tierKindOf(skill.tier)}
          </Badge>
        </div>
      </div>
      <Switch
        aria-label={`${skill.title} is available`}
        checked={!hidden}
        onCheckedChange={() => onAsk({ kind: hidden ? 'enable' : 'disable', skill })}
        className="mt-0.5 shrink-0"
      />
    </li>
  )
}

/**
 * One file that would not load, as a row of the same list.
 *
 * No switch and no badges: there is nothing here to toggle, and main's own sentence about the failure is
 * the most useful thing that can be said about it. It is drawn in the same list as the skills rather than
 * in a section of its own because the filter's third value is how a reader asks for these on their own,
 * and because a list a reader pages through is the whole shape of this panel.
 */
function SkillErrorRow({ error }: { error: SkillLoadError }) {
  return (
    <li
      data-slot="skill-panel-row"
      data-row-status="load-error"
      data-row-id={error.id}
      className="flex items-start gap-2 rounded-md border border-destructive/35 bg-card px-2.5 py-2"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-tight" title={error.id}>
          {error.id}
        </p>
        <p className="text-[11px] leading-tight break-words text-muted-foreground">
          {`${error.tier} — ${error.message} (${error.code})`}
        </p>
      </div>
    </li>
  )
}
