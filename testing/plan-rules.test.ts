import { describe, expect, it } from 'vitest'
import { mergePlan, normalizePlan, reconcilePlanOnTurnEnd, type PlanStep } from '@/conveyor/protocol/plan'

/**
 * The plan's rules, as rules rather than as wiring.
 *
 * A plan is the model's own declaration of what it is doing, and both rules here exist because a
 * declaration can lie in two ways: by losing a step it simply stopped mentioning, and by still
 * claiming to be running after the turn that was doing the work has ended. Neither is visible in a
 * DOM test, and both are visible here in one assertion each.
 */

function step(id: string, status: PlanStep['status'], text = id): PlanStep {
  return { id, text, status }
}

describe('mergePlan', () => {
  it('matches by id, updating a step in place rather than appending a second one', () => {
    const merged = mergePlan([step('read', 'in_progress')], [step('read', 'done', 'Read the parser')])

    expect(merged).toEqual([{ id: 'read', text: 'Read the parser', status: 'done' }])
  })

  it('appends an id it has not seen, in the order the update gave it', () => {
    const merged = mergePlan([step('read', 'done')], [step('tests', 'pending'), step('run', 'pending')])

    expect(merged.map((s) => s.id)).toEqual(['read', 'tests', 'run'])
    expect(merged.map((s) => s.status)).toEqual(['done', 'pending', 'pending'])
  })

  it('preserves a step the update never mentions, so an update cannot drop work', () => {
    const merged = mergePlan([step('read', 'done'), step('tests', 'in_progress')], [step('tests', 'done')])

    expect(merged.map((s) => [s.id, s.status])).toEqual([
      ['read', 'done'],
      ['tests', 'done'],
    ])
  })

  it('leaves a plan untouched when the update is empty, and stays empty when both are', () => {
    expect(mergePlan([step('read', 'done')], [])).toEqual([step('read', 'done')])
    expect(mergePlan([], [])).toEqual([])
  })

  it('does not mutate either side', () => {
    const current = [step('read', 'pending')]
    const update = [step('read', 'done')]

    mergePlan(current, update)

    expect(current).toEqual([step('read', 'pending')])
    expect(update).toEqual([step('read', 'done')])
  })
})

describe('reconcilePlanOnTurnEnd', () => {
  it('marks every in-progress step interrupted, because nothing can still be running', () => {
    const reconciled = reconcilePlanOnTurnEnd([step('read', 'done'), step('tests', 'in_progress')])

    expect(reconciled.map((s) => s.status)).toEqual(['done', 'interrupted'])
  })

  it('leaves pending and done alone: pending is work the next turn may still start', () => {
    const plan = [step('a', 'pending'), step('b', 'done'), step('c', 'interrupted')]

    expect(reconcilePlanOnTurnEnd(plan)).toEqual(plan)
  })

  it('is idempotent, so reconciling twice cannot change the record', () => {
    const once = reconcilePlanOnTurnEnd([step('a', 'in_progress'), step('b', 'pending')])

    expect(reconcilePlanOnTurnEnd(once)).toEqual(once)
  })

  it('leaves an empty plan absent rather than inventing one', () => {
    expect(reconcilePlanOnTurnEnd([])).toEqual([])
  })
})

describe('normalizePlan', () => {
  it('reads a plan out of what crossed the boundary, keeping the order', () => {
    const plan = normalizePlan([
      { id: 'a', text: 'One', status: 'pending' },
      { id: 'b', text: 'Two', status: 'in_progress' },
    ])

    expect(plan).toEqual([step('a', 'pending', 'One'), step('b', 'in_progress', 'Two')])
  })

  it('reads anything that is not a list as no plan at all', () => {
    for (const value of [null, undefined, 'a plan', 42, { steps: [] }]) {
      expect(normalizePlan(value)).toBeNull()
    }
  })

  it('drops a malformed row and keeps the rest, rather than losing the whole plan to one step', () => {
    const plan = normalizePlan([
      { id: 'a', text: 'One', status: 'pending' },
      { id: '', text: 'no identity', status: 'pending' },
      { id: 'c', text: 'Three', status: 'sideways' },
      { id: 'd', text: 'Four', status: 'done' },
    ])

    expect(plan?.map((s) => s.id)).toEqual(['a', 'd'])
  })

  it('reads an empty list as an absent plan, not as an empty checklist', () => {
    expect(normalizePlan([])).toBeNull()
  })
})
