import { useState } from 'react'
import { CircleAlert, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
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
import { PaneHeader } from './pane-header'
import { ACTIVITIES } from './icon-rail'
import { useWorkbenchStore } from './store'
import { formatRelativeTime } from './relative-time'
import type { SessionError } from './use-chat-sessions'

/**
 * The chat rail's secondary panel: the conversation list.
 *
 * Metadata comes from the chat-sessions store, which main owns — so the list is the same in every
 * window and survives a restart. The transcript it refers to is a separate file, loaded only when a
 * session is opened, which is what keeps a streaming answer off the store's broadcast path.
 *
 * The panel is deliberately thin: it renders rows and reports intent. Opening, creating, and
 * deleting all have to coordinate the transcript (save before leaving, load after arriving), and
 * that coordination lives in `use-chat-sessions` rather than being spread across event handlers
 * here.
 */
export function SessionListPanel({
  onCreate,
  onOpen,
  onDelete,
  error,
}: {
  onCreate: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  /** The session whose transcript failed to load, if any. */
  error: SessionError | null
}) {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)
  const activity = ACTIVITIES.find((a) => a.id === 'chat') ?? ACTIVITIES[1]
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle}>
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
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId
            const isBroken = error?.id === session.id
            return (
              <li key={session.id}>
                <div
                  className={cn(
                    'group relative flex items-start gap-2 px-3 py-2 transition-colors',
                    isActive ? 'bg-brand-soft' : 'hover:bg-accent'
                  )}
                >
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

                  <AlertDialog
                    open={pendingDelete === session.id}
                    onOpenChange={(open) => setPendingDelete(open ? session.id : null)}
                  >
                    <AlertDialogTrigger asChild>
                      {/*
                        Revealed on hover and on focus, so it is reachable by keyboard rather than
                        being a pointer-only affordance.
                      */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${session.title}`}
                        title="Delete"
                        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                      >
                        <Trash2 />
                      </Button>
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
              </li>
            )
          })}
        </ul>
      )}
    </div>
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
