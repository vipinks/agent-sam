import { memo } from 'react'
import Markdown from 'react-markdown'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentActionCard } from './agent-action-card'
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

  return (
    <div className={cn('flex w-full px-4 py-2.5', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] min-w-0 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
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
    </div>
  )
})

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

/**
 * Markdown for assistant turns. Styled through Tailwind on the surrounding element rather than a
 * plugin, so no CSS file is needed and the type scale stays the app's.
 */
function MarkdownContent({ content }: { content: string }) {
  if (!content) {
    return <span className="text-muted-foreground">Thinking…</span>
  }

  return (
    <div className="space-y-2.5 [&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2">
      <Markdown
        components={{
          p: ({ children }) => <p className="break-words whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
          h1: ({ children }) => <h1 className="text-[15px] font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13px] font-semibold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
          ),
          // Fenced blocks keep their own horizontal scroll so a long line cannot widen the bubble.
          code: ({ children, className }) => (
            <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[12px]', className)}>{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted p-2.5 font-mono text-[12px]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
