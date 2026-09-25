import { describe, expect, it } from 'vitest'
import { HOME_STARTERS } from '@/app/components/workbench/home'

/**
 * The home screen's own words, as rules rather than as a rendered screen.
 *
 * What is left to assert here is the one thing home decides rather than reads: the three ways in. The
 * chips the screen offers back are not a decision of this module any more — they are derived from the
 * folders the workspace store remembers and the conversations the sessions store holds, by a rule
 * pinned in `tests/workspace/recent-project-chips-test.ts` — and the wiring suite covers the part a
 * rule cannot see, that the screen reaches these.
 */

describe('the starter prompts', () => {
  it('is three distinct prompts, each with something in it', () => {
    expect(HOME_STARTERS).toHaveLength(3)
    expect(new Set(HOME_STARTERS).size).toBe(3)
    for (const prompt of HOME_STARTERS) expect(prompt.trim().length).toBeGreaterThan(0)
  })
})
