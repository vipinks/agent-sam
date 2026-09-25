/**
 * The MCP servers panel's view rules: which rows the mirror's two reads become, which of them a query and
 * a status keep, and which page of them is showing.
 *
 * The counterpart of `protocol/skill-panel.ts`, and pure in the same way and for the same reason: a status
 * classification, a substring match and a page boundary are data in, data out, and a component that
 * computed them could only be checked by rendering it and reading the answer back out of the DOM. It is
 * also a separate module rather than three more exports in `protocol/mcp-settings.ts` because the two
 * answer different kinds of question: that module derives what the state of a *server* is, and this one
 * derives what a *list of servers* is shown as.
 *
 * Nothing here reads anything. The panel adds no command and no read of its own — it draws the mirror the
 * settings section already refreshes — and everything it does to that read is stated below.
 *
 * A row is one of four things, and the four are what the status filter names. A row is *running* when a
 * process answers for its id, *stopped* when the flag is on and nothing does, *disabled* when the file says
 * so, and *needs trust* when the row is a project server whose grant is absent or no longer matches the
 * config it was granted against. The four are not four readings of one field, so the interesting part is
 * their order, and it is: the flag, then trust, then the process. A row with the flag off is *disabled*
 * whatever the process list says, because a switched-off server is one the user has taken out of play and
 * that is the fact about it a reader is looking for. Trust outranks the running states because an untrusted
 * project server is one that cannot be started at all, whatever a process list derived from tools happens
 * to contain for its id. Only the sub-string match is borrowed outright: `matchesSkillQuery` asked with an
 * id and two empty fields is the same rule the Skills panel applies to its failures, and a second copy of
 * `toLowerCase().includes` would be a second chance for the two panels to disagree about what a search is.
 *
 * A per-record config failure is deliberately not a row here. The settings section reports those beside the
 * lists, where there is room to say what is wrong with the file; this panel's list is what can be found,
 * narrowed and switched, and a record that did not parse is none of those. The whole-listing failure is the
 * other way round: there is no list at all then, and the tab says so in the same words the section does.
 */
import type { McpScope, McpTrustState } from './mcp'
import type { McpRunningServer } from './mcp-settings'
import { matchesSkillQuery } from './skills'
import { paginateSkillPanelRows, type SkillPanelPage } from './skill-panel'

/** The four things a row of the panel's list can be, in the order the classification below decides them. */
export type McpPanelRowStatus = 'disabled' | 'needs-trust' | 'running' | 'stopped'

/** What the status filter offers, in the order it offers it. `all` is where the control starts. */
export const MCP_PANEL_STATUS_FILTERS = ['all', 'running', 'stopped', 'disabled', 'needs-trust'] as const

export type McpPanelStatusFilter = (typeof MCP_PANEL_STATUS_FILTERS)[number]

/**
 * The label each value is shown as.
 *
 * Beside the values rather than in the component, for the reason the Skills panel carries its own: one
 * list is what makes the control and the rule it feeds impossible to disagree.
 */
export const MCP_PANEL_STATUS_LABELS: Record<McpPanelStatusFilter, string> = {
  all: 'All statuses',
  running: 'Running',
  stopped: 'Stopped',
  disabled: 'Disabled',
  'needs-trust': 'Needs trust',
}

/** How many rows the panel shows at once. */
export const MCP_PANEL_PAGE_SIZE = 5

/**
 * The fields one row reads off a listing entry.
 *
 * Structural rather than the listing's own type, for the reason `protocol/mcp-settings.ts` takes the tool
 * list structurally: the renderer imports only `type AppRouter`, so the listing's shape is declared once on
 * the procedure that returns it, and this module states the subset it is a rule about. A config read that
 * grew a field would not need this file touched, and one that dropped a field below would fail to compile
 * where the row is built.
 */
export interface McpPanelServer {
  id: string
  scope: McpScope
  enabled: boolean
  /** Null for a user server: trust governs the project scope only, and is not consulted for one. */
  trust: McpTrustState | null
}

/** The two reads the panel draws, as of the mirror's last answer. */
export interface McpPanelSource {
  /** Both scopes as main reported them, or null before the first answer has landed. */
  listing: {
    user: readonly McpPanelServer[]
    project: readonly McpPanelServer[]
  } | null
  /** The servers a process answers for, derived from the live tool list. */
  running: readonly McpRunningServer[]
}

/** One server the panel draws, and may switch on or off. */
export interface McpPanelRow {
  server: McpPanelServer
  status: McpPanelRowStatus
  /** Whether a process answers for this row's id. Independent of the status, which trust and the flag both outrank. */
  running: boolean
  /** How many tools that process is offering, or null when there is no process to ask. */
  toolCount: number | null
  /**
   * Whether the row is a project server without a current grant, which is what the muted chip says.
   *
   * A fact of its own rather than the status in other words: a row switched off *and* untrusted is
   * classified as disabled and still needs trusting before it can run, so the chip is drawn from this
   * rather than from the classification.
   */
  needsTrust: boolean
}

/**
 * Whether a server is a project one whose grant is absent or no longer matches.
 *
 * Takes the two fields it reads rather than the whole row, because the classification below asks the same
 * question of a record before it has an id in hand.
 *
 * `matched` is the only state that is not this, and a project server that reported no state at all is
 * judged as needing trust: the comparison is between two files on the user's disk, so a record that carries
 * no answer is not a record that was found trusted.
 */
export function mcpServerNeedsTrust(server: { scope: McpScope; trust: McpTrustState | null }): boolean {
  if (server.scope !== 'project') return false
  return server.trust !== 'matched'
}

/**
 * Which of the four statuses one server's facts give it.
 *
 * The order is the rule, and each step is a different question: has the user taken it out of play, may it
 * run at all in this folder, and is a process answering for it. `running` is a fact the caller read from
 * the live tool list; the other three come off the record and the trust file.
 */
export function classifyMcpServer(input: {
  scope: McpScope
  enabled: boolean
  trust: McpTrustState | null
  running: boolean
}): McpPanelRowStatus {
  if (!input.enabled) return 'disabled'
  if (mcpServerNeedsTrust(input)) return 'needs-trust'
  return input.running ? 'running' : 'stopped'
}

/**
 * The rows one read draws.
 *
 * One list from two scopes, in the order the settings section draws the same read in — the user's servers,
 * then the project's, each in the order main reported it. One scan of the app must not look like two
 * different libraries depending on which surface is open, and the order inside a scope is main's, which has
 * already decided it.
 *
 * The running set is keyed by server id alone, which is what the derivation can say: the live tool list
 * names the server that offers a tool and not the scope it was started from. A user server and a project
 * server that share an id therefore both read as running. That is the read being reported honestly rather
 * than a gap this file could close — the alternative would be for a row to claim a process whose scope
 * nothing in the list records.
 */
export function mcpPanelRows(source: McpPanelSource): McpPanelRow[] {
  if (!source.listing) return []

  const rows: McpPanelRow[] = []
  for (const scope of ['user', 'project'] as const) {
    for (const server of source.listing[scope]) {
      const live = source.running.find((entry) => entry.serverId === server.id) ?? null
      const running = live !== null
      rows.push({
        server,
        status: classifyMcpServer({ scope: server.scope, enabled: server.enabled, trust: server.trust, running }),
        running,
        toolCount: live ? live.toolCount : null,
        needsTrust: mcpServerNeedsTrust(server),
      })
    }
  }
  return rows
}

/**
 * The rows a query keeps.
 *
 * A server record carries an id and no other text, so the id is the whole of what a search can match — the
 * same rule, asked of the same place, that the Skills panel asks of a file that would not load. A query of
 * only spaces is an empty query, which `matchesSkillQuery` already decides by trimming.
 */
export function filterMcpPanelRows(rows: readonly McpPanelRow[], query: string): McpPanelRow[] {
  const needle = query.trim()
  if (needle === '') return [...rows]
  return rows.filter((row) => matchesSkillQuery({ id: row.server.id, title: '', summary: '' }, needle))
}

/** The rows one status keeps. `all` keeps every row, which is where the control starts. */
export function filterMcpPanelRowsByStatus(rows: readonly McpPanelRow[], status: McpPanelStatusFilter): McpPanelRow[] {
  if (status === 'all') return [...rows]
  return rows.filter((row) => row.status === status)
}

/**
 * One page of rows, through the Skills panel's own helper.
 *
 * Not a parallel rule: that function is generic over the row shape and takes its page size as an argument,
 * so what it holds is the whole of what either panel does with a page — five at a time, clamped into range,
 * and a count line that collapses to one number when its two ends would repeat each other. The alias exists
 * so a caller of this file pages rows by a name this file owns, and so the page size below is the one this
 * panel states rather than one a reader has to go looking for.
 */
export const paginateMcpPanelRows = paginateSkillPanelRows

/** One page of rows, with the count line and the pager state that go with it. */
export type McpPanelPage<T> = SkillPanelPage<T>

/** One panel view: the window of rows, and what the counts say about it. */
export interface McpPanelView extends McpPanelPage<McpPanelRow> {
  /** How many rows the query and the status kept, before the window was taken. */
  matched: number
}

/**
 * The panel's whole view rule, in one place and in one order: filter, then status, then the window.
 *
 * One function rather than three calls at the call site because the order *is* the rule: windowing first
 * would count rows the query had already dropped, and taking the status after the window would leave a
 * switched-off row sitting on a page it was filtered out of — neither of which looks wrong on the first
 * page.
 */
export function planMcpPanelView(
  source: McpPanelSource,
  query: string,
  status: McpPanelStatusFilter,
  page: number
): McpPanelView {
  const rows = mcpPanelRows(source)
  const matched = filterMcpPanelRowsByStatus(filterMcpPanelRows(rows, query), status)
  return { ...paginateMcpPanelRows(matched, page, MCP_PANEL_PAGE_SIZE), matched: matched.length }
}
