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
 * Added lines green and removed lines red, in the app's monospace face. Colour is never the only
 * signal: each line carries its own `+`/`-`/space marker, so the change still reads in a monochrome or
 * colour-blind rendering.
 *
 * `fill` is the height policy, and it belongs to the host rather than to this component. The card
 * wants a *cap*: it sits in a transcript that already limits its own `pre`s, and a long diff there must
 * not push the rest of the conversation off the screen. The diff pane wants the opposite: it is the
 * whole point of the pane, so its scroll region has to absorb the pane's height. Carrying the card's
 * cap into the pane was a real defect — the region collapsed to content-or-cap height and left dead
 * space below it, with the scrollbar thumb parked at the last line. The two policies live here, chosen
 * by a prop, so the colours and markers still cannot drift apart while the heights can differ.
 *
 * The default is the card's policy, because that is what every existing caller had and the safer one:
 * an un-capped diff in a context nobody thought about would be a transcript that grows without bound.
 */
export function DiffView({
  diff,
  className,
  fill = false,
}: {
  diff: FileDiff
  className?: string
  /** When true, the scroll region fills its host's height instead of stopping at the card's cap. */
  fill?: boolean
}) {
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
    <div
      className={cn(
        'overflow-hidden rounded border border-border/70 bg-background/60',
        // The fill chain, and the whole of this component's part in the fix. A flex column at the host's
        // full height, with a scroll region below that takes the remainder. `min-h-0` at both levels is
        // what lets the region shrink below its content — without it a long diff would overflow the host
        // rather than scroll inside it, which trades one layout defect for another.
        fill && 'flex h-full min-h-0 flex-col',
        className ?? 'mt-1.5'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between border-b border-border/70 px-2 py-1 text-[10.5px] text-muted-foreground',
          // Only inside a flex column does the header need to be told not to shrink; in the card's plain
          // block container the class would say nothing, which is why it rides with `fill` rather than
          // being added unconditionally.
          fill && 'shrink-0'
        )}
      >
        <span>
          {diff.added} added, {diff.removed} removed
        </span>
        {diff.truncated && <span>showing the first {diff.lines.length} lines</span>}
      </div>
      <pre
        className={cn(
          'font-mono text-[11px] leading-relaxed',
          // The card's cap, or the pane's fill. One or the other, never both: the cap is what produced
          // the dead space when it was applied to a host that wanted to grow, and the pane's chain is
          // what would let a transcript grow without bound if it reached the card.
          fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-64 overflow-auto'
        )}
      >
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
