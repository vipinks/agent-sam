import {
  Folder,
  GitBranch,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
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
 * The activity views the workbench switches between, in the order they are read: the conversation,
 * then the folder it is about, then the state of that folder. Settings is deliberately not one of
 * them — it is a place you visit and leave, and it comes last for the same reason.
 *
 * The shell is not one of them either, and that is this phase's change: the terminal is a resident of
 * the right rail, docked into the inner group's right slot like the file's two views, rather than a
 * view that takes the whole main area. So the list is three, and the three are all things the *drawer*
 * shows.
 *
 * The order is the rail's, top to bottom, because the rail draws this list and nothing else does: a
 * reader of either one is reading the other, and that is what makes a reorder here a change to the
 * rail rather than a second place where the rail's order is written down. It is also why nothing
 * outside this module positions itself by an index into the list — a panel's header asks for its own
 * activity by name, because a reorder changes what the rail offers and not what a panel is.
 */
export const ACTIVITIES: Activity[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, panelTitle: 'Chat Sessions' },
  { id: 'files', label: 'Explorer', icon: Folder, panelTitle: 'Explorer' },
  { id: 'git', label: 'Git', icon: GitBranch, panelTitle: 'Git Changes' },
]

/**
 * One activity of the registry, by name.
 *
 * Named lookups rather than the index a panel happens to sit at: the rail's order is a presentation of
 * this list, so a header titled from a position would be retitled by a reorder that was only meant to
 * move icons. The head of the list stands in for an id the registry does not hold, which no panel asks
 * for — every caller passes an id from the list above.
 */
export function activityById(id: string): Activity {
  return ACTIVITIES.find((activity) => activity.id === id) ?? ACTIVITIES[0]
}

/**
 * The drawer's collapse flag, and the direction a click would take it in.
 *
 * The label is named once here rather than at each of the two controls, so the drawer's header glyph and
 * the rail's cannot come to disagree about what a click does. Each of them renders one direction only —
 * the header while the drawer is here, the rail while it is away — so between them the flag never has a
 * button whose label describes the state it has left.
 */
function useDrawerCollapse(): { collapsed: boolean; label: string; toggle: () => void } {
  const drawerCollapsed = useWorkbenchStore((s) => s.drawerCollapsed)
  const setDrawerCollapsed = useWorkbenchStore((s) => s.setDrawerCollapsed)
  return {
    collapsed: drawerCollapsed,
    label: drawerCollapsed ? 'Expand drawer' : 'Collapse drawer',
    toggle: () => setDrawerCollapsed(!drawerCollapsed),
  }
}

/**
 * The way back into the drawer, at the rail's top — rendered only while there is one to come back to.
 *
 * Phase 29 repurposed the slot the status dot held as the drawer's collapse control, which meant the
 * rail's head was a control whose direction the state decided. Phase 39 gives the way *in* to the
 * drawer's own header, where it is a panel-left-close glyph beside the panel it belongs to, and retires
 * the rail's copy of that direction: this renders the mirrored panel-left-open glyph, and only while the
 * drawer is away. The slot therefore belongs to the state it exists for rather than to the rail's
 * furniture, and an element that is not there is one nothing can tab to — which is the point, because
 * the rail's first stop is the conversation whenever there is nothing to expand.
 */
export function DrawerOpen({ className }: { className?: string }) {
  const { collapsed, label, toggle } = useDrawerCollapse()

  if (!collapsed) return null

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={toggle}
      className={className}
    >
      <PanelLeftOpen className="size-4.5" />
    </button>
  )
}

/**
 * The drawer's own collapse control, at the right edge of its header beside whatever panel is showing.
 *
 * It replaces the header chevron Phase 29 put here, and it is now the only control that puts the drawer
 * away: the rail kept the way back instead of both directions, so the two are one glyph and its mirror
 * rather than two arrows that had to keep agreeing. It states one direction, and there is no state in
 * which it has to state the other one — the header belongs to the drawer, so while the drawer is away
 * there is no header to hold it. `aria-expanded` is pinned true for the reason the drawer's control on
 * the right rail pins it: a reader told this control collapses a panel can be told the panel is here.
 */
export function DrawerClose() {
  const { collapsed, label, toggle } = useDrawerCollapse()

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      className="shrink-0"
      onClick={toggle}
    >
      <PanelLeftClose />
    </Button>
  )
}

/**
 * The icon rail: the workbench's top-level navigation. Icons only, so each button states its label
 * through a tooltip for pointers and an `aria-label` for everything else. Settings sits at the
 * foot because it is a place you visit and leave, not a mode you work in.
 *
 * An activity click means what the screen makes it mean, which is three cases rather than one. While
 * the drawer is away, any icon is the way back and brings the drawer with the panel it names. While it
 * is here, the icon of the panel already showing puts it away, because that is what a second click on
 * "the thing that is open" means everywhere else. Any other icon is the switch it has always been.
 */
export function IconRail() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const setActiveActivity = useWorkbenchStore((s) => s.setActiveActivity)
  const drawerCollapsed = useWorkbenchStore((s) => s.drawerCollapsed)
  const setDrawerCollapsed = useWorkbenchStore((s) => s.setDrawerCollapsed)

  const choose = (id: string) => {
    if (drawerCollapsed) {
      setActiveActivity(id)
      setDrawerCollapsed(false)
      return
    }
    if (id === activeActivity) {
      setDrawerCollapsed(true)
      return
    }
    setActiveActivity(id)
  }

  return (
    <nav aria-label="Workbench" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-card py-2">
      <DrawerOpen className="mb-1 flex size-8 items-center justify-center rounded-md border border-brand/35 bg-brand-soft text-brand outline-none transition-colors hover:bg-brand-soft/80 focus-visible:ring-2 focus-visible:ring-ring" />

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
            onClick={() => choose(activity.id)}
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
