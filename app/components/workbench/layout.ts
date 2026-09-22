/**
 * The sizes the workbench's two resize groups open with.
 *
 * Pure and renderer-only, for the reason `changes.ts` and `mentions.ts` are: a proportion can be wrong
 * while still looking plausible on screen, so a test should be able to assert on it without a DOM.
 *
 * The reason the numbers are here rather than inline in the JSX is that the workbench is two *nested*
 * groups, and the share a panel has of its own group is not the share it has of the window. Writing
 * them together is what makes the second multiplication visible: the viewer's 37.5 is a share of the
 * main column, which is itself 80 of the window, so the viewer opens at 30 percent of the window and
 * the chat at 50.
 */

/** The drawer and the main area on the outside, and the main area's own split on the inside. */
export interface LayoutSizes {
  /** The outer group: the secondary panel, then everything to its right. */
  outer: { drawer: number; main: number }
  /** The main column's split between the conversation and the pane beside it. */
  main: { chat: number; viewer: number }
}

/**
 * The defaults the workbench opens with.
 *
 * The drawer takes a fifth of the window and the main area the remainder; inside the main area the
 * chat takes five eighths and the viewer three. Those are the shares the group is given, which is why
 * they are shares and not pixels — a pixel default would open the same width on every screen, and the
 * point of a proportion is that it does not.
 *
 * A fresh object per call: none of this is state, and a caller that changes its copy must not change
 * what the next caller receives.
 */
export function initialLayoutSizes(): LayoutSizes {
  return {
    outer: { drawer: 20, main: 80 },
    main: { chat: 62.5, viewer: 37.5 },
  }
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
