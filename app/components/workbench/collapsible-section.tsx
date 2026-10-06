import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { advanceSectionCollapse, openingSectionCollapse, type SectionCollapse } from '@/conveyor/protocol/collapse'

/**
 * One step of a transcript, as a section with a header that folds it.
 *
 * What folds here is work, not words: the card of a single tool call, and never the answer a turn wrote —
 * the prose a turn said is plain visible markdown outside any section. The card is therefore the one
 * foldable thing in a transcript, and it is drawn here rather than inside the caller so that there is one
 * answer to "when is this open" rather than two that drift.
 *
 * The body stays mounted and is hidden rather than dropped. That is deliberate, and it is the one thing
 * here that is not about looks: what a turn did is what the transcript holds, and a section that
 * unmounted its body would make the document on screen the only record of a message while it is folded.
 * The export reads the transcript data and the copy reads the turn's own text — neither goes near this
 * DOM — so what the hidden body buys is parity for anything else that reads the document, and a fold
 * that is a drawing decision rather than a claim about what the turn did.
 *
 * The header is the reveal: a chevron that turns, the step named in one line in the user's own words,
 * and `aria-expanded`, which is what states the state to a reader who cannot see the chevron. No new
 * tokens: the header is the styling the tool card has always had, and the chevron is the glyph the app
 * already turns for the same purpose.
 */

/**
 * The state of one section, driven by the pure rule in `conveyor/protocol/collapse`.
 *
 * The in-flight input is what the auto rule reacts to, and the reaction is on the *transition* — out of
 * flight folds the section, and returning to flight re-opens it and forgets any manual toggle that was
 * recorded before. A tick that does not change that input changes nothing here, which is what keeps a
 * stream's frames from re-rendering a section that is already where it belongs, and what keeps a
 * section the user opened by hand from being folded under them by the next frame.
 */
function useSectionCollapse(inFlight: boolean, defaultOpen: boolean): { expanded: boolean; toggle: () => void } {
  const [state, setState] = useState<SectionCollapse>(() =>
    defaultOpen ? { expanded: true, manual: false } : openingSectionCollapse(inFlight)
  )
  const wasInFlight = useRef(inFlight)

  useEffect(() => {
    if (wasInFlight.current === inFlight) return
    wasInFlight.current = inFlight
    setState((current) => advanceSectionCollapse(current, inFlight ? 'started' : 'completed'))
  }, [inFlight])

  // The user's own click, and the only thing that records a manual toggle: the rule is told what
  // happened rather than what to do, so the decision about what a toggle means stays in one place.
  const toggle = useCallback(() => setState((current) => advanceSectionCollapse(current, 'toggled')), [])

  return { expanded: state.expanded, toggle }
}

export function CollapsibleSection({
  summary,
  inFlight,
  slot,
  icon,
  trailing,
  defaultOpen = false,
  title,
  className,
  headerClassName,
  bodyClassName,
  children,
}: {
  /** The one line the header says about the step, in the words the transcript uses for it. */
  summary: string
  /** Whether the step this section is about is happening now, which is what the auto rule reads. */
  inFlight: boolean
  /**
   * The `data-slot` stem this section is drawn under, with `-body` on the body.
   *
   * A prop rather than a constant because the two callers are two different things to a test and to a
   * reader of the DOM, and because a section's own hook into the document should be readable at the
   * call site rather than inferred from its position.
   */
  slot: string
  /** A glyph before the summary — the kind of step, where the card knows its tool. */
  icon?: ReactNode
  /** A glyph after it — the outcome, where the card shows how its call ended. */
  trailing?: ReactNode
  /**
   * Whether the section mounts open, whatever the rule would say.
   *
   * For the one case a transcript has where a folded section would hide something the run is stuck on:
   * a call nobody ever decided. Read once, when the section mounts, because it describes the step as it
   * arrived rather than something that can change under it.
   */
  defaultOpen?: boolean
  /**
   * The summary in full, for the case the header had to cut it.
   *
   * The header's line truncates — it has to, or a long command would widen the column it sits in — so a
   * step named by something longer than the row is a step whose name the user could not read. The native
   * title is what offers the whole of it, on hover, without a second element or a new surface.
   */
  title?: string
  className?: string
  headerClassName?: string
  bodyClassName?: string
  children: ReactNode
}) {
  const { expanded, toggle } = useSectionCollapse(inFlight, defaultOpen)

  return (
    <section data-slot={slot} className={cn('overflow-hidden', className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title={title}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          headerClassName
        )}
      >
        {/* Turned rather than swapped: one glyph, so the header cannot read as two different controls
            depending on which state the reader caught it in. Hooked with a `data-slot` because a row's
            header holds an icon as well, and a chevron that can only be found by being the first `svg`
            is not one a test can point at. */}
        <ChevronRight
          data-slot="section-chevron"
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
        />
        {icon}
        <span className="min-w-0 flex-1 truncate font-medium">{summary}</span>
        {trailing}
      </button>

      {/* Mounted either way; `hidden` is what folds it. Not `hidden` as a utility class and not a
          conditional render — an attribute a test can read, and a body that is still there. */}
      <div data-slot={`${slot}-body`} hidden={!expanded} className={bodyClassName}>
        {children}
      </div>
    </section>
  )
}
