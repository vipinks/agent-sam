import { describe, expect, it } from 'vitest'
import {
  assembleMemorySection,
  MAX_MEMORY_BRIEF_BYTES,
  planMemoryInjection,
  splitDecisions,
} from '@/conveyor/protocol/memory'

/**
 * The memory brief and its injection slot, pinned without a filesystem or a loop.
 *
 * Two claims, both about the pure planner: the section is assembled in the deterministic order the
 * turn start promises (handoff, pending vetoes, recent decisions, quirks — the episodes section emits
 * nothing in slice 1), and the injection is null-in null-out with the same already-present guard the
 * role injection keeps, so a resumed run never gets a second copy.
 */

describe('the memory brief, assembled', () => {
  it('orders handoff, pending vetoes, recent decisions and quirks', () => {
    const section = assembleMemorySection({ handoff: 'H', vetoes: 'V', decisions: 'D', quirks: 'Q' })
    expect(section).not.toBeNull()
    const text = section!.content
    const h = text.indexOf('Handoff')
    const v = text.indexOf('Pending vetoes')
    const d = text.indexOf('Recent decisions')
    const q = text.indexOf('Quirks')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(v).toBeGreaterThan(h)
    expect(d).toBeGreaterThan(v)
    expect(q).toBeGreaterThan(d)
  })

  it('emits nothing at all when every section is blank', () => {
    expect(assembleMemorySection({ handoff: '', vetoes: '', decisions: '', quirks: '  ' })).toBeNull()
  })

  it('is bounded by the 8 KB brief budget', () => {
    expect(MAX_MEMORY_BRIEF_BYTES).toBe(8192)
  })
})

describe('the memory injection, planned', () => {
  it('is null-in, null-out', () => {
    expect(planMemoryInjection([], null)).toBeNull()
  })

  it('injects a fresh section and refuses an already-present one', () => {
    expect(planMemoryInjection([{ role: 'user', content: 'hi' }], 'memory section')).toEqual({
      content: 'memory section',
    })
    expect(planMemoryInjection([{ role: 'system', content: 'memory section' }], 'memory section')).toBeNull()
  })
})

describe('the decisions split', () => {
  it('separates vetoes from decisions on the vetoes heading', () => {
    expect(splitDecisions('decided A\n\n## Vetoes\n\nveto B')).toEqual({
      vetoes: 'veto B',
      decisions: 'decided A',
    })
  })
})
