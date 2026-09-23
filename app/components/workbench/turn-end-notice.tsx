import { TriangleAlert } from 'lucide-react'
import type { TurnEndNotice as TurnEndNoticeData } from './agent-session'
import type { TurnEndCause } from '@/conveyor/protocol/turn-end'
import { Button } from '../ui/button'

/**
 * A turn that stopped before it was done, said out loud above the composer.
 *
 * Pinned above the composer rather than written into the transcript for the same reason the plan is:
 * it is about now. A turn that died needs an answer, and the place an answer is given is the composer
 * — which is also what makes the Continue button obviously the next thing to do rather than a control
 * buried in a bubble the user has scrolled past.
 *
 * The wording is branched on the cause and lives here rather than crossing IPC, which is the rule the
 * rest of the app's failures follow: main reports a cause, the UI says what happened in the user's
 * terms. Two sentences, because the user needs to know the reply is incomplete and, from the reason,
 * whether asking again is likely to help.
 *
 * `model_stop` words nothing and renders nothing. That is the point of the card's existence: the
 * ordinary ending must not look like an incident, and a card under every answer would make the one
 * that matters indistinguishable from the noise.
 *
 * A notice can say more than one thing, which is why the lines are a list rather than a single
 * sentence: a turn whose reply was cut off *and* whose consent pause ended with the process is one
 * card that reports both, because a user reading one of them still needs the other.
 */

/** What each ending says. `null` for the ending that says nothing. */
const WORDING: Record<TurnEndCause, string | null> = {
  model_stop: null,
  truncated: 'Ended early: the reply was cut off (output limit)',
  stream_error: 'Ended early: the reply was cut off (the connection dropped)',
}

/** A consent pause the process did not survive, which is not a reply that stopped arriving. */
const LOST_PENDING = 'Ended while waiting for your approval — the app closed before you answered.'

export function TurnEndNotice({
  notice,
  onContinue,
}: {
  notice: TurnEndNoticeData | null
  /** Sends the resume message. Absent on a card read back from a stored transcript. */
  onContinue?: () => void
}) {
  if (!notice) return null

  const lines = [WORDING[notice.cause], notice.lostPending === true ? LOST_PENDING : null].filter(
    (line): line is string => line !== null
  )
  // Nothing to read for this ending — the ordinary one — so nothing on screen. The card exists for the
  // endings that need explaining, and a row under every answer is how it stops being read.
  if (lines.length === 0) return null

  // The button appears only where continuing is both possible and meaningful. A card from a stored
  // transcript has no run behind it and passes no handler, so the reason is shown without an action —
  // history is a record, not a thing to click.
  const actionable = notice.resumable && onContinue !== undefined

  return (
    <section
      aria-label="Turn ended early"
      className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        {lines.map((line) => (
          <span key={line} className="text-[11.5px] leading-snug text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
      {actionable ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onContinue}>
          Continue
        </Button>
      ) : null}
    </section>
  )
}
