import { describe, expect, it } from 'vitest'
import {
  assembleMemorySection,
  EPISODES_IN_BRIEF,
  MAX_EPISODES_BRIEF_BYTES,
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

  it('appends episodes last, newest first, inside their own 2 KB sub-budget', () => {
    const block = (turnId: string, capturedAt: number, ask: string) => ({
      sessionId: '11111111-2222-4333-8444-555555555555',
      turnId,
      capturedAt,
      ordinal: 1,
      text: `<!-- episode turn=${turnId} at=${new Date(capturedAt).toISOString()} -->\n## Episode 1\n- ask: ${ask}`,
    })
    const section = assembleMemorySection({
      handoff: 'H',
      vetoes: 'V',
      decisions: 'D',
      quirks: 'Q',
      episodes: [block('older', 1_000, 'the older ask'), block('newer', 2_000, 'the newer ask')],
    })
    expect(section).not.toBeNull()
    const text = section!.content
    expect(text.indexOf('Quirks')).toBeLessThan(text.indexOf('## Episodes'))
    expect(text.indexOf('the newer ask')).toBeLessThan(text.indexOf('the older ask'))
    expect(EPISODES_IN_BRIEF).toBe(5)
    expect(MAX_EPISODES_BRIEF_BYTES).toBe(2048)
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
