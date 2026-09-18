/**
 * Relative timestamps for the session list, e.g. "2h ago".
 *
 * Takes `now` as a parameter rather than reading the clock, so the wording for a given age is
 * testable and does not depend on when the test runs. Deliberately coarse: a session list is for
 * spotting the recent one, not for auditing exact times, and a value that changes every second would
 * re-render rows for no reason.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Round down to whole units: "2h ago" for anything from 2h00m to 2h59m. */
function units(value: number, unit: number): number {
  return Math.floor(value / unit)
}

/**
 * Format an age. A timestamp slightly ahead of `now` — clock skew, or a store written by a machine
 * whose clock moved — reads as "just now" rather than as a negative age.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const elapsed = now - timestamp
  if (elapsed < MINUTE) return 'just now'

  if (elapsed < HOUR) return `${units(elapsed, MINUTE)}m ago`
  if (elapsed < DAY) return `${units(elapsed, HOUR)}h ago`
  if (elapsed < WEEK) return `${units(elapsed, DAY)}d ago`
  if (elapsed < MONTH) return `${units(elapsed, WEEK)}w ago`
  if (elapsed < YEAR) return `${units(elapsed, MONTH)}mo ago`
  return `${units(elapsed, YEAR)}y ago`
}
