import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/**
 * The shared pane header. Fixed height so the rail, explorer, chat and code columns sit on one
 * baseline — the three panes are separate scroll containers and would otherwise drift apart.
 * It is also the narrowest row in the app whenever the drawer is the column it titles, because the
 * drawer's width is the one the user chooses — and a chosen width is a width that can be too small. So
 * the row degrades in a stated order instead of wrapping. The title never wraps: `truncate` is nowrap
 * with an ellipsis, and the whole label travels in `title`, which is what a reader who can only see
 * "Chat Sess…" needs. What gives up its width first is the trailing row, which carries the heavier
 * shrink factor, so a narrow drawer costs a short search field before it costs the title a character.
 * What cannot usefully move is pinned: the glyph, and the controls whose hit targets are their size.
 *
 * `leading` is the slot before the glyph, and it exists for the one control that belongs to the *view*
 * rather than to the pane's own contents: the way back out of a screen that took the whole main area
 * over. Optional, so every other pane renders exactly the row it rendered before.
 *
 * `afterTitle` is the matching slot on the other side of the name: a control that belongs to the title
 * itself, in the left cluster with it. It carries a heavier shrink factor than the name does, for the
 * reason the trailing row does — the label a control shows is worth a character less than the pane's own
 * name is — while the name keeps the `truncate` it always had. Also optional, and for the same reason.
 */
export function PaneHeader({
  icon: Icon,
  title,
  leading,
  afterTitle,
  children,
}: {
  icon: LucideIcon
  title: string
  /** Optional control before the glyph — the way back into the view this pane took over. */
  leading?: ReactNode
  /** Optional control after the title, in the left cluster with it — the pane's own subject. */
  afterTitle?: ReactNode
  /** Optional trailing controls, pinned to the right edge. */
  children?: ReactNode
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 select-none">
      {leading}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-[13px] font-medium" title={title}>
        {title}
      </span>
      {afterTitle}
      {children && <div className="ml-auto flex min-w-0 shrink-6 items-center gap-1">{children}</div>}
    </header>
  )
}
