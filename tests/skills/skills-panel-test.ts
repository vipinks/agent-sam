/**
 * Verifies the Skills panel's view rules: which rows a listing offers, which a query and a status keep,
 * and which page of them is showing.
 *
 * Asserted against the real protocol module and a listing fixture rather than through a render, for the
 * reason the other rules suites give: what a query matches, what a status classifies and where a page
 * begins are data in, data out. A page boundary is exactly the kind of off-by-one a render hides behind
 * a plausible-looking first page — the last partial page is where a windowing rule is wrong and still
 * looks right.
 *
 * The listing is written here rather than scanned, because a scan is another suite's subject. What
 * matters below is the shape main hands over: four tiers in precedence order, the per-file failures
 * beside them, and the switches that apply to the folders this listing read.
 */
import { strict as assert } from 'node:assert'
import {
  classifySkillEntry,
  filterSkillPanelRows,
  filterSkillPanelRowsByStatus,
  paginateSkillPanelRows,
  planSkillPanelView,
  SKILL_PANEL_PAGE_SIZE,
  SKILL_PANEL_STATUS_FILTERS,
  SKILL_PANEL_STATUS_LABELS,
  skillPanelRows,
} from '../../conveyor/protocol/skill-panel'
import type {
  SkillListing,
  SkillScope,
  SkillSummary,
  SkillTierId,
  SkillTierListing,
} from '../../conveyor/protocol/skills'

const results: string[] = []

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

/** One row of a tier, with the fields the panel reads filled in the way a scan fills them. */
function skill(tier: SkillTierId, id: string, title: string, summary = ''): SkillSummary {
  const scope: SkillScope = tier.startsWith('project') ? 'project' : 'user'
  return { id, scope, tier, title, summary, tags: [], sourcePath: `C:/w/${tier}/${id}/SKILL.md` }
}

function tier(tierId: SkillTierId, skills: SkillSummary[]): SkillTierListing {
  const scope: SkillScope = tierId.startsWith('project') ? 'project' : 'user'
  return {
    tier: tierId,
    scope,
    kind: tierId.endsWith('native') ? 'native' : 'compat',
    sourceDir: `C:/w/${tierId}`,
    skills,
  }
}

/**
 * A library of thirteen skills and one file that would not load, with two of the rows switched off.
 *
 * The sizes are chosen rather than arbitrary: fourteen rows is three pages at five apiece with a partial
 * last page, and the word "notes" appears in exactly the seven user-tier rows — one of them switched off
 * — so a query that keeps seven of them still spans two pages. Both are what the composition
 * assertions need.
 */
const LISTING: SkillListing = {
  tiers: [
    tier('project-native', [
      skill('project-native', 'ship-it', 'Ship It', 'Cut a release and tag it.'),
      skill('project-native', 'code-review', 'Code Review', 'Review a diff before it lands.'),
      skill('project-native', 'alpha', 'Alpha', 'The first letter, at length.'),
      skill('project-native', 'bravo', 'Bravo'),
      skill('project-native', 'charlie', 'Charlie'),
      skill('project-native', 'delta', 'Delta'),
    ]),
    tier('project-compat', []),
    tier('user-native', [
      skill('user-native', 'echo', 'Echo', 'Personal notes for the weekly sync.'),
      skill('user-native', 'golf', 'Release Ship Notes', 'Written by another tool.'),
      skill('user-native', 'hotel', 'Hotel', 'Notes on how to ship a release safely.'),
      skill('user-native', 'india', 'India', 'Notes about the deploy checklist.'),
      skill('user-native', 'juliett', 'Juliett', 'Notes on the migration.'),
      skill('user-native', 'kilo', 'Kilo', 'Notes for the on-call rota.'),
      skill('user-native', 'lima', 'Lima', 'Notes, kept for reference.'),
    ]),
    tier('user-compat', []),
  ],
  errors: [
    {
      id: 'broken-one',
      scope: 'project',
      tier: 'project-native',
      code: 'SKILL_MANIFEST_INVALID',
      message: 'The manifest block is not readable.',
    },
  ],
  disabled: [
    { tier: 'project-native', rootPath: 'C:/w', skillId: 'ship-it' },
    { tier: 'user-native', rootPath: null, skillId: 'lima' },
  ],
  counts: { total: 13, project: 6, user: 7, errors: 1, hidden: 2 },
}

/** The ids a set of rows is about, in the order the rows hold them. */
function ids(rows: ReadonlyArray<{ skill?: { id: string }; error?: { id: string } }>): string[] {
  return rows.map((row) => row.skill?.id ?? row.error?.id ?? '?')
}

/** How many rows carry one status, which is the readable form of a fourteen-entry array. */
function countOfStatus(rows: ReadonlyArray<{ status: string }>, status: string): number {
  return rows.filter((row) => row.status === status).length
}

// ---------------------------------------------------------------- the rows a listing offers

function theListingBecomesRowsInOneStatedOrder() {
  const rows = skillPanelRows(LISTING)

  // Errors first, then the tiers in the listing's own order: the same order the Settings tab draws this
  // listing in, so the two surfaces cannot show a reader a different list for one read.
  assert.equal(rows.length, 14)
  assert.equal(rows[0]?.status, 'load-error')
  assert.deepEqual(ids(rows).slice(0, 3), ['broken-one', 'ship-it', 'code-review'])
  assert.deepEqual(ids(rows).slice(-2), ['kilo', 'lima'])

  // Every row carries its own classification, from the listing's own fields: one failure, and of the
  // thirteen skills two are switched off — one in a project tier, one in a user tier.
  assert.equal(countOfStatus(rows, 'load-error'), 1)
  assert.equal(countOfStatus(rows, 'hidden'), 2)
  assert.equal(countOfStatus(rows, 'available'), 11)

  // The switch written for the project folder is read as one: `ship-it` is hidden by an entry naming
  // this listing's root, exactly as the Settings card classifies it.
  assert.equal(rows.find((row) => row.status !== 'load-error' && row.skill.id === 'ship-it')?.status, 'hidden')

  results.push('a listing becomes rows: errors first, then the tiers, each classified against its switches')
}

// ---------------------------------------------------------------- classification

function everyRowStatusIsClassifiedFromTheListingsOwnFields() {
  // Available: a skill with no entry against it.
  assert.equal(classifySkillEntry(LISTING, { id: 'charlie', tier: 'project-native' }), 'available')

  // Hidden: a skill an entry names, in the tier and folder the entry names.
  assert.equal(classifySkillEntry(LISTING, { id: 'lima', tier: 'user-native' }), 'hidden')
  assert.equal(classifySkillEntry(LISTING, { id: 'ship-it', tier: 'project-native' }), 'hidden')

  // Load error: a file main reported rather than a row it drew.
  assert.equal(classifySkillEntry(LISTING, { id: 'broken-one', tier: 'project-native' }), 'load-error')

  // The three are told apart by the fields and not by position: the same id in another tier is another
  // row's answer, and an id that is only a failure is not also a skill.
  assert.equal(classifySkillEntry(LISTING, { id: 'charlie', tier: 'user-native' }), 'available')

  // Every status the filter offers is one of the three, with the label the filter shows for it.
  assert.deepEqual([...SKILL_PANEL_STATUS_FILTERS], ['all', 'available', 'hidden', 'load-error'])
  assert.equal(SKILL_PANEL_STATUS_LABELS.all, 'All statuses')
  assert.equal(SKILL_PANEL_STATUS_LABELS.available, 'Available')
  assert.equal(SKILL_PANEL_STATUS_LABELS.hidden, 'Hidden')
  assert.equal(SKILL_PANEL_STATUS_LABELS['load-error'], 'Load error')

  results.push('a row is available, hidden or a load error, read from the listing fields alone')
}

// ---------------------------------------------------------------- the text filter

function aQueryMatchesTheIdTheTitleAndTheSummary() {
  const rows = skillPanelRows(LISTING)

  // One needle, three fields, three different rows: the id of one, the title of the next, and the
  // summary of the third — which is what makes this a claim about all three rather than about one.
  assert.deepEqual(ids(filterSkillPanelRows(rows, 'SHIP')), ['ship-it', 'golf', 'hotel'])

  // Case-insensitive, and a plain substring rather than a pattern.
  assert.deepEqual(ids(filterSkillPanelRows(rows, 'ship')), ids(filterSkillPanelRows(rows, 'SHIP')))
  assert.deepEqual(ids(filterSkillPanelRows(rows, '  code-rev  ')), ['code-review'])

  // An untouched box is not a filter that matches nothing.
  assert.equal(filterSkillPanelRows(rows, '').length, 14)
  assert.equal(filterSkillPanelRows(rows, '   ').length, 14)

  // A failure is matched on the name it is reported under, which is the only text it has.
  assert.deepEqual(ids(filterSkillPanelRows(rows, 'broken')), ['broken-one'])

  // Nothing matches nothing, rather than everything.
  assert.deepEqual(filterSkillPanelRows(rows, 'no-such-skill'), [])

  results.push('the query matches the id, the title and the summary, case-insensitively')
}

// ---------------------------------------------------------------- the status filter

function theStatusFilterKeepsOneStatusOrAllOfThem() {
  const rows = skillPanelRows(LISTING)

  assert.equal(filterSkillPanelRowsByStatus(rows, 'all').length, 14)
  assert.equal(filterSkillPanelRowsByStatus(rows, 'available').length, 11)
  assert.deepEqual(ids(filterSkillPanelRowsByStatus(rows, 'hidden')), ['ship-it', 'lima'])
  assert.deepEqual(ids(filterSkillPanelRowsByStatus(rows, 'load-error')), ['broken-one'])

  results.push('the status filter keeps available, hidden or errored rows, or every row')
}

// ---------------------------------------------------------------- pagination

function aPageIsFiveRowsAndTheLastOneIsShort() {
  assert.equal(SKILL_PANEL_PAGE_SIZE, 5)

  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']

  const first = paginateSkillPanelRows(rows, 1)
  assert.deepEqual(first.rows, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(first.pageCount, 3)
  assert.equal(first.total, 12)
  assert.equal(first.range, '1–5 of 12')

  // The last page is partial, and the count line names the rows it is holding rather than how many
  // pages there are.
  const last = paginateSkillPanelRows(rows, 3)
  assert.deepEqual(last.rows, ['k', 'l'])
  assert.equal(last.page, 3)
  assert.equal(last.range, '11–12 of 12')

  // A page before the first and a page past the last are both clamped rather than empty: a filter that
  // shortens the list must not leave the reader looking at nothing.
  assert.equal(paginateSkillPanelRows(rows, 0).page, 1)
  assert.deepEqual(paginateSkillPanelRows(rows, 0).rows, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(paginateSkillPanelRows(rows, 9).page, 3)
  assert.deepEqual(paginateSkillPanelRows(rows, 9).rows, ['k', 'l'])

  // A set of one is one page of one row, and says so without a range.
  assert.equal(paginateSkillPanelRows(['a'], 1).range, '1 of 1')

  // And nothing at all is one empty page, so the pager has a page to be disabled on rather than a page
  // count of zero to divide by.
  const none = paginateSkillPanelRows([], 1)
  assert.deepEqual(none.rows, [])
  assert.equal(none.page, 1)
  assert.equal(none.pageCount, 1)
  assert.equal(none.range, '0 of 0')

  results.push('five rows a page, a short last page, and a count line that names the rows on it')
}

// ---------------------------------------------------------------- composition

function theWindowIsTakenAfterTheFilterAndTheStatus() {
  // The whole listing: fourteen rows, three pages, the first of them the error and four skills.
  const first = planSkillPanelView(LISTING, '', 'all', 1)
  assert.equal(first.total, 14)
  assert.equal(first.pageCount, 3)
  assert.equal(first.range, '1–5 of 14')
  assert.deepEqual(ids(first.rows), ['broken-one', 'ship-it', 'code-review', 'alpha', 'bravo'])

  const third = planSkillPanelView(LISTING, '', 'all', 3)
  assert.equal(third.range, '11–14 of 14')
  assert.deepEqual(ids(third.rows), ['india', 'juliett', 'kilo', 'lima'])

  // Filter, then page: the query keeps seven rows, so the window is a window onto seven and its second
  // page is the last two of *those* — not rows six and seven of the listing.
  const filtered = planSkillPanelView(LISTING, 'notes', 'all', 2)
  assert.equal(filtered.total, 7)
  assert.equal(filtered.matched, 7)
  assert.equal(filtered.pageCount, 2)
  assert.equal(filtered.range, '6–7 of 7')
  assert.deepEqual(ids(filtered.rows), ['kilo', 'lima'])

  // Status, then page: one of those seven is switched off, so the available six still have a second page
  // and it is short by one.
  const available = planSkillPanelView(LISTING, 'notes', 'available', 2)
  assert.equal(available.total, 6)
  assert.equal(available.pageCount, 2)
  assert.equal(available.range, '6 of 6')
  assert.deepEqual(ids(available.rows), ['kilo'])

  // Filter and status both, keeping one row: the switched-off row that matches the query is the one the
  // status filter drops, which is only true if the status is applied to what the query kept.
  const onlyHidden = planSkillPanelView(LISTING, 'ship', 'hidden', 1)
  assert.deepEqual(ids(onlyHidden.rows), ['ship-it'])
  assert.equal(onlyHidden.range, '1 of 1')

  // Everything filtered away is an empty view rather than an error: no rows, one page, and the count
  // line that says so.
  const nothing = planSkillPanelView(LISTING, 'ship', 'load-error', 1)
  assert.equal(nothing.matched, 0)
  assert.deepEqual(nothing.rows, [])
  assert.equal(nothing.pageCount, 1)
  assert.equal(nothing.range, '0 of 0')

  results.push('the composition is filter, then status, then the window of five')
}

// ---------------------------------------------------------------- harness

function main(): Promise<void> {
  return (async () => {
    await step('rows', theListingBecomesRowsInOneStatedOrder)
    await step('classification', everyRowStatusIsClassifiedFromTheListingsOwnFields)
    await step('text filter', aQueryMatchesTheIdTheTitleAndTheSummary)
    await step('status filter', theStatusFilterKeepsOneStatusOrAllOfThem)
    await step('pagination', aPageIsFiveRowsAndTheLastOneIsShort)
    await step('composition', theWindowIsTakenAfterTheFilterAndTheStatus)

    console.log(`skills panel: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  })()
}

void main().catch((err: unknown) => {
  console.error('SKILLS PANEL TEST FAILED:', err)
  process.exit(1)
})
