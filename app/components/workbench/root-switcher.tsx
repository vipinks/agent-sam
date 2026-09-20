import { useState } from 'react'
import { Check, ChevronDown, FolderOpen, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sameRoot } from '@/conveyor/protocol/recent-roots'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { rootTail } from './recent-roots'

/**
 * The explorer header's folder switcher: the open root, and the folders it can be switched to.
 *
 * It renders the control and reports intent. Which folder is open is main-owned state in the
 * workspace store, and the switch itself — the stat in main, the confirmation in front of it, the
 * error it can fail with — belongs to the panel that owns those flows. This is the same split the
 * mention picker has with the composer: one place decides, one place draws.
 *
 * The trigger shows the *tail* rather than the path, because the header is one line and the tail is
 * the part that identifies the folder; the full path is on the menu rows, where the user is choosing
 * between folders that can share a tail.
 *
 * A folder is offered as a row of its own rather than as the trigger's text, so "what is open" and
 * "what can I open" never have to be read from the same element.
 */
export function RootSwitcher({
  rootPath,
  recentRoots,
  busy,
  onSwitch,
  onForget,
  onOpenFolder,
}: {
  /** The open root, or null when no folder is open. */
  rootPath: string | null
  /** Most recent first, as the store holds it. */
  recentRoots: readonly string[]
  /** True while a switch or the folder dialog is in flight. */
  busy: boolean
  onSwitch: (path: string) => void
  onForget: (path: string) => void
  onOpenFolder: () => void
}) {
  // Whether the menu is open is the one thing here that is nobody else's business: it is a view of a
  // click, not a fact about the workspace.
  const [open, setOpen] = useState(false)

  const label = rootPath ? rootTail(rootPath) : 'Open Folder'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*  `aria-label` carries the control's name while the text carries its value: a trigger whose
            accessible name were the folder it happened to be showing would be a different control
            after every switch. */}
        <Button variant="ghost" size="xs" aria-label="Recent folders" disabled={busy} className="max-w-40">
          {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          <span className="truncate">{label}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-1">
        <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Recent folders</p>

        {recentRoots.length === 0 ? (
          <p className="px-2 pb-1 text-[12px] leading-relaxed text-muted-foreground">
            Folders you open are listed here, so coming back is one click.
          </p>
        ) : (
          <ul>
            {recentRoots.map((path) => {
              // Compared with the rules the store reduces by, not with `===`: the same folder reaches
              // the list with whatever case the dialog that returned it used.
              const active = rootPath !== null && sameRoot(path, rootPath)
              return (
                // A row is a button and the forget control beside it is another: a button cannot hold
                // a button, and the two clicks mean different things — open this folder, or stop
                // offering it.
                <li key={path} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    // `aria-current` rather than a class alone, so the open folder is stated to a
                    // screen reader instead of only drawn.
                    aria-current={active ? 'true' : undefined}
                    // The tooltip is the whole path: two roots can share a tail, and the menu is where
                    // that has to be decidable.
                    title={path}
                    onClick={() => {
                      setOpen(false)
                      onSwitch(path)
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-accent hover:text-accent-foreground focus-visible:outline-none',
                      active ? 'font-medium text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {active ? (
                      <Check aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      // The check's width, kept by something that is not a check: without it the
                      // labels of active and inactive rows would not line up.
                      <span aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{rootTail(path)}</span>
                  </button>

                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Forget ${rootTail(path)}`}
                    disabled={busy}
                    onClick={() => onForget(path)}
                    className="text-muted-foreground"
                  >
                    <X />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {/* The existing dialog, offered where the list runs out — which is also the only way out of
            an empty list, so it is never conditional on there being recents. */}
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onOpenFolder()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-accent hover:text-accent-foreground focus-visible:outline-none disabled:opacity-50"
          >
            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
            Open Folder
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
