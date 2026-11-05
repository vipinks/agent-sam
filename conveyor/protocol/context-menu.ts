import { z } from 'zod'

/**
 * The two regions of the app that answer a right-click with the OS's own menu, and what each offers.
 *
 * A right-click is the one gesture this app cannot draw for itself: the menu it raises is a native
 * window, owned by the platform rather than by the DOM, so it is main that builds it. What may be
 * offered where is not main's judgement, though — it is a fact about the region that was clicked — so
 * it lives here, free of `electron`, and main only turns the answer into a menu. A test can therefore
 * assert the items without a window, and the command that opens them stays a thin translation.
 *
 * ## Why the region is named rather than measured
 *
 * The obvious discriminators are the ones electron hands a `context-menu` event: `params.isEditable`
 * and `params.selectionText`. Both were measured and both were rejected, because neither can name the
 * composer. `isEditable` is true for the guarded editor's textarea as well, and that surface keeps no
 * menu of its own; `selectionText` is non-empty for any selected text anywhere in the window, the
 * transcript included, and empty for a right-click in an empty composer. So a policy built on them
 * would either give the editor a menu it must not have or refuse the composer the one it must. The
 * region is a fact the renderer knows by construction — it is the element the handler sits on — and it
 * is the only thing that can tell the two editable surfaces apart.
 *
 * ## What each region offers
 *
 * The composer offers what an editable field offers, in the platform's own order and grouped by what
 * the items do: the history pair, then the clipboard triple, then selection. The chat offers a copy
 * and nothing else, because a right-click on selected *text* is a question about that text — it is not
 * a place to edit, and it is not a place to delete or regenerate a message. Those acts have their own
 * controls at the bubble's bottom, where they are visible rather than hidden behind a gesture.
 *
 * Every item is a native *role* and never a literal label or a hand-written `click` handler: the role
 * is what makes the platform provide the wording, the accelerator, the disabled state and the action
 * itself, so a copy that runs is the focused element's own copy rather than a second implementation
 * of it.
 */

/** The regions that answer a right-click with a menu. Anything else is refused by the schema below. */
export const CONTEXT_MENU_REGIONS = ['chat', 'composer'] as const

/** One of them. */
export type ContextMenuRegion = (typeof CONTEXT_MENU_REGIONS)[number]

/**
 * What a right-click hands main: which region, and where the pointer was.
 *
 * All three fields are required, and none is optional, because a menu with no position is a menu that
 * opens wherever the platform last put one — which is the defect this payload exists to prevent. The
 * coordinates are the `contextmenu` event's own `clientX`/`clientY`, in viewport pixels: `Menu.popup`
 * takes them in the window's client area, which is the same space.
 *
 * The region is an enum rather than a string: an unknown region is a caller that means something this
 * build does not draw, and it is refused at the boundary rather than answered with the chat's menu.
 */
export const ContextMenuInput = z.object({
  region: z.enum(CONTEXT_MENU_REGIONS),
  x: z.number(),
  y: z.number(),
})

/** The payload, as main's handler receives it. */
export type ContextMenuInput = z.infer<typeof ContextMenuInput>

/**
 * The native roles this file may name.
 *
 * The six an editable field needs. Listed rather than taken from electron's own type so this module
 * stays importable without `electron` — the command evaluates these against the real
 * `Menu.buildFromTemplate`, which accepts exactly this vocabulary.
 */
export type ContextMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

/** One item of a template: a native role, or the rule that groups two of them. */
export type ContextMenuItem = { role: ContextMenuRole } | { type: 'separator' }

/**
 * Each region's items, in the order the menu draws them, and nothing else.
 *
 * A table rather than a function with branches, so "what does this region offer" is one readable
 * answer per region and a region added to the enum is a row this table must gain — a `switch` with a
 * default would answer for the new region with the old one's menu.
 */
const TEMPLATES: Readonly<Record<ContextMenuRegion, readonly ContextMenuItem[]>> = {
  chat: [{ role: 'copy' }],
  composer: [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  ],
}

/**
 * The menu for a region, ready for `Menu.buildFromTemplate`.
 *
 * A copy rather than the table's own arrays: electron mutates the options objects it is handed, and a
 * menu built twice must start from the same items both times.
 */
export function contextMenuTemplate(region: ContextMenuRegion): ContextMenuItem[] {
  return TEMPLATES[region].map((item) => ({ ...item }))
}
