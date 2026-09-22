import { describe, expect, it } from 'vitest'
import {
  COMPOSER_MAX_SHARE,
  COMPOSER_MIN_HEIGHT,
  clampComposerHeight,
  composerBounds,
} from '@/app/components/workbench/composer-resize'

/**
 * The composer's height arithmetic, called directly.
 *
 * A clamp is the kind of rule whose mistakes look like a design: a composer that stops short of the
 * pane's limit, or that refuses to grow on a short pane, reads as a choice rather than as a bug. The
 * crossing case is the one a DOM suite cannot reach either — jsdom performs no layout, so it has no
 * short pane to offer — which is the second reason these assertions are here rather than only in the
 * wiring suite.
 */

describe('clamping a requested composer height', () => {
  it('lets a request inside the bounds through untouched', () => {
    expect(clampComposerHeight(180, COMPOSER_MIN_HEIGHT, 300)).toBe(180)
  })

  it('raises a request below the floor to the floor', () => {
    expect(clampComposerHeight(40, COMPOSER_MIN_HEIGHT, 300)).toBe(COMPOSER_MIN_HEIGHT)
  })

  it('lowers a request above the ceiling to the ceiling', () => {
    expect(clampComposerHeight(900, COMPOSER_MIN_HEIGHT, 300)).toBe(300)
  })

  it('leaves a request that lands exactly on either bound where it is', () => {
    expect(clampComposerHeight(COMPOSER_MIN_HEIGHT, COMPOSER_MIN_HEIGHT, 300)).toBe(COMPOSER_MIN_HEIGHT)
    expect(clampComposerHeight(300, COMPOSER_MIN_HEIGHT, 300)).toBe(300)
  })

  it('keeps the floor when the bounds cross, so a short pane cannot invert the composer', () => {
    expect(clampComposerHeight(120, COMPOSER_MIN_HEIGHT, 40)).toBe(COMPOSER_MIN_HEIGHT)
  })

  it('resolves a request it cannot measure to the floor rather than to NaN', () => {
    // A drag read before the pane has been measured. NaN would reach the style attribute as a broken
    // length and collapse the composer onto its content — the behaviour this module exists to remove.
    expect(clampComposerHeight(Number.NaN, COMPOSER_MIN_HEIGHT, 300)).toBe(COMPOSER_MIN_HEIGHT)
    expect(clampComposerHeight(Number.POSITIVE_INFINITY, COMPOSER_MIN_HEIGHT, 300)).toBe(COMPOSER_MIN_HEIGHT)
  })
})

describe('the bounds a pane of a given height allows', () => {
  it('takes the composer floor as the minimum, however short the pane is', () => {
    expect(composerBounds(1000).min).toBe(COMPOSER_MIN_HEIGHT)
    expect(composerBounds(120).min).toBe(COMPOSER_MIN_HEIGHT)
    expect(composerBounds(0).min).toBe(COMPOSER_MIN_HEIGHT)
  })

  it('caps the composer at the pane share', () => {
    expect(composerBounds(1000).max).toBe(COMPOSER_MAX_SHARE * 1000)
    expect(composerBounds(400).max).toBe(COMPOSER_MAX_SHARE * 400)
  })

  it('never asks for a ceiling under the floor, whatever the pane measures', () => {
    expect(composerBounds(120)).toEqual({ min: COMPOSER_MIN_HEIGHT, max: COMPOSER_MIN_HEIGHT })
    expect(composerBounds(0)).toEqual({ min: COMPOSER_MIN_HEIGHT, max: COMPOSER_MIN_HEIGHT })
  })
})
