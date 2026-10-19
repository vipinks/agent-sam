/**
 * The dark ladder at GitHub's depth, as arithmetic: the surface family every theme sits on, and the ink
 * held on it.
 *
 * The previous lift put the dark page on a charcoal near `#15171b`. This pass moves it to the depth
 * github.com's own dark mode uses — a page at `#0d1117`, a plate at `#161b22`, a hairline at `#30363d` —
 * and rebuilds the foreground family to match: primary text near `#e6edf3`, muted text a cool step below
 * it. Lightness and saturation are the same shape for every theme, and only the hue moves, so the five
 * themes keep their identities on a surface family that reads like GitHub rather than like a neutral grey.
 *
 * Two numbers here are not the ones the brief names, and both are deliberate:
 *
 * - The muted rung sits at 64 percent, not the 53 percent of `#7d8590`. GitHub draws its muted text on
 *   `#0d1117` (5.07:1) and `#161b22` (4.64:1), never on the subtle chip surface this app calls `--muted`:
 *   at 53 percent the same ink measures 4.10 to 4.46 against that step, under the floor. The contrast
 *   control's top step spreads the chip further from the page still, so anything under about 64 percent
 *   would have to be rescued by the readability pass at a slider position a user can reach. 64 is the
 *   first uniform rung that clears every guarded surface at every step of both controls.
 * - The foregrounds are held against canvas, plate and popover — the three surfaces the brief names —
 *   while the muted rung is additionally held to the chip step by the engine's own guard, which is why
 *   the number above had to move at all.
 *
 * The light family is asserted to stay where it was: this is a dark-mode change, and a suite that let
 * both modes drift would not notice if it stopped being one.
 *
 * The floor is stated as an assertion and never relaxed to fit the data: `MIN_CONTRAST` is the engine's
 * own constant, and a theme that could not reach it is a theme to retune rather than a number to lower.
 * The values are read from the registry, through the suite's own HSL parse, so a claim about a value is
 * never the engine agreeing with itself.
 *
 * Nothing here measures a pixel: what the page *looks* like — the room at GitHub's depth in all five
 * themes, beside a github.com dark page — is Boss's eyes on the running window. What is provable without
 * a browser is the ladder and the arithmetic on it.
 */
import { strict as assert } from 'node:assert'
import {
  MIN_CONTRAST,
  TEXT_SURFACES,
  contrastRatio,
  ensureReadable,
  parseHsl,
  resolveThemeVars,
} from '../../app/components/workbench/theme-engine'
import { THEMES, THEME_MODES, type ThemeMode } from '../../app/components/workbench/themes'

const results: string[] = []
const failures: string[] = []

/**
 * The ladder the dark canvas sits on, in the HSL the registry spells.
 *
 * Three surfaces, exactly as the brief names them: the page, the plate that sits on it, and the hairline
 * that draws an edge when an edge is still wanted. Each carries its own saturation because the shape being
 * copied is github.com's own: 25 percent on the page, 20 on the plate, 12 on the hairline. The rest of the
 * family — muted, accent, secondary, the bright hairline — is asserted by its *order* against these three
 * rather than by a fourth number, so the ladder can gain a step without this file having an opinion.
 */
const LIFTED = {
  background: { lightness: 7, saturation: 25 },
  card: { lightness: 11, saturation: 20 },
  border: { lightness: 21, saturation: 12 },
} as const

/**
 * The foreground ladder, in the same shape.
 *
 * Primary text is the three tokens a foreground is drawn with: `--foreground`, `--card-foreground` and
 * `--popover-foreground`. Muted text is its own rung. The saturation caps are what keep the hue a whisper:
 * a theme tints its whites, it does not paint them.
 */
const INK = {
  primary: { lightness: 93, saturation: 20 },
  muted: { lightness: 64, saturation: 10 },
} as const

/** Half a point, which is finer than any of these values needs to be pinned. */
const TOLERANCE = 0.5

/** One claim, reported on its own so a red run names every claim that is red. */
function claim(name: string, check: () => void): void {
  try {
    check()
    results.push(name)
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message.split('\n')[0]}`)
  }
}

type SurfaceName = 'background' | 'card' | 'border' | 'muted' | 'border-bright' | 'secondary'
type ForegroundName = 'foreground' | 'card-foreground' | 'popover-foreground' | 'muted-foreground'

/** A token as HSL, failing loudly rather than measuring `undefined` as black. */
function hslOf(themeId: string, mode: ThemeMode, name: SurfaceName | ForegroundName) {
  const value = THEMES.find((theme) => theme.id === themeId)?.tokens[mode][name]
  const hsl = parseHsl(value ?? '')
  assert.ok(hsl, `${themeId} ${mode}: --${name} (${value}) is not an hsl colour`)
  return hsl
}

/**
 * Every dark theme sits on the ladder at GitHub's depth.
 *
 * Read as a band rather than as an equality: a theme's own tint moves a channel by a point or two either
 * way, and what is being asserted is the depth — a page at seven percent, a plate at eleven, a hairline at
 * twenty-one — with the saturation shape that makes those three the values github.com chose.
 */
function everyThemeSitsOnTheLiftedLadder(): void {
  for (const theme of THEMES) {
    for (const [name, expected] of Object.entries(LIFTED) as [
      keyof typeof LIFTED,
      (typeof LIFTED)[keyof typeof LIFTED],
    ][]) {
      const { l, s } = hslOf(theme.id, 'dark', name)
      assert.ok(
        Math.abs(l - expected.lightness) <= TOLERANCE,
        `${theme.id} dark: --${name} is at ${l}%, not the GitHub depth of ${expected.lightness}%`
      )
      assert.ok(
        Math.abs(s - expected.saturation) <= TOLERANCE,
        `${theme.id} dark: --${name} is at ${s}% saturation, not the ${expected.saturation}% of the ladder`
      )
    }
  }
}

/**
 * The ladder ascends, so a plate still separates from the page it sits on.
 *
 * This is the half the numbers alone cannot state: three lifted values that happened to land in the wrong
 * order would pass the band above and draw a page with no separation at all, which is the exact defect the
 * pass is repairing.
 */
function theLadderAscends(): void {
  for (const theme of THEMES) {
    const order = ['background', 'card', 'muted', 'border', 'border-bright'] as const
    const values = order.map((name) => ({ name, l: hslOf(theme.id, 'dark', name).l }))

    for (let i = 1; i < values.length; i += 1) {
      assert.ok(
        values[i].l > values[i - 1].l,
        `${theme.id} dark: --${values[i].name} (${values[i].l}%) does not sit above --${values[i - 1].name} (${values[i - 1].l}%)`
      )
    }

    // And with room between the first two, which is the pair the eye reads as a plate on a page.
    const [background, card] = values
    assert.ok(
      card.l - background.l >= 2,
      `${theme.id} dark: the plate is only ${(card.l - background.l).toFixed(2)} points above the page`
    )
  }
}

/**
 * Each theme's tint survives the depth change as a whisper.
 *
 * Every surface token of one theme shares one hue — the theme's own — so crimson is a warm room, ocean a
 * cool one, and so on, while the saturation stays low enough to read as charcoal rather than as a colour.
 * The named three carry the ladder's own saturation shape; the chip and bright-hairline steps only have to
 * stay inside the whisper band, because they are the steps the brief does not name.
 */
function eachThemeKeepsItsOwnTint(): void {
  for (const theme of THEMES) {
    const family = ['background', 'card', 'muted', 'border', 'border-bright'] as const
    const hues = family.map((name) => hslOf(theme.id, 'dark', name))
    const reference = hues[0].h

    for (const [index, hsl] of hues.entries()) {
      const name = family[index]
      assert.ok(
        Math.abs(hsl.h - reference) <= 2,
        `${theme.id} dark: --${name} is at hue ${hsl.h}, not the family's ${reference}`
      )

      if (name in LIFTED) {
        const expected = LIFTED[name as keyof typeof LIFTED]
        assert.ok(
          Math.abs(hsl.s - expected.saturation) <= TOLERANCE,
          `${theme.id} dark: --${name} is at ${hsl.s}% saturation, not the ${expected.saturation}% of the ladder`
        )
        continue
      }

      assert.ok(hsl.s >= 4, `${theme.id} dark: --${name} is at ${hsl.s}% saturation, which is a neutral grey`)
      assert.ok(hsl.s <= 20, `${theme.id} dark: --${name} is at ${hsl.s}% saturation, which is a colour`)
    }
  }
}

/**
 * The foreground family sits on GitHub's cool ladder, in each theme's own hue.
 *
 * The three primary tokens share one rung at 93 percent — near-white, but not the pure bloom the old
 * family used — and the muted token sits below them. Saturation is capped rather than fixed, because what
 * has to hold is the *whisper*: a hue of the theme's own, never a tint strong enough to name.
 */
function everyDarkForegroundSitsOnTheLadder(): void {
  for (const theme of THEMES) {
    const familyHue = hslOf(theme.id, 'dark', 'background').h

    for (const name of ['foreground', 'card-foreground', 'popover-foreground'] as const) {
      const { l, s, h } = hslOf(theme.id, 'dark', name)
      assert.ok(
        Math.abs(l - INK.primary.lightness) <= TOLERANCE,
        `${theme.id} dark: --${name} is at ${l}%, not the primary rung of ${INK.primary.lightness}%`
      )
      assert.ok(
        s <= INK.primary.saturation,
        `${theme.id} dark: --${name} is at ${s}% saturation, past the ${INK.primary.saturation}% cap`
      )
      assert.ok(s >= 4, `${theme.id} dark: --${name} is at ${s}% saturation, a neutral white rather than a tinted one`)
      assert.ok(
        Math.abs(h - familyHue) <= 2,
        `${theme.id} dark: --${name} is at hue ${h}, not the family's ${familyHue}`
      )
    }

    const muted = hslOf(theme.id, 'dark', 'muted-foreground')
    assert.ok(
      Math.abs(muted.l - INK.muted.lightness) <= TOLERANCE,
      `${theme.id} dark: --muted-foreground is at ${muted.l}%, not the muted rung of ${INK.muted.lightness}%`
    )
    assert.ok(
      muted.s <= INK.muted.saturation,
      `${theme.id} dark: --muted-foreground is at ${muted.s}% saturation, past the ${INK.muted.saturation}% cap`
    )
    assert.ok(muted.s >= 4, `${theme.id} dark: --muted-foreground is at ${muted.s}% saturation, a neutral grey`)
    assert.ok(
      Math.abs(muted.h - familyHue) <= 2,
      `${theme.id} dark: --muted-foreground is at hue ${muted.h}, not the family's ${familyHue}`
    )
  }
}

/**
 * Every dark foreground clears the floor on every surface the brief names.
 *
 * Primary text, card text, popover text and muted text, each measured against the canvas, the plate and the
 * popover in all five themes. The registry's own strings are measured, so this is a claim about what a
 * theme authors rather than about what the engine would rescue.
 */
function everyDarkForegroundPairReads(): void {
  const inks = ['foreground', 'card-foreground', 'popover-foreground', 'muted-foreground'] as const
  const surfaces = ['background', 'card', 'popover'] as const

  for (const theme of THEMES) {
    for (const ink of inks) {
      for (const surface of surfaces) {
        const ratio = contrastRatio(theme.tokens.dark[ink], theme.tokens.dark[surface])
        assert.ok(
          ratio >= MIN_CONTRAST,
          `${theme.id} dark: --${ink} (${theme.tokens.dark[ink]}) on --${surface} (${theme.tokens.dark[surface]}) measured ${ratio.toFixed(2)}, under the ${MIN_CONTRAST} floor`
        )
      }
    }
  }
}

/**
 * Light mode is where it was.
 *
 * The lift is a dark-mode change, and the one way it could go wrong invisibly is by dragging the light
 * family with it: the ladder for a near-white page is a different set of numbers entirely, and these
 * bands are wide enough to hold the five themes as they are while failing if any of them moved towards
 * the dark one.
 */
function lightModeIsUntouched(): void {
  for (const theme of THEMES) {
    assert.ok(hslOf(theme.id, 'light', 'background').l >= 94, `${theme.id} light: the page left the near-white band`)
    assert.ok(hslOf(theme.id, 'light', 'card').l >= 99, `${theme.id} light: the plate left the near-white band`)
    assert.ok(hslOf(theme.id, 'light', 'muted').l >= 96, `${theme.id} light: --muted left the near-white band`)
    const border = hslOf(theme.id, 'light', 'border').l
    assert.ok(border >= 80 && border <= 88, `${theme.id} light: --border moved to ${border}%`)
  }
}

/**
 * Every dark `--brand-text` clears the floor on every surface text is drawn on.
 *
 * An accent is chosen for a surface, not for text, and this pass moved every surface under it: the ink that
 * read at the old charcoal is the ink this claim re-measures at GitHub's depth. The card is named in the
 * brief and every text surface is measured, because a muted line and a popover are as much somewhere a
 * glyph is drawn as a plate is.
 */
function everyDarkBrandTextReads(): void {
  for (const theme of THEMES) {
    const brandText = theme.tokens.dark['brand-text']
    assert.equal(typeof brandText, 'string', `${theme.id} dark: the registry carries a --brand-text`)

    for (const surface of TEXT_SURFACES) {
      const ratio = contrastRatio(brandText, theme.tokens.dark[surface])
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${theme.id} dark: --brand-text (${brandText}) on --${surface} (${theme.tokens.dark[surface]}) measured ${ratio.toFixed(2)}, under the ${MIN_CONTRAST} floor`
      )
    }

    // The card is the surface the brief names, stated on its own so a red run points at it by name.
    const onCard = contrastRatio(brandText, theme.tokens.dark.card)
    assert.ok(onCard >= MIN_CONTRAST, `${theme.id} dark: --brand-text on the plate measured ${onCard.toFixed(2)}`)
  }
}

/**
 * The readability pass has nothing to rescue on the new ladder.
 *
 * If a pair needed moving at the theme's own brightness, the floor would still be met — by the pass rather
 * than by the palette — and the app would launch into a theme that is not the one it authored. So the pass
 * is asked here whether it moved anything, in both modes, and expected to say no.
 */
function thePassMovesNothingAtTheDefaultBrightness(): void {
  for (const theme of THEMES) {
    for (const mode of THEME_MODES satisfies readonly ThemeMode[]) {
      const { moved } = ensureReadable(resolveThemeVars(theme.id, mode, 0))
      assert.deepEqual(moved, [], `${theme.id} ${mode}: the readability pass moved ${moved.join(', ') || 'nothing'}`)
    }
  }
}

// ---------------------------------------------------------------- main

function main(): void {
  claim('every theme sits at GitHub depth in dark mode', everyThemeSitsOnTheLiftedLadder)
  claim('the dark ladder ascends, so a plate separates from its page', theLadderAscends)
  claim('each theme keeps its own tint as a whisper rather than a neutral grey', eachThemeKeepsItsOwnTint)
  claim('the dark foregrounds sit on GitHub’s cool rung in each theme’s own hue', everyDarkForegroundSitsOnTheLadder)
  claim('every dark foreground clears the floor on the canvas, the plate and the popover', everyDarkForegroundPairReads)
  claim('the light family is where it was', lightModeIsUntouched)
  claim('every dark --brand-text clears the floor on every surface it is drawn on', everyDarkBrandTextReads)
  claim('the default brightness needs no rescue from the readability pass', thePassMovesNothingAtTheDefaultBrightness)

  if (failures.length) {
    console.error(`lifted canvas: ${failures.length} failed, ${results.length} passed`)
    for (const failure of failures) console.error(`  fail: ${failure}`)
    process.exit(1)
  }

  console.log(`lifted canvas: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

main()
