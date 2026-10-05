import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsibleSection } from '@/app/components/workbench/collapsible-section'

/**
 * The one kind of section a transcript still folds, as wiring.
 *
 * The decision itself — open in flight, fold on completion, never fight a manual toggle — is a pure rule
 * and is tested in `tests/ui/section-collapse-test.ts`, without a DOM. What is left here is the half a
 * rule test cannot see: that the component which draws a section is wired to that rule, that it is the
 * *transition* of the in-flight input which moves it, and that a folded body is hidden rather than taken
 * out of the document.
 *
 * Rendered directly rather than through the pane, and that is a consequence of the reshape rather than a
 * shortcut: there is exactly one foldable thing left in a transcript — the row over a run of tool steps
 * — and the claims about *that* row, its count and the cards it reveals, are made through the real
 * transcript in `testing/step-run-rows.test.tsx`. What belongs here is the component's own contract,
 * which the rule suite cannot reach.
 *
 * The prose cases this file used to hold are gone with the sections they asserted: a turn's answer is
 * plain visible words now and there is nothing about it to fold, which is asserted in
 * `testing/answer-visibility.test.tsx` instead. A card no longer folds either — the row above it does —
 * which is asserted in `testing/step-run-rows.test.tsx`.
 *
 * jsdom proves wiring and words, not pixels: that the chevron carries the class that rotates it is a
 * claim about the class, and whether it looks like a chevron is read by eye.
 */

/** The section under test, drawn with the props the transcript's run row actually passes it. */
function section(inFlight: boolean, defaultOpen = false) {
  return (
    <CollapsibleSection
      slot="step-run"
      kind="row"
      summary="View Steps"
      meta="· 3"
      inFlight={inFlight}
      defaultOpen={defaultOpen}
    >
      <p>the cards</p>
    </CollapsibleSection>
  )
}

/** The section's header button, which is what a user clicks and what states the state. */
function header(): HTMLElement {
  return screen.getByRole('button', { name: /View Steps/ })
}

/** The section's body, which stays in the document whether or not it is shown. */
function body(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="step-run-body"]') as HTMLElement
}

/** Whether the section is open, read the way a screen reader reads it. */
function isOpen(): boolean {
  return header().getAttribute('aria-expanded') === 'true'
}

/** The chevron's own class, which is what turns with the section. */
function chevronClass(): string {
  const svg = document.querySelector('[data-slot="section-chevron"]')
  if (!svg) throw new Error('the section draws no chevron')
  return svg.getAttribute('class') ?? ''
}

describe('the section that folds a transcript', () => {
  it('mounts open while its step is in flight, and folds when the run lands', async () => {
    const view = render(section(true))

    // Open on arrival, because the run is still going: the work the user is watching is the work on
    // screen, and the count is part of what the header says about it.
    expect(isOpen()).toBe(true)
    expect(body().hasAttribute('hidden')).toBe(false)
    expect(chevronClass()).toContain('rotate-90')
    expect(header().textContent).toContain('View Steps')
    expect(header().textContent).toContain('3')

    // The transition, not a re-render: the run's own ending is what folds it, and it folds without
    // taking the cards out of the document.
    view.rerender(section(false))

    expect(isOpen()).toBe(false)
    expect(body().hasAttribute('hidden')).toBe(true)
    expect(body().textContent).toContain('the cards')
    expect(chevronClass()).not.toContain('rotate-90')
  })

  it('leaves a section the user reopened open through every later completion tick', async () => {
    const user = userEvent.setup()
    const view = render(section(true))

    // The run lands and folds the section, and the user opens it again — the claim the rule must honour.
    view.rerender(section(false))
    expect(isOpen()).toBe(false)

    await user.click(header())
    expect(isOpen()).toBe(true)

    // Every tick that follows leaves it as the user left it. This is asserted as further renders of the
    // same input, because the rule reacts to the transition and a claimed section is not its business.
    view.rerender(section(false))
    expect(isOpen()).toBe(true)
    expect(body().hasAttribute('hidden')).toBe(false)
  })

  it('re-opens on a new run and forgets the claim, so the next completion folds it', async () => {
    const user = userEvent.setup()
    const view = render(section(false))

    // Folded at rest, and claimed by hand.
    expect(isOpen()).toBe(false)
    await user.click(header())
    expect(isOpen()).toBe(true)

    // A new in-flight period is the one thing that overrides a claim: the reader asked to see the work
    // that is happening now, and a row still answering to an old preference would hide it.
    view.rerender(section(true))
    expect(isOpen()).toBe(true)

    // And the claim really was cleared rather than merely overridden, which is the part that is easy to
    // get wrong: with the flag gone, the next completion folds the row under the reader like any other.
    view.rerender(section(false))
    expect(isOpen()).toBe(false)
  })
})
