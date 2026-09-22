import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ID,
  THEMES,
  THEME_MODES,
  THEME_VARIABLES,
  isThemeId,
  themeById,
  type Theme,
  type ThemeMode,
  type ThemeVariable,
} from '@/app/components/workbench/themes'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  MIN_CONTRAST,
  PAIR_SURFACES,
  adjustLightness,
  clampBrightness,
  contrastRatio,
  ensureReadable,
  formatHsl,
  hslToRgb,
  parseHsl,
  relativeLuminance,
  resolveThemeVars,
  type ReadablePair,
  type ThemeVars,
} from '@/app/components/workbench/theme-engine'
import { parseHslString, rgbOf, strictRgbOf, stylesheetTokens, themeLayer } from './theme-css'

/**
 * The theme engine as arithmetic: the registry's data, and the three claims the phase makes about it.
 *
 * 1. Every theme is complete — one entry per custom property the stylesheet declares, in both modes.
 * 2. Every theme is readable — the three text pairs clear 4.5:1 in both modes at the bottom, the
 *    default, and the top of the brightness range, after the readability pass has had its say.
 * 3. `crimson` is today's palette exactly — token for token against `globals.css` itself, so the
 *    default experience is the stylesheet's values rather than a near miss.
 *
 * The floor is asserted as an assertion, never relaxed to fit the data. If a theme cannot reach it, the
 * theme is wrong and the theme gets retuned; a suite that lowered 4.5 to whatever a palette happened to
 * score would be a description of the bug rather than a test of it.
 *
 * Nothing here touches the DOM or a store: what renders the result is `theme-apply-wiring.test.tsx`,
 * and what this file can prove without a browser is the part that is arithmetic.
 */

/** The brightness steps the floor is stated at: both ends of the range and the default between them. */
const BRIGHTNESS_STEPS = [BRIGHTNESS_MIN, BRIGHTNESS_DEFAULT, BRIGHTNESS_MAX] as const

/** One text pair, the two variables it is made of, and the surfaces it is drawn on. */
interface Pair {
  /** The pair's own name, as `ensureReadable` reports it. */
  key: ReadablePair
  fg: ThemeVariable
  bg: ThemeVariable
  /** Every surface the foreground is held against — the engine's own list, not a second copy of it. */
  surfaces: readonly ThemeVariable[]
}

/**
 * The pairs the floor is about.
 *
 * `muted-foreground` is measured against the page background, which is the pair the phase names; the
 * readability pass itself is stricter and holds each foreground against every surface it can be drawn
 * on, which `surfaces` carries so the two claims are made about the same thing.
 */
function pairs(): Pair[] {
  return [
    { key: 'foreground', fg: 'foreground', bg: 'background', surfaces: PAIR_SURFACES.foreground },
    { key: 'muted-foreground', fg: 'muted-foreground', bg: 'background', surfaces: PAIR_SURFACES['muted-foreground'] },
    { key: 'primary', fg: 'primary-foreground', bg: 'primary', surfaces: PAIR_SURFACES.primary },
  ]
}

/** Every pair's measured ratio, with the values it was measured from. */
function measure(
  themeId: string,
  mode: ThemeMode,
  brightness: number
): { pair: Pair; fg: string; bg: string; ratio: number }[] {
  const { vars } = ensureReadable(resolveThemeVars(themeId, mode, brightness))
  return pairs().map((pair) => {
    const fg = vars[pair.fg]
    const bg = vars[pair.bg]
    return { pair, fg, bg, ratio: contrastRatio(fg, bg) }
  })
}

/**
 * A colour's luminance as a screen shows it, for the polarity invariant below.
 *
 * Reading the engine's own conversion is the right tool for that assertion: polarity is a property of
 * the *rendered* palette, so it has to be judged from the same numbers a screen would get.
 */
function luminanceOf(value: string): number {
  const rgb = hslToRgb(value)
  return rgb ? relativeLuminance(rgb) : 0
}

/**
 * Whether the ink a theme authored for a pair can reach the floor by moving along its own ladder.
 *
 * This is what turns the readability pass into something a test can check without restating it: the
 * engine moves a foreground along its own hue and saturation, so the question "should this pair have
 * moved?" is answerable by walking the same ladder here. The direction mirrors the engine's rule — the
 * ink moves away from the mean lightness of the surfaces it sits on — and the step is the same half
 * point, so the two agree on every input rather than on the ones that were tried.
 *
 * A pair that already reads answers false, because the claim is about a *move*: the engine leaves a
 * legible pair alone even though that ink could also be walked further.
 */
function inkCanReachFloor(theme: Theme, mode: ThemeMode, pair: Pair, vars: ThemeVars): boolean {
  const ink = parseHsl(theme.tokens[mode][pair.fg])
  if (!ink) return false

  const reads = (value: string) => pair.surfaces.every((surface) => contrastRatio(value, vars[surface]) >= MIN_CONTRAST)
  if (reads(formatHsl(ink))) return false

  const surfaces = pair.surfaces.map((surface) => parseHsl(vars[surface])?.l ?? 0)
  const mean = surfaces.reduce((sum, l) => sum + l, 0) / surfaces.length
  const direction = ink.l <= mean ? -0.5 : 0.5

  for (let l = Math.min(100, Math.max(0, ink.l)); l >= 0 && l <= 100; l += direction) {
    if (reads(formatHsl({ ...ink, l }))) return true
  }
  return false
}

describe('the contrast floor', () => {
  for (const theme of THEMES) {
    for (const mode of THEME_MODES) {
      for (const brightness of BRIGHTNESS_STEPS) {
        it(`holds for ${theme.id} in ${mode} at brightness ${brightness}`, () => {
          for (const { pair, fg, bg, ratio } of measure(theme.id, mode, brightness)) {
            expect(
              ratio,
              `${theme.id} ${mode} brightness ${brightness}: ${pair.fg} (${fg}) on ${pair.bg} (${bg}) measured ${ratio}`
            ).toBeGreaterThanOrEqual(MIN_CONTRAST)
          }
        })
      }
    }
  }
})

describe('the readability pass', () => {
  it('moves nothing for the default theme at brightness 0, so the default experience is the stylesheet’s', () => {
    for (const mode of THEME_MODES) {
      const vars = resolveThemeVars(DEFAULT_THEME_ID, mode, BRIGHTNESS_DEFAULT)
      const { vars: resolved, moved } = ensureReadable(vars)

      expect(moved, `${DEFAULT_THEME_ID} ${mode} moved ${moved.join(', ')}`).toEqual([])
      expect(resolved).toEqual(vars)
    }
  })

  it('moves a pair exactly when the theme’s own ink can be moved to read', () => {
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        for (const brightness of BRIGHTNESS_STEPS) {
          const before = resolveThemeVars(theme.id, mode, brightness)
          const { vars, moved } = ensureReadable(before)
          const where = `${theme.id} ${mode} brightness ${brightness}`

          for (const pair of pairs()) {
            const fixable = inkCanReachFloor(theme, mode, pair, before)
            expect(moved.includes(pair.key), `${where}: ${pair.key} moved=${moved.join(', ')}`).toBe(fixable)

            // And where the theme's ink could be moved, the pair is readable on the other side of the
            // move — the same floor the contrast suite states, checked here on the moved values.
            if (fixable) {
              const ratio = contrastRatio(vars[pair.fg], vars[pair.bg])
              expect(
                ratio,
                `${where}: ${pair.key} after the pass (${vars[pair.fg]} on ${vars[pair.bg]}) measured ${ratio}`
              ).toBeGreaterThanOrEqual(MIN_CONTRAST)
            }
          }

          // Three variables may differ, and no fourth: the pass is not allowed to be a repaint.
          const changed = THEME_VARIABLES.filter((name) => vars[name] !== before[name])
          expect(changed.sort(), where).toEqual(
            changed
              .filter((name) => name === 'foreground' || name === 'muted-foreground' || name === 'primary-foreground')
              .sort()
          )
        }
      }
    }
  })

  it('reports a pair it could not fix, instead of claiming a floor it did not reach', () => {
    // Built here rather than found in the registry, which has no such theme: a page that is dark in one
    // place and light in another cannot be read by any single ink — black fails on the dark surface and
    // white fails on the light one — so the pass has to stop somewhere with a pair that still does not
    // read. That is what "or the bounds stop it" means, and the assertion is that such a pair comes back
    // *reported* rather than as a silent pass: the contrast suite is what turns the report into a failure.
    const vars = resolveThemeVars(DEFAULT_THEME_ID, 'light', BRIGHTNESS_DEFAULT)
    const split: ThemeVars = {
      ...vars,
      background: 'hsl(0 0% 8%)',
      card: 'hsl(0 0% 98%)',
      foreground: 'hsl(0 0% 50%)',
    }
    const { vars: resolved, moved } = ensureReadable(split)

    expect(moved).toContain('foreground')
    expect(resolved.foreground).not.toBe(split.foreground)
    // It walked away from the lighter surface, which is the direction its own lightness implies, and
    // stopped at the bound with the dark surface still unreadable rather than looping forever.
    expect(parseHsl(resolved.foreground)?.l).toBe(0)
    expect(contrastRatio(resolved.foreground, resolved.background)).toBeLessThan(MIN_CONTRAST)
    expect(contrastRatio(resolved.foreground, resolved.card)).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })
})

describe('known values', () => {
  it('scores black on white 21, the top of the WCAG scale', () => {
    expect(contrastRatio('hsl(0 0% 0%)', 'hsl(0 0% 100%)')).toBe(21)
  })

  it('scores a colour against itself 1, the bottom of the scale', () => {
    expect(contrastRatio('hsl(210 50% 40%)', 'hsl(210 50% 40%)')).toBe(1)
  })

  it('scores a value it cannot read as 1 rather than as a pass', () => {
    // 1 is below every floor, so an unreadable token fails a contrast claim instead of slipping past it.
    expect(contrastRatio('0.5rem', 'hsl(0 0% 100%)')).toBe(1)
    expect(contrastRatio('hsl(0 0% 100%)', 'color-mix(in oklab, red, blue)')).toBe(1)
  })

  it('reads the light and dark ends of the scale as opposites', () => {
    const dark = contrastRatio('hsl(0 0% 0%)', 'hsl(0 0% 50%)')
    const light = contrastRatio('hsl(0 0% 100%)', 'hsl(0 0% 50%)')

    // The same mid grey read against each end. The numbers are the published WCAG ones for black and
    // white on #808080, which is what a 50 percent grey is once a channel is rounded to a byte.
    expect(dark).toBeCloseTo(5.32, 2)
    expect(light).toBeCloseTo(3.95, 2)
    expect(dark).toBeGreaterThan(light)
  })
})

describe('the brightness arithmetic', () => {
  it('adds the delta to lightness and leaves hue and saturation where the theme put them', () => {
    expect(adjustLightness('hsl(210 50% 40%)', 12)).toBe('hsl(210 50% 52%)')
    expect(adjustLightness('hsl(210 50% 40%)', -12)).toBe('hsl(210 50% 28%)')
  })

  it('clamps at zero, so a dark surface cannot be pushed past black', () => {
    expect(adjustLightness('hsl(210 50% 8%)', -20)).toBe('hsl(210 50% 0%)')
  })

  it('clamps at 100, so a light surface cannot be pushed past white', () => {
    expect(adjustLightness('hsl(210 20% 95%)', 20)).toBe('hsl(210 20% 100%)')
  })

  it('is the identity at zero, spelled the way the registry spells it', () => {
    expect(adjustLightness('hsl(36 18.519% 94.706%)', BRIGHTNESS_DEFAULT)).toBe('hsl(36 18.519% 94.706%)')
    expect(adjustLightness('hsl(36.923 12.871% 80.196%)', BRIGHTNESS_DEFAULT)).toBe('hsl(36.923 12.871% 80.196%)')
  })

  it('leaves an alpha where it was, for the one token that carries one', () => {
    expect(adjustLightness('hsl(10.355 100% 61.373% / 0.13)', 20)).toBe('hsl(10.355 100% 81.373% / 0.13)')
  })

  it('leaves a value that is not a colour alone, rather than inventing one', () => {
    expect(adjustLightness('0.5rem', 20)).toBe('0.5rem')
    expect(adjustLightness('hsl(36 18.519% 94.706%)', Number.NaN)).toBe('hsl(36 18.519% 94.706%)')
  })

  it('holds a brightness inside the range and defaults anything that is not a number', () => {
    expect(clampBrightness(BRIGHTNESS_MAX)).toBe(BRIGHTNESS_MAX)
    expect(clampBrightness(BRIGHTNESS_MIN)).toBe(BRIGHTNESS_MIN)
    expect(clampBrightness(BRIGHTNESS_MAX + 40)).toBe(BRIGHTNESS_MAX)
    expect(clampBrightness(BRIGHTNESS_MIN - 40)).toBe(BRIGHTNESS_MIN)
    expect(clampBrightness(undefined)).toBe(BRIGHTNESS_DEFAULT)
    expect(clampBrightness('12')).toBe(BRIGHTNESS_DEFAULT)
    expect(clampBrightness(Number.NaN)).toBe(BRIGHTNESS_DEFAULT)
  })
})

describe('resolution', () => {
  it('names exactly the custom properties the stylesheet declares, in both of its blocks', () => {
    // Enumerated from the file rather than restated here: a token added to `:root` without a value in
    // every theme is a token that would silently inherit the default palette's colour.
    const sheet = stylesheetTokens()
    expect(THEME_VARIABLES.slice().sort()).toEqual(Object.keys(sheet.light).sort())
    expect(Object.keys(sheet.dark).sort()).toEqual(Object.keys(sheet.light).sort())
  })

  it('wires every Tailwind colour utility to a variable a theme sets', () => {
    const colors = Object.entries(themeLayer()).filter(([name]) => name.startsWith('color-'))
    expect(colors.length).toBeGreaterThan(0)

    for (const [name, value] of colors) {
      const targets = [...value.matchAll(/var\(--([a-z-]+)\)/g)].map((match) => match[1])
      expect(targets.length, `--${name}`).toBeGreaterThan(0)
      for (const target of targets) {
        expect(THEME_VARIABLES, `--${name} reads --${target}, which no theme sets`).toContain(target)
      }
    }
  })

  it('returns every variable for every theme and mode, as a value to set', () => {
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const vars = resolveThemeVars(theme.id, mode, BRIGHTNESS_DEFAULT)
        expect(Object.keys(vars).sort(), `${theme.id} ${mode}`).toEqual(THEME_VARIABLES.slice().sort())

        for (const name of THEME_VARIABLES) {
          expect(typeof vars[name], `${theme.id} ${mode} --${name}`).toBe('string')
          expect(vars[name].length, `${theme.id} ${mode} --${name}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('writes every colour token as an hsl string, and the radius as the radius', () => {
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const vars = resolveThemeVars(theme.id, mode, BRIGHTNESS_DEFAULT)
        for (const name of THEME_VARIABLES) {
          if (name === 'radius') {
            expect(vars[name], `${theme.id} ${mode} --${name}`).toBe('0.5rem')
            continue
          }
          expect(vars[name], `${theme.id} ${mode} --${name}`).toMatch(/^hsl\(/)
          expect(parseHsl(vars[name]), `${theme.id} ${mode} --${name}`).not.toBeNull()
        }
      }
    }
  })

  it('moves the surface family and their borders with brightness, and nothing else', () => {
    const moves = new Set([
      'background',
      'card',
      'popover',
      'muted',
      'accent',
      'secondary',
      'border',
      'border-bright',
      'input',
      'ring',
    ])

    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const base = resolveThemeVars(theme.id, mode, BRIGHTNESS_DEFAULT)
        const brighter = resolveThemeVars(theme.id, mode, BRIGHTNESS_MAX)

        for (const name of THEME_VARIABLES) {
          const moved = brighter[name] !== base[name]
          expect(moved, `${theme.id} ${mode} --${name} at brightness ${BRIGHTNESS_MAX}`).toBe(moves.has(name))
        }
      }
    }
  })

  it('keeps every surface inside the gamut a screen can paint, at every step', () => {
    // A saturated surface shifted twenty points down can leave the range a colour can be shown in, and a
    // browser clamps what it cannot paint. That clamp is why a palette that drifts out of range renders
    // as something nobody authored; keeping the registry inside it is what lets the readability pass and
    // a real screen agree on every measurement. Read through the suite's own conversion, so this is a
    // statement about the values rather than about the engine's arithmetic.
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        for (const brightness of BRIGHTNESS_STEPS) {
          const vars = resolveThemeVars(theme.id, mode, brightness)
          for (const [name, value] of Object.entries(vars)) {
            const hsl = parseHslString(value)
            if (!hsl) continue
            const rgb = strictRgbOf(hsl)
            const where = `${theme.id} ${mode} brightness ${brightness} --${name} (${value})`
            expect(rgb.r, where).toBeGreaterThanOrEqual(0)
            expect(rgb.g, where).toBeGreaterThanOrEqual(0)
            expect(rgb.b, where).toBeGreaterThanOrEqual(0)
            expect(rgb.r, where).toBeLessThanOrEqual(255)
            expect(rgb.g, where).toBeLessThanOrEqual(255)
            expect(rgb.b, where).toBeLessThanOrEqual(255)
          }
        }
      }
    }
  })

  it('keeps every theme the right way up: dark ink on a light page, light ink on a dark one', () => {
    // A palette with a swapped pair still passes every contrast check it is asked to, so nothing else in
    // this file would notice one: a theme whose foreground became its background reads, and reads
    // backwards. This is the assertion that notices, and it is why `luminanceOf` is here at all.
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        for (const brightness of BRIGHTNESS_STEPS) {
          const vars = resolveThemeVars(theme.id, mode, brightness)
          const where = `${theme.id} ${mode} brightness ${brightness}`
          const page = luminanceOf(vars.background)
          // Which way up a palette is is a property of the mode, not of the theme: every one of these is
          // dark ink on a light page in light mode and light ink on a dark page in dark mode.
          const darker = mode === 'light'

          for (const ink of ['foreground', 'muted-foreground'] as const) {
            const text = luminanceOf(vars[ink])
            expect(darker ? text < page : text > page, `${where}: --${ink} (${vars[ink]} on ${vars.background})`).toBe(
              true
            )
          }
        }
      }
    }
  })

  it('falls back to the default theme for an id the registry does not know', () => {
    for (const unknown of ['', 'chartreuse', null, undefined, 42]) {
      expect(themeById(unknown as string).id).toBe(DEFAULT_THEME_ID)
    }
    expect(isThemeId('crimson')).toBe(true)
    expect(isThemeId('chartreuse')).toBe(false)
  })

  it('gives every theme a distinct id and label, and a swatch drawn from its own surface', () => {
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length)
    expect(new Set(THEMES.map((theme) => theme.label)).size).toBe(THEMES.length)
    expect(THEMES.length).toBe(5)

    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        // The swatch is the theme's own background rather than a separately authored colour: a picker
        // that drew a hue the window does not use would be advertising a theme nobody can open.
        expect(theme.swatch[mode], `${theme.id} ${mode} swatch`).toBe(theme.tokens[mode].background)
        expect(parseHslString(theme.swatch[mode]), `${theme.id} ${mode} swatch`).not.toBeNull()
      }
    }

    // And the five are actually five: two themes whose whole surface family matched would leave a user
    // choosing between two names for one window.
    const backgrounds = new Set(THEMES.map((theme) => theme.tokens.light.background))
    expect(backgrounds.size).toBe(THEMES.length)
  })
})

describe('crimson is today’s palette', () => {
  for (const mode of THEME_MODES) {
    it(`reproduces globals.css token for token in ${mode}`, () => {
      const sheet = stylesheetTokens()[mode]
      const vars = resolveThemeVars(DEFAULT_THEME_ID, mode, BRIGHTNESS_DEFAULT)

      for (const name of THEME_VARIABLES) {
        if (name === 'radius') {
          expect(vars[name], `--${name}`).toBe(sheet[name])
          continue
        }

        const expected = rgbOf(sheet[name])
        // Read through the suite's own HSL conversion, not the engine's, so the comparison is between
        // two implementations rather than between the engine and itself.
        const actual = rgbOf(vars[name])
        expect(actual, `${mode} --${name} (stylesheet ${sheet[name]}, theme ${vars[name]})`).toEqual({
          r: expected.r,
          g: expected.g,
          b: expected.b,
          a: expected.a,
        })
      }
    })
  }

  it('keeps the one translucent token translucent, at the same alpha', () => {
    for (const mode of THEME_MODES) {
      const sheet = stylesheetTokens()[mode]
      const vars = resolveThemeVars(DEFAULT_THEME_ID, mode, BRIGHTNESS_DEFAULT)
      expect(parseHsl(vars['brand-soft'])?.a, `${mode} --brand-soft`).toBe(rgbOf(sheet['brand-soft']).a)
    }
  })
})
