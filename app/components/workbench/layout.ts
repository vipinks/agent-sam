/**
 * The sizes the workbench's resize groups open with, per window state.
 *
 * Pure and renderer-only, for the reason `changes.ts` and `mentions.ts` are: a proportion can be wrong
 * while still looking plausible on screen, so a test should be able to assert on it without a DOM.
 *
 * The bottom terminal panel's height is the third of them, and it is the one that is not part of a
 * `LayoutSizes`: the sets describe the columns of a window and the panel is a share of the chat
 * column's own height, so it is stored as a bare percentage beside them and clamped on the way in.
 * Its open flag is the one thing here that is not geometry, and it is read with the same strictness
 * the two sets are read with — absent means the closed panel a first launch opens with.
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
 * The chat column's own group: the conversation, then the bottom terminal panel under it.
 *
 * The third group, and the one that makes the terminal's move a move rather than a rebuild: the panel
 * is a split inside the column the conversation already owns, so the right panel and its residents
 * share the row exactly as they did, and a reader who had dragged the column's own separator gets the
 * width they chose. Declared from the height alone — the conversation takes the remainder — because
 * the two numbers are one declaration, the way they are in the groups above.
 *
 * Declared even while the panel is closed, and set aside by the library then for the reason the other
 * groups' declarations are: it names two panels and the group has one, which is the fallback the
 * chat's own `100%` and the drawer's return both rely on.
 */
export function chatGroupLayout(height: number): Record<string, number> {
  return { conversation: 100 - height, terminal: height }
}

/**
 * The height the bottom panel opens at before it has ever been dragged, as a share of its column.
 *
 * A third of the column: enough for the shell's own line and a few lines of its output, and not so
 * much that the conversation it is under has to be scrolled after one message.
 */
export const DEFAULT_BOTTOM_HEIGHT = 35

/**
 * The range a height can be read in, in percent of the column.
 *
 * The clamp exists for records this version did not write: a percentage left by a hand edit or by an
 * older shape of the record can be a panel of two pixels or a conversation of one line. The panel's
 * own pixel minimum and the conversation's are stated at the panels themselves, where the library
 * enforces them against a measured box; these two are what keeps an unmeasured *number* sane.
 */
export const MIN_BOTTOM_HEIGHT = 15
export const MAX_BOTTOM_HEIGHT = 85

/** The key one window state's bottom-panel height is stored under. */
export type BottomHeightKey = 'bottomPanelHeightWindowed' | 'bottomPanelHeightMaximized'

/**
 * The stored key one state's height is written and read under.
 *
 * Named by the state, like `layoutSetKey` and for the same reason: the write is one file and the read
 * is another, so a key spelled out at one of them is a height that silently never applies.
 */
export function bottomHeightKey(state: WindowState): BottomHeightKey {
  return state === 'maximized' ? 'bottomPanelHeightMaximized' : 'bottomPanelHeightWindowed'
}

/**
 * A height in the range a panel can be read in, or the default when the value is not a height at all.
 *
 * The two outcomes are deliberately different. A number outside the range is a height this panel
 * cannot be read at, so it is pulled to the boundary it was past; a value that is not a number — a
 * string, a `NaN`, a record some future version writes — describes no height, so it falls back the way
 * an absent key does rather than being called a boundary.
 */
export function clampBottomHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BOTTOM_HEIGHT
  return Math.min(Math.max(value, MIN_BOTTOM_HEIGHT), MAX_BOTTOM_HEIGHT)
}

/**
 * The height the bottom panel opens at in one window state: what was dragged in that state, or the
 * default.
 *
 * Per state, like the two sets above it: a height dragged in a windowed window is a fact about that
 * window, and the maximized one has its own.
 */
export function bottomPanelHeightFor(state: WindowState, saved: StoredLayoutSets): number {
  return clampBottomHeight(saved[bottomHeightKey(state)])
}

/**
 * Whether the bottom panel was left open, as the title bar's toggle reads it.
 *
 * A `true` that was left behind or nothing: the flag is written only when the panel is open, so the
 * absence of the key is what "closed" is stored as, and every other value — a `false`, a string, a
 * record that is not a boolean at all — means the closed panel a first launch opens with. Being
 * strict rather than truthy is what keeps a corrupted record from opening a panel nobody asked for.
 */
export function bottomPanelOpenFrom(value: unknown): boolean {
  return value === true
}

/**
 * The stored key one state's set is written and read under.
 *
 * Named by the state rather than left to the call site, because the write and the read are in different
 * files: a key spelled out at one of them and misspelled at the other is a memory that silently never
 * applies.
 */
export function layoutSetKey(state: WindowState): LayoutSetKey {
  return state === 'maximized' ? 'layoutMaximized' : 'layoutWindowed'
}

/** The key one state's set is stored under. */
export type LayoutSetKey = 'layoutWindowed' | 'layoutMaximized'

/**
 * The two sets as they were persisted: one per window state, either of them absent.
 *
 * Both optional, and the values read as unknown because that is what they are — a record written by
 * an older version, or hand-edited, is not a `LayoutSizes` until something has checked it. `layoutFor`
 * is the one place that checking happens, so no caller has to decide what a half-formed set means.
 */
export interface StoredLayoutSets {
  layoutWindowed?: LayoutSizes
  layoutMaximized?: LayoutSizes
  /**
   * The bottom panel's height in each window state, present only once it has been dragged in it.
   *
   * Here rather than beside the open flag in the store's own record because a height *is* a share of a
   * group, exactly like the sets above it — and because the same drag path writes it: a separator
   * dragged in either of the other two groups rebuilds this record through `mergeSavedLayout`, and a
   * record rebuilt without these keys would cost the user the terminal's height on the first drag
   * anywhere else.
   */
  bottomPanelHeightWindowed?: number
  bottomPanelHeightMaximized?: number
}

/** A share of a group that could have been measured, or null. */
function shareOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100 ? value : null
}

/**
 * A stored set, or null when it is not one.
 *
 * Strict on purpose. A set has to name both groups, both panels of each, with positive finite shares
 * that fill their group exactly — because that is the shape a real drag produces, and anything else is
 * a record the app cannot faithfully restore. Being lenient here would mean guessing which half of a
 * stale record to keep, and a guess that is wrong looks like a layout bug rather than a bad record.
 */
export function sanitizeLayoutSizes(value: unknown): LayoutSizes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { outer?: unknown; main?: unknown }
  if (!candidate.outer || typeof candidate.outer !== 'object') return null
  if (!candidate.main || typeof candidate.main !== 'object') return null

  const outer = candidate.outer as { drawer?: unknown; main?: unknown }
  const main = candidate.main as { chat?: unknown; viewer?: unknown }
  const drawer = shareOf(outer.drawer)
  const outerMain = shareOf(outer.main)
  const chat = shareOf(main.chat)
  const viewer = shareOf(main.viewer)
  if (drawer === null || outerMain === null || chat === null || viewer === null) return null

  // Each group has to fill its own width: the library normalises a layout to 100, so a stored set that
  // does not add up is a record of some other shape rather than a smaller version of this one.
  if (!fills(drawer + outerMain)) return null
  if (!fills(chat + viewer)) return null

  return { outer: { drawer, main: outerMain }, main: { chat, viewer } }
}

/** Whether two shares fill their group, within the rounding a percentage drag leaves behind. */
function fills(total: number): boolean {
  return Math.abs(total - 100) < 0.001
}

/**
 * The sizes one window state opens with: what was dragged in that state, or its defaults.
 *
 * Saved-over-default, and per state: a set was dragged in one window state and says nothing about the
 * other, so the fallback is that state's own default rather than a shared one. The answer is a fresh
 * object either way — a caller that resolves a layout must not be able to write through it into what
 * was stored.
 */
export function layoutFor(state: WindowState, saved: StoredLayoutSets): LayoutSizes {
  const stored = sanitizeLayoutSizes(saved[layoutSetKey(state)])
  if (!stored) return defaultLayoutForState(state)
  return { outer: { ...stored.outer }, main: { ...stored.main } }
}

/**
 * The record with one state's set replaced.
 *
 * One state's set and only that one: a drag while windowed is a fact about windowed, and writing it
 * must leave what the maximized window was dragged to exactly as it was — which is also why the record
 * is rebuilt rather than edited. A merge that dropped the other key would make the first maximize after
 * any drag open on the other state's defaults, which is the behaviour this phase exists to replace.
 */
export function mergeSavedLayout(saved: StoredLayoutSets, state: WindowState, sizes: LayoutSizes): StoredLayoutSets {
  return {
    ...(saved.layoutWindowed ? { layoutWindowed: saved.layoutWindowed } : {}),
    ...(saved.layoutMaximized ? { layoutMaximized: saved.layoutMaximized } : {}),
    ...storedBottomHeights(saved),
    [layoutSetKey(state)]: { outer: { ...sizes.outer }, main: { ...sizes.main } },
  }
}

/**
 * The record with one state's bottom-panel height replaced.
 *
 * The same rule as the sets' merge, for the same reason: the height a separator drag left belongs to
 * the state the window was in when the drag ended, and writing it must leave the other state's height
 * and both sets exactly as they were. Rebuilt rather than edited, so a caller holding the record it
 * passed in cannot see it change.
 */
export function mergeSavedBottomHeight(saved: StoredLayoutSets, state: WindowState, height: number): StoredLayoutSets {
  return {
    ...(saved.layoutWindowed ? { layoutWindowed: saved.layoutWindowed } : {}),
    ...(saved.layoutMaximized ? { layoutMaximized: saved.layoutMaximized } : {}),
    ...storedBottomHeights(saved),
    [bottomHeightKey(state)]: clampBottomHeight(height),
  }
}

/**
 * The two heights as the record holds them, either of them absent.
 *
 * One reader for both writers above and for the store's serializer, so a record rebuilt by a drag in
 * one group, a record rebuilt by a drag in another, and a record written when the panel is opened
 * cannot disagree about how a height is carried across.
 */
export function storedBottomHeights(saved: StoredLayoutSets): Partial<Record<BottomHeightKey, number>> {
  return {
    ...(saved.bottomPanelHeightWindowed !== undefined
      ? { bottomPanelHeightWindowed: saved.bottomPanelHeightWindowed }
      : {}),
    ...(saved.bottomPanelHeightMaximized !== undefined
      ? { bottomPanelHeightMaximized: saved.bottomPanelHeightMaximized }
      : {}),
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
