/**
 * The sizes the workbench's two resize groups open with, per window state.
 *
 * Pure and renderer-only, for the reason `changes.ts` and `mentions.ts` are: a proportion can be wrong
 * while still looking plausible on screen, so a test should be able to assert on it without a DOM.
 *
 * The reason the numbers are here rather than inline in the JSX is that the workbench is two *nested*
 * groups, and the share a panel has of its own group is not the share it has of the window. Writing
 * them together is what makes the second multiplication visible: the maximized viewer's 46.25 is a
 * share of the main column, which is itself 80 of the window, so the viewer opens at 37 percent of the
 * window and the chat at 43.
 *
 * A set per window state rather than one set for both, because the two windows want different columns.
 * A windowed window is short of width, so its three columns are near-equal: the drawer takes 34 of the
 * window and the rest is split in half, 33 and 33. A maximized window has width to spare, and the
 * drawer is the one column that keeps a pixel width rather than a share (`preserve-pixel-size`), so it
 * takes a fifth and leaves the remainder to the two columns that can use it — 43 and 37. One set could
 * not be right for both windows, which is why a state is part of the question rather than a detail of
 * the answer.
 */

/** The two window states the workbench lays a set out for. */
export type WindowState = 'windowed' | 'maximized'

/** Both states, for the readers that have to answer for each of them. */
export const WINDOW_STATES: readonly WindowState[] = ['windowed', 'maximized']

/** The drawer and the main area on the outside, and the main area's own split on the inside. */
export interface LayoutSizes {
  /** The outer group: the secondary panel, then everything to its right. */
  outer: { drawer: number; main: number }
  /** The main column's split between the conversation and the pane beside it. */
  main: { chat: number; viewer: number }
}

/**
 * The defaults one window state opens with, before anything has been dragged in it.
 *
 * The shares are shares and not pixels — a pixel default would open the same width on every screen,
 * and the point of a proportion is that it does not. A fresh object per call: none of this is state,
 * and a caller that changes its copy must not change what the next caller receives.
 */
export function defaultLayoutForState(state: WindowState): LayoutSizes {
  return state === 'maximized'
    ? { outer: { drawer: 20, main: 80 }, main: { chat: 53.75, viewer: 46.25 } }
    : { outer: { drawer: 34, main: 66 }, main: { chat: 50, viewer: 50 } }
}

/**
 * The outer group's layout, keyed by the panel ids that group is built with.
 *
 * Keyed at all because this is the shape the resize library's `defaultLayout` takes — panel id to that
 * panel's share of its group — and the ids are named here, next to the sizes, rather than only where
 * the panels are written. A drag arrives keyed the same way, so the two directions of the mapping sit
 * together instead of one of them being reconstructed at the call site.
 */
export function outerGroupLayout(sizes: LayoutSizes): Record<string, number> {
  return { secondary: sizes.outer.drawer, main: sizes.outer.main }
}

/** The main column's own group: the chat, then the code viewer. */
export function mainGroupLayout(sizes: LayoutSizes): Record<string, number> {
  return { chat: sizes.main.chat, code: sizes.main.viewer }
}

/**
 * A share written the way the resize library reads it as a percentage.
 *
 * The trap this names: `react-resizable-panels` reads a bare number as *pixels* — `defaultSize={20}`
 * is a twenty-pixel drawer — and a string as a percentage of the group. Converting in one place is
 * what keeps a size from being wired in as a length, and it is also what makes the value legible where
 * the library writes it out.
 */
export function percentSize(share: number): string {
  return `${share}%`
}
