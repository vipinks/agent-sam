import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from '@/app/components/ui/input'

/**
 * The input field's surface, as the classes it carries.
 *
 * The field is drawn on the dialog's own card surface. In dark mode the input token at 30 percent is
 * almost the card's own colour, so the field reads as an outline rather than as a place to type; the
 * fixed contract is a higher tint of the same `--input` token, which lightens the field without
 * introducing a second background token.
 *
 * jsdom applies no stylesheet, so "dark mode" cannot be toggled into existence here. What is checkable
 * is the class contract itself: the dark branch carries the raised tint and the light branch carries
 * no dark override, which is the cause of the rendered colour rather than a copy of it. Whether the
 * field *looks* lighter is a pixel judgement the running window makes, in both modes and every theme.
 */

/** Class tokens, not substrings: `file:bg-transparent` must never satisfy a `bg-transparent` check. */
function tokensOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean))
}

function renderInput(): Set<string> {
  const { container } = render(<Input aria-label="surface probe" />)
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

  it('leaves the light surface to the card behind it', () => {
    const tokens = renderInput()

    // Light mode keeps the field transparent, so the card's own surface shows through unchanged.
    expect(tokens.has('bg-transparent')).toBe(true)
  })

  it('keeps the input border token and the larger touch target', () => {
    const tokens = renderInput()

    expect(tokens.has('border-input')).toBe(true)
    expect(tokens.has('h-10')).toBe(true)
  })
})
