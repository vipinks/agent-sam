/**
 * The terminal preferences' bounds, and the field rules the two Settings controls are held to.
 *
 * Pure and shared rather than main-only, the same way `protocol/terminal-pty.ts` is: the *decision* a
 * field makes — whether this string is a number the terminal may be given — is a thing a suite has to
 * be able to reach without a form, and the bounds are what main validates a dispatched preference
 * against. One declaration, two readers.
 *
 * The refusal is a field rule and not a `ConveyorError` code, deliberately. An out-of-range number is
 * not a failure of the terminal; it is a value the section explains under the field it came from, so
 * the words live here beside the bounds rather than in a toast that would take the reader away from
 * the input they have to fix. The message is part of the answer rather than assembled by the caller so
 * the field, the store and the suite all say the same sentence.
 */
import { DEFAULT_BUFFER_LINES } from './terminal-pty'

/**
 * The fewest and most lines a shell may retain.
 *
 * The floor is not zero: a session that retains nothing has nothing to reconnect to, and the pane's
 * whole re-attach story is the transcript — so the smallest useful retention is the setting's floor
 * rather than a bound that would silently take the feature away. The ceiling is a memory bound, not a
 * policy: an unbounded transcript is a leak with a shell attached.
 */
export const MIN_SCROLLBACK_LINES = 100
export const MAX_SCROLLBACK_LINES = 50_000

/** What a session retains when nobody has said otherwise — Turn 1's bound, under the setting's name. */
export const DEFAULT_SCROLLBACK_LINES = DEFAULT_BUFFER_LINES

/**
 * The smallest and largest terminal font, in pixels.
 *
 * Ordinary terminal bounds: below eight pixels nothing is legible, and above thirty-two the pane shows
 * a handful of columns. Both are the field's business rather than xterm's, which would accept either.
 */
export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32

/** The size the terminal was built with before this was a preference, so nothing moves on upgrade. */
export const DEFAULT_FONT_SIZE = 12

/**
 * What a field's check answered: the number to store, or the words the field shows instead.
 *
 * `reason` is for the caller's branching — the DOM suite asserts on it — and `message` is what a
 * reader is shown. They are not the same thing on purpose: two refusals can share a sentence and still
 * be different situations, and a caller that branched on the sentence would be branching on wording.
 */
export type TerminalPreferenceCheck =
  { ok: true; value: number } | { ok: false; reason: 'not-a-number' | 'out-of-range'; message: string }

/** A number as the field's sentence spells it, thousands separated so both bounds read at a glance. */
function grouped(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Digits only, deliberately, rather than `Number(raw)`.
 *
 * `Number` accepts `1e3`, `12.5`, `0x10` and `Infinity`, none of which is a number of lines someone
 * typed. What the field holds is a count, so the rule is the same one a count has: whole digits and
 * nothing else. Everything that fails it is one repair — "a whole number" — which is why the three
 * cases share a sentence and a reason.
 */
const WHOLE_NUMBER = /^\d+$/

/** Whether a typed string is a whole number of lines this app will retain, and why not when it is not. */
export function checkScrollbackLines(raw: string): TerminalPreferenceCheck {
  const trimmed = raw.trim()
  if (!WHOLE_NUMBER.test(trimmed)) {
    return { ok: false, reason: 'not-a-number', message: 'Enter a whole number of lines.' }
  }

  const value = Number(trimmed)
  // The range check carries two cases at once, and both belong under it: a count below the floor, and a
  // string of digits long enough to arrive as an infinity — which is out of range rather than a parse
  // failure, because the reader's repair is the same one either way.
  if (value < MIN_SCROLLBACK_LINES || value > MAX_SCROLLBACK_LINES) {
    return {
      ok: false,
      reason: 'out-of-range',
      message: `Enter a whole number of lines between ${grouped(MIN_SCROLLBACK_LINES)} and ${grouped(MAX_SCROLLBACK_LINES)}.`,
    }
  }

  return { ok: true, value }
}

/** Whether a typed string is a font size this app will paint, and why not when it is not. */
export function checkFontSize(raw: string): TerminalPreferenceCheck {
  const trimmed = raw.trim()
  if (!WHOLE_NUMBER.test(trimmed)) {
    return { ok: false, reason: 'not-a-number', message: 'Enter a whole number of pixels.' }
  }

  const value = Number(trimmed)
  if (value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) {
    return {
      ok: false,
      reason: 'out-of-range',
      message: `Enter a whole number of pixels between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
    }
  }

  return { ok: true, value }
}
