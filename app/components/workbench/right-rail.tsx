import { Eye, FileCode, Maximize2, Minimize2, PanelRightClose, SquareTerminal, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { useWorkbenchStore } from './store'

/**
 * The right rail, and the panels it docks.
 *
 * The rail is the left rail's mirror and its opposite in one way: an icon click here does not switch
 * between columns but *docks* one panel into the inner group, beside the chat. Three residents, one at
 * a time, because the slot they share is one column — the file's source, the same file rendered, and
 * the shell command transcript are three things a reader looks at in the same place, not three places.
 *
 * At launch nothing is docked. That is the phase's decision rather than a default that fell out of the
 * code: the inner group holds the conversation alone, and the rail is where you go to open the file
 * beside it. A docked panel is a way of looking at the file in front of you, so the flag lives in the
 * store as memory only — a session switch inside a run leaves it alone, and every launch opens
 * rail-only.
 *
 * The registry is here, beside the rail that draws it, for the reason the left rail's `ACTIVITIES` is:
 * the order is the rail's top to bottom and nothing else writes it down, so a reorder here is a change
 * to the rail rather than a second place the order exists.
 */

/** The ids of the panels the right rail can dock. */
export type RightPanelId = 'code' | 'preview' | 'terminal'

/** One resident of the rail: what it is called, and the glyph it is drawn as. */
export interface RightResident {
  id: RightPanelId
  label: string
  icon: LucideIcon
}

/**
 * The residents, in the order they are read: the file's source and its diffs, then that same file
 * rendered, then the shell. The first two are the same open file seen two ways and sit together for
 * that reason; the terminal is a different thing entirely and comes last.
 */
export const RIGHT_RESIDENTS: RightResident[] = [
  { id: 'code', label: 'Code', icon: FileCode },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
]

/**
 * One resident of the registry, by name.
 *
 * Named lookups rather than a position, for the reason `activityById` gives: a header titled from an
 * index would be retitled by a reorder that was only meant to move icons. The head of the list stands
 * in for an id the registry does not hold, which no panel asks for.
 */
export function rightResidentById(id: string): RightResident {
  return RIGHT_RESIDENTS.find((resident) => resident.id === id) ?? RIGHT_RESIDENTS[0]
}

/**
 * The right rail: three buttons, one per resident, and nothing else — the same shape the left rail
 * has, icons only, each stating its label through a tooltip for pointers and an `aria-label` for
 * everything else.
 *
 * `aria-pressed` is the state of the dock rather than of the button: while a resident is docked its
 * icon is pressed, which is what tells a reader which panel the slot is holding. Clicking the pressed
 * one puts it away, which is the second-click rule the left rail already keeps.
 */
export function RightRail() {
  const rightPanel = useWorkbenchStore((s) => s.rightPanel)
  const toggleRightPanel = useWorkbenchStore((s) => s.toggleRightPanel)

  return (
    <nav aria-label="Right rail" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-card py-2">
      {RIGHT_RESIDENTS.map((resident) => {
        const Icon = resident.icon
        const isDocked = resident.id === rightPanel
        return (
          <button
            key={resident.id}
            type="button"
            title={resident.label}
            aria-label={resident.label}
            aria-pressed={isDocked}
            onClick={() => toggleRightPanel(resident.id)}
            className={cn(
              'flex size-10 items-center justify-center rounded-md outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring',
              isDocked ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Icon className="size-4.5" />
          </button>
        )
      })}
    </nav>
  )
}

/**
 * The header's collapse glyph: the way back to rail-only from inside the panel.
 *
 * Every resident offers it in its own header rather than the slot framing them all, because the slot
 * would then carry a second header above the panel's own and the two would have to agree about a
 * height that only one of them owns. It states one direction and there is no state in which it has to
 * state the other: the header belongs to the panel, so while the panel is away there is no header to
 * hold it and the rail's own icon is how it comes back. `aria-expanded` is pinned true for the same
 * reason — a reader told the control collapses a panel can be told that the panel is expanded.
 */
export function PanelCollapseControl() {
  const closeRightPanel = useWorkbenchStore((s) => s.closeRightPanel)

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Collapse panel"
      title="Put this panel back to the rail"
      aria-expanded
      onClick={closeRightPanel}
    >
      <PanelRightClose />
    </Button>
  )
}

/**
 * The viewer's expansion, offered by whichever panel is docked.
 *
 * It lives here rather than in the code viewer it started in because it belongs to the slot and not to
 * one of its residents: expanding means the docked column takes the chat's width, and that is true of
 * the rendered preview and the transcript exactly as it is of the source. The labels are the ones the
 * control has always stated, and they still move with the state, so each direction is named.
 */
export function PanelExpandControl() {
  const viewerExpanded = useWorkbenchStore((s) => s.viewerExpanded)
  const setViewerExpanded = useWorkbenchStore((s) => s.setViewerExpanded)

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-pressed={viewerExpanded}
      aria-label={viewerExpanded ? 'Restore the chat column' : 'Expand the viewer'}
      title={viewerExpanded ? 'Restore the chat column' : 'Expand the viewer over the chat column'}
      onClick={() => setViewerExpanded(!viewerExpanded)}
    >
      {viewerExpanded ? <Minimize2 /> : <Maximize2 />}
    </Button>
  )
}
