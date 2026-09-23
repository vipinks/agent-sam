import { CornerDownRight } from 'lucide-react'
import type { AutoContinueMark as AutoContinueMarkData } from './agent-session'

/**
 * One seam where a turn picked itself up again, drawn inside the answer rather than above the composer.
 *
 * This is the visible half of auto-continue, and it exists because the app now sends without being
 * asked. A turn that nudges its own model three times is a turn with four stretches of work in it, and
 * presented as one unbroken answer it would be a lie of omission: the user would read a single reply
 * that kept going, and learn only later that the app had spent three extra round-trips on their behalf.
 * So each continuation says so, where it happened.
 *
 * Small and muted, deliberately. It is not news — it is the boundary between two pieces of the same
 * work — so it reads as a seam: one line, secondary colour, no border, no button. The card above the
 * composer stays the loud surface, and it appears only when the loop has stopped continuing and the
 * decision is the user's again.
 *
 * The numbers are the loop's own, carried on the chunk: `count` of `max` is how much of the turn's
 * budget this seam spent. The pane is not counting anything, which is what keeps one turn's `2 of 4`
 * from being confused with another build's different cap.
 */
export function AutoContinueMark({ mark }: { mark: AutoContinueMarkData }) {
  return (
    <p
      aria-label="Continued automatically"
      className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground"
    >
      <CornerDownRight aria-hidden className="size-3 shrink-0" />
      <span>{`Auto-continuing — ${mark.count} of ${mark.max}`}</span>
    </p>
  )
}
