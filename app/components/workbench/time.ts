/**
 * The app's time wording: an age, a duration, and a wall-clock stamp.
 *
 * One module because these three are one subject, and because the alternative is what this replaced: a
 * slice of `toISOString()` in one panel, a duration assembled in another, and a relative age with its
 * own constants. Each took `Date.now()` at the call site, which is the thing that makes a reading
 * untestable and a screenshot unreadable — so every function here is a pure function of numbers, and
 * the clock is read by the caller, never in here.
 *
 * Nothing here depends on `Intl`: the app's wording is fixed English rather than locale-shaped, and a
 * formatting dependency would be a dependency for three functions that fit in a page.
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
 *
 * Deliberately coarse: a session list is for spotting the recent one, not for auditing exact times,
 * and a value that changes every second would re-render rows for no reason. It lives here now and is
 * still served from `relative-time`, which is where its two call sites and its pin already point.
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

/**
 * Format an elapsed span as the shortest honest reading of it.
 *
 * Seconds up to a minute, minutes and seconds up to an hour, hours and minutes beyond it — each
 * carrying the unit below it, so "1m 0s" cannot be read as a minute and a bit. Partial seconds are
 * floored rather than rounded: a readout that said 5s after four and a half would be claiming a
 * second that has not happened, and these are read as facts about time, not as estimates.
 *
 * A negative span is clamped to zero rather than formatted with a minus. Every caller measures from a
 * mark it took itself, so the only way to get one is a clock that moved backwards between two reads —
 * and "0s" is the truthful reading of that, where "-3s" would be a bug report on screen.
 */
export function formatDuration(ms: number): string {
  // SEAM (next commit): the ruled boundaries — flooring, the 0s/59s, 1m 0s/59m 59s and 1h 0m steps,
  // and the negative clamp — are the behaviour the pins in `tests/ui/time-test.ts` are recording as red.
  // Declared here so the suite bundles and fails on the assertion rather than on the import.
  return `${Math.max(0, ms)}ms`
}

/**
 * Format an instant as the local wall clock, `YYYY-MM-DD HH:mm`.
 *
 * Local rather than UTC because it is read by the person who was there: a transcript's timestamps are
 * "when I did this", and a stamped UTC minute in a list of episodes is a minute that disagrees with the
 * clock in the corner of the screen. The shape is fixed-width and sortable rather than locale-shaped,
 * which is what lets it sit in a row without a second layout decision.
 */
export function formatDateTime(ms: number): string {
  // SEAM (next commit): local `YYYY-MM-DD HH:mm`, declared now so the pin can import it.
  void ms
  return ''
}
