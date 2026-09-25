/**
 * Verifies the MCP servers panel's view rules: which rows the mirror's two reads become, which of them a
 * query and a status keep, and which page of them is showing.
 *
 * The counterpart of `skills/skills-panel-test.ts`, and pure for the same reason: what a status classifies,
 * what a query matches and where a page begins are data in, data out, and a page boundary is exactly the
 * kind of off-by-one a render hides behind a plausible-looking first page.
 *
 * The status table is the interesting one. It is not a reading of one field — a row is *running* because a
 * process answers for it, *disabled* because the file says so, and *needs trust* because a project's grant
 * no longer matches its config, and those three facts can be true of one server at once. Every pair below
 * is therefore an assertion about precedence rather than about a field, and the disabled-and-untrusted case
 * is written out rather than left to be inferred: the approved rule names what needs trust outranks
 * (running and stopped) and says a disabled row is disabled regardless of its running state, so a disabled
 * row that is also untrusted classifies as the flag it carries, not as the trust it lacks.
 *
 * The listing is written here rather than read from a file: what a config file parse does is another
 * suite's subject. What matters below is the shape main hands over — the two scopes, a trust state per
 * project server, and the live tool list the running set is derived from.
 */
import { strict as assert } from 'node:assert'
import {
  classifyMcpServer,
  filterMcpPanelRows,
  filterMcpPanelRowsByStatus,
  MCP_PANEL_PAGE_SIZE,
  MCP_PANEL_STATUS_FILTERS,
  MCP_PANEL_STATUS_LABELS,
  mcpPanelRows,
  mcpServerNeedsTrust,
  paginateMcpPanelRows,
  planMcpPanelView,
  type McpPanelRow,
  type McpPanelRowStatus,
  type McpPanelServer,
  type McpPanelSource,
} from '../../conveyor/protocol/mcp-panel'
import type { McpRunningServer } from '../../conveyor/protocol/mcp-settings'
import type { McpScope, McpTrustState } from '../../conveyor/protocol/mcp'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** One server, with the fields the panel reads filled in the way a config read fills them. */
function server(scope: McpScope, id: string, enabled: boolean, trust: McpTrustState | null = null): McpPanelServer {
  return { id, scope, enabled, trust: scope === 'project' ? (trust ?? 'absent') : null }
}

/** One running server as the tool list derives it: an id and how many tools it is offering. */
function running(serverId: string, toolCount: number): McpRunningServer {
  return { serverId, toolCount }
}

/**
 * Three user servers and six project ones, arranged so every status rule has a row to be wrong about.
 *
 * `atlas` is the pair that matters: it is running *and* its grant is absent, so it is the row that tells
 * "needs trust outranks running" apart from "running wins"; `legacy` is switched off *and* untrusted, so
 * it is the row that tells the disabled rule apart from the trust rule. `filesystem` and `github` are the
 * two runners, one per scope, and both are trusted where trust applies.
 *
 * Nine rows is the size the composition assertions need: the query used there keeps six of them, so the
 * second page it produces is a short page of the *filtered* set — which is the only way a rule that took
 * the window before the filter could be told apart from one that took it after.
 *
 * Ids are distinct across the scopes on purpose, because the running set is keyed by id alone — see the
 * note on `mcpPanelRows`. A fixture with twins would be asserting an answer this read cannot give.
 */
const SOURCE: McpPanelSource = {
  listing: {
    user: [server('user', 'filesystem', true), server('user', 'memory', true), server('user', 'playwright', false)],
    project: [
      server('project', 'github', true, 'matched'),
      // Running with no grant at all: the precedence pair.
      server('project', 'atlas', true, 'absent'),
      server('project', 'notes', true, 'mismatched'),
      // Switched off and untrusted: the other precedence pair.
      server('project', 'legacy', false, 'absent'),
      server('project', 'serena', true, 'matched'),
      // Trusted and stopped, and the sixth id the query below matches: a row whose only job here is to be
      // on a page the first one does not reach.
      server('project', 'chrome-devtools', true, 'matched'),
    ],
  },
  running: [running('filesystem', 2), running('github', 3), running('atlas', 1)],
}

/** The ids of a set of rows, which is what a filter claim is really about. */
function ids(rows: readonly McpPanelRow[]): string[] {
  return rows.map((row) => row.server.id)
}

/** One row's status, by id. */
function statusOf(rows: readonly McpPanelRow[], id: string): McpPanelRowStatus | 'missing' {
  return rows.find((row) => row.server.id === id)?.status ?? 'missing'
}

// ---------------------------------------------------------------- classification

function everyRowStatusIsClassifiedByOneStatedPrecedence() {
  const rows = mcpPanelRows(SOURCE)

  // The four statuses, each read off its own ordinary row: a flag that is on with a process behind it, a
  // flag that is on without one, a flag that is off, and a project grant that is not a grant.
  assert.equal(statusOf(rows, 'filesystem'), 'running', 'running is the flag plus an answer for the id')
  assert.equal(statusOf(rows, 'github'), 'running', 'a trusted project server runs the same way')
  assert.equal(statusOf(rows, 'memory'), 'stopped', 'an enabled server with no tools behind it is stopped')
  assert.equal(statusOf(rows, 'playwright'), 'disabled', 'the flag decides before the process does')

  // Trust outranks both of the running states. `atlas` is the assertion that matters: it is running, and
  // the rule says the missing grant is what the row is about.
  assert.equal(statusOf(rows, 'atlas'), 'needs-trust', 'needs trust outranks running')
  assert.equal(statusOf(rows, 'notes'), 'needs-trust', 'a grant that no longer matches also needs trust')

  // The disabled rule, stated as the absolute it is: the flag decides whatever the process list says, and
  // whatever the trust file says. `legacy` is off and untrusted at once, and the row is about the flag.
  assert.equal(
    classifyMcpServer({ scope: 'user', enabled: false, trust: null, running: true }),
    'disabled',
    'a switched-off server is disabled even while it is running'
  )
  assert.equal(statusOf(rows, 'legacy'), 'disabled', 'and a switched-off untrusted server is disabled too')

  // The same verdicts asked of the rule directly, so a table row here cannot pass by agreeing with
  // `mcpPanelRows` about a fixture rather than about a rule.
  assert.equal(classifyMcpServer({ scope: 'project', enabled: true, trust: 'matched', running: false }), 'stopped')
  assert.equal(classifyMcpServer({ scope: 'project', enabled: true, trust: null, running: false }), 'needs-trust')
  // Trust governs the project scope only: a user server that carries a state anyway is not judged by it.
  assert.equal(classifyMcpServer({ scope: 'user', enabled: true, trust: 'mismatched', running: false }), 'stopped')
  // And the chip's own condition, which is independent of the status: it is drawn for every project row
  // whose grant is not current, whether or not that is what the row is classified as.
  assert.equal(mcpServerNeedsTrust(server('project', 'legacy', false, 'absent')), true)
  assert.equal(mcpServerNeedsTrust(server('project', 'github', true, 'matched')), false)
  assert.equal(mcpServerNeedsTrust(server('user', 'filesystem', true)), false)

  results.push('a row is one of four statuses, in one order: disabled, needs trust, running, stopped')
}

// ---------------------------------------------------------------- rows

function theTwoScopesBecomeRowsWithTheFactsARowDraws() {
  // No answer yet is an empty list rather than an error: the mirror holds the last read, and a read that
  // has not landed has nothing to draw.
  assert.deepEqual(mcpPanelRows({ listing: null, running: SOURCE.running }), [], 'no listing is no rows')

  const rows = mcpPanelRows(SOURCE)

  // One order, and it is the order the settings section draws the same two reads in: the user's servers,
  // then the project's, each in the order main reported them.
  assert.deepEqual(ids(rows), [
    'filesystem',
    'memory',
    'playwright',
    'github',
    'atlas',
    'notes',
    'legacy',
    'serena',
    'chrome-devtools',
  ])

  // The facts beside the status, which are what the row's other marks are drawn from: whether a process
  // answers for the id, with how many tools, and whether the row is a project one without a current grant.
  const file = rows[0]
  assert.equal(file?.running, true)
  assert.equal(file?.toolCount, 2)
  assert.equal(file?.needsTrust, false)
  const memory = rows[1]
  assert.equal(memory?.running, false, 'a stopped server claims no process')
  assert.equal(memory?.toolCount, null, 'and no tool count to state')
  const legacy = rows.find((row) => row.server.id === 'legacy')
  assert.equal(legacy?.status, 'disabled')
  assert.equal(legacy?.needsTrust, true, 'the chip is a fact of its own, not the status in other words')

  results.push('the two scopes become one list of rows, each carrying the facts its marks are drawn from')
}

// ---------------------------------------------------------------- text filter

function aQueryMatchesTheServerIdAndNothingElse() {
  const rows = mcpPanelRows(SOURCE)

  // An empty query keeps everything, and a query of nothing but spaces is an empty query.
  assert.deepEqual(ids(filterMcpPanelRows(rows, '')), ids(rows))
  assert.deepEqual(ids(filterMcpPanelRows(rows, '   ')), ids(rows))

  // Case-insensitive, and matched anywhere in the id: filesystem is found by three different spellings.
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'FILE')), ['filesystem'])
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'System')), ['filesystem'])
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'GitHub')), ['github'])
  // Surrounding space is typed by accident, so it is trimmed rather than matched.
  assert.deepEqual(ids(filterMcpPanelRows(rows, '  atlas  ')), ['atlas'])

  // A record carries an id and nothing else to search, so a word that is everywhere on the screen but in
  // no id matches nothing: scope and status are not searched, because they are not text a record has.
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'project')), [])
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'stopped')), [])
  assert.deepEqual(ids(filterMcpPanelRows(rows, 'nothing-like-this')), [])

  results.push('a query matches the server id, case-insensitively, and nothing else')
}

// ---------------------------------------------------------------- status filter

function theStatusFilterKeepsOneStatusOrAllOfThem() {
  const rows = mcpPanelRows(SOURCE)

  // The five values, in the order the control offers them, with the label each is shown as: one list, so
  // the control and the rule it feeds cannot disagree.
  assert.deepEqual([...MCP_PANEL_STATUS_FILTERS], ['all', 'running', 'stopped', 'disabled', 'needs-trust'])
  assert.deepEqual(MCP_PANEL_STATUS_LABELS, {
    all: 'All statuses',
    running: 'Running',
    stopped: 'Stopped',
    disabled: 'Disabled',
    'needs-trust': 'Needs trust',
  })

  assert.deepEqual(ids(filterMcpPanelRowsByStatus(rows, 'all')), ids(rows), 'all keeps every row')
  // `atlas` is running and is not here: the status that outranks running is what the row is about.
  assert.deepEqual(ids(filterMcpPanelRowsByStatus(rows, 'running')), ['filesystem', 'github'])
  assert.deepEqual(ids(filterMcpPanelRowsByStatus(rows, 'stopped')), ['memory', 'serena', 'chrome-devtools'])
  assert.deepEqual(ids(filterMcpPanelRowsByStatus(rows, 'disabled')), ['playwright', 'legacy'])
  assert.deepEqual(ids(filterMcpPanelRowsByStatus(rows, 'needs-trust')), ['atlas', 'notes'])

  // Every row lands in exactly one of the four, and the four together are the listing: a row that fell out
  // of all of them would be a server no filter could reach.
  const everyStatus: McpPanelRowStatus[] = ['running', 'stopped', 'disabled', 'needs-trust']
  assert.deepEqual(
    everyStatus.flatMap((status) => ids(filterMcpPanelRowsByStatus(rows, status))).sort(),
    ids(rows).sort()
  )

  results.push('the status filter keeps one of the four statuses, or all of them')
}

// ---------------------------------------------------------------- pagination

function aPageIsFiveRowsAndTheLastOneIsShort() {
  const rows = mcpPanelRows(SOURCE)
  assert.equal(MCP_PANEL_PAGE_SIZE, 5)

  // The whole set, through the same helper the Skills panel pages through: nine rows is two pages, the
  // second of them short by four, and the line names which rows it is holding rather than how many.
  const first = paginateMcpPanelRows(rows, 1)
  assert.deepEqual(ids(first.rows), ['filesystem', 'memory', 'playwright', 'github', 'atlas'])
  assert.equal(first.page, 1)
  assert.equal(first.pageCount, 2)
  assert.equal(first.total, 9)
  assert.equal(first.range, '1–5 of 9')

  const second = paginateMcpPanelRows(rows, 2)
  assert.deepEqual(ids(second.rows), ['notes', 'legacy', 'serena', 'chrome-devtools'])
  assert.equal(second.range, '6–9 of 9')

  // A page past the end is clamped into range rather than drawn empty, and a page below the start is the
  // first one: the page number is a reader's choice and the list can shorten under it.
  assert.equal(paginateMcpPanelRows(rows, 9).page, 2)
  assert.equal(paginateMcpPanelRows(rows, 0).page, 1)
  assert.equal(paginateMcpPanelRows(rows, Number.NaN).page, 1)

  // A list with one row has one page and a count line that is a single number rather than a range.
  const one = paginateMcpPanelRows([rows[0] as McpPanelRow], 1)
  assert.equal(one.pageCount, 1)
  assert.equal(one.range, '1 of 1')

  // Nothing at all is one empty page rather than no page, so the pager has a state to be disabled in.
  const none = paginateMcpPanelRows([], 1)
  assert.deepEqual(none.rows, [])
  assert.equal(none.pageCount, 1)
  assert.equal(none.first, 0)
  assert.equal(none.last, 0)
  assert.equal(none.range, '0 of 0')

  results.push('a page is five rows, the last one short, and a page past the end is clamped')
}

// ---------------------------------------------------------------- composition

function theWindowIsTakenAfterTheFilterAndTheStatus() {
  // The query keeps six of the nine — `playwright`, `github` and `atlas` are not in it — so the second page
  // it produces is the second page of those six and not rows six and seven of the listing.
  const filtered = planMcpPanelView(SOURCE, 'e', 'all', 2)
  assert.equal(filtered.total, 6)
  assert.equal(filtered.matched, 6)
  assert.equal(filtered.pageCount, 2)
  assert.equal(filtered.range, '6 of 6')
  assert.deepEqual(ids(filtered.rows), ['chrome-devtools'])

  // Status, then page: two of those six need trust, one of which the query had already dropped.
  const needsTrust = planMcpPanelView(SOURCE, 'e', 'needs-trust', 1)
  assert.equal(needsTrust.matched, 1)
  assert.deepEqual(ids(needsTrust.rows), ['notes'])
  assert.equal(needsTrust.range, '1 of 1')

  // Disabled rows, with the window taken third: two of the nine.
  const disabled = planMcpPanelView(SOURCE, '', 'disabled', 1)
  assert.deepEqual(ids(disabled.rows), ['playwright', 'legacy'])
  assert.equal(disabled.total, 2)

  // Filter and status both, over a page the reader chose before either was applied: the page is clamped
  // rather than honoured, which is the state a query typed on page two leaves behind.
  const clamped = planMcpPanelView(SOURCE, 'e', 'stopped', 3)
  assert.equal(clamped.page, 1)
  assert.deepEqual(ids(clamped.rows), ['memory', 'serena', 'chrome-devtools'])

  // Everything filtered away is an empty view rather than an error.
  const nothing = planMcpPanelView(SOURCE, '', 'running', 2)
  assert.equal(nothing.matched, 2)
  assert.equal(nothing.pageCount, 1)

  // And with no read at all, every value is empty rather than throwing: the tab is drawn before the first
  // answer lands.
  const unread = planMcpPanelView({ listing: null, running: [] }, 'filesystem', 'running', 1)
  assert.equal(unread.matched, 0)
  assert.deepEqual(unread.rows, [])
  assert.equal(unread.range, '0 of 0')

  results.push('the composition is filter, then status, then the window of five')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('rows', theTwoScopesBecomeRowsWithTheFactsARowDraws)
  step('classification', everyRowStatusIsClassifiedByOneStatedPrecedence)
  step('text filter', aQueryMatchesTheServerIdAndNothingElse)
  step('status filter', theStatusFilterKeepsOneStatusOrAllOfThem)
  step('pagination', aPageIsFiveRowsAndTheLastOneIsShort)
  step('composition', theWindowIsTakenAfterTheFilterAndTheStatus)

  console.log(`mcp panel: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err: unknown) {
  console.error('MCP PANEL TEST FAILED:', err)
  process.exit(1)
}
