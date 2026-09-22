import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, TriangleAlert } from 'lucide-react'
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
} from '../ui/alert-dialog'
import { Textarea } from '../ui/textarea'
import { AgentActionCard } from './agent-action-card'
import { MarkdownContent } from './markdown'
import { MentionChipRow } from './mention-chip'
import { contextNoticeText } from './mentions'
import type { AgentTurn } from './agent-session'

/**
 * A single message bubble.
 *
 * Memoised on purpose: during a stream, every token updates the transcript state, and without this
 * each token would re-render every previous turn — the exact cost the performance rule forbids.
 * Only the streaming message's `content` changes, so only it re-renders.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onApprove,
  onDeny,
  canEdit,
  laterTurns,
  onResend,
}: {
  message: AgentTurn
  onApprove?: (callId: string) => void
  onDeny?: (callId: string) => void
  /**
   * Whether a message may be edited at all right now.
   *
   * The pane decides this rather than the bubble, because it is a fact about the conversation: a run
   * in flight or a decision waiting is producing the very turns an edit would remove. Defaulted off, so
   * a bubble rendered on its own — as the copy tests do — offers no control whose effect it cannot
   * perform.
   */
  canEdit?: boolean
  /** How many turns follow this one, which is how many an edit would remove. */
  laterTurns?: number
  /**
   * Send this message again, with the words and the files it ended up with.
   *
   * The id rather than the turn itself: the replacement is built by the pane's ordinary send path, and
   * a bubble holding a stale copy of its own turn could not describe it.
   */
  onResend?: (turnId: string, text: string, mentionPaths: string[]) => void
}) {
  const isUser = message.role === 'user'
  const steps = message.steps

  /*
   * The editor, held here rather than in the pane.
   *
   * Only one message is ever being edited, and it is the one on screen under the cursor — a second
   * piece of pane state would be a second place to keep in step with the transcript. The chips start
   * from the turn's own and are the send's `mentionPaths`, so an edit that removed a file really does
   * send the message without it.
   */
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [editChips, setEditChips] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)

  const startEditing = () => {
    setEditText(message.content)
    setEditChips(message.mentionPaths ? [...message.mentionPaths] : [])
    setConfirming(false)
    setEditing(true)
  }

  const stopEditing = () => {
    setEditing(false)
    setConfirming(false)
  }

  const resend = () => {
    setConfirming(false)
    setEditing(false)
    onResend?.(message.id, editText.trim(), editChips)
  }

  const saveAndResend = () => {
    // An emptied message is not a message. The editor stays open rather than sending whitespace or
    // closing on a click that did nothing.
    if (editText.trim() === '') return
    // Nothing follows it, so there is nothing to remove and nothing to ask about. Otherwise the count
    // is named once, before anything is cut.
    if ((laterTurns ?? 0) > 0) {
      setConfirming(true)
      return
    }
    resend()
  }

  /*
   * What the copy button takes, and the whole of it.
   *
   * `content` is the turn's own text: what the user sent, or the narration the assistant's chunks
   * were assembled into. Everything else a turn carries sits in its own field — tool cards in
   * `steps`, the plan in `plan`, the ending in `endNotice` — so a copy is the words, never a
   * rendering of the widgets that happened to sit among them.
   */
  const copyButton = <CopyMessageButton value={message.content} label={isUser ? 'Copy message' : 'Copy reply'} />

  return (
    <div className={cn('flex w-full px-4 py-2.5', isUser ? 'justify-end' : 'justify-start')}>
      {/* The button is a sibling of the bubble, on the side away from the message's own edge, rather
          than a layer over it: overlaid it would cover the first line of a short message, and a corner
          reserved inside the bubble would indent every bubble for a control most readers never use.
          `group` sits on this pair, so the button answers to the bubble it belongs to and not to
          empty space beside it. The pair carries the width cap the bubble used to carry, so the
          button's box is reserved even while it is invisible — a control that appeared on hover
          would reflow the text it is offering to copy. */}
      <div className="group flex max-w-[85%] min-w-0 items-start gap-1.5">
        {/* Beside the copy control, and for the same reason: a sibling rather than an overlay, so a
            short message is never hidden by the controls that act on it. */}
        {isUser && canEdit && <EditMessageButton onEdit={startEditing} />}
        {isUser && copyButton}
        <div
          className={cn(
            'min-w-0 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
            isUser ? 'bg-brand-soft text-foreground' : 'border border-border bg-card text-card-foreground'
          )}
        >
          {isUser ? (
            editing ? (
              <>
                {/* The chips above the text, exactly where the message shows them, and removable here
                  because they are part of what is being sent again rather than a record of what was. */}
                {editChips.length > 0 && (
                  <MentionChipRow
                    paths={editChips}
                    onRemove={(path) => setEditChips((current) => current.filter((chip) => chip !== path))}
                    className="mb-2"
                  />
                )}
                <Textarea
                  // Focused on open: the editor exists to be typed in, and the click that opened it
                  // was the user's way of saying which message.
                  autoFocus
                  value={editText}
                  aria-label="Edit message text"
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      saveAndResend()
                    }
                  }}
                  // A fixed box rather than one that grows with the draft: the transcript is scrolled by
                  // reading, and an editor that pushed the conversation around while being typed in
                  // would move the message the user is working on.
                  className="field-sizing-fixed h-20 w-80 max-w-full resize-none text-[13px]"
                />
                <div className="mt-2 flex items-center justify-end gap-1.5">
                  <Button type="button" size="xs" variant="outline" aria-label="Cancel editing" onClick={stopEditing}>
                    Cancel
                  </Button>
                  <Button type="button" size="xs" aria-label="Save and resend" onClick={saveAndResend}>
                    Save and resend
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* What this message attached, above it: the files are what the sentence is about, and a
                  reopened conversation shows them again from the paths that were stored with it. Not
                  removable here — the message has been sent, so the chips are a record, not a control. */}
                {message.mentionPaths && message.mentionPaths.length > 0 && (
                  <MentionChipRow paths={message.mentionPaths} className="mb-2" />
                )}
                {/* A user's message is literal text: never parsed as markdown, which would eat their
                  angle brackets and asterisks. */}
                <p className="break-words whitespace-pre-wrap">{message.content}</p>
              </>
            )
          ) : (
            <>
              {/* Files this send named that could not be included. Above the answer because they are
                about the question, and a warning the user reads after the reply is a warning too late
                to do anything about. */}
              {message.contextNotices && message.contextNotices.length > 0 && (
                <div className="mb-2 space-y-1">
                  {message.contextNotices.map((notice, index) => (
                    <ContextNoticeRow key={`${notice.path}-${index}`} path={notice.path} code={notice.code} />
                  ))}
                </div>
              )}
              {/* Steps above the prose: the actions are what the answer refers to, so they read in
                the order they happened. */}
              {steps.length > 0 && (
                <div className="mb-2 space-y-1.5">
                  {steps.map((step) => (
                    <AgentActionCard key={step.callId} step={step} onApprove={onApprove} onDeny={onDeny} />
                  ))}
                </div>
              )}
              {/* With steps but no prose yet, the cards are the content — an empty "Thinking…" under
                them would be noise. */}
              {(message.content || steps.length === 0) && <MarkdownContent content={message.content} />}
            </>
          )}

          {message.error && (
            <p className="mt-2 border-t border-border pt-2 text-[12px] text-destructive">{message.error}</p>
          )}
        </div>
        {!isUser && copyButton}
      </div>

      {/*
        The confirmation, raised once before anything is cut, and only when there is something to cut.

        It is asked because the removal is not visible in the act: the message is edited in place, and
        the answers that went with it disappear at the same moment — so the count is the only warning
        the user gets, and it is named before the click rather than after it.
      */}
      {confirming && (
        <AlertDialog open onOpenChange={(open) => (!open ? setConfirming(false) : undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Resend this message?</AlertDialogTitle>
              <AlertDialogDescription>{resendConfirmText(laterTurns ?? 0)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction aria-label="Resend" onClick={resend}>
                Resend
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
})

/** How long the button says a copy happened before going quiet again. */
const COPIED_MS = 1500

/**
 * How many later turns a resend would remove, in a sentence.
 *
 * One is spelled out because "1 later turns" is the kind of sentence a user distrusts a dialog for,
 * and the count is the whole of what this dialog has to say. The number is the length of the cut
 * rather than a promise about it: the same rule that counts here is the one the send applies.
 */
function resendConfirmText(laterTurns: number): string {
  return laterTurns === 1
    ? 'One later turn will be removed from this conversation.'
    : `${laterTurns} later turns will be removed from this conversation.`
}

/**
 * Opens the editor on the message it sits beside.
 *
 * Hidden until the bubble is hovered, and revealed by focus as well — the same treatment as the copy
 * button beside it, and for the same reason: `opacity-0` leaves it in the tab order, so a keyboard
 * reaches it without a pointer ever crossing the message.
 *
 * The label names the action rather than the message: "Edit message" is what a screen reader user is
 * told, and the message itself is the thing their focus has just arrived next to.
 */
function EditMessageButton({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      aria-label="Edit message"
      onClick={onEdit}
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Pencil className="size-3.5" />
    </button>
  )
}

/**
 * Copies one bubble's text to the clipboard.
 *
 * Hidden until the bubble is hovered, and revealed by focus as well — the button stays in the tab
 * order while hidden, because `opacity-0` is not `display: none`, so a keyboard reaches it without a
 * pointer ever crossing a bubble. That is also why it is revealed rather than disabled: an affordance
 * that exists only for a mouse is not an affordance.
 *
 * The confirmation is the glyph and it clears itself, so a bubble cannot sit there claiming a copy
 * from an hour ago. The label stays the name of the action throughout: it is what the button does,
 * and it is the one thing a screen reader user is told when they land on it.
 */
function CopyMessageButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A bubble unmounts while its confirmation is pending — a session switch re-renders the transcript
  // from a different root — and the timer would then set state on a component that is gone.
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const copy = async (): Promise<void> => {
    // The confirmation follows the write rather than the click: a write the platform refuses never
    // reaches the lines below, so the glyph stays as it was instead of claiming a copy that did not
    // happen.
    await navigator.clipboard.writeText(value)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/**
 * A file the send named that could not be attached.
 *
 * The code is branched on, never the sentence main would have written: the wording belongs to the
 * renderer, and the code is shown beside it because it is the half of the message that does not move
 * when the copy does.
 */
function ContextNoticeRow({ path, code }: { path: string; code: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-2 py-1.5 text-[12px] text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0">
        <span className="font-mono break-all text-foreground">{path}</span> {contextNoticeText(code)}{' '}
        <span className="font-mono">({code})</span>
      </p>
    </div>
  )
}
