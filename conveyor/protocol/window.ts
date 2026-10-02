/**
 * The titlebar's view acts as a rule: how far one zoom step moves and where the ladder stops.
 *
 * Pure, like `preview-kind.ts` beside it, and for the same reason: a step and its bounds are a decision
 * a test should be able to make by calling a function, and the module that performs the act in main
 * needs the same answer it reads here. Nothing in this file knows about electron — it takes a number
 * and returns the number a window should be set to.
 *
 * The increment is the one the View menu's zoom entries already use — half a level, which is how far
 * `web.zoomIn` moves the page — so a press on the titlebar and a press on the menu entry move it by the
 * same amount. What the menu has no counterpart for is a bound: its handlers step the level by half a
 * level whatever the level already is, so a reader can walk the page off the end of the ladder.
 *
 * The two bounds here are the outermost half-steps that still lie inside the range electron documents
 * for its own zoom policy, whose default limits are 300% and 50% and whose `scale := 1.2 ^ level` is
 * how a level means a percentage. Level 6 is 298.6%, and the next half-step out is 358%: past the
 * ceiling. Level -3.5 is 52.9%, and the next half-step out is 48.2%: past the floor. Between them the
 * ladder runs eight steps either way from the original size, which is as far as a reader is likely to
 * want to go and no further than the page can honestly be drawn.
 */

/** What a zoom act asks for. `reset` is not a step: it is the original size the ladder starts from. */
export type ZoomDirection = 'in' | 'out' | 'reset'

/** One step of the ladder: half a level, the increment the View menu's zoom entries move by. */
export const ZOOM_STEP = 0.5

/** The far end upward: level 6, `1.2 ^ 6`, about 299%. */
export const ZOOM_MAX = 6

/** The far end downward: level -3.5, `1.2 ^ -3.5`, about 53%. */
export const ZOOM_MIN = -3.5

/**
 * The codes a window act refuses under.
 *
 * Named and exported rather than written out at the throw site, because a caller branches on the string:
 * a typo there would be a second, silently unreachable state rather than an error. The two are apart
 * because they are two different refusals — one window could plausibly be zoomable and not fullscreen —
 * and a renderer that had to guess which act failed from one shared code would be guessing.
 */
export const ZOOM_UNAVAILABLE = 'ZOOM_UNAVAILABLE'
export const FULLSCREEN_UNAVAILABLE = 'FULLSCREEN_UNAVAILABLE'

/**
 * The level one zoom act asks for, from the level the page is at now.
 *
 * A step that would leave the ladder is the bound itself rather than the bound plus an overshoot, so
 * holding a zoom button walks to the end and stops there. That also makes each bound a fixed point: a
 * level that arrived from somewhere else — a stored value, a page that set its own zoom — is brought
 * back inside the ladder by the first press rather than left outside it.
 */
export function zoomNext(level: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 0

  const stepped = direction === 'in' ? level + ZOOM_STEP : level - ZOOM_STEP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped))
}
