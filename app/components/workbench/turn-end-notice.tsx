import { TriangleAlert } from 'lucide-react'
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
 */

/** What each ending says. `null` for the ending that says nothing. */
const WORDING: Record<TurnEndCause, string | null> = {
  model_stop: null,
  truncated: 'Ended early: the reply was cut off (output limit)',
  stream_error: 'Ended early: the reply was cut off (the connection dropped)',
}

export function TurnEndNotice({
  notice,
  onContinue,
}: {
  notice: { cause: TurnEndCause; resumable: boolean } | null
  /** Sends the resume message. Absent on a card read back from a stored transcript. */
  onContinue?: () => void
}) {
  const wording = notice ? WORDING[notice.cause] : null
  // No notice, or the ordinary ending: nothing to read, so nothing on screen.
  if (!notice || !wording) return null

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
      <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">{wording}</span>
      {actionable ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onContinue}>
          Continue
        </Button>
      ) : null}
    </section>
  )
}
