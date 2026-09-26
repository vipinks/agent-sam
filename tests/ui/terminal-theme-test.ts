/**
 * Verifies the one mapping the terminal's theming consists of: the app's tokens to xterm's theme.
 *
 * The terminal is the app's only surface that Tailwind does not draw. xterm paints its own canvas and
 * takes the colours it paints as an object, so a token is honoured only if it is handed over — which
 * makes this mapping the whole of the terminal's theme support, and makes it a mapping rather than a
 * palette. Every value is required to come from a token the rest of the app already uses, because a
 * second palette is exactly how a terminal becomes the one rectangle that does not move when the user
 * changes theme.
 *
 * Run against the real registry and the real engine, over `THEME_IDS` crossed with `THEME_MODES`, so
 * "all five themes in both modes" is a claim about `themes.ts` rather than about a number written
 * here — the count is asserted from the registry, and a sixth theme would be covered by existing.
 */
import { strict as assert } from 'node:assert'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  MIN_CONTRAST,
  contrastRatio,
  ensureReadable,
  resolveThemeVars,
  type ThemeVars,
} from '../../app/components/workbench/theme-engine'
import { THEME_IDS, THEME_MODES, THEME_VARIABLES, type ThemeMode } from '../../app/components/workbench/themes'
import {
  TERMINAL_THEME_TOKENS,
  terminalTheme,
  terminalThemeFor,
  type TerminalThemeField,
} from '../../app/components/workbench/terminal-theme'

const results: string[] = []

/** The fields the terminal cannot be drawn without, whatever else the table maps. */
const REQUIRED_FIELDS: readonly TerminalThemeField[] = ['background', 'foreground', 'cursor', 'selectionBackground']

/** The fields the table maps, as a list rather than as the object it is stored in. */
const mappedFields = Object.keys(TERMINAL_THEME_TOKENS) as TerminalThemeField[]

/** Every theme in both modes, as the pairs this suite is about. */
const everyCombination: Array<{ themeId: string; mode: ThemeMode }> = THEME_IDS.flatMap((themeId) =>
  THEME_MODES.map((mode) => ({ themeId, mode }))
)

/** The resolved tokens for a combination, computed the way the document's own variables are. */
function varsFor(themeId: string, mode: ThemeMode, brightness = BRIGHTNESS_DEFAULT): ThemeVars {
  return ensureReadable(resolveThemeVars(themeId, mode, brightness)).vars
}

// ---------------------------------------------------------------- the table is tokens, not colours

/**
 * Every entry names a real custom property.
 *
 * The table is a `Record<TerminalThemeField, ThemeVariable>`, so this is partly the compiler's job —
 * but only partly: `THEME_VARIABLES` is the list the stylesheet declares, and a variable that exists in
 * the type and not in the list would be a token the terminal reads and nothing else ever sets.
 */
function tableNamesRealTokens() {
  const declared = new Set<string>(THEME_VARIABLES)
  const unknown = mappedFields.filter((field) => !declared.has(TERMINAL_THEME_TOKENS[field]))

  assert.deepEqual(unknown, [], 'every mapped field is filled from a variable the stylesheet declares')
  assert.equal(mappedFields.length, new Set(mappedFields).size, 'and the table names no field twice')

  results.push('the mapping reads declared theme variables only')
}

/** Nothing xterm draws without is left to the library's defaults. */
function requiredFieldsAreMapped() {
  const missing = REQUIRED_FIELDS.filter((field) => !(field in TERMINAL_THEME_TOKENS))
  assert.deepEqual(missing, [], 'background, foreground, cursor and selection are all mapped')

  results.push('the four fields the terminal is drawn from are all mapped')
}

// ---------------------------------------------------------------- the mapping is a mapping

/**
 * Each value is the token it names, for every theme in both modes.
 *
 * The assertion is against the *engine's* resolved values rather than against the registry's, because
 * brightness and the readability pass both move a token after the registry has had its say — and the
 * terminal has to follow the values the document was given, not the ones the theme was written with.
 * A literal here would show up as a mismatch in whichever theme it was not copied from.
 */
function everyValueComesFromItsToken() {
  let checked = 0

  for (const { themeId, mode } of everyCombination) {
    const vars = varsFor(themeId, mode)
    const theme = terminalThemeFor(themeId, mode, BRIGHTNESS_DEFAULT)

    for (const field of mappedFields) {
      const token = TERMINAL_THEME_TOKENS[field]
      const value = theme[field]

      assert.equal(
        value,
        vars[token],
        `${themeId}/${mode}: ${field} should be the ${token} token (${vars[token]}), not ${String(value)}`
      )
      assert.equal(typeof value, 'string', `${themeId}/${mode}: ${field} is a colour, not a hole`)
      assert.notEqual(value, '', `${themeId}/${mode}: ${field} is not empty`)
      checked += 1
    }
  }

  assert.equal(checked, everyCombination.length * mappedFields.length, 'every field of every combination was read')

  results.push('all five themes in both modes map each field straight from the token it names')
}

/** The pure half agrees with the convenience half: one implementation, reached two ways. */
function theTableAppliedIsTheTheme() {
  const vars = varsFor('forest', 'dark')

  assert.deepEqual(terminalTheme(vars), terminalThemeFor('forest', 'dark', BRIGHTNESS_DEFAULT))

  results.push('the theme a resolved map produces is the theme a theme id produces')
}

// ---------------------------------------------------------------- and it is legible

/**
 * The pair the terminal is read in clears the app's own contrast floor.
 *
 * This is the invariant that makes the mapping worth having as a rule rather than as a habit: the
 * engine only guarantees that *the document's* foreground/background pair is readable, and the terminal
 * is free to pair the same two tokens with a different cursor and selection. So the floor is re-checked
 * on the pair as the terminal will actually paint it.
 */
function thePairIsReadable() {
  for (const { themeId, mode } of everyCombination) {
    const theme = terminalThemeFor(themeId, mode, BRIGHTNESS_DEFAULT)
    const ratio = contrastRatio(theme.foreground as string, theme.background as string)

    assert.ok(
      ratio >= MIN_CONTRAST,
      `${themeId}/${mode}: text on the terminal is ${ratio.toFixed(2)}:1, below the ${MIN_CONTRAST}:1 floor`
    )
  }

  results.push(`terminal text clears the ${MIN_CONTRAST}:1 floor in all five themes, in both modes`)
}

// ---------------------------------------------------------------- the theme is not a constant

/**
 * Different themes produce different terminals, and the brightness is honoured.
 *
 * Two ways for this mapping to be silently useless: return one terminal for every theme, or read the
 * registry and ignore the brightness. The first is caught by the backgrounds having to differ; the
 * second by a brighter document having to produce a brighter terminal — which is the same argument the
 * theme-application wiring makes about the document's own variables.
 */
function themesDifferAndBrightnessIsHeard() {
  for (const mode of THEME_MODES) {
    const backgrounds = THEME_IDS.map((themeId) => terminalThemeFor(themeId, mode, BRIGHTNESS_DEFAULT).background)
    assert.equal(
      new Set(backgrounds).size,
      THEME_IDS.length,
      `${mode}: every theme paints a different background, got ${backgrounds.join(', ')}`
    )
  }

  const dim = terminalThemeFor('crimson', 'dark', BRIGHTNESS_DEFAULT).background
  const bright = terminalThemeFor('crimson', 'dark', BRIGHTNESS_MAX).background
  assert.notEqual(bright, dim, 'a brighter document gives a brighter terminal')

  results.push('the terminal follows the theme and the brightness rather than a constant')
}

/** The coverage claim, taken from the registry rather than from a number written here. */
function coverageIsFiveThemesInBothModes() {
  assert.equal(THEME_IDS.length, 5, 'the registry holds five themes')
  assert.equal(THEME_MODES.length, 2, 'and the app has two modes')
  assert.equal(everyCombination.length, 10, 'so there are ten combinations, every one of them checked above')

  results.push('five themes crossed with two modes — ten combinations, none skipped')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('table', tableNamesRealTokens)
  step('required fields', requiredFieldsAreMapped)
  step('values', everyValueComesFromItsToken)
  step('composition', theTableAppliedIsTheTheme)
  step('contrast', thePairIsReadable)
  step('theme and brightness', themesDifferAndBrightnessIsHeard)
  step('coverage', coverageIsFiveThemesInBothModes)

  console.log('terminal theme: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('TERMINAL THEME TEST FAILED:', err)
  process.exit(1)
})
