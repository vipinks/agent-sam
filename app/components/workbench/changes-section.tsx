import { useState } from 'react'
import { Check, GitBranch, Minus, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import type { GitStatusEntry } from '@/conveyor/protocol/git'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import {
  aheadBehindLabel,
  discardSummary,
  gitErrorMessage,
  groupChanges,
  renameNote,
  rowState,
  shortPath,
} from './changes'
import type { ChangeSide } from './changes'
import { useWorkbenchStore } from './store'

/**
 * The Changes section of the explorer: what git thinks of the working tree, and the actions a user
 * takes on it.
 *
 * It lives inside the explorer panel rather than behind a rail item of its own, because the two are
 * readings of the same thing — the tree and its state — and one of them means little without the
 * other in view. It is a section rather than a pane because a panel 250px wide can carry a list and a
 * branch line but not a diff, so the diff opens in the code viewer beside it.
 *
 * Nothing here runs git. Every read is a query main answers with structured data, and every action is
 * a command it answers with a code on failure — the renderer never sees git's output, and never
 * branches on a sentence git wrote.
 */

/** The refetch interval for git state, in the one case the panel has to poll. */
const STATUS_STALE_MS = 4000

export function ChangesSection({ rootPath }: { rootPath: string }) {
  // The list refetches on the window refocusing, so an agent's write or an editor's save shows up
  // without the user reaching for refresh — the refresh button is for impatience, not correctness.
  const status = conveyor.git.status.useQuery({
    input: { rootPath },
    retry: false,
    staleTime: STATUS_STALE_MS,
  })
  const branch = conveyor.git.branch.useQuery({ input: { rootPath }, retry: false })
  const log = conveyor.git.log.useQuery({ input: { rootPath }, retry: false })
  const localBranches = conveyor.git.localBranches.useQuery({ input: { rootPath }, retry: false })

  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const selectedChange = useWorkbenchStore((s) => s.selectedChange)
  const setSelectedChange = useWorkbenchStore((s) => s.setSelectedChange)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)
  const commitMessage = useWorkbenchStore((s) => s.commitMessage)
  const setCommitMessage = useWorkbenchStore((s) => s.setCommitMessage)

  /**
   * Open one row in the diff pane.
   *
   * The open file is closed at the same time, so the main area has exactly one answer to "what is it
   * showing": the pane renders a change when one is selected and a file otherwise, and clearing the
   * other on every selection is what keeps the two from disagreeing about which was clicked last.
   */
  const openChange = (change: { path: string; side: ChangeSide; origPath?: string }) => {
    setSelectedFile(null)
    setSelectedChange(change)
  }

  const stage = conveyor.git.stage.useMutation()
  const unstage = conveyor.git.unstage.useMutation()
  const commit = conveyor.git.commit.useMutation()
  const discard = conveyor.git.discardWorktree.useMutation()
  const checkout = conveyor.git.checkoutBranch.useMutation()

  /** Refetch every read the panel makes. One place, so a new read cannot be forgotten by a caller. */
  const refreshAll = () => {
    void conveyor.git.status.invalidate({ rootPath })
    void conveyor.git.branch.invalidate({ rootPath })
    void conveyor.git.log.invalidate({ rootPath })
    void conveyor.git.localBranches.invalidate({ rootPath })
  }

  /**
   * Run one action, then refresh.
   *
   * The refresh is unconditional — in a `finally` — because a command that failed may still have
   * changed something (a partially applied batch), and a panel showing state it has already
   * invalidated is worse than one refetching a little too often.
   */
  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    try {
      await action()
      if (success) toast.success(success)
    } catch (err) {
      // Branched on the code, never on the message. The code is shown too: it is the half that does
      // not move when the wording does.
      const code = err instanceof ConveyorError ? err.code : 'UNKNOWN'
      toast.error(gitErrorMessage(code), { description: code })
    } finally {
      setBusy(null)
      refreshAll()
    }
  }

  // The not-a-repository state, and the missing-binary state, are read off the branch query — the
  // first read the panel makes, and the one whose failure says whether there is a repository at all.
  // Branched on the code so the copy is ours rather than main's, and never a toast: a folder without
  // a repository is an ordinary thing to open.
  const failureCode =
    status.error instanceof ConveyorError
      ? status.error.code
      : branch.error instanceof ConveyorError
        ? branch.error.code
        : null

  if (failureCode === 'GIT_NOT_REPO' || failureCode === 'GIT_NOT_INSTALLED') {
    return (
      <div className="border-b border-border px-3 py-2">
        <p className="text-[12px] text-muted-foreground">{gitErrorMessage(failureCode)}</p>
      </div>
    )
  }

  const groups = groupChanges(status.data ?? [])
  const branchLabel = aheadBehindLabel(
    branch.data ?? { name: '', detached: false, upstream: null, ahead: 0, behind: 0 }
  )
  const stagedCount = groups.staged.length

  /** A row's tooltip: the full path, and where a rename came from. */
  const fullPath = (entry: GitStatusEntry) => {
    const from = renameNote(entry)
    return from ? `${entry.path}\nrenamed from ${from}` : entry.path
  }

  return (
    <div className="flex min-h-0 flex-col border-b border-border">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={branch.data?.name}>
                {branch.data?.name || '…'}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="text-[11.5px]">{branchLabel ?? 'This branch tracks no upstream.'}</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">{branchLabel}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh changes"
          disabled={status.isFetching}
          onClick={refreshAll}
        >
          <RefreshCw className={status.isFetching ? 'animate-spin' : undefined} />
        </Button>
      </div>

      <div className="max-h-64 overflow-auto px-1 pb-1">
        {stagedCount > 0 && (
          <Group
            title="Staged"
            entries={groups.staged}
            side="staged"
            busy={busy}
            selectedChange={selectedChange}
            fullPath={fullPath}
            onSelect={openChange}
            onAction={(entry) =>
              void run(`unstage:${entry.path}`, () => unstage.mutateAsync({ rootPath, paths: [entry.path] }))
            }
            actionLabel="Unstage"
            actionIcon={<Minus />}
          />
        )}

        <Group
          title="Changes"
          entries={groups.unstaged}
          side="unstaged"
          busy={busy}
          selectedChange={selectedChange}
          fullPath={fullPath}
          onSelect={openChange}
          onAction={(entry) =>
            void run(`stage:${entry.path}`, () => stage.mutateAsync({ rootPath, paths: [entry.path] }))
          }
          actionLabel="Stage"
          actionIcon={<Plus />}
          onDiscard={(entry) => setPendingDiscard([entry.path])}
        />

        {status.data && status.data.length === 0 && (
          <p className="px-2 py-2 text-[11.5px] text-muted-foreground">No changes — the worktree matches the commit.</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-2 pb-2">
        <Input
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter commits, which is the convention for a one-line message box. Shift+Enter is left
            // alone so a longer message can still be typed into the field.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void run('commit', () => commit.mutateAsync({ rootPath, message: commitMessage }), 'Committed.').then(
                () => setCommitMessage('')
              )
            }
          }}
          placeholder="Commit message"
          aria-label="Commit message"
          className="h-7 flex-1 text-[12px]"
        />
        <Button
          size="icon-xs"
          aria-label="Commit staged changes"
          disabled={!commitMessage.trim() || stagedCount === 0 || busy === 'commit'}
          onClick={() =>
            void run('commit', () => commit.mutateAsync({ rootPath, message: commitMessage }), 'Committed.').then(() =>
              setCommitMessage('')
            )
          }
        >
          <Check />
        </Button>
      </div>

      {log.data && log.data.length > 0 && (
        <div className="border-t border-border px-2 py-1.5">
          <p className="mb-1 text-[10.5px] tracking-wide text-muted-foreground uppercase">Recent</p>
          <ul className="space-y-0.5">
            {log.data.slice(0, 5).map((entry) => (
              <li key={entry.hash} className="flex gap-1.5 text-[11px]">
                <span className="shrink-0 font-mono text-muted-foreground">{entry.hash}</span>
                <span className="truncate" title={entry.subject}>
                  {entry.subject}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {localBranches.data && localBranches.data.length > 0 && (
        <div className="border-t border-border px-2 py-1.5">
          <label
            className="mb-1 block text-[10.5px] tracking-wide text-muted-foreground uppercase"
            htmlFor="branch-pick"
          >
            Switch branch
          </label>
          <select
            id="branch-pick"
            aria-label="Switch branch"
            className="w-full rounded-sm border border-input bg-transparent px-1.5 py-1 font-mono text-[11.5px]"
            value=""
            disabled={busy?.startsWith('branch') === true}
            onChange={(e) => {
              const name = e.target.value
              if (!name) return
              void run(`branch:${name}`, () => checkout.mutateAsync({ rootPath, name }), `Now on ${name}.`)
            }}
          >
            <option value="">Switch to…</option>
            {localBranches.data.map((name) => (
              <option key={name} value={name} disabled={name === branch.data?.name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/*
        Discard is the one destructive control here, so it asks first and names what it will throw away.
        The paths are named individually rather than counted: "discard 2 files" does not tell the user
        whether the file they care about is one of them.
      */}
      <AlertDialog open={pendingDiscard !== null} onOpenChange={(open) => !open && setPendingDiscard(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes to these files?</AlertDialogTitle>
            <AlertDialogDescription>
              This throws away the edits in the worktree and puts the files back as they are in the index. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 space-y-0.5 overflow-auto">
            {(pendingDiscard ?? []).map((path) => (
              <li key={path} className="truncate font-mono text-[12px]" title={path}>
                {path}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const paths = pendingDiscard ?? []
                setPendingDiscard(null)
                void run(
                  'discard',
                  async () => {
                    const result = await discard.mutateAsync({ rootPath, paths })
                    toast.success(discardSummary(result))
                    return result
                  },
                  undefined
                )
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * One group of rows, with the actions that apply to its side.
 */
function Group({
  title,
  entries,
  side,
  busy,
  selectedChange,
  fullPath,
  onSelect,
  onAction,
  actionLabel,
  actionIcon,
  onDiscard,
}: {
  title: string
  entries: GitStatusEntry[]
  side: ChangeSide
  busy: string | null
  selectedChange: { path: string; side: ChangeSide } | null
  fullPath: (entry: GitStatusEntry) => string
  onSelect: (change: { path: string; side: ChangeSide; origPath?: string }) => void
  onAction: (entry: GitStatusEntry) => void
  actionLabel: string
  actionIcon: React.ReactNode
  onDiscard?: (entry: GitStatusEntry) => void
}) {
  if (entries.length === 0) return null

  return (
    <div className="mb-1">
      <p className="px-2 py-1 text-[10.5px] tracking-wide text-muted-foreground uppercase">
        {title} · {entries.length}
      </p>
      <ul>
        {entries.map((entry) => {
          const isSelected = selectedChange?.path === entry.path && selectedChange.side === side
          const from = renameNote(entry)
          return (
            <li key={`${side}:${entry.path}`} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  onSelect({ path: entry.path, side, ...(entry.origPath ? { origPath: entry.origPath } : {}) })
                }
                title={fullPath(entry)}
                aria-current={isSelected ? 'true' : undefined}
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[11.5px] transition-colors ${
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
              >
                <span className="w-3 shrink-0 text-center font-mono text-[10.5px] text-muted-foreground">
                  {rowState(entry, side)}
                </span>
                <span className="truncate font-mono">{shortPath(entry.path)}</span>
                {from && <span className="shrink-0 text-[10px] text-muted-foreground">← renamed</span>}
              </button>

              {onDiscard && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Discard changes to ${entry.path}`}
                  disabled={busy !== null}
                  onClick={() => onDiscard(entry)}
                >
                  <RotateCcw />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${actionLabel} ${entry.path}`}
                disabled={busy !== null}
                onClick={() => onAction(entry)}
              >
                {actionIcon}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
