import { describe, expect, it } from 'vitest'
import { planFirstSend, planResumeStart } from '@/app/components/workbench/session-resume'
import { UNTITLED } from '@/app/components/workbench/session-rules'

/**
 * Shows that the inputs the wiring tests use actually distinguish fixed from broken behaviour.
 *
 * "The tests pass" and "the tests would have caught it" are different claims, and only the second
 * makes a regression test worth having. This pins the second: it states the pre-fix predicate
 * alongside the shipped one and asserts they disagree on exactly the input the wiring test uses.
 *
 * The pre-fix predicates are transcribed from git history (9bba02a^) rather than injected by mocking
 * the module. An earlier attempt to do it with `vi.doMock` was wrong twice over: it did not intercept
 * the mount-hydration path, and the mock leaked into the next test — both of which produced failures
 * that looked like proof and were not. A predicate written out in the test is honest and cannot leak.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** The Phase 7 guard, verbatim: the store's active id stands in for "this session is loaded". */
function preFixResumeWouldLoad(requestedId: string, activeId: string | null): boolean {
  return requestedId !== activeId
}

/** The Phase 7 title rule, verbatim: an existing session is never named. */
function preFixTitle(activeId: string | null): string | null {
  return activeId ? null : 'derived'
}

describe('the regression tests discriminate', () => {
  it('Bug A: the pre-fix guard and the shipped one disagree on the restart state', () => {
    // The defining state: the session is the store's active one, and its transcript has never been
    // loaded. This is a real app state after a restart, not a contrived one.
    const requestedId = SESSION_ID
    const hydratedId = null

    const shipped = planResumeStart({
      requestedId,
      hydratedId,
      transcript: { turns: [], interrupted: false },
      savedSnapshot: null,
    })

    // Shipped: loads, because nothing is loaded yet.
    expect(shipped.load, 'the shipped guard must load a session that is active but not hydrated').toBe(true)

    // Pre-fix: does not load, because it only compared ids. Same input, opposite answer — which is
    // what makes the wiring test's assertion meaningful rather than incidental.
    expect(
      preFixResumeWouldLoad(requestedId, requestedId),
      'the pre-fix guard must refuse to load in this state, or the wiring test proves nothing'
    ).toBe(false)
  })

  it('Bug B: the pre-fix rule and the shipped one disagree on an untitled existing session', () => {
    const message = 'make a fibonacci script'

    const shipped = planFirstSend({
      activeId: SESSION_ID,
      activeTitle: UNTITLED,
      message,
      isHydrated: false,
    })

    expect(shipped.title, 'the shipped rule names an untitled session').toBe(message)

    // Pre-fix: returned early on the existing id, so no title was ever derived — the observed
    // symptom, every persisted row reading "Untitled conversation".
    expect(preFixTitle(SESSION_ID), 'the pre-fix rule leaves it untitled').toBeNull()
  })

  it('the shipped rules still refuse the cases they should', () => {
    // A named session is not renamed, and an already-hydrated session is not reloaded. Without these
    // the "fix" could be "always do the thing", which would be a different bug.
    expect(
      planFirstSend({ activeId: SESSION_ID, activeTitle: 'A name', message: 'x', isHydrated: true }).title
    ).toBeNull()

    const alreadyShowing = planResumeStart({
      requestedId: SESSION_ID,
      hydratedId: SESSION_ID,
      transcript: { turns: [], interrupted: false },
      savedSnapshot: null,
    })
    expect(alreadyShowing.alreadyShowing).toBe(true)
    expect(alreadyShowing.load).toBe(false)
  })
})
