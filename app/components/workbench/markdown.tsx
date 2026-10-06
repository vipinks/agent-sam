import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
 * `remark-gfm` is wired here, and only here, for the same reason: both surfaces consume this component,
 * so a table, a task list, a strikethrough or an autolink is supported in the chat and in the viewer at
 * once. The alternative — a plugin added at one call site — would have left the two surfaces rendering
 * the same characters differently, which is the divergence this file exists to prevent.
 *
 * GFM is a *parsing* extension and nothing more. It adds syntaxes to the markdown grammar; it does not
 * add a step that turns markup into elements. `rehype-raw` is still absent from this pipeline, so raw
 * HTML in a source document continues to arrive as its own characters, which is the property the
 * renderer's safety rests on. `remark-gfm`'s own tagfilter is not a substitute for that and is not
 * relied on as one: it removes a handful of dangerous *tags* from an HTML stream, and there is no HTML
 * stream here to filter.
 *
 * Styled through Tailwind on the surrounding element and through the theme file for the constructs whose
 * markup this file cannot reach — a task list's checkbox and its generated class names, and the `del`
 * element, which has no component override because it is a GFM element rather than a markdown one. The
 * type scale stays the app's.
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
    // `data-slot` is the hook the theme file scopes its GFM rules to, so the chat and the preview get one
    // set of table, checkbox and strikethrough styles rather than two that can drift apart.
    <div data-slot="markdown" className="space-y-2.5 [&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The prose wraps, and it wraps on every construct markdown can draw it in rather than on the
          // paragraph alone. `break-words` on a paragraph was the only containment there was, so a long
          // inline code span inside a list item, a heading or a blockquote was an unbreakable run that
          // painted past its block box and into the transcript's scroll container — which is what put a
          // horizontal scrollbar under an answer. The two constructs that must *not* wrap are excluded on
          // purpose and keep their own horizontal scroll below: a wrapped code line is a line that can no
          // longer be copied as written, and a wrapped cell is a table that reflows instead of scrolling.
          p: ({ children }) => <p className="break-words whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1 break-words">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1 break-words">{children}</ol>,
          h1: ({ children }) => <h1 className="text-[15px] font-semibold break-words">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-semibold break-words">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13px] font-semibold break-words">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 break-words text-muted-foreground">
              {children}
            </blockquote>
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
          // Only the scroll wrapper is set here. A table's borders, cell padding and header emphasis live
          // in the theme file with the rest of the GFM rules, so a wide table scrolls inside the bubble
          // while its own appearance has one definition rather than two.
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
