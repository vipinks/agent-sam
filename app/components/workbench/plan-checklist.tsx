import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, ListChecks, Slash } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PlanStep, PlanStepStatus } from '@/conveyor/protocol/plan'

/**
 * The model's plan, as a checklist pinned above the composer.
 *
 * Pinned rather than placed in the transcript because a plan is about now: it is read while the run is
 * happening, and a checklist that scrolled away with the conversation would be unusable exactly when
 * it is useful. Collapsible because it is a standing panel in a narrow column and the user may want
 * the space back — the choice is theirs, so it starts open and stays where they left it.
 *
 * Each status is carried by a distinct glyph *and* named in the row's accessible label, never by
 * colour alone: an interrupted step and a done one must be told apart by someone who cannot see the
 * difference between the markers, and a screenshot of a plan should survive being printed in black
 * and white.
 *
 * A session with no plan renders nothing. That is deliberate and load-bearing: a plan is optional, so
 * nothing here warns about a missing one, reserves space for one, or blocks on one — absence is the
 * degraded state, and the degraded state is silence.
 */

/** How one status is drawn and named. */
const MARKERS: Record<PlanStepStatus, { icon: LucideIcon; label: string; text: string }> = {
  pending: { icon: Circle, label: 'Pending', text: 'text-muted-foreground' },
  in_progress: { icon: CircleDot, label: 'In progress', text: 'font-medium text-foreground' },
  done: { icon: Check, label: 'Done', text: 'text-muted-foreground line-through' },
  interrupted: { icon: Slash, label: 'Interrupted', text: 'text-muted-foreground italic' },
}

export function PlanChecklist({ plan }: { plan: PlanStep[] | null }) {
  const [collapsed, setCollapsed] = useState(false)

  // No plan, no panel — checked before any state is read, so a session that never declared one renders
  // an empty fragment rather than an empty box.
  if (!plan || plan.length === 0) return null

  const done = plan.filter((step) => step.status === 'done').length

  return (
    <section aria-label="Plan" className="mb-2 shrink-0 rounded-md border border-border bg-muted/30">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((previous) => !previous)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[12px] font-medium">Plan</span>
        {/* The count is what makes a collapsed checklist worth collapsing: the progress stays legible
            while the steps do not. */}
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {done}/{plan.length}
        </span>
        {collapsed ? (
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <ul className="flex flex-col gap-0.5 px-2 pb-1.5">
          {plan.map((step) => {
            const marker = MARKERS[step.status]
            const Icon = marker.icon
            return (
              <li
                key={step.id}
                // Keyed by id and labelled with status and text, so an update to the step the user is
                // watching changes this row rather than replacing it — and so the status is readable
                // without seeing the marker.
                aria-label={`${marker.label}: ${step.text}`}
                className="flex items-start gap-1.5"
              >
                <Icon aria-hidden className={`mt-0.5 size-3 shrink-0 ${marker.text}`} />
                <span className={`text-[11.5px] leading-snug ${marker.text}`}>{step.text}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
