import { sanitizeLayoutSizes, type LayoutSizes, type WindowState } from './layout'

/**
 * What a separator drag means for the window state's stored set: which state's set to write, and what
 * that set now is — or nothing at all, when the drag says nothing that could be restored.
 *
 * Pure, and separate from the workbench, for the same reason `layout.ts` is: the decision has three
 * inputs that only exist together at a call site (which group was dragged, what it now reports, and
 * whether the viewer has taken the chat's column), and every one of them is a way to write a wrong
 * layout that would look perfectly plausible the next time it was applied.
 *
 * This is the one place that pairs a group with a state's set, so the drag path and the restore path
 * cannot disagree about what a stored set contains: both go through `LayoutSizes`, and only the source
 * of the numbers differs.
 */

/** Which of the workbench's two groups reported the change. */
export type LayoutGroup = 'outer' | 'main'

/** What the resize library hands back: panel id to that panel's share of its group. */
export type GroupLayout = Record<string, number>

export interface LayoutChangeInput {
  /** The window state in force, which is the set the change belongs to. */
  active: WindowState
  /** The state's set as the workbench is applying it, which supplies the group that did not move. */
  sizes: LayoutSizes
  /** The group the library reported a change for. */
  group: LayoutGroup
  /** The layout it reported, keyed by panel id. */
  layout: GroupLayout
  /** Whether the viewer is currently taking the chat's column. */
  viewerExpanded: boolean
}

export interface LayoutChange {
  state: WindowState
  sizes: LayoutSizes
}

/**
 * The set a drag produces, or null when the drag is not one to remember.
 *
 * The inner group while the viewer is expanded is the case with a reason rather than a rule: Phase 21's
 * expansion *removes* the chat column, so that group holds one panel and the layout it reports is the
 * viewer's own width. Storing that as the state's inner split would replace a two-column split with a
 * one-panel fact, and the split the user returns to would be gone. The outer group is unaffected by the
 * expansion, so a drag there is still the state's own and is still written.
 *
 * A report that does not name both panels of the dragged group — or names a share that is not a
 * positive number, or a pair that does not fill its group — is not a layout, and writing it would
 * replace a good set with one that resolves to a default. `sanitizeLayoutSizes` is the judge of that,
 * because it is already the judge of what a stored set may be.
 */
export function layoutChangeFor(input: LayoutChangeInput): LayoutChange | null {
  if (input.group === 'main' && input.viewerExpanded) return null

  const candidate: LayoutSizes =
    input.group === 'outer'
      ? {
          outer: { drawer: input.layout.secondary, main: input.layout.main },
          main: { ...input.sizes.main },
        }
      : {
          outer: { ...input.sizes.outer },
          main: { chat: input.layout.chat, viewer: input.layout.code },
        }

  const sizes = sanitizeLayoutSizes(candidate)
  if (!sizes) return null

  return { state: input.active, sizes }
}
