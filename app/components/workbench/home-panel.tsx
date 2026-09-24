import { useState } from 'react'
import { Check, ChevronDown, FolderOpen, History, Loader2 } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { sameRoot } from '@/conveyor/protocol/recent-roots'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  HOME_HEADLINE,
  HOME_OPEN_FOLDER,
  HOME_STARTERS,
  HOME_SUBLINE,
  homeChip,
  projectRowLabel,
  recentSessionsForHome,
} from './home'
import { rootErrorMessage, rootTail } from './recent-roots'
import { useRootSwitch } from './use-root-switch'
import { useChatSessionsContext } from './chat-sessions-context'
import { releaseViewer } from './use-chat-sessions'

/**
 * The home screen: the two pieces the pane draws around its composer.
 *
 * Home is the workbench with nothing open in it, and the composer stays exactly where it always is —
 * the bottom of the chat column — so neither piece here draws the box or the send. `HomeHero` fills the
 * space the transcript would have taken, and `HomePanel` sits under the composer, in that order:
 * the headline, the composer card, the folder the work will happen in, the conversations worth
 * returning to, and three ways to start.
 *
 * The composer is deliberately not re-implemented for this screen. A second box would be a second
 * place for sending, mentions and the drag to drift from the first; what home changes about the
 * composer is where it sits and how it is framed, and both of those are the pane's business.
 *
 * Everything drawn here is a control. The hero says what the screen is for and stops; the folder row,
 * the conversations offered back and the starter prompts are the things a person can act on, and a
 * paragraph explaining any of them would be read once and then be in the way.
 */

/** The headline, in the space above the composer. */
export function HomeHero() {
  return (
    // The space is the transcript's, taken as it stands: the column keeps its shape between the two
    // states, and the headline is centred in whatever height the window has for it.
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 py-6 text-center">
      {/* The screen's one heading, and a real one: this is what the view is, and a screen reader
          landing here should be told that rather than being read a styled paragraph. */}
      <h1 className="text-[19px] font-semibold tracking-tight text-foreground">{HOME_HEADLINE}</h1>
      <p className="max-w-lg text-[12.5px] leading-relaxed text-muted-foreground">{HOME_SUBLINE}</p>
    </div>
  )
}

/**
 * Everything under the composer card: where the work will happen, what is already there, and how to
 * begin.
 *
 * One width, the composer's, so the row and the chips read as belonging to the box above them rather
 * than floating in the column.
 */
export function HomePanel({ onStarter }: { onStarter: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pt-3 pb-6">
      <ProjectRow />
      <RecentChips />

      {/*
        Three prompts rather than a menu of everything the app can do: a starter is worth having when it
        is something a person would actually type, and a list of capabilities would be a manual on the
        screen whose whole point is to get out of the way. Each one fills the composer; none sends.
      */}
      <div className="flex flex-wrap gap-2">
        {HOME_STARTERS.map((prompt) => (
          <Button key={prompt} variant="outline" size="sm" className="text-[12.5px]" onClick={() => onStarter(prompt)}>
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * The folder the next conversation will run in, and the way to change it.
 *
 * The switch is the explorer's own: the same dialog, the same `openRoot` call, and the same refusal
 * code — a folder that is gone is reported as gone rather than as a failure. Only what each surface
 * does *around* a switch differs, and here it is nothing but closing a clean buffer, because there is
 * no editor in front of the user to ask about.
 *
 * With no folder open there is nothing to name, so the row is the action instead: the same words the
 * menu's own entry carries, since it is the same act.
 */
function ProjectRow() {
  // `?? null` because the mirror is not answered on the first render: the store's state arrives a
  // tick after the component mounts, and until it does there is no folder open — which is a state the
  // row already draws, and the honest reading of "main has told us nothing yet".
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const recentRoots = useConveyorStore(workspaceStore, (s) => s.recentRoots) ?? []
  const rootSwitch = useRootSwitch()
  const [open, setOpen] = useState(false)

  /** Hand a path to main, and close a clean viewer once the folder has actually changed. */
  const switchTo = async (path: string) => {
    const code = await rootSwitch.switchRoot(path)
    if (code === null) releaseViewer()
  }

  /** The dialog's answer goes through the same switch a menu row does. */
  const openFolder = async () => {
    const picked = await rootSwitch.chooseFolder()
    if (picked) await switchTo(picked)
  }

  const error = rootSwitch.error ? (
    <p role="status" className="text-[11.5px] text-destructive">
      {rootErrorMessage(rootSwitch.error)}
    </p>
  ) : null

  if (rootPath === null) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={rootSwitch.busy} onClick={() => void openFolder()}>
          {rootSwitch.busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {HOME_OPEN_FOLDER}
        </Button>
        {error}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/*  `aria-label` names the control while the text carries its value: a trigger whose
              accessible name were the folder it happened to be showing would be a different control
              after every switch. The full path is on the trigger's title, and on every menu row. */}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Work in a project"
            title={rootPath}
            disabled={rootSwitch.busy}
            className="max-w-64"
          >
            {rootSwitch.busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            <span className="truncate">{projectRowLabel(rootPath)}</span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80 p-1">
          <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Recent folders</p>

          {recentRoots.length === 0 ? (
            <p className="px-2 pb-1 text-[12px] leading-relaxed text-muted-foreground">
              Folders you open are listed here.
            </p>
          ) : (
            <ul>
              {recentRoots.map((path) => {
                // Compared with the rule the store reduces by, not with `===`: the same folder reaches
                // the list with whatever case the dialog that returned it used.
                const active = sameRoot(path, rootPath)
                return (
                  <li key={path}>
                    <button
                      type="button"
                      // `aria-current` rather than a class alone, so the open folder is stated to a
                      // screen reader instead of only drawn.
                      aria-current={active ? 'true' : undefined}
                      title={path}
                      onClick={() => {
                        setOpen(false)
                        void switchTo(path)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
              disabled={rootSwitch.busy}
              onClick={() => {
                setOpen(false)
                void openFolder()
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            >
              <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
              {HOME_OPEN_FOLDER}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {error}
    </div>
  )
}

/**
 * The conversations offered back: the three most recently touched, across projects.
 *
 * A chip says which project it belongs to and what it was about, because either half alone is
 * ambiguous — titles repeat across projects, and a project name says nothing about which of its
 * conversations this is. Clicking one opens it through the same path a row in the sessions panel
 * takes, which is what makes the folder follow the conversation.
 *
 * Nothing is drawn when there is nothing to offer back: an empty state here would be a list of the
 * conversations the user does not have yet, on a screen that is already offering three ways to start.
 */
function RecentChips() {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const { openSession } = useChatSessionsContext()
  const recent = recentSessionsForHome(sessions)

  if (recent.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <History aria-hidden="true" className="size-3.5" />
        Recent work
      </p>
      <div className="flex flex-wrap gap-2">
        {recent.map((session) => {
          const chip = homeChip(session)
          return (
            <button
              key={session.id}
              type="button"
              // The whole title, for the width the chip does not have.
              title={session.title}
              onClick={() => void openSession(session.id)}
              className="flex max-w-72 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {/* Which project, then what it was: the project comes first because it is what tells two
                  conversations with the same title apart. */}
              <span className="shrink-0 text-muted-foreground">{chip.project}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="truncate">{chip.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
