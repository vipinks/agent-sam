import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '@/app/app'

/**
 * The splash as the renderer draws it.
 *
 * jsdom lays nothing out, so this suite does not claim the logo is 360 pixels or that the five vertical
 * bands add up to 480. It holds the parts a screenshot cannot state: the logo has an accessible name,
 * the caption is the ruled copy, and both animated elements stop animating when motion is reduced.
 *
 * The hash is set before `App` renders because the root mount is the router here: no second Vite entry
 * and no second React root exist, so `#splash` is the only thing that selects this screen.
 */
beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '#splash')
})

describe('the startup splash', () => {
  it('serves from the app root with an accessible logo, the ruled caption and reduced-motion stops', () => {
    render(<App />)

    const logo = screen.getByRole('img', { name: 'Agent Sam' })
    expect(logo.getAttribute('src')).toBeTruthy()
    expect(logo.className.split(/\s+/)).toContain('motion-reduce:animate-none')
    expect(logo.className.split(/\s+/)).toContain('animate-in')

    const caption = screen.getByText('Waking Sam...')
    expect(caption.className.split(/\s+/)).toContain('text-[14px]')
    expect(caption.className.split(/\s+/)).toContain('animate-pulse')
    expect(caption.className.split(/\s+/)).toContain('motion-reduce:animate-none')
  })
})
