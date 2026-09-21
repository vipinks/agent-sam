import { z } from 'zod'

/**
 * The agent's plan: the steps the model declared it would take, and where each has got to.
 *
 * Pure, and shared rather than main-only, for the same reason the transcript shape is: main merges a
 * `set_plan` call into the plan its chunk carries, the renderer merges that chunk into the plan the
 * checklist shows, and the transcript stores the result — three processes' worth of interest in one
 * small rule, which is exactly what drifts when it is written down twice.
 *
 * Nothing here touches the disk, a shell or the network, which is also why the tool built on it is
 * the one tool the loop never gates: a plan is a declaration, and a declaration has no effect to
 * consent to.
 *
 * The rules exist because a declaration can lie in two ways. It can lose a step by simply not
 * mentioning it again, which is what `mergePlan` refuses. And it can claim to be running after the
 * turn that was doing the work has ended, which is what `reconcilePlanOnTurnEnd` refuses.
 */

/**
 * The four states a step can be in.
 *
 * `interrupted` is the one the model never sends: it is what a step still `in_progress` becomes when
 * its turn ends, because "in progress" is a claim about now and the end of the turn is the end of
 * the only thing that could be doing the work.
 */
export const PLAN_STATUSES = ['pending', 'in_progress', 'done', 'interrupted'] as const
export type PlanStepStatus = (typeof PLAN_STATUSES)[number]

/**
 * How many steps one declaration may carry.
 *
 * A cap rather than a preference: the list arrives from the model and is rendered as a pinned list
 * above the composer, so an unbounded one would be a list that pushes the composer off the screen.
 * It is enforced at the tool boundary — the argument schema refuses rather than truncates — so the
 * model is told its declaration did not land instead of silently having steps dropped.
 */
export const MAX_PLAN_STEPS = 24

/** One step. `id` is the identity the model reuses to update a step rather than declare a second. */
export const planStepSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(PLAN_STATUSES),
})

export type PlanStep = z.infer<typeof planStepSchema>
/** A plan, in the order the model declared it. */
export type Plan = PlanStep[]

/**
 * Read a plan out of something that crossed a boundary, or `null` when there is none.
 *
 * A step whose shape is wrong is dropped rather than failing the whole read: the chunk is the only
 * description of the plan the renderer gets, and refusing it would take the checklist away from the
 * user over one malformed row. A list with nothing usable in it reads as no plan at all, which is
 * the same state as never having had one — an empty checklist is a box on screen with nothing in it.
 */
export function normalizePlan(value: unknown): Plan | null {
  if (!Array.isArray(value)) return null

  const steps: PlanStep[] = []
  for (const item of value) {
    const parsed = planStepSchema.safeParse(item)
    if (parsed.success) steps.push(parsed.data)
  }

  return steps.length > 0 ? steps : null
}

/**
 * A plan with an update applied: matching ids are updated, new ids are appended, the rest stay.
 *
 * Written as one rule because the order and the preservation are both load-bearing. The order is the
 * model's, so a plan reads as a sequence of work rather than as whatever order a lookup produced.
 * And a step the update does not mention is kept exactly as it was, which is what makes a *partial*
 * declaration safe: a model that restates only the step it just finished cannot lose the four it has
 * not mentioned since, and the user's checklist cannot silently shrink under them.
 */
export function mergePlan(current: readonly PlanStep[], update: readonly PlanStep[]): Plan {
  const merged = current.map((step) => ({ ...step }))
  const at = new Map(merged.map((step, index) => [step.id, index]))

  for (const step of update) {
    const index = at.get(step.id)
    if (index === undefined) {
      at.set(step.id, merged.length)
      merged.push({ ...step })
    } else {
      merged[index] = { ...step }
    }
  }

  return merged
}

/**
 * A plan as it must read once its turn is over: nothing can still be running.
 *
 * Only `in_progress` moves. A `done` step is finished either way, and a `pending` step is work the
 * model has not started — the next turn may well start it, and marking it interrupted would say the
 * model abandoned something it never picked up. Idempotent, so it does not matter how many endings
 * a turn passes through.
 */
export function reconcilePlanOnTurnEnd(plan: readonly PlanStep[]): Plan {
  return plan.map((step) =>
    step.status === 'in_progress' ? { id: step.id, text: step.text, status: 'interrupted' as const } : { ...step }
  )
}
