/**
 * The Skills panel's view rules: which rows a listing offers, which of them a query and a status keep,
 * and which page of them is showing.
 *
 * Pure, and in the protocol layer rather than in the component, for the reason the rest of this folder
 * is: a page boundary, a status classification and a substring match are data in, data out. A component
 * that computed them could only be checked by rendering it and reading the answer back out of the DOM,
 * which is the wrong place to find an off-by-one at the end of a list. The panel adds no command and no
 * read of its own — it draws the listing main already produces — and everything it does to that listing
 * is stated here.
 *
 * A row is one of three things, and the three are what the status filter names. A skill the switches do
 * not mention is *available*; one an entry names, in the tier and folder it names it in, is *hidden*; and
 * a file main could not read is a *load error*. A failure is a row of the same list rather than a section
 * of its own, because the panel is one flat list a reader pages through — and because the filter's third
 * value exists precisely so those rows can be asked for alone.
 *
 * The rows are in one order. Errors come first, then the tiers in the order the listing carries them,
 * which is the order the Settings section draws the same read in: one scan must not look like two
 * different libraries depending on which surface is open. Inside a tier the listing's own order stands —
 * main has already applied tier precedence and sorted by id, and re-sorting here would be a second
 * opinion about a decision that was made once, for a collision no surface here can even see.
 *
 * The composition is in one order too, and it is why this is a single function rather than four the
 * caller assembles: filter by text, then by status, then take the window. Windowing first would count
 * rows the query had already dropped, and taking the status after the window would leave a switched-off
 * row sitting on a page it was filtered out of — neither of which looks wrong on the first page.
 */
import {
  isSkillHidden,
  matchesSkillQuery,
  type SkillListing,
  type SkillLoadError,
  type SkillSummary,
  type SkillTierId,
} from './skills'

/** The three things a row of the panel's list can be. */
export type SkillRowStatus = 'available' | 'hidden' | 'load-error'

/** One skill the panel draws, and may switch on or off. */
export interface SkillPanelSkillRow {
  status: 'available' | 'hidden'
  skill: SkillSummary
}

/** One file the scan could not read, drawn as a row of the same list. */
export interface SkillPanelErrorRow {
  status: 'load-error'
  error: SkillLoadError
}

/** One row of the panel's list: a skill, or a file that would not load. */
export type SkillPanelRow = SkillPanelSkillRow | SkillPanelErrorRow

/** What the status filter offers, in the order it offers it. `all` is where the control starts. */
export const SKILL_PANEL_STATUS_FILTERS = ['all', 'available', 'hidden', 'load-error'] as const

export type SkillPanelStatusFilter = (typeof SKILL_PANEL_STATUS_FILTERS)[number]

/**
 * The label each value is shown as.
 *
 * Beside the values rather than in the component, for the reason the tier table carries its own labels:
 * one list is what makes the control and the rule it feeds impossible to disagree.
 */
export const SKILL_PANEL_STATUS_LABELS: Record<SkillPanelStatusFilter, string> = {
  all: 'All statuses',
  available: 'Available',
  hidden: 'Hidden',
  'load-error': 'Load error',
}

/** How many rows the panel shows at once. */
export const SKILL_PANEL_PAGE_SIZE = 5

/**
 * Which of the three statuses a listing's fields give one entry.
 *
 * The failure is asked about first: a file that would not load is not a skill that has been switched off,
 * and main reports it as a failure rather than as a row of a tier. Everything else is the switches'
 * answer, matched on the tier and the id together — the same id in two folders is two decisions, which is
 * what naming a tier in the question is for.
 */
export function classifySkillEntry(
  listing: Pick<SkillListing, 'disabled' | 'errors'>,
  entry: { id: string; tier: SkillTierId }
): SkillRowStatus {
  const failed = listing.errors.some((error) => error.tier === entry.tier && error.id === entry.id)
  if (failed) return 'load-error'
  return isSkillHidden(listing.disabled, entry.tier, entry.id) ? 'hidden' : 'available'
}

/**
 * The rows one listing draws.
 *
 * A failure's row carries the failure rather than a skill synthesised from it: a file that could not be
 * read has no title and no summary, and making one out of an id would put words in a row about nothing.
 */
export function skillPanelRows(listing: SkillListing): SkillPanelRow[] {
  const rows: SkillPanelRow[] = listing.errors.map((error) => ({ status: 'load-error', error }))

  for (const tier of listing.tiers) {
    for (const skill of tier.skills) {
      // The bottom of the three cannot apply here: a row that came out of a tier is a skill, so only the
      // switches' two answers can be the answer.
      const status = classifySkillEntry(listing, { id: skill.id, tier: tier.tier })
      rows.push(status === 'hidden' ? { status, skill } : { status: 'available', skill })
    }
  }

  return rows
}

/**
 * The rows a query keeps.
 *
 * A skill is matched on its own three fields, through the same rule the composer's picker narrows by. A
 * failure is matched on its id, which is the only text it has and the name the panel draws it under.
 */
export function filterSkillPanelRows(rows: readonly SkillPanelRow[], query: string): SkillPanelRow[] {
  const needle = query.trim()
  if (needle === '') return [...rows]
  return rows.filter((row) =>
    row.status === 'load-error'
      ? matchesSkillQuery({ id: row.error.id, title: '', summary: '' }, needle)
      : matchesSkillQuery(row.skill, needle)
  )
}

/** The rows one status keeps. `all` keeps every row, which is where the control starts. */
export function filterSkillPanelRowsByStatus(
  rows: readonly SkillPanelRow[],
  status: SkillPanelStatusFilter
): SkillPanelRow[] {
  if (status === 'all') return [...rows]
  return rows.filter((row) => row.status === status)
}

/** One page of rows, with the count line and the pager state that go with it. */
export interface SkillPanelPage<T> {
  /** The rows this page is holding, in the order they were handed over in. */
  rows: T[]
  /**
   * Which page is showing, 1-based and clamped into range.
   *
   * Clamped rather than trusted, because the page is a number the reader chose and the list can shorten
   * under it: a query typed while looking at page three leaves a page three that no longer exists, and
   * the honest answer is the last page there is rather than a blank one.
   */
  page: number
  /** Never zero: an empty list is one empty page, so the pager has a state to be disabled in. */
  pageCount: number
  /** How many rows the whole set holds, which is what the count line is a range of. */
  total: number
  /** 1-based index of the first and the last row on this page, or zero when there are none. */
  first: number
  last: number
  /** The ranged count line — `1–5 of 14` — which is a row count only when the page holds one row. */
  range: string
}

/**
 * One page of a set of rows.
 *
 * The line is a range rather than a row count, because the two things a reader needs to know about a page
 * are which rows of how many they are looking at, and "5 rows" answers neither. It collapses to a single
 * number when the two ends would repeat each other, which is also what makes an empty set read as
 * `0 of 0` without a case of its own.
 */
export function paginateSkillPanelRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = SKILL_PANEL_PAGE_SIZE
): SkillPanelPage<T> {
  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const asked = Number.isFinite(page) ? Math.trunc(page) : 1
  const showing = Math.min(Math.max(asked, 1), pageCount)
  const start = (showing - 1) * pageSize
  const window = rows.slice(start, start + pageSize)
  const first = total === 0 ? 0 : start + 1
  const last = total === 0 ? 0 : first + window.length - 1

  return {
    rows: [...window],
    page: showing,
    pageCount,
    total,
    first,
    last,
    range: first === last ? `${first} of ${total}` : `${first}–${last} of ${total}`,
  }
}

/** One panel view: the window of rows, and what the counts say about it. */
export interface SkillPanelView extends SkillPanelPage<SkillPanelRow> {
  /** How many rows the query and the status kept, before the window was taken. */
  matched: number
}

/**
 * The panel's whole view rule, in one place and in one order: filter, then status, then the window.
 *
 * One function rather than three calls at the call site because the order *is* the rule, and a caller
 * assembling the same three differently would be wrong in a way none of the steps looks wrong about.
 */
export function planSkillPanelView(
  listing: SkillListing,
  query: string,
  status: SkillPanelStatusFilter,
  page: number
): SkillPanelView {
  const rows = skillPanelRows(listing)
  const matched = filterSkillPanelRowsByStatus(filterSkillPanelRows(rows, query), status)
  return { ...paginateSkillPanelRows(matched, page), matched: matched.length }
}
