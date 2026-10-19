/**
 * The six window acts the View menu used to spell out, and the keys that still reach them.
 *
 * Phase 100 takes the menus out of the titlebar, and the View menu was the only place these shortcuts
 * were declared: `Ctrl+R`, `Ctrl+Shift+I`, the zoom ladder, actual size and `F11`. A shortcut that lived
 * in a menu died with the menu, so what replaces it is this table — the acts, their words, and the
 * keystrokes that resolve to them — read by one listener that has nothing to do with any menu.
 *
 * The table is pure on purpose: no conveyor client, no DOM, no electron. Every combination is decidable
 * in a node suite, which is what makes "the six shortcuts survived" a checkable claim rather than a
 * description of a screenshot.
 *
 * The commands are the ones the menu's entries called — `conveyor.web.*` — so the removal of the menu is
 * a move of its behaviour rather than a second implementation of it. `app/shell/use-window-shortcuts.ts`
 * is the only place that turns a resolved command into a conveyor call.
 */

/** One window act, named the way the conveyor `web` module names it. */
export type WindowCommand = 'reload' | 'toggleDevtools' | 'zoomIn' | 'zoomOut' | 'actualSize' | 'toggleFullscreen'

/**
 * One keystroke, as the DOM reports it.
 *
 * A structural subset of `KeyboardEvent`, so the listener can hand the event over untouched. Both the
 * control and the command modifier count as the primary one: on macOS the key a reader presses for these
 * six is ⌘, and a table that only knew `ctrlKey` would leave every chord dead on that platform.
 */
export interface KeyStroke {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * The modifiers and keys one shortcut accepts.
 *
 * `shift` is optional rather than required, and that is the one subtlety here: `Ctrl+Plus` is a shifted
 * `=` on most layouts and arrives as either key with either shift state, so a table that demanded
 * `shift: false` would refuse the spelling half the keyboards send. Where the shift state carries meaning
 * — devtools is `Ctrl+Shift+I`, and `Ctrl+Shift+R` is deliberately not reload — it is stated.
 */
export interface ShortcutStroke {
  /** Ctrl, or ⌘ on macOS. */
  primary: boolean
  /** The shift state, or `undefined` when either is accepted. */
  shift?: boolean
  alt: boolean
  /** Every key that stands for this act, already lowercased. */
  keys: string[]
}

/** One row of the table: the act, the words a reader learns it from, and the keystroke that reaches it. */
export interface WindowShortcut {
  command: WindowCommand
  label: string
  /** The chord as a tooltip writes it. */
  accelerator: string
  stroke: ShortcutStroke
}

/**
 * The six, in the order the View menu listed them.
 *
 * The order is the menu's because the titlebar's row reads in it — reload, then the ladder, then
 * fullscreen — and a reader who knew the menu finds the same three acts in the same order on the bar.
 */
export const WINDOW_SHORTCUTS: WindowShortcut[] = [
  {
    command: 'reload',
    label: 'Reload',
    accelerator: 'Ctrl+R',
    stroke: { primary: true, shift: false, alt: false, keys: ['r'] },
  },
  {
    command: 'toggleDevtools',
    label: 'Toggle DevTools',
    accelerator: 'Ctrl+Shift+I',
    stroke: { primary: true, shift: true, alt: false, keys: ['i'] },
  },
  {
    command: 'zoomIn',
    label: 'Zoom In',
    accelerator: 'Ctrl+Plus',
    stroke: { primary: true, alt: false, keys: ['+', '='] },
  },
  {
    command: 'zoomOut',
    label: 'Zoom Out',
    accelerator: 'Ctrl+Minus',
    stroke: { primary: true, alt: false, keys: ['-', '_'] },
  },
  {
    command: 'actualSize',
    label: 'Actual Size',
    accelerator: 'Ctrl+0',
    stroke: { primary: true, shift: false, alt: false, keys: ['0'] },
  },
  {
    command: 'toggleFullscreen',
    label: 'Toggle Fullscreen',
    accelerator: 'F11',
    stroke: { primary: false, shift: false, alt: false, keys: ['f11'] },
  },
]

/**
 * The table by the act it dispatches.
 *
 * Built once from the list above rather than written a second time, for the reason the list is the
 * source: two declarations of one shortcut are two things that can disagree, and the tooltip's words and
 * the listener's behaviour read from the same row here.
 */
const BY_COMMAND = new Map<WindowCommand, WindowShortcut>(
  WINDOW_SHORTCUTS.map((shortcut) => [shortcut.command, shortcut])
)

/** One act's row, by name. Every command in `WindowCommand` has one, so the fallback is unreachable. */
export function windowShortcut(command: WindowCommand): WindowShortcut {
  const shortcut = BY_COMMAND.get(command)
  if (!shortcut) throw new Error(`No window shortcut is declared for ${command}`)
  return shortcut
}

/** The keystroke against one row: same modifiers, and one of the row's keys. */
function matches(stroke: KeyStroke, declared: ShortcutStroke): boolean {
  const primary = Boolean(stroke.ctrlKey || stroke.metaKey)
  if (primary !== declared.primary) return false
  if (Boolean(stroke.altKey) !== declared.alt) return false
  if (declared.shift !== undefined && Boolean(stroke.shiftKey) !== declared.shift) return false
  return declared.keys.includes(stroke.key.toLowerCase())
}

/** What the listener knows about the keystroke beyond its keys: whether a field is what will receive it. */
export interface ShortcutContext {
  /**
   * True while the focused element is a field.
   *
   * The terminal panel is why this exists: `Ctrl+R` at a shell prompt is the shell's own reverse search,
   * and `Ctrl+I` inserts a tab. A window act that answered those instead would be taking keystrokes out
   * of a line the user is typing — the same hazard the terminal panel's `Ctrl+\`` already names, handled
   * the same way. The whole set is suppressed rather than the two chords with an obvious text meaning,
   * because a window act that fires while someone is typing is the surprise, whichever act it is.
   */
  textEntry: boolean
}

/**
 * The act one keystroke asks for, or null when it asks for none.
 *
 * Pure, and the only decision the listener makes: the caller adds the focus gate (another window's
 * keystrokes must not reach this one) and the dispatch. Resolving to a name rather than calling anything
 * is what lets a node suite assert all six combinations without a renderer.
 */
export function resolveWindowShortcut(stroke: KeyStroke, context: ShortcutContext): WindowCommand | null {
  if (context.textEntry) return null

  for (const shortcut of WINDOW_SHORTCUTS) {
    if (matches(stroke, shortcut.stroke)) return shortcut.command
  }
  return null
}

/**
 * Whether an element is a place a keystroke is text rather than a window command.
 *
 * The tag check covers the two plain fields and the one control a chord can mean something in; the
 * contenteditable check covers the rich editors a `div` becomes. Written against the shape rather than
 * against `HTMLElement` so it is decidable outside a document, which is what lets the node suite assert
 * the focus rule itself instead of only the listener that applies it.
 */
export function isTextEntryTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
