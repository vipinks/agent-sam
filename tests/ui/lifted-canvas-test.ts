/**
 * The lifted dark canvas, as arithmetic: the charcoal ladder under every theme, and the ink held on it.
 *
 * Turn 1 and Turn 1b left the dark page at `#08090a` — a near-black that a plate could not separate
 * from and that body-size text bloomed against. This suite is the record of the lift: each theme's dark
 * surface family sits on a charcoal ladder, per theme and with a whisper of that theme's own hue rather
 * than a neutral grey, and every dark `--brand-text` clears the 4.5:1 floor on the surfaces text is
 * actually drawn on. The light family is asserted to stay where it was, because the lift was a dark-mode
 * change and a suite that let both modes drift would not notice if it stopped being one.
 *
 * The floor is stated as an assertion and never relaxed to fit the data: `MIN_CONTRAST` is the engine's
 * own constant, and a theme that could not reach it is a theme to retune rather than a number to lower.
 * The values are read from the registry, through the suite's own HSL parse, so a claim about a value is
 * never the engine agreeing with itself.
 *
 * Nothing here measures a pixel: what the lifted page *looks* like — the plate separating from it in
 * both modes and all five themes, on a conversation view and on the home view — is Boss's eyes on the
 * running window. What is provable without a browser is the ladder and the arithmetic on it.
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
 * The ladder the dark canvas is lifted onto, as lightness in the HSL the registry spells.
 *
 * Three numbers because three surfaces are what the brief names: the page, the plate that sits on it,
 * and the hairline that draws an edge when an edge is still wanted. The rest of the family — muted,
 * accent, secondary, the bright hairline — is asserted by its *order* against these three rather than
 * by a fourth number, so the ladder can gain a step without this file having an opinion about it.
 */
const LIFTED = { background: 9.4, card: 12.35, border: 17.06 } as const

/** Half a point of lightness, which is finer than any of these three values needs to be pinned. */
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

/** A token as HSL, failing loudly rather than measuring `undefined` as black. */
function hslOf(
  themeId: string,
  mode: ThemeMode,
  name: 'background' | 'card' | 'border' | 'muted' | 'border-bright' | 'secondary'
) {
  const value = THEMES.find((theme) => theme.id === themeId)?.tokens[mode][name]
  const hsl = parseHsl(value ?? '')
  assert.ok(hsl, `${themeId} ${mode}: --${name} (${value}) is not an hsl colour`)
  return hsl
}

/**
 * Every dark theme sits on the lifted ladder.
 *
 * Read as a band rather than as an equality: the brief names a charcoal near `#15171b` for the page,
 * near `#1b1e24` for the plate and near `#262a31` for the hairline, and a theme's own tint moves the
 * channel values by a point or two either way. What is being asserted is that the page is charcoal and
 * no longer black, which is the property the lift is for.
 */
function everyThemeSitsOnTheLiftedLadder(): void {
  for (const theme of THEMES) {
    for (const [name, expected] of Object.entries(LIFTED) as [keyof typeof LIFTED, number][]) {
      const { l } = hslOf(theme.id, 'dark', name)
      assert.ok(
        Math.abs(l - expected) <= TOLERANCE,
        `${theme.id} dark: --${name} is at ${l}%, not the lifted ${expected}%`
      )
    }
  }
}

/**
 * The ladder ascends, so a plate still separates from the page it sits on.
 *
 * This is the half the numbers alone cannot state: three lifted values that happened to land in the
 * wrong order would pass the band above and draw a page with no separation at all, which is the exact
 * defect the pass is repairing.
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
 * Each theme's tint survives the lift as a whisper.
 *
 * The four surface tokens of one theme share one hue — the hue that theme's dark family already had —
 * at a saturation low enough to read as charcoal rather than as a colour, and high enough that the
 * window is not a neutral grey five times over. Both halves matter: a lift to `#15171b` reproduced
 * with zero saturation would delete the difference between the five themes in dark mode.
 */
function eachThemeKeepsItsOwnTint(): void {
  for (const theme of THEMES) {
    const family = ['background', 'card', 'muted', 'border'] as const
    const hues = family.map((name) => hslOf(theme.id, 'dark', name))
    const reference = hues[0].h

    for (const [index, hsl] of hues.entries()) {
      assert.ok(
        Math.abs(hsl.h - reference) <= 2,
        `${theme.id} dark: --${family[index]} is at hue ${hsl.h}, not the family's ${reference}`
      )
      assert.ok(hsl.s >= 4, `${theme.id} dark: --${family[index]} is at ${hsl.s}% saturation, which is a neutral grey`)
      assert.ok(hsl.s <= 20, `${theme.id} dark: --${family[index]} is at ${hsl.s}% saturation, which is a colour`)
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
 * An accent is chosen for a surface, not for text, and the lifted page raised every surface under it:
 * the ink that read at `#08090a` is the ink this claim re-measures on the charcoal one. The card is
 * named in the brief and every text surface is measured, because a muted line and a popover are as
 * much somewhere a glyph is drawn as a plate is.
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
    assert.ok(onCard >= MIN_CONTRAST, `${theme.id} dark: --brand-text on the lifted card measured ${onCard.toFixed(2)}`)
  }
}

/**
 * The readability pass has nothing to rescue on the lifted ladder.
 *
 * If a pair needed moving at the theme's own brightness, the floor would still be met — by the pass
 * rather than by the palette — and the app would launch into a theme that is not the one it authored.
 * So the pass is asked here whether it moved anything, in both modes, and expected to say no.
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
  claim('every theme sits on the lifted charcoal ladder in dark mode', everyThemeSitsOnTheLiftedLadder)
  claim('the dark ladder ascends, so a plate separates from its page', theLadderAscends)
  claim('each theme keeps its own tint as a whisper rather than a neutral grey', eachThemeKeepsItsOwnTint)
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
