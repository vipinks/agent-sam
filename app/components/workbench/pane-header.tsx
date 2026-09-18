import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/**
 * The shared pane header. Fixed height so the rail, explorer, chat and code columns sit on one
 * baseline — the three panes are separate scroll containers and would otherwise drift apart.
 */
export function PaneHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  /** Optional trailing controls, pinned to the right edge. */
  children?: ReactNode
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 select-none">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-[13px] font-medium">{title}</span>
      {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </header>
  )
}
