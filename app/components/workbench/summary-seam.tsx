import { useState } from 'react'
import { ChevronDown, ChevronRight, Scissors } from 'lucide-react'
import { seamLabel, summarizedTurns } from '@/conveyor/protocol/truncate'
import type { AgentTurn } from './agent-session'

/**
 * The seam a compacted conversation draws where its summary sits.
 *
 * A summary turn is a regular turn, but drawing it as a message would be a lie about who said it: the
 * user never wrote those words, and the pane is the place that knows the difference. So the row is a
 * seam — a line saying what it stands for — and the conversation it replaced is one click away.
 *
 * The expansion is pane-local and deliberately not persisted: a reader who opened the range to check it
 * wants it open while they are reading, and a reopened conversation should open the way a compacted one
 * reads — summarized, with the detail behind a control rather than in the way. What is persisted is the
 * summary itself, which is what the next send uses either way: expanding changes what the user sees and
 * never what the model is told.
 */
export function SummarySeam({ summary, turns }: { summary: AgentTurn; turns: AgentTurn[] }) {
  const [open, setOpen] = useState(false)
  const range = summary.summarizesTurns ?? []
  const replaced = summarizedTurns(turns, summary)

  return (
    <div data-slot="summary-seam" className="mx-auto my-2 w-full max-w-3xl px-4">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <Scissors aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-slot="summary-seam-label" className="text-[12.5px] font-medium">
          {seamLabel(range.length)}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide the summarized turns' : 'Show the summarized turns'}
          onClick={() => setOpen((value) => !value)}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5" />
          )}
          {open ? 'Hide' : 'Expand'}
        </button>
      </div>

      {open && (
        <ol data-slot="summary-seam-turns" className="mt-1.5 flex flex-col gap-1.5 border-l border-border pl-3">
          {replaced.map((turn) => (
            <li key={turn.id} className="rounded-md bg-muted/30 px-2.5 py-1.5">
              <span className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                {turn.role}
              </span>
              <p className="mt-0.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">{turn.content}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
