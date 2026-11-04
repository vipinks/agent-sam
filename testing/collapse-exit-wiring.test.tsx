import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsibleSection } from '@/app/components/workbench/collapsible-section'

/**
 * The fold's exit, as the DOM carries it.
 *
 * The rule that decides *when* a section folds is tested in `section-collapse-wiring.test.tsx`; this
 * file is about the drawing of the fold once the rule has decided. The contract is four facts in one
 * window: the body leaves `expanded` immediately, says it is closing, stays mounted and visible for the
 * quick duration, and is inert for it — so a reader tabbing through a folding transcript cannot land in
 * a body that is on its way out. The hidden write arrives on a timer, never on `animationend`, because
 * jsdom does not fire one and a real window must not depend on a stylesheet being present to unmount.
 *
 * Re-opened mid-window is the case that makes the timer worth cancelling: the body must not blink or
 * disappear under a reader who changed their mind.
 */

function section(inFlight: boolean) {
  return (
    <CollapsibleSection slot="agent-action-card" summary="Reading parser.ts" inFlight={inFlight}>
      <p>the call</p>
    </CollapsibleSection>
  )
}

function body(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="agent-action-card-body"]') as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a section folding itself away', () => {
  it('marks the body closing, keeps it visible, and delays the hidden write by the quick window', async () => {
    const view = render(section(true))
    expect(body().hasAttribute('hidden')).toBe(false)

    view.rerender(section(false))

    // The state is withdrawn at once, and the drawing says why the body is still on screen.
    expect(screen.getByRole('button', { name: /Reading parser\.ts/ }).getAttribute('aria-expanded')).toBe('false')
    expect(body().getAttribute('data-expanded')).toBe('false')
    expect(body().getAttribute('data-closing')).toBe('true')
    expect(body().hasAttribute('hidden')).toBe(false)
    // Inert, not merely transparent: a body on its way out is not somewhere the keyboard may enter.
    expect(body().hasAttribute('inert')).toBe(true)

    const classes = (body().getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    expect(classes).toEqual(
      expect.arrayContaining([
        'data-[closing=true]:animate-out',
        'data-[closing=true]:fade-out-0',
        'data-[closing=true]:slide-out-to-top-1',
        'data-[closing=true]:duration-150',
        'data-[closing=true]:ease-out',
        'motion-reduce:animate-none',
      ])
    )

    await waitFor(() => expect(body().hasAttribute('hidden')).toBe(true))
    expect(body().getAttribute('data-closing')).toBeNull()
    expect(body().hasAttribute('inert')).toBe(false)
    // Still the same node: the fold hides the body rather than taking it out of the document.
    expect(body().textContent).toContain('the call')
  })

  it('cancels the window when the reader re-opens mid-fold', async () => {
    const user = userEvent.setup()
    const view = render(section(true))

    view.rerender(section(false))
    expect(body().getAttribute('data-closing')).toBe('true')

    await user.click(screen.getByRole('button', { name: /Reading parser\.ts/ }))

    expect(body().getAttribute('data-expanded')).toBe('true')
    expect(body().getAttribute('data-closing')).toBeNull()
    expect(body().hasAttribute('hidden')).toBe(false)
    expect(body().hasAttribute('inert')).toBe(false)

    // The timer the fold scheduled would have hidden it; nothing may change after it.
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(body().hasAttribute('hidden')).toBe(false)
    expect(body().getAttribute('data-closing')).toBeNull()
  })

  it('hides immediately under reduced motion, with no closing class and no inert left behind', () => {
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia)

    const view = render(section(true))
    view.rerender(section(false))

    // Instant and identical to the pre-motion fold: no window, no class, no inert.
    expect(body().hasAttribute('hidden')).toBe(true)
    expect(body().getAttribute('data-closing')).toBeNull()
    expect(body().hasAttribute('inert')).toBe(false)
  })
})
