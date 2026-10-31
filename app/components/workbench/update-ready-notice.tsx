import { useState } from 'react'
import { CircleArrowUp, X } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { SAC_POLICY_WARNING } from '@/conveyor/protocol/updates'
import { updateStatusStore } from '@/conveyor/stores/update-status'
import { Button } from '../ui/button'

/**
 * The update-ready notice: the one thing about the updater a user is told without asking.
 *
 * A downloaded update installs when the app quits, so this card is not what makes an update happen — the
 * updater's own `autoInstallOnAppQuit` is. The card exists because the user cannot see that for themselves:
 * the bytes are on disk, the app is a restart away from running them, and nothing else in the window says
 * so. The ready half therefore speaks at exactly one state; the recovery half speaks for the previous
 * launch's unfinished install, which outranks this launch's status because it is what the user can still
 * act on. `available` and `downloading` are the updater working, and
 * the Updates section already reports them for a reader who wants to look; `up-to-date`, `idle` and `error`
 * have nothing to offer. A card that appeared for those would be interrupting someone to tell them nothing
 * they can act on, which is how a notice stops being read.
 *
 * It is mounted in the workbench rather than in a panel, for the same reason: the news is about the app, not
 * about the view in front of it, so it has to reach a user who is in the conversation, in the explorer or in
 * a document. It is pinned to the bottom of the main area as an overlay rather than carried in a panel's own
 * flow, because a card in the transcript would scroll away and a card in the drawer would be in a column half
 * the screen does not have. The strip itself is the app's existing notice idiom — the turn-end card's
 * bordered `bg-muted/30` row with a small leading glyph and a trailing button — with a dismiss control added,
 * which is the one thing that idiom did not have and the one thing this notice needs to be bearable.
 *
 * The dismissal is this component's own memory, held in state for the life of the shell. It cannot live in a
 * store: a dismissed notice is a fact about a window's attention rather than about the app, and persisting it
 * would silence a later launch's notice about a *different* update. State rather than a timestamp, and state
 * is why the memory ends with the process — which is the right end, because a genuinely new update needs to
 * be able to say so.
 *
 * In development the ready half renders nothing, by the code path the requirement names: the updater is never
 * wired outside a packaged build, so the mirror never leaves `idle`. The recovery half can still appear there:
 * the previous launch's marker is read before the packaged gate, because the pointer is owed regardless of the
 * build that finds it.
 */
export function UpdateReadyNotice() {
  const state = useConveyorStore(updateStatusStore, (s) => s.state)
  const availableVersion = useConveyorStore(updateStatusStore, (s) => s.availableVersion)
  const pendingInstall = useConveyorStore(updateStatusStore, (s) => s.pendingInstall)
  const sacPolicyState = useConveyorStore(updateStatusStore, (s) => s.sacPolicyState)
  const [dismissed, setDismissed] = useState(false)
  const [recoveryDismissed, setRecoveryDismissed] = useState(false)

  const install = conveyor.updates.install.useMutation()
  const showInstaller = conveyor.updates.showInstaller.useMutation()
  const installVisible = conveyor.updates.installVisible.useMutation()

  // A recovery is a notice in its own right: it speaks for the previous launch's unfinished install, and it
  // is not silenced by the ready card's state or dismissal. Everything else stays silent outside `ready`.
  const recovering = pendingInstall !== null && !recoveryDismissed
  if (!recovering && (dismissed || state !== 'ready')) return null

  return (
    <section
      data-slot={recovering ? 'update-recovery-notice' : 'update-ready-notice'}
      aria-label={recovering ? 'Update did not finish' : 'Update ready'}
      className="pointer-events-auto flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 shadow-lg"
    >
      {!recovering && sacPolicyState === 'enforcing' ? (
        <span
          data-slot="sac-policy-warning"
          className="text-[11.5px] leading-snug text-orange-600 dark:text-orange-400"
        >
          {SAC_POLICY_WARNING}
        </span>
      ) : null}
      <div className="flex w-full items-center gap-2">
        <CircleArrowUp aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11.5px] leading-snug text-muted-foreground">
            {recovering && pendingInstall !== null
              ? `Update to ${pendingInstall.version} didn't finish — open the installer`
              : 'Update ready — restart to install'}
          </span>
          {recovering ? (
            <span className="text-[11.5px] leading-snug text-muted-foreground">
              Try visible install if no installer appeared; strict app-control policies may still block it.
            </span>
          ) : availableVersion === null ? null : (
            <span className="text-[11.5px] leading-snug text-muted-foreground">Version {availableVersion}</span>
          )}
        </div>
        {recovering ? (
          <Button size="xs" disabled={showInstaller.isPending} onClick={() => void showInstaller.mutateAsync()}>
            Show installer
          </Button>
        ) : null}
        {recovering ? (
          <Button
            size="xs"
            variant="outline"
            disabled={installVisible.isPending}
            onClick={() => void installVisible.mutateAsync()}
          >
            Try visible install
          </Button>
        ) : null}
        {recovering ? null : (
          <Button
            size="sm"
            // The same act, and therefore the same dispatcher, as the Updates section's own install button: two
            // surfaces offering one thing must not be two implementations of it.
            disabled={install.isPending}
            onClick={() => void install.mutateAsync()}
          >
            Install and restart
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={recovering ? 'Dismiss update recovery notice' : 'Dismiss update notice'}
          title="Dismiss"
          onClick={() => (recovering ? setRecoveryDismissed(true) : setDismissed(true))}
        >
          <X />
        </Button>
      </div>
    </section>
  )
}
