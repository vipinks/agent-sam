import { Folder, MessageSquare, Settings, SquareTerminal, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkbenchStore } from './store'

/** The three activity views the workbench switches between. */
export interface Activity {
  id: string
  label: string
  icon: LucideIcon
  /** What the secondary panel shows while this view is active. */
  panelTitle: string
  /** Narrows an open file list down to what belongs to the view; everything shows for the rest. */
  filter: RegExp | null
}

export const ACTIVITIES: Activity[] = [
  { id: 'files', label: 'Explorer', icon: Folder, panelTitle: 'Explorer', filter: null },
  { id: 'chat', label: 'Chat', icon: MessageSquare, panelTitle: 'Chat Sessions', filter: /\.(tsx?|jsx?|md|json)$/ },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: SquareTerminal,
    panelTitle: 'Terminal',
    filter: /\.(tsx?|jsx?|json)$/,
  },
]

/**
 * The icon rail: the workbench's top-level navigation. Icons only, so each button states its label
 * through a tooltip for pointers and an `aria-label` for everything else.
 */
export function IconRail() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const setActiveActivity = useWorkbenchStore((s) => s.setActiveActivity)

  return (
    <nav aria-label="Workbench" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-card py-2">
      <span className="mb-1 flex size-8 items-center justify-center rounded-md border border-brand/35 bg-brand-soft">
        <span className="size-2.5 rounded-full bg-brand" />
      </span>

      {ACTIVITIES.map((activity) => {
        const Icon = activity.icon
        const isActive = activity.id === activeActivity
        return (
          <button
            key={activity.id}
            type="button"
            title={activity.label}
            aria-label={activity.label}
            aria-pressed={isActive}
            onClick={() => setActiveActivity(activity.id)}
            className={cn(
              'flex size-10 items-center justify-center rounded-md outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring',
              isActive ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Icon className="size-4.5" />
          </button>
        )
      })}

      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        className="mt-auto flex size-10 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings className="size-4.5" />
      </button>
    </nav>
  )
}
