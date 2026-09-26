import { clampBottomHeight, sanitizeLayoutSizes, type LayoutSizes, type WindowState } from './layout'

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
 *
 * The bottom terminal panel's separator is the third group and the one that is not read as a set: what
 * it reports is a height rather than a pair of column shares, so it has a rule of its own below — and
 * the two rules are here together because they are one decision, "is what the library just reported a
 * number worth remembering".
 */

/** Which of the workbench's three groups reported the change. */
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

/** What the bottom panel's separator drag reports: the two panels of the chat column's group. */
export interface BottomHeightChangeInput {
  /** The window state in force, which is the height the drag belongs to. */
  active: WindowState
  /** The layout the library reported for the chat column's group, keyed by panel id. */
  layout: GroupLayout
}

export interface BottomHeightChange {
  state: WindowState
  height: number
}

/**
 * "What a drag of the bottom panel's separator was dragged to", or null when it is not one.
 *
 * Simpler than the two sets above it in one way and stricter in another. Simpler because the report is
 * one panel's share of its own group rather than a pair that has to add up — the conversation's share
 * is the remainder, and it is `chatGroupLayout` that states it. Stricter in that the panel read here is
 * named: a report that does not name `terminal` at all, or names one of its shares as something that
 * cannot be a percentage, describes no panel that could be restored, and writing it would replace a
 * good height with one that resolves to a default.
 *
 * A number inside the range is left exactly as it was reported, and one outside it is pulled to the
 * boundary rather than refused — the same repair `clampBottomHeight` applies to a stored record, so a
 * height reaches storage by one rule whether it came from a drag or from a file.
 */
export function bottomHeightChangeFor(input: BottomHeightChangeInput): BottomHeightChange | null {
  const height = input.layout.terminal
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height >= 100) return null

  return { state: input.active, height: clampBottomHeight(height) }
}
