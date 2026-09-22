import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
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
}: {
  message: AgentTurn
  onApprove?: (callId: string) => void
  onDeny?: (callId: string) => void
}) {
  const isUser = message.role === 'user'
  const steps = message.steps

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
        {isUser && copyButton}
        <div
          className={cn(
            'min-w-0 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
            isUser ? 'bg-brand-soft text-foreground' : 'border border-border bg-card text-card-foreground'
          )}
        >
          {isUser ? (
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
    </div>
  )
})

/** How long the button says a copy happened before going quiet again. */
const COPIED_MS = 1500

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
