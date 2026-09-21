import Markdown from 'react-markdown'
import { cn } from '@/lib/utils'

/**
 * Markdown, as this app renders it.
 *
 * Extracted from the chat so that a second surface can show a file the same way the chat shows an
 * answer. The point of the extraction is what it *reuses* rather than what it shares: the same
 * `react-markdown` element, the same absence of `rehype-raw`, and the same one place where a file's
 * characters become elements. A preview built on its own renderer would be a second safety argument to
 * make, and a second set of type sizes to keep in step with the first.
 *
 * Styled through Tailwind on the surrounding element rather than a plugin, so no CSS file is needed and
 * the type scale stays the app's.
 *
 * `dangerouslySetInnerHTML` appears nowhere in this file, and that is the whole of the safety story: the
 * renderer's pipeline has no raw-HTML step, so markup in the source is not passed through as markup, and
 * URLs are filtered by its own url transform before they become attributes. Every caller therefore
 * inherits the same answer — the chat for an answer, the viewer for a file — instead of each deciding
 * what a document may contain.
 */
export function MarkdownContent({ content }: { content: string }) {
  if (!content) {
    // The chat's empty state, worded for a stream that has not started yet. The viewer's preview is not
    // a stream, so it answers for its own empty file rather than borrowing this sentence.
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
