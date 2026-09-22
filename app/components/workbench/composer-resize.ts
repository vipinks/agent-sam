/**
 * How tall the composer may be, and where a drag stops.
 *
 * Pure and renderer-only, for the reason `layout.ts` and `mentions.ts` are: a clamp with the wrong
 * bounds still looks deliberate on screen — a composer that stops short of its limit reads as a design
 * choice rather than as arithmetic — so the rule is stated where a test can call it directly.
 *
 * The composer opens at a fixed height and scrolls inside itself. That is what the floor is for. A
 * textarea that grows with its content pushes the transcript off the top of the pane and moves the
 * send button away from the sentence being written; the user can always make it taller by hand, and
 * doing so deliberately is the difference between a control and a slide.
 */

/** The height the composer opens at, and the floor a drag cannot go below. */
export const COMPOSER_MIN_HEIGHT = 96

/**
 * The most of the chat pane the composer may take.
 *
 * A share rather than a pixel ceiling because the pane is resizable: a fixed maximum would be most of
 * a short pane and a sliver of a tall one. Six tenths leaves the transcript readable — the composer is
 * for writing a message, not for reading the conversation it belongs to.
 */
export const COMPOSER_MAX_SHARE = 0.6

/** A floor and a ceiling for one pane height. */
export interface ComposerBounds {
  min: number
  max: number
}

/**
 * The floor and the ceiling for a pane of this height.
 *
 * The floor raises the ceiling when the two would cross — a pane shorter than 160 pixels — because the
 * floor is what keeps the composer renderable, and a ceiling below it would be a height nothing can be
 * drawn at. A pane that measures nothing at all (before layout, or in a test with no layout) therefore
 * yields a fixed composer rather than a broken one.
 */
export function composerBounds(paneHeight: number): ComposerBounds {
  return {
    min: COMPOSER_MIN_HEIGHT,
    max: Math.max(COMPOSER_MIN_HEIGHT, Math.round(paneHeight * COMPOSER_MAX_SHARE)),
  }
}

/**
 * Hold a requested height inside its bounds.
 *
 * A request that cannot be measured — the pointer's position read before the pane has a size — resolves
 * to the floor rather than to `NaN`: the style attribute would take `NaN` as a broken length and collapse
 * the composer to its content, which is the exact behaviour this module exists to remove.
 */
export function clampComposerHeight(requested: number, min: number, max: number): number {
  if (!Number.isFinite(requested)) return min
  return Math.min(Math.max(requested, min), Math.max(min, max))
}
