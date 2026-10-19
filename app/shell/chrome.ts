/**
 * The one chrome grid: the measure the titlebar and the two rails are drawn on.
 *
 * Phase 100 asks the window's three chrome bands — the titlebar across the top, the icon rail down the
 * left, the tools rail down the right — to share one measure, so the shell reads as one frame rather than
 * as three strips that happen to meet. The measure is the titlebar's own height, `2.5rem`, which is the
 * number the bar already had; the rails come to it rather than the bar growing to meet the rails.
 *
 * The four tokens are class strings rather than pixels because the app's styling is Tailwind utilities and
 * nothing else — there is no stylesheet to put a custom property in, and a token that is only a number
 * would leave every call site deciding which utility to spell. Read together they are the whole grid: a
 * band 2.5rem tall, a rail 2.5rem wide, an icon inside the rail at 2rem (so the same 4px gutter on both
 * sides of it), and one gap between the icons of a rail — the same gap the titlebar keeps between the
 * icons of a group.
 *
 * The gap is deliberately one token on both rails and on the bar. The pitch it produces is tighter than
 * the 44px the rails carried before this phase — a 32px icon plus 4px between the two below it — while
 * the 4px itself is what keeps the icons from reading as one column of glyphs.
 */

/** The titlebar's height, and the measure every chrome band is drawn against. */
export const CHROME_BAND_HEIGHT = 'h-10'

/** A rail's width: the same 2.5rem, applied across instead of down. */
export const CHROME_RAIL_WIDTH = 'w-10'

/** An icon button inside a rail: 2rem, which leaves a 4px gutter on either side of the 2.5rem rail. */
export const CHROME_RAIL_ICON = 'size-8'

/** The one gap: between the icons of a rail, and between the icons inside a titlebar group. */
export const CHROME_ICON_GAP = 'gap-1'
