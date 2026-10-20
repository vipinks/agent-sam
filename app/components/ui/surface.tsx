import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'

/**
 * Which family of surface a control is drawn on, and the fill that reads against it.
 *
 * The app has two surface families in light mode, and they are two tones rather than two tokens: the
 * page (`--background`, `#f4f2ef`) and the card (`--card`, `#fffefc`) that sits on it. A field painted
 * with the page's own tone dissolves into a page and reads as a field on a card; a field painted with the
 * card's tone does the opposite. One fixed fill therefore cannot be right on both, which is why every
 * field, every select trigger and the two bordered button variants ask this module instead of naming a
 * colour. The reference is the home screen's Recent-projects pill — the raised plate a reader already
 * reads as something lying *on* the surface rather than cut into it.
 *
 * The card family is recessed relative to the page in both directions, so the two values are each other's
 * inverse: on a page a control takes `bg-card`, on a card it takes `bg-background`. Dark mode is untouched
 * by both — every control states its own dark tint, and a `dark:` utility outranks a bare one — so the
 * raised tint the fields carry in the dark is exactly what it was.
 *
 * `page` is the default because it is the shell's own surface: the window, the chat pane, the settings
 * screen, the tools panel and every viewer are drawn on `bg-background`, so a control that names no
 * parent is a control on the page. A card declares itself — a dialog, a popover, the provider box, the
 * session list, the composer's raised plate — and its contents read against it.
 */
export type SurfaceKind = 'page' | 'card'

const SurfaceContext = createContext<SurfaceKind>('page')

/** Declares the family its subtree is drawn on. Renders no element: it is the context and nothing else. */
export function SurfaceProvider({ kind, children }: { kind: SurfaceKind; children: ReactNode }) {
  return <SurfaceContext.Provider value={kind}>{children}</SurfaceContext.Provider>
}

/** The family the calling control is drawn on. */
export function useSurfaceKind(): SurfaceKind {
  return useContext(SurfaceContext)
}

/**
 * A card-family surface, as the element that *is* the card.
 *
 * A panel that is already a `bg-card` box would otherwise need a second, empty element around it to carry
 * the declaration, and a box around a box is a layout the app does not need. This is the same declaration
 * written as the element itself: the props are the div's props, so the marker, the data attributes and the
 * classes are exactly what the caller already wrote.
 */
export function CardSurface({ children, ...props }: ComponentProps<'div'>) {
  return (
    <SurfaceProvider kind="card">
      <div {...props}>{children}</div>
    </SurfaceProvider>
  )
}

/**
 * The light-mode fill for a control on each family.
 *
 * Named as one table rather than two ternaries so the two controls that recess themselves differently
 * — none, today — cannot drift into two answers about the same surface.
 */
export const SURFACE_FILL: Readonly<Record<SurfaceKind, string>> = {
  page: 'bg-card',
  card: 'bg-background',
}
