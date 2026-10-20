import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from '@/app/components/ui/input'
import { SurfaceProvider } from '@/app/components/ui/surface'

/**
 * The input field's surface, as the classes it carries.
 *
 * The field is drawn on two families of surface, and one fill could not be right on both: a field painted
 * with the page's own tone dissolves into a page, and a field painted with the card's tone dissolves into a
 * card. The contract is therefore the surface's, not the field's — the raised plate on a page, the page's
 * tone on a card — and it is the same answer the select trigger beside it gives, because it is the same
 * question.
 *
 * In dark mode the input token at 30 percent was almost the card's own colour, so the field read as an
 * outline rather than as a place to type; the fixed contract there is a higher tint of the same `--input`
 * token, which lightens the field without introducing a second background token. That branch is untouched by
 * the parent-aware fill: a `dark:` utility outranks a bare one, so the four combinations of two families and
 * two modes stay two colours rather than four.
 *
 * jsdom applies no stylesheet, so "dark mode" cannot be toggled into existence here. What is checkable is
 * the class contract itself: the dark branch carries the raised tint and the light branch the one the surface
 * asks for, which is the cause of the rendered colour rather than a copy of it. Whether the field *looks* like
 * a field is a pixel judgement the running window makes, in both modes and every theme.
 */

/** Class tokens, not substrings: `file:bg-transparent` must never satisfy a `bg-transparent` check. */
function tokensOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean))
}

function renderInput(kind: 'page' | 'card' = 'page'): Set<string> {
  const field = <Input aria-label="surface probe" />
  const { container } = render(kind === 'card' ? <SurfaceProvider kind="card">{field}</SurfaceProvider> : field)
  const input = container.querySelector<HTMLElement>('[data-slot="input"]')
  expect(input).not.toBeNull()
  return tokensOf(input as HTMLElement)
}

describe('input surface', () => {
  it('raises the input tint over the dark card it sits on', () => {
    const tokens = renderInput()

    expect(tokens.has('dark:bg-input/50')).toBe(true)
    expect(tokens.has('dark:bg-input/30')).toBe(false)
  })

  it('takes the raised plate on the page it is typed on', () => {
    const tokens = renderInput('page')

    // Light mode on a page: the plate the Recent-projects pill wears, which is what separates a field from
    // the page around it. `file:bg-transparent` is a different token and must not answer for this.
    expect(tokens.has('bg-card')).toBe(true)
    expect(tokens.has('bg-background/60'), 'the tone that was the page itself').toBe(false)
    expect(tokens.has('bg-transparent')).toBe(false)
  })

  it('recesses to the page tone inside a card, where the plate would be the card itself', () => {
    const tokens = renderInput('card')

    expect(tokens.has('bg-background')).toBe(true)
    expect(tokens.has('bg-card'), 'the colour of the card the field is lying on').toBe(false)
    expect(tokens.has('dark:bg-input/50'), 'the dark branch is one answer, not two').toBe(true)
  })

  it('keeps the input border token and the larger touch target', () => {
    const tokens = renderInput()

    expect(tokens.has('border-input')).toBe(true)
    expect(tokens.has('h-10')).toBe(true)
  })
})
