import { CornerDownRight } from 'lucide-react'
import type { AutoContinueMark as AutoContinueMarkData } from './agent-session'
import type { TurnEndCause } from '@/conveyor/protocol/turn-end'

/**
 * One seam where a turn picked itself up again, drawn inside the answer rather than above the composer.
 *
 * This is the visible half of auto-continue, and it exists because the app now sends without being
 * asked. A turn that nudges its own model three times is a turn with four stretches of work in it, and
 * presented as one unbroken answer it would be a lie of omission: the user would read a single reply
 * that kept going, and learn only later that the app had spent three extra round-trips on their behalf.
 * So each continuation says so, where it happened.
 *
 * Why it kept going, not just that it did. A turn picked up after the provider ran out of output room is
 * a different event from one picked up after the model stopped, and the difference is the only actionable
 * part of the line: the first says the answer was longer than one reply holds, the second says the model
 * thought it was finished when its plan said otherwise. A number alone would leave the user unable to tell
 * which of those they are looking at, which is exactly the question they want answered when they notice
 * that one answer took four round-trips.
 *
 * Small and muted, deliberately. It is not news — it is the boundary between two pieces of the same
 * work — so it reads as a seam: one line, secondary colour, no border, no button. The card above the
 * composer stays the loud surface, and it appears only when the loop has stopped continuing and the
 * decision is the user's again.
 *
 * The numbers are the loop's own, carried on the chunk: `count` of `max` is how much of the turn's
 * budget this seam spent. The pane is not counting anything, which is what keeps one turn's `2 of 8`
 * from being confused with another build's different cap.
 */

/**
 * What the line says the turn was picked up after.
 *
 * The three endings that can produce a seam, and nothing else: a dropped connection is never nudged, so a
 * mark claiming one cannot be produced by this loop. The fallback is the ending a mark without a cause
 * could have had — every mark written before the loop reported one was made after a plain stop — which is
 * also why the set is read through a lookup rather than rendered from the cause itself.
 */
const SEAM_CAUSES: Partial<Record<TurnEndCause, string>> = {
  truncated: 'Auto-continuing after the output cap',
  model_stop: 'Auto-continuing after a plain stop',
  // Named apart from the plain stop it resembles, because the two are the reason this line exists at all:
  // a turn picked up after a plain stop went on because its plan said there was more, and a turn picked up
  // after an empty stop went on because there was no answer to read. A user who saw the seam appear wants
  // to know which of the three it was, and "after a plain stop" would tell them the wrong one.
  empty_stop: 'Auto-continuing after an empty stop',
}

export function AutoContinueMark({ mark }: { mark: AutoContinueMarkData }) {
  const why = (mark.cause && SEAM_CAUSES[mark.cause]) || SEAM_CAUSES.model_stop
  return (
    <p
      aria-label="Continued automatically"
      className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground"
    >
      <CornerDownRight aria-hidden className="size-3 shrink-0" />
      <span>{`${why} — ${mark.count} of ${mark.max}`}</span>
    </p>
  )
}
