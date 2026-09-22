import { Folder, GitBranch, MessageSquare, Settings, SquareTerminal, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkbenchStore } from './store'

/** The activity views the workbench switches between. */
export interface Activity {
  id: string
  label: string
  icon: LucideIcon
  /** What the secondary panel shows while this view is active. */
  panelTitle: string
}

/**
 * The activity views the workbench switches between, in the order they are read: the folder, the state
 * of that folder, the conversation about it, and the shell beside it. Settings is deliberately not one
 * of them — it is a place you visit and leave, and it comes last for the same reason.
 */
export const ACTIVITIES: Activity[] = [
  { id: 'files', label: 'Explorer', icon: Folder, panelTitle: 'Explorer' },
  { id: 'git', label: 'Git', icon: GitBranch, panelTitle: 'Git Changes' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, panelTitle: 'Chat Sessions' },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal, panelTitle: 'Terminal' },
]

/**
 * The icon rail: the workbench's top-level navigation. Icons only, so each button states its label
 * through a tooltip for pointers and an `aria-label` for everything else. Settings sits at the
 * foot because it is a place you visit and leave, not a mode you work in.
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
        aria-pressed={activeActivity === 'settings'}
        onClick={() => setActiveActivity('settings')}
        className={cn(
          'mt-auto flex size-10 items-center justify-center rounded-md outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring',
          activeActivity === 'settings'
            ? 'bg-brand-soft text-brand'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <Settings className="size-4.5" />
      </button>
    </nav>
  )
}
