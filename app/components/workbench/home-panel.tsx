import { FolderOpen, Loader2 } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { projectChips, sameRoot, type ProjectChip } from '@/conveyor/protocol/recent-roots'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { HOME_HEADLINE, HOME_OPEN_FOLDER, HOME_RECENT_PROJECTS, HOME_SUBLINE } from './home'
import { rootErrorMessage } from './recent-roots'
import { useRootSwitch } from './use-root-switch'
import { useChatSessionsContext } from './chat-sessions-context'
import { releaseViewer } from './use-chat-sessions'

/**
 * The home screen: the two pieces the pane draws around its composer.
 *
 * Home is the workbench with nothing open in it, and the composer stays exactly where it always is —
 * the bottom of the chat column — so neither piece here draws the box or the send. `HomeHero` fills the
 * space the transcript would have taken, and `HomePanel` sits under the composer, in that order:
 * the headline, the composer card, the folders the app remembers, and three ways to start.
 *
 * The composer is deliberately not re-implemented for this screen. A second box would be a second
 * place for sending, mentions and the drag to drift from the first; what home changes about the
 * composer is where it sits and how it is framed, and both of those are the pane's business.
 *
 * Everything drawn here is a control. The hero says what the screen is for and stops; the folder chips
 * and the starter prompts are the things a person can act on, and a paragraph explaining any of them
 * would be read once and then be in the way.
 *
 * One surface offers work back, and it offers *folders*: a project is where a conversation is resumed,
 * and the drawer remains the place a conversation is picked out by name. Listing conversations here as
 * well was a second way to the same rooms, and it drifted from the first the moment either changed.
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
 * Everything under the composer card: the folders the app remembers, and how to begin.
 *
 * One width, the composer's, so the row and the chips read as belonging to the box above them rather
 * than floating in the column.
 *
 * The prompts are handed in rather than read here, because which ones are offered is not this screen's
 * decision: a chosen Buddy offers its own, the app offers its three when nobody did, and the rule that
 * picks between them lives with the choice. This draws the row it is given.
 */
export function HomePanel({
  onStarter,
  starters,
}: {
  onStarter: (prompt: string) => void
  /** The prompts to offer, in the order to offer them. Never empty: a starterless Buddy keeps the three. */
  starters: readonly string[]
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pt-3 pb-6">
      <RecentProjects />

      {/*
        Three prompts rather than a menu of everything the app can do: a starter is worth having when it
        is something a person would actually type, and a list of capabilities would be a manual on the
        screen whose whole point is to get out of the way. Each one fills the composer; none sends.
      */}
      <div className="flex flex-wrap gap-2">
        {starters.map((prompt) => (
          <Button key={prompt} variant="outline" size="sm" className="text-[12.5px]" onClick={() => onStarter(prompt)}>
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * The folders the app remembers, and the way to one it does not.
 *
 * A chip says one thing and does one thing: which folder it is, how many conversations were last used
 * in it, and — on click — that folder. Which conversation is in a folder is the drawer's subject, so a
 * chip that offered one would be the second list this row exists to remove; what a chip resumes is
 * instead the *most recent* conversation there, which is the one a person returning to a project means.
 *
 * The switch is the explorer's own: the same dialog, the same `openRoot` call, and the same refusal
 * code — a folder that is gone is reported as gone rather than as a failure. Only what each surface
 * does *around* a switch differs, and here it is nothing but closing a clean buffer, because there is
 * no editor in front of the user to ask about.
 *
 * With nothing remembered there is nothing to head, so the row is the action alone.
 */
function RecentProjects() {
  // `?? null` / `?? []` because the mirror is not answered on the first render: the store's state
  // arrives a tick after the component mounts, and until it does there is no folder open and nothing
  // remembered — which is a state the row already draws, and the honest reading of "main has told us
  // nothing yet".
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const recentRoots = useConveyorStore(workspaceStore, (s) => s.recentRoots) ?? []
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions) ?? []
  const { openSession } = useChatSessionsContext()
  const rootSwitch = useRootSwitch()

  // The store's order, and the counts and the conversation to resume, all decided by the rule rather
  // than here: the screen holds the state and draws the result.
  const chips = projectChips(recentRoots, sessions)

  /** Hand a path to main, and close a clean viewer once the folder has actually changed. */
  const switchTo = async (path: string) => {
    const code = await rootSwitch.switchRoot(path)
    if (code === null) releaseViewer()
    return code
  }

  /**
   * Take the window to a folder, and answer whether it went there.
   *
   * A folder that is gone is refused here, before anything opens: existence is main's answer, and a
   * chip whose project has been deleted has to say so rather than open a conversation in a folder
   * nothing can be read from.
   *
   * The folder already open is not re-opened. It is the rule a session click follows — a click inside
   * the current project costs no `stat` at all — and it is what keeps such a click to the one thing it
   * is about.
   */
  const goToRoot = async (path: string): Promise<boolean> => {
    if (rootPath !== null && sameRoot(path, rootPath)) return true
    return (await switchTo(path)) === null
  }

  /**
   * A chip: the folder first, then the conversation in it.
   *
   * The conversation is opened through the drawer's own action, so a chip and a row in the list do the
   * same thing — save what is open, select, load — rather than two things that have to be kept in step.
   * The folder moves first either way, because the tree, the git reads and the agent's own tool paths
   * are all answered against whatever the workspace store holds, and a transcript must not arrive and
   * be read against the wrong one.
   *
   * A folder with nothing in it stops here: the folder *is* the destination then, and the composer is
   * already waiting for whatever the user came back to do.
   */
  const openChip = async (chip: ProjectChip) => {
    if (!(await goToRoot(chip.root))) return
    if (chip.sessionId !== null) await openSession(chip.sessionId)
  }

  /** The dialog's answer goes through the same switch a chip's folder does. */
  const openAnother = async () => {
    const picked = await rootSwitch.chooseFolder()
    if (picked) await switchTo(picked)
  }

  const error = rootSwitch.error ? (
    <p role="status" className="text-[11.5px] text-destructive">
      {rootErrorMessage(rootSwitch.error)}
    </p>
  ) : null

  return (
    <div className="flex flex-col gap-2">
      {/* The label is drawn only when there is something under it: with no folders remembered the row
          is the way to open one, and a heading over nothing would be the list explaining its own
          emptiness on a screen that is already offering three ways to start. */}
      {chips.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <FolderOpen aria-hidden="true" className="size-3.5" />
          {HOME_RECENT_PROJECTS}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => {
          const open = rootPath !== null && sameRoot(chip.root, rootPath)

          return (
            <button
              key={chip.root}
              type="button"
              // The whole path, for the width the chip does not have: two projects can share a last
              // segment, and the chip's name is that segment.
              title={chip.root}
              // `aria-current` rather than a weight alone, so which folder the next message runs in is
              // stated to a screen reader instead of only being drawn.
              aria-current={open ? 'true' : undefined}
              onClick={() => void openChip(chip)}
              className={cn(
                'flex max-w-72 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                open && 'font-medium text-foreground'
              )}
            >
              <span className="truncate">{chip.label}</span>
              {/* Muted, and after the name: how much is in the folder is a detail of the folder. */}
              <span className="text-muted-foreground">{chip.count}</span>
            </button>
          )
        })}

        {/* The existing dialog, offered at the end of the list — which is also the only way out of an
            empty one, so it is never conditional on there being recents. */}
        <Button
          variant="outline"
          size="sm"
          className="text-[12.5px]"
          disabled={rootSwitch.busy}
          onClick={() => void openAnother()}
        >
          {rootSwitch.busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {HOME_OPEN_FOLDER}
        </Button>
      </div>

      {error}
    </div>
  )
}
