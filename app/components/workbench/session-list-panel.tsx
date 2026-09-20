import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Download, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { chatSessionsStore, type ChatSession } from '@/conveyor/stores/chat-sessions'
import { SEARCH_MIN_TERM } from '@/conveyor/protocol/search'
import type { ExportFormat } from '@/conveyor/protocol/export'
import { cn } from '@/lib/utils'
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
  AlertDialogTrigger,
} from '../ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { PaneHeader } from './pane-header'
import { ACTIVITIES } from './icon-rail'
import { useWorkbenchStore } from './store'
import { formatRelativeTime } from './relative-time'
import { isSearchable, planVisibleSessions, snippetsFor } from './session-search'
import { planRename } from './rename'
import type { SessionError } from './use-chat-sessions'

/**
 * The chat rail's secondary panel: the conversation list, its search, and its row actions.
 *
 * Metadata comes from the chat-sessions store, which main owns — so the list is the same in every
 * window and survives a restart. The transcript it refers to is a separate file, loaded only when a
 * session is opened, which is what keeps a streaming answer off the store's broadcast path.
 *
 * Two things cross the boundary from main rather than being computed here, and both are deliberate.
 * Renaming is a store action, so the new title is broadcast to every window like any other change.
 * Searching is a scan of the transcripts on disk — which this panel cannot do, because it cannot see
 * the disk — so it asks main for snippets and renders whatever comes back. What it never receives is a
 * transcript body: the scan returns three excerpts and a count per session, and nothing else.
 *
 * The panel is deliberately thin: it renders rows and reports intent. Opening, creating, and
 * deleting all have to coordinate the transcript (save before leaving, load after arriving), and
 * that coordination lives in `use-chat-sessions` rather than being spread across event handlers
 * here.
 */
export function SessionListPanel({
  onCreate,
  onOpen,
  onRename,
  onExport,
  onDelete,
  error,
}: {
  onCreate: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void
  onExport: (id: string, format: ExportFormat) => void
  onDelete: (id: string) => void
  /** The session whose transcript failed to load, if any. */
  error: SessionError | null
}) {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)
  const activity = ACTIVITIES.find((a) => a.id === 'chat') ?? ACTIVITIES[1]
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // The row being renamed, and the text in its editor. Held here rather than in the row so that only
  // one row can be in edit mode at a time — which is what a list should do, and what makes the
  // committed value unambiguous.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const [query, setQuery] = useState('')
  const [queryFocused, setQueryFocused] = useState(false)

  const searchable = isSearchable(query, SEARCH_MIN_TERM)

  /**
   * The snippet scan.
   *
   * `enabled` is what keeps a short term off the wire entirely: main's schema refuses a term under
   * three characters, so asking with one would be a request that can only fail. Keyed on the
   * trimmed term, so typing a space does not start a second scan.
   */
  const matches = conveyor.sessions.searchSessions.useQuery({
    input: { term: query.trim() },
    enabled: searchable,
  })

  /**
   * The rows on screen: title matches unioned with the body matches main reported.
   *
   * Scoped to a focused, long-enough term, because that is the only state in which the scan is
   * running — a blurred or short field has no scan behind it, so `bodyMatchIds` would be a stale
   * answer to a question the user is no longer asking, and using it would leave rows on screen that
   * no visible query explains. Below the floor the list is the plain metadata list.
   */
  const bodyMatchIds = useMemo(() => {
    if (!searchable || !queryFocused) return undefined
    // `data` is undefined until the scan answers, which is the state the title-only rule is for.
    return matches.data?.map((result) => result.id)
  }, [matches.data, queryFocused, searchable])

  const visible = useMemo(() => planVisibleSessions(sessions, query, bodyMatchIds), [sessions, query, bodyMatchIds])

  /**
   * Commit the row's editor: write the new title, or leave the session alone.
   *
   * Both outcomes close the editor, and for the same reason — the previous title is what the row
   * goes back to. A blank submission is rejected by `planRename` returning nothing, which is what
   * restores the old name rather than writing an empty one.
   */
  const commitRename = (session: ChatSession) => {
    const plan = planRename(session.title, draft)
    if (plan) onRename(session.id, draft)
    setEditingId(null)
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setQueryFocused(true)}
          onBlur={() => setQueryFocused(false)}
          onKeyDown={(e) => {
            // Escape clears the search rather than leaving the field, which is what a search box
            // that filters a list in place should do — there is nowhere to go "back" to.
            if (e.key === 'Escape') {
              e.preventDefault()
              setQuery('')
            }
          }}
          placeholder="Search"
          aria-label="Search conversations"
          type="search"
          className="h-6 w-28 px-1.5 text-[11.5px] md:text-[11.5px]"
        />
        <Button variant="ghost" size="icon-xs" aria-label="New chat" title="New chat" onClick={onCreate}>
          <Plus />
        </Button>
      </PaneHeader>

      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <MessageSquare className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No conversations yet</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              Start one with the button above, or just send a message — a session is created for you.
            </p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        // A filter with no survivors is not an empty list of conversations, and saying so is what
        // keeps the user from thinking their sessions are gone.
        <div className="flex flex-1 items-start justify-center px-6 pt-6 text-center">
          <p className="text-[12.5px] text-muted-foreground">No conversations match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {visible.map((session) => {
            const isActive = session.id === activeSessionId
            const isBroken = error?.id === session.id
            const match = queryFocused && searchable ? snippetsFor(session.id, matches.data) : undefined

            return (
              <li key={session.id}>
                <div
                  className={cn(
                    'group relative flex items-start gap-2 px-3 py-2 transition-colors',
                    isActive ? 'bg-brand-soft' : 'hover:bg-accent'
                  )}
                >
                  {editingId === session.id ? (
                    <RenameField
                      value={draft}
                      onChange={setDraft}
                      onCommit={() => commitRename(session)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(session.id)}
                      aria-current={isActive ? 'true' : undefined}
                      className="min-w-0 flex-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <p className={cn('truncate text-[12.5px] font-medium', isActive && 'text-foreground')}>
                        {session.title}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{formatRelativeTime(session.updatedAt, Date.now())}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate font-mono" title={`${session.providerId} · ${session.model}`}>
                          {session.providerId}/{session.model}
                        </span>
                      </p>
                      {isBroken && (
                        // An inline note, not only a toast: a toast is gone before the user can act on
                        // it, and this row is the thing they need to decide about.
                        <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                          <CircleAlert className="size-3 shrink-0" />
                          {error.message}
                        </p>
                      )}
                    </button>
                  )}

                  {/* Row actions. Hidden until hover, but revealed on focus as well so they are
                      reachable by keyboard rather than being a pointer-only affordance. */}
                  {editingId !== session.id && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <IconButton
                        label={`Rename ${session.title}`}
                        tooltip="Rename"
                        onClick={() => {
                          setDraft(session.title)
                          setEditingId(session.id)
                        }}
                      >
                        <Pencil />
                      </IconButton>

                      <ExportButton title={session.title} onExport={(format) => onExport(session.id, format)} />

                      <AlertDialog
                        open={pendingDelete === session.id}
                        onOpenChange={(open) => setPendingDelete(open ? session.id : null)}
                      >
                        <AlertDialogTrigger asChild>
                          <IconButton
                            label={`Delete ${session.title}`}
                            tooltip="Delete"
                            className="data-[state=open]:opacity-100"
                          >
                            <Trash2 />
                          </IconButton>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                            <AlertDialogDescription>
                              “{session.title}” and its transcript will be removed. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                setPendingDelete(null)
                                onDelete(session.id)
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>

                {match && match.snippets.length > 0 && (
                  <div className="border-l-2 border-border pr-3 pl-4 pb-2">
                    {match.snippets.map((snippet, index) => (
                      <p key={index} className="truncate text-[11px] text-muted-foreground" title={snippet}>
                        {snippet}
                      </p>
                    ))}
                    {match.matchCount > match.snippets.length && (
                      // The count covers occurrences the snippets do not show, which is the reason it
                      // is sent at all.
                      <p className="text-[10.5px] text-muted-foreground/70">{match.matchCount} matches</p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * A row's title in edit mode.
 *
 * Focus on mount, so the pencil puts the caret in the field rather than making the user click again.
 * Enter and blur both commit, Escape reverts — and Escape must not then be followed by a commit,
 * which is why the cancelled flag is checked before committing on the way out.
 */
function RenameField({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const cancelled = useRef(false)

  return (
    <input
      // Focused on mount because the field exists only because the user asked to rename this row:
      // focusing it is the action itself, not a convenience.
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        // A revert is not a rename. Without this, Escape would revert and then blur-commit the
        // draft it had just discarded.
        if (cancelled.current) return
        onCommit()
      }}
      aria-label="Session title"
      className="min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 py-0.5 text-[12.5px] font-medium outline-none"
    />
  )
}

/**
 * The export control: one download icon, and the format chosen from it.
 *
 * A single button with a two-item menu rather than two buttons, because the row is 250 pixels wide
 * and already holding a pencil and a trash can; and rather than a dialog, because the format is the
 * only decision and a dialog for one choice is a heavier interruption than the task deserves.
 *
 * Built the way the titlebar's menus are — an absolutely positioned list, outside-click and Escape to
 * close — rather than on a portal, so it stays inside this row's stacking context and behaves in a
 * DOM test the way it behaves in the app.
 */
function ExportButton({ title, onExport }: { title: string; onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)

  return (
    <div ref={wrapper} className="relative">
      <IconButton
        label={`Export ${title}`}
        tooltip="Export"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Download />
      </IconButton>

      {open && (
        <ExportMenu
          onClose={() => setOpen(false)}
          onPick={(format) => {
            setOpen(false)
            onExport(format)
          }}
          wrapper={wrapper}
        />
      )}
    </div>
  )
}

/** The two formats, as a small menu anchored to the export button. */
function ExportMenu({
  onPick,
  onClose,
  wrapper,
}: {
  onPick: (format: ExportFormat) => void
  onClose: () => void
  wrapper: React.RefObject<HTMLDivElement | null>
}) {
  const menu = useRef<HTMLDivElement>(null)

  // Open state owns the listeners, so they exist exactly while the menu does.
  useMenuDismiss(menu, wrapper, onClose)

  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Export format"
      className="absolute top-full right-0 z-50 mt-1 w-40 rounded-md border border-border bg-popover p-1 shadow-lg"
    >
      {(['markdown', 'json'] as const).map((format) => (
        <button
          key={format}
          type="button"
          role="menuitem"
          onClick={() => onPick(format)}
          className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
        >
          {format === 'markdown' ? 'Markdown (.md)' : 'JSON (.json)'}
        </button>
      ))}
    </div>
  )
}

/**
 * Close the menu on an outside click or Escape.
 *
 * The listener is on `mousedown` rather than `click`, matching the titlebar menus: a menu that closes
 * after the click lands has already let the click through to whatever was underneath.
 */
function useMenuDismiss(
  menu: React.RefObject<HTMLDivElement | null>,
  trigger: React.RefObject<HTMLDivElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      // A click on the trigger is the trigger's own business — closing here as well would reopen the
      // menu on the next click and make the button feel broken.
      if (trigger.current?.contains(target)) return
      if (menu.current && !menu.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, trigger, onClose])
}

/** A row action: an icon button that says what it does, on hover and to a screen reader. */
function IconButton({
  label,
  tooltip,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; tooltip: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={label} className={className} {...props}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The chat activity renders the session list instead of the file tree.
 *
 * The explorer keeps the tree; this is only the branch for the chat rail, which is what makes the
 * panel header's promise true.
 */
export function ChatSecondaryPanel(props: Parameters<typeof SessionListPanel>[0]) {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  if (activeActivity !== 'chat') return null
  return <SessionListPanel {...props} />
}
