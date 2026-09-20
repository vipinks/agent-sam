import { cn } from '@/lib/utils'
import type { FileDiff } from '@/conveyor/protocol/diff'

/**
 * A line-level diff, rendered once and used wherever one is shown.
 *
 * Extracted from the agent's approval card when the changes panel needed the same view: a diff
 * computed by `computeFileDiff` in main is the same object whether it describes a write the agent is
 * asking permission for or a file the user has already changed, and two renderers would be two places
 * for the colours, the markers and the cap notice to drift apart.
 *
 * The diff arrives already computed — the renderer never reads the disk — so this only colours it.
 * Added lines green and removed lines red, in the app's monospace face, capped and scrollable so a
 * large rewrite cannot push the rest of the view off the screen. Colour is never the only signal: each
 * line carries its own `+`/`-`/space marker, so the change still reads in a monochrome or colour-blind
 * rendering.
 */
export function DiffView({ diff, className }: { diff: FileDiff; className?: string }) {
  // A write of an empty file, a diff with nothing in it, or a change too large to align: three
  // different real outcomes, each with its own sentence rather than an empty box.
  if (diff.lines.length === 0) {
    return (
      <p
        className={cn(
          'rounded bg-background/60 p-2 font-mono text-[11px] text-muted-foreground',
          className ?? 'mt-1.5'
        )}
      >
        {diff.added === 0 && diff.removed === 0 ? 'No change to this file.' : 'The change is too large to show.'}
      </p>
    )
  }

  return (
    <div className={cn('overflow-hidden rounded border border-border/70 bg-background/60', className ?? 'mt-1.5')}>
      <div className="flex items-center justify-between border-b border-border/70 px-2 py-1 text-[10.5px] text-muted-foreground">
        <span>
          {diff.added} added, {diff.removed} removed
        </span>
        {diff.truncated && <span>showing the first {diff.lines.length} lines</span>}
      </div>
      <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed">
        {diff.lines.map((line, index) => (
          <div
            // Lines have no identity of their own, and this list is static once rendered.
            key={index}
            className={cn(
              'px-2 whitespace-pre-wrap',
              line.kind === 'added' && 'bg-success/12 text-success',
              line.kind === 'removed' && 'bg-destructive/12 text-destructive'
            )}
          >
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
