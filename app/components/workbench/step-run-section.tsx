import { ListChecks } from 'lucide-react'
import { CollapsibleSection } from './collapsible-section'
import { AgentActionCard } from './agent-action-card'
import type { StepRun } from '@/conveyor/protocol/step-runs'
import type { ToolStep } from './agent-session'

/**
 * A stretch of a turn's work, as one slim row.
 *
 * The row is what the transcript says about the steps a turn took: one line reading "View Steps" and how
 * many, folded at rest, and one click away from the cards themselves. It replaces the header every card
 * used to carry, and the reason is the shape of a real turn — a run of thirty calls was thirty foldable
 * boxes with thirty headers, each of them a decision the reader had to make about work they mostly did
 * not want to read. One row per run says how much work happened and leaves the reading of it to the
 * reader, which is the whole of the change.
 *
 * The run is computed by the bubble and handed over rather than derived again here, so the count in the
 * header and the cards in the body cannot disagree: both come from the one walk over the turn's steps.
 * What the row decides for itself is nothing at all — it is a header, a fold, and the cards.
 *
 * Folded by the shared rule and by nothing else: open while any step of the run is still going — a call
 * being run, or one waiting on a decision — and folded when the last of them lands. That is also what
 * puts a consent card on screen: a run holding an unanswered question cannot be collapsed over it, since
 * the awaiting status is one of the in-flight ones the rule reads.
 *
 * The cards inside are drawn exactly as they ever were, consent block, diff, output, approve and deny and
 * all. What changed is that they no longer fold: the row they sit in is the fold, so a card is content
 * rather than a second header.
 */
export function StepRunSection({
  run,
  onApprove,
  onDeny,
}: {
  run: StepRun<ToolStep>
  onApprove?: (callId: string) => void
  onDeny?: (callId: string) => void
}) {
  return (
    <CollapsibleSection
      slot="step-run"
      kind="row"
      summary="View Steps"
      // The space in front of the middle-dot is deliberate and is for the accessible name: a flex gap
      // is spacing a screen reader never sees, so a row that relied on it alone would be announced as
      // "View Steps· 3". The count reads as part of what the row is called.
      meta={` · ${run.count}`}
      inFlight={run.inFlight}
      icon={<ListChecks className="size-3.5 shrink-0 text-muted-foreground" />}
    >
      <div className="space-y-1.5 px-0.5 pb-1">
        {run.steps.map((step) => (
          <AgentActionCard key={step.callId} step={step} onApprove={onApprove} onDeny={onDeny} />
        ))}
      </div>
    </CollapsibleSection>
  )
}
