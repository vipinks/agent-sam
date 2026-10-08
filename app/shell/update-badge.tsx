import { CircleArrowUp } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { updateBadge } from '@/conveyor/protocol/updates'
import { updateStatusStore } from '@/conveyor/stores/update-status'
import { ControlButton } from './control-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { useWorkbenchStore } from '../components/workbench/store'

/**
 * The header's update badge: the one thing in the chrome that mentions the updater.
 *
 * The Updates section is the right place for the updater's state — it is an advanced preference, and a
 * check that takes place in the background is not news. What that placement costs is a user who never opens
 * Settings: a release could be found, downloaded and installed on the next quit without them ever being
 * told. This closes that gap without opening a new one, and the two halves are the point:
 *
 * - It speaks for exactly three states — `available`, `downloading` and `ready` — which is the rule's
 *   decision rather than this component's. An error is deliberately not one of them: it belongs to the
 *   screen that can say which phase failed and offer a retry, and a permanent mark in the title bar about a
 *   failed check would be chrome nagging about something it cannot fix. `idle`, `checking` and `up-to-date`
 *   are the updater either having nothing to say or not having asked yet.
 * - It leads rather than acts. A press opens the settings screen *at* the Updates rail entry through the
 *   store's own deep link — the same one the composer's slash commands and the tools panel use — so the
 *   section a user lands on is the one that can explain, offer the download or perform the install. Nothing
 *   here installs anything, and that is deliberate: an install is a restart, and a control in the window
 *   chrome is the last place a user expects a window to disappear from.
 *
 * The words come from `updateBadge` in the protocol, and both versions travel in them, so the sentence says
 * what is being replaced by what. The tooltip is the same string as the control's `aria-label`: one
 * sentence reached two ways, rather than two descriptions of one control that can disagree.
 *
 * It is drawn in the right cluster immediately before the terminal panel's control — the row's other
 * resident that changes what the window is showing rather than what it looks like — and it is the same
 * `ControlButton` as its neighbours, so it fills the bar's height, carries the row's hover treatment, and is
 * reachable by Tab because it is a real button and not a decorated span. The amber dot is the one thing the
 * neighbours do not have: without it, a control that only appears once in a while reads as another glyph in
 * a row of glyphs, and the mark is what says there is something behind it.
 *
 * In development it renders nothing at all, by the same code path the requirement names: the updater is
 * never wired outside a packaged build, so the mirror this reads never leaves `idle`.
 */
export function UpdateBadge() {
  const state = useConveyorStore(updateStatusStore, (s) => s.state)
  const currentVersion = useConveyorStore(updateStatusStore, (s) => s.currentVersion)
  const availableVersion = useConveyorStore(updateStatusStore, (s) => s.availableVersion)
  const openSettingsAt = useWorkbenchStore((s) => s.openSettingsAt)

  // A version the mirror has not been told yet is drawn as nothing rather than as an empty pair of arrows:
  // `available` and `ready` both carry a version by construction, so an absent one is a mirror that has not
  // caught up, and a sentence with a hole in it is worse than a badge a moment later.
  const badge = updateBadge(state, currentVersion, availableVersion ?? '')
  if (!badge.present || availableVersion === null) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <ControlButton
            data-slot="update-badge"
            label={badge.label}
            className="relative"
            onClick={() => openSettingsAt('updates')}
          >
            <CircleArrowUp className="size-4" />
            <span
              data-slot="update-badge-dot"
              aria-hidden
              className="absolute top-2 right-2 size-1.5 rounded-full bg-amber-500"
            />
          </ControlButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{badge.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
