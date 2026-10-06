import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { updateAvailability } from '@/conveyor/protocol/updates'
import { updatePreferencesStore } from '@/conveyor/stores/update-preferences'
import { updateStatusStore } from '@/conveyor/stores/update-status'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { formatRelativeTime } from './relative-time'

/**
 * The Updates section: what the updater is doing, and the three things a user can ask it to do.
 *
 * Here rather than on a control in the title bar, and that is the placement decision rather than a
 * convenience. A check running in the background is not news, and an update that installs on quit needs
 * nothing from the user at all — so the surface that reports it belongs with the other advanced
 * preferences, one rail click away, and the one moment that does need the user is announced by
 * `update-ready-notice.tsx` where they already are. The two surfaces read one store: this is where the state
 * is described in full, that is where the one state worth interrupting for is acted on.
 *
 * **Nothing here decides anything.** Every word on the screen and every control's presence or enabled state
 * comes from `updateAvailability`, which is handed the state, the user's auto-download preference and the
 * failure code. A component that branched on the state itself would be a second copy of a rule that already
 * has one — and the two copies would disagree the first time a state was added. That is also why the error
 * line cannot print main's message: the code crosses as a string, the rule refuses a value that is not one of
 * the declared codes, and what it hands back is the word for the code or the state's own.
 *
 * Both values are the stores', not this component's: `updateStatus` is main's mirror of what the updater
 * reported — the state, the version a found update would install, the running build's version, when a check
 * last completed, and the code a failure carries — and `updatePreferences` is main's persisted copy of the one
 * choice a user owns here. The section keeps no draft and no local switch position, so the switch cannot show
 * a value the store does not hold.
 *
 * The `lastCheckedAt` reading goes through `formatRelativeTime`, the session list's own coarse formatter:
 * "when did this build last hear from the feed" is a question about recency, not about a timestamp, and a
 * status line that ticked every second would re-render this screen for nothing. The absence is said in words
 * rather than drawn as epoch zero, because a build that has never checked is not a build that checked in 1970.
 *
 * In development nothing here runs: the module refuses outside a packaged build with `UPDATES_DISABLED_IN_DEV`,
 * the store never leaves `idle`, and the section says so in the one line it has — which is the honest answer,
 * not an empty screen.
 */
export function UpdatesSection() {
  const state = useConveyorStore(updateStatusStore, (s) => s.state)
  const errorCode = useConveyorStore(updateStatusStore, (s) => s.errorCode)
  const currentVersion = useConveyorStore(updateStatusStore, (s) => s.currentVersion)
  const lastCheckedAt = useConveyorStore(updateStatusStore, (s) => s.lastCheckedAt)
  const autoDownload = useConveyorStore(updatePreferencesStore, (s) => s.autoDownload)
  const { setAutoDownload } = useConveyorStore(updatePreferencesStore)

  // Read once, for the whole render: the status line and the three controls are one answer about one state,
  // and asking the rule once per control would be four chances for a render to straddle a transition.
  const availability = updateAvailability({ state, autoDownload, errorCode })

  const check = conveyor.updates.check.useMutation()
  const download = conveyor.updates.download.useMutation()
  const install = conveyor.updates.install.useMutation()

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Updates</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Agent Sam checks for a new release in the background and installs one when the app quits. Updates are only
          available in an installed build, so nothing on this screen does anything in a development run.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {/* The fact of the screen: which build is speaking, and what it last heard. Both are fields of the
            status mirror rather than anything this component derived, so a window that has just opened says
            what main already knows. */}
        <div className="flex flex-col gap-1">
          <span data-slot="updates-version" className="text-[12.5px] leading-relaxed text-muted-foreground">
            Agent Sam {currentVersion || 'version unknown'}
          </span>
          <span data-slot="updates-last-checked" className="text-[12.5px] leading-relaxed text-muted-foreground">
            {lastCheckedAt === null ? 'Never checked' : `Last checked ${formatRelativeTime(lastCheckedAt, Date.now())}`}
          </span>
        </div>

        {/* The status line, verbatim from the rule — including a failure, which is worded by its code and
            never by the sentence main's own Error carried. */}
        <p data-slot="updates-status" className="text-[13px] leading-relaxed text-foreground">
          {availability.statusWord}
        </p>

        {/* The one preference. It is read by the updater as it applies its settings before each check, so
            flipping it governs the next check rather than one already in flight — which is also why the
            download button beside it appears the moment it goes off and the state is `available`. */}
        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor="updates-auto-download" className="text-[12.5px]">
              Download updates automatically
            </Label>
            <span className="text-[11.5px] leading-snug text-muted-foreground">
              Off means the update is offered here instead of fetched on its own.
            </span>
          </div>
          <Switch
            id="updates-auto-download"
            aria-label="Download updates automatically"
            checked={autoDownload}
            onCheckedChange={(next) => setAutoDownload({ autoDownload: next })}
          />
        </div>

        {/* The three acts, each drawn by the rule rather than by a conditional written here. The check is
            always on the screen and disabled while `canCheck` is false — the state says one is already
            running, and a control that vanished would be a surface that changed shape under a user who was
            looking at it. The download is presence-based, because it exists only as the manual half of the
            preference: with auto-download on the updater is already fetching the update, and offering to
            fetch it again would be offering work that is underway. */}
        <div className="flex items-center gap-2">
          <Button
            data-slot="updates-check"
            size="sm"
            variant="secondary"
            disabled={!availability.canCheck || check.isPending}
            onClick={() => void check.mutateAsync()}
          >
            Check for updates
          </Button>

          {availability.canDownload ? (
            <Button
              data-slot="updates-download"
              size="sm"
              variant="outline"
              disabled={download.isPending}
              onClick={() => void download.mutateAsync()}
            >
              Download
            </Button>
          ) : null}

          {availability.canInstall ? (
            <Button
              data-slot="updates-install"
              size="sm"
              disabled={install.isPending}
              onClick={() => void install.mutateAsync()}
            >
              Install and restart
            </Button>
          ) : null}
        </div>
      </div>
    </>
  )
}
