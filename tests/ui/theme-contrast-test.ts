/**
 * Verifies the contrast control's mechanism: the store slot it writes, the preference it is remembered
 * in, and the values the document is given for it.
 *
 * Contrast is the brightness control's twin, and it is built the same way for the same reason: it is
 * arithmetic in `theme-engine.ts` and nothing else. There is no filter, no stylesheet and no new custom
 * property — a contrast step multiplies how far each surface sits from the page it is drawn on, and the
 * result travels to the document in the values of the properties the document already has. That is what
 * this suite can check without a document: the slot, the record, and the map.
 *
 * The store is loaded after a `localStorage` double is installed, because the store reads storage once,
 * when its module is evaluated. Outside this suite the renderer's own `localStorage` is the file, and a
 * suite that wanted a preference back would have to reload the module to see it; here the file it reads
 * at import time is the double, so a write can be read back at all.
 *
 * The floor is asserted at every step of the control's range, on the same pairs the readability pass
 * guards. A slider a user can drag is a second way to reach a palette, so it is a second way to reach an
 * unreadable one, and the claim that it cannot is worth having as an assertion rather than as an
 * argument.
 *
 * Every claim is reported rather than only the first: the cases are independent, and a red run that
 * named one of five would hide the four behind it.
 */
import { strict as assert } from 'node:assert'
import {
  MIN_CONTRAST,
  PAIR_SURFACES,
  SURFACE_VARIABLES,
  contrastRatio,
  ensureReadable,
  parseHsl,
  resolveThemeVars,
  type ThemeVars,
} from '../../app/components/workbench/theme-engine'
import {
  THEMES,
  THEME_MODES,
  THEME_VARIABLES,
  type ThemeMode,
  type ThemeVariable,
} from '../../app/components/workbench/themes'
import { terminalThemeFor } from '../../app/components/workbench/terminal-theme'

const results: string[] = []
const failures: string[] = []

/** The two ends of the range the contrast control offers — the slider's own minimum and maximum. */
const RANGE_BOTTOM = 0
const RANGE_TOP = 100

/** The contrast values the floor is stated at: both ends of the range and the middle between them. */
const CONTRAST_STEPS = [RANGE_BOTTOM, 25, 50, 75, RANGE_TOP] as const

/** The variable carrying each pair's ink, by the name the readability pass reports the pair under. */
const PAIR_INK: Record<keyof typeof PAIR_SURFACES, ThemeVariable> = {
  foreground: 'foreground',
  'muted-foreground': 'muted-foreground',
  primary: 'primary-foreground',
}

/** The preference the store writes, as this suite reads it. */
const THEME_KEY = 'sam-ai-theme-preference'

/** The state this suite leans on: the theme preference and the two controls that write it. */
interface PreferenceState {
  themeId: string
  brightness: number
  contrast: number
  setBrightness: (brightness: number) => void
  setContrast: (contrast: number) => void
}

/** A `localStorage` in memory, so a preference written by the store can be read back. */
function installStorage(): Map<string, string> {
  const file = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => file.get(key) ?? null,
    setItem: (key: string, value: string) => void file.set(key, value),
    removeItem: (key: string) => void file.delete(key),
    clear: () => file.clear(),
  }
  return file
}

/**
 * The document's variables for a theme, mode, brightness and contrast.
 *
 * Spelled the way `themeVarsFor` in `theme-apply.ts` spells them — `ensureReadable(resolveThemeVars(…))`
 * — rather than imported from it: that module's other half writes to a document and pulls the shell in
 * with it, and what a node suite is about here is the map, not the write. The composition is that
 * function's documented twin rather than a second implementation of it.
 */
function documentVars(themeId: string, mode: ThemeMode, brightness: number, contrast: number): ThemeVars {
  return ensureReadable(resolveThemeVars(themeId, mode, brightness, contrast)).vars
}

/** The stored theme preference, parsed, as a record this suite can assert about key by key. */
function stored(file: Map<string, string>): Record<string, unknown> {
  return JSON.parse(file.get(THEME_KEY) ?? '{}') as Record<string, unknown>
}

/** One claim, reported on its own so a red run names every claim that is red. */
function claim(name: string, check: () => void): void {
  try {
    check()
    results.push(name)
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message.split('\n')[0]}`)
  }
}

// ---------------------------------------------------------------- the slot

function theContrastSlotIsTheThemesOwnContrast(store: { getState: () => PreferenceState }): void {
  const state = store.getState()
  assert.equal(typeof state.contrast, 'number', 'the store carries a contrast slot, beside the brightness one')
  assert.equal(state.contrast, RANGE_BOTTOM, 'a launch starts on the theme’s own contrast')
  assert.equal(typeof state.setContrast, 'function', 'and the slot is written the way brightness is')

  store.getState().setContrast(RANGE_TOP + 40)
  assert.equal(store.getState().contrast, RANGE_TOP, 'a value past the end of the range is held at the end')
  store.getState().setContrast(-1)
  assert.equal(store.getState().contrast, RANGE_BOTTOM, 'and one below it is held at the bottom')
}

function aContrastIsWrittenToThePreference(
  store: { getState: () => PreferenceState },
  file: Map<string, string>
): void {
  // The three halves are written by one writer, so a contrast step cannot drop the theme or the
  // brightness the record already carried.
  store.getState().setBrightness(-6)
  store.getState().setContrast(40)

  assert.equal(store.getState().contrast, 40, 'the slot holds what it was handed')
  assert.deepEqual(
    stored(file),
    { themeId: 'crimson', brightness: -6, contrast: 40 },
    'and the preference records it beside the theme and the brightness it is chosen with'
  )

  store.getState().setContrast(RANGE_TOP + 40)
  assert.deepEqual(
    stored(file),
    { themeId: 'crimson', brightness: -6, contrast: RANGE_TOP },
    'a value held inside the range is the value that is remembered'
  )
}

// ---------------------------------------------------------------- the map

function theDocumentIsGivenTheContrastInPropertiesItAlreadyHas(): void {
  for (const theme of THEMES) {
    for (const mode of THEME_MODES satisfies readonly ThemeMode[]) {
      const where = `${theme.id} ${mode}`
      const own = documentVars(theme.id, mode, 0, RANGE_BOTTOM)

      // The bottom of the range is the identity, stated as a comparison rather than as an argument
      // about a multiplier: a theme with contrast untouched is the theme.
      assert.deepEqual(documentVars(theme.id, mode, 0, RANGE_BOTTOM), own, `${where}: contrast 0 changes nothing`)
      assert.deepEqual(
        ensureReadable(resolveThemeVars(theme.id, mode, 0)).vars,
        own,
        `${where}: a caller that names no contrast gets the bottom of the range`
      )

      const stretched = documentVars(theme.id, mode, 0, RANGE_TOP)
      assert.deepEqual(
        Object.keys(stretched).sort(),
        THEME_VARIABLES.slice().sort(),
        `${where}: no property is added — the contrast travels in the values of the map`
      )

      // The ink is not contrast's business: a step moves the surfaces off the page, and what is drawn
      // on them is held to the floor by the readability pass rather than by the slider.
      for (const pair of Object.keys(PAIR_INK) as (keyof typeof PAIR_INK)[]) {
        assert.equal(
          parseHsl(stretched[PAIR_INK[pair]])?.l,
          parseHsl(own[PAIR_INK[pair]])?.l,
          `${where}: ${pair} keeps the lightness the theme authored`
        )
      }

      const page = parseHsl(own.background)?.l ?? 0
      assert.equal(parseHsl(stretched.background)?.l, page, `${where}: the page is the anchor, so it does not move`)

      for (const name of SURFACE_VARIABLES) {
        if (name === 'background') continue
        const before = (parseHsl(own[name])?.l ?? 0) - page
        const moved = parseHsl(stretched[name])?.l ?? 0
        // Twice its distance from the page, except where the ladder ends first: a surface already at 0 or 100
        // has nowhere further to go, so the value there is the clamp rather than a lost multiplier.
        const doubled = Math.min(100, Math.max(0, page + before * 2))
        assert.ok(
          Math.abs(moved - doubled) < 1e-4,
          `${where}: --${name} should be twice its distance from the page, was ${before} → ${moved - page}`
        )
      }
    }
  }
}

function theFloorHoldsAtEveryStepOfTheRange(): void {
  for (const theme of THEMES) {
    for (const mode of THEME_MODES satisfies readonly ThemeMode[]) {
      for (const contrast of CONTRAST_STEPS) {
        const where = `${theme.id} ${mode} contrast ${contrast}`
        const { vars, moved } = ensureReadable(resolveThemeVars(theme.id, mode, 0, contrast))

        // Nothing needed moving at any step: the multiplier moves the surfaces away from the page, and
        // the page is where the ink sits. A step that forced the pass to rescue a pair would mean the
        // slider could paint a palette the theme did not author.
        assert.deepEqual(moved, [], `${where}: the readability pass had nothing to move`)

        for (const pair of Object.keys(PAIR_SURFACES) as (keyof typeof PAIR_SURFACES)[]) {
          for (const surface of PAIR_SURFACES[pair]) {
            const ratio = contrastRatio(vars[PAIR_INK[pair]], vars[surface])
            assert.ok(
              ratio >= MIN_CONTRAST,
              `${where}: ${pair} on ${surface} measured ${ratio}, under the ${MIN_CONTRAST} floor`
            )
          }
        }
      }
    }
  }
}

function theTerminalFollowsByTheSameRoute(): void {
  for (const theme of THEMES) {
    for (const mode of THEME_MODES satisfies readonly ThemeMode[]) {
      assert.notDeepEqual(
        terminalThemeFor(theme.id, mode, 0, RANGE_TOP),
        terminalThemeFor(theme.id, mode, 0, RANGE_BOTTOM),
        `${theme.id} ${mode}: the terminal is drawn from the same map, so a contrast step reaches it too`
      )
    }
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const file = installStorage()
  const store = (await import('../../app/components/workbench/store')) as unknown as {
    useWorkbenchStore: { getState: () => PreferenceState }
  }

  claim('the contrast slot exists, starts on the theme’s own contrast, and holds a value inside the range', () =>
    theContrastSlotIsTheThemesOwnContrast(store.useWorkbenchStore)
  )
  claim('a contrast is written to the preference beside the theme and the brightness', () =>
    aContrastIsWrittenToThePreference(store.useWorkbenchStore, file)
  )
  claim('the contrast is a multiplier on each surface’s distance from the page, in the map the document is given', () =>
    theDocumentIsGivenTheContrastInPropertiesItAlreadyHas()
  )
  claim('every pair clears the floor at every step of the range, and the pass moves nothing', () =>
    theFloorHoldsAtEveryStepOfTheRange()
  )
  claim('the terminal follows the contrast by the route it follows the brightness', () =>
    theTerminalFollowsByTheSameRoute()
  )

  if (failures.length) {
    console.error(`theme contrast: ${failures.length} failed, ${results.length} passed`)
    for (const failure of failures) console.error(`  fail: ${failure}`)
    process.exit(1)
  }

  console.log(`theme contrast: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('THEME CONTRAST TEST FAILED:', err)
  process.exit(1)
})
