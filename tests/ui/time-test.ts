/**
 * Verifies the three time wordings — a duration, a wall-clock stamp, and an age.
 *
 * The point of the module is that every one of them is a pure function of numbers: the clock is read by
 * the caller, so a boundary can be asserted exactly, a screenshot can be read, and a stored timestamp
 * never has to be re-derived from "now". These are the boundaries a readout is read at, and the cases
 * that are easy to get subtly wrong: a partial second, a span measured from a clock that moved
 * backwards, a padded month and minute, and the midnight hour that a 24-hour clock can still get wrong.
 *
 * No React, no DOM, no disk: this is the pure rule half of the turn-legibility feature.
 */
import { strict as assert } from 'node:assert'
import {
  formatDateTime,
  formatDuration,
  formatRelativeTime as formatRelativeTimeFromTime,
} from '../../app/components/workbench/time'
import { formatRelativeTime } from '../../app/components/workbench/relative-time'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- durations

function thePinnedDurations() {
  // The five boundaries the readout is drawn at, and the shapes each one takes.
  assert.equal(formatDuration(0), '0s', 'zero is zero seconds')
  assert.equal(formatDuration(59_000), '59s', 'just under a minute stays in seconds')
  assert.equal(formatDuration(60_000), '1m 0s', 'a whole minute keeps its seconds')
  assert.equal(formatDuration(3_599_000), '59m 59s', 'just under an hour keeps both units')
  assert.equal(formatDuration(3_600_000), '1h 0m', 'a whole hour drops the seconds')

  // Above an hour, and far above it, the shape is hours and minutes.
  assert.equal(formatDuration(3_661_000), '1h 1m')
  assert.equal(formatDuration(7_200_000), '2h 0m')
  assert.equal(formatDuration(90 * 3_600_000), '90h 0m', 'an implausible span is still formatted, not refused')

  results.push('durations read in seconds, minutes and seconds, then hours and minutes')
}

function partialSecondsAreFloored() {
  // A readout that rounded up would claim a second that has not happened, and these are read as facts
  // about time rather than as estimates.
  assert.equal(formatDuration(1), '0s', 'a millisecond is not a second')
  assert.equal(formatDuration(999), '0s', 'nor are 999 of them')
  assert.equal(formatDuration(1_000), '1s', 'a whole second is one')
  assert.equal(formatDuration(1_999), '1s', 'and a second and a half is still one')
  assert.equal(formatDuration(61_999), '1m 1s', 'the floor is applied before the split, not to each unit')

  results.push('partial seconds are floored, never rounded')
}

function aBackwardsClockIsClamped() {
  // Every caller measures from a mark it took itself, so the only way to see a negative span is a clock
  // that moved between two reads. Zero is the truthful reading of that; "-3s" would be a bug report.
  assert.equal(formatDuration(-1), '0s', 'a millisecond before the start reads as zero')
  assert.equal(formatDuration(-60_000), '0s', 'and a minute before it does not read as negative')
  assert.equal(formatDuration(Number.NEGATIVE_INFINITY), '0s', 'nor does a nonsense span throw')

  results.push('a span measured backwards is clamped to zero rather than shown with a minus')
}

// ---------------------------------------------------------------- wall clock

function theWallClockIsLocalAndFixedWidth() {
  // Built from local components and compared with a local string, so the assertion says what a person
  // reads rather than what a time zone makes of it.
  const morning = new Date(2024, 6, 4, 9, 5, 0, 0)
  assert.equal(formatDateTime(morning.getTime()), '2024-07-04 09:05', 'the month, day, hour and minute are padded')

  const singleDigits = new Date(2024, 0, 2, 3, 4, 0, 0)
  assert.equal(formatDateTime(singleDigits.getTime()), '2024-01-02 03:04', 'four single digits all pad to two')

  const midnight = new Date(2024, 0, 2, 0, 0, 0, 0)
  assert.equal(formatDateTime(midnight.getTime()), '2024-01-02 00:00', 'midnight is 00:00, not 24:00')

  const lastMinute = new Date(2024, 11, 31, 23, 59, 0, 0)
  assert.equal(formatDateTime(lastMinute.getTime()), '2024-12-31 23:59', 'and the last minute of the year is 23:59')

  // Seconds and milliseconds are not part of the shape, and neither is a UTC offset marker: this is a
  // stamp for a row, not a serialisation of an instant.
  const withSeconds = new Date(2024, 6, 4, 9, 5, 59, 999)
  assert.equal(formatDateTime(withSeconds.getTime()), '2024-07-04 09:05', 'seconds and millis are not shown')

  results.push('a stamp is the local wall clock, fixed-width and padded')
}

// ---------------------------------------------------------------- the age, unchanged

function theAgeStillReadsAsItAlwaysDid() {
  // The rule changed home, not wording: its call sites and its pin still import the name from
  // `relative-time`, and this is what proves the two names are one function rather than two copies.
  assert.equal(formatRelativeTime, formatRelativeTimeFromTime, 'relative-time re-exports the time module’s rule')

  const now = 1_700_000_000_000
  const ago = (ms: number) => formatRelativeTime(now - ms, now)
  assert.equal(ago(5_000), 'just now')
  assert.equal(ago(90_000), '1m ago')
  assert.equal(ago(2 * 3_600_000), '2h ago', 'the documented example')
  assert.equal(ago(3 * 86_400_000), '3d ago')
  assert.equal(ago(10 * 86_400_000), '1w ago')
  assert.equal(ago(60 * 86_400_000), '2mo ago')
  assert.equal(ago(400 * 86_400_000), '1y ago')
  assert.equal(formatRelativeTime(now + 60_000, now), 'just now', 'clock skew still reads as just now')

  results.push('the relative age is byte-for-byte the wording it had, and is one function, not two')
}

// ---------------------------------------------------------------- no clock inside

function theFunctionsDoNotReadTheClock() {
  // The claim that makes every case above exact: none of the three reads `Date.now()`, so a value handed
  // in is the only input. Proved by installing a clock that would change the answer if it were read.
  const realNow = Date.now
  Date.now = () => 0
  try {
    assert.equal(formatDuration(4_000), '4s', 'a duration is read from its argument, not from the clock')
    assert.equal(formatDateTime(new Date(2024, 6, 4, 9, 5).getTime()), '2024-07-04 09:05', 'and so is a stamp')
    assert.equal(formatRelativeTime(1_000, 1_000 + 90_000), '1m ago', 'and so is an age')
  } finally {
    Date.now = realNow
  }

  results.push('no function reads the clock: every answer is a function of its arguments')
}

// ---------------------------------------------------------------- report

function main() {
  step('pinned durations', thePinnedDurations)
  step('floored seconds', partialSecondsAreFloored)
  step('backwards clock', aBackwardsClockIsClamped)
  step('wall clock', theWallClockIsLocalAndFixedWidth)
  step('relative age', theAgeStillReadsAsItAlwaysDid)
  step('no clock inside', theFunctionsDoNotReadTheClock)

  console.log(`time: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
