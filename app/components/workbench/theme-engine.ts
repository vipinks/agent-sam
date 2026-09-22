/**
 * The theme engine: pure math over the registry's token strings.
 *
 * Everything here is a function of its arguments — no DOM, no store, no storage — because the two
 * claims the phase has to make are numeric ones. That a theme's text clears 4.5 against its surface at
 * every brightness step is arithmetic, and arithmetic is checkable without rendering anything; the
 * renderer's only job, in `theme-apply.ts`, is to hand these results to the document.
 *
 * The values are HSL strings all the way through, which is what makes a brightness adjustment a single
 * addition: raising or lowering `L` moves a colour up or down the same ladder the palette was authored
 * on, and leaves hue and saturation — the theme's identity — exactly where the registry put them. Hex
 * would have to be converted to HSL and back on every step, and every round trip is a place for a
 * colour to come back one step off.
 *
 * One thing here is less obvious than it looks: a colour whose channels leave 0..255 is not one a screen
 * can paint, and a browser clamps it — so `hslToRgb` clamps too, rather than letting a channel of 260
 * produce a luminance nothing will ever show. Keeping the registry inside the gamut is the suite's job;
 * rendering out-of-range values the way a browser would is this file's.
 *
 * `ensureReadable` is the floor stated as code rather than as a hope: a pair that cannot be read is
 * moved until it can be, and the caller is told which pairs moved. At the default brightness it moves
 * nothing for the default theme, which is what keeps the default experience identical to the
 * stylesheet's own values.
 */

import { DEFAULT_THEME_ID, THEME_VARIABLES, type ThemeMode, type ThemeVariable, themeById } from './themes'

/** A resolved variable map: every custom property `globals.css` declares, as the value to set. */
export type ThemeVars = Record<ThemeVariable, string>

/** Brightness is a lightness delta in percentage points, bounded so a theme cannot be pushed past reading. */
export const BRIGHTNESS_MIN = -20
export const BRIGHTNESS_MAX = 20
export const BRIGHTNESS_DEFAULT = 0

/** The WCAG AA floor for body text, and the number every pair in the contrast suite is held to. */
export const MIN_CONTRAST = 4.5

/**
 * The variables brightness moves: the surfaces a theme is *made of*, plus the borders drawn on them.
 *
 * Foregrounds are deliberately absent. A brightness step is about how bright the page is, and the ink
 * on it is what has to stay readable on the result — moving both ends together would move the whole
 * pair and change nothing about the contrast between them. The semantic accents (brand, destructive,
 * success, the syntax hues) are absent for a different reason: their jobs are fixed by meaning, so a
 * brighter page must not quietly turn "deleted" into a different red.
 */
export const SURFACE_VARIABLES = [
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
] as const satisfies readonly ThemeVariable[]

/**
 * The surfaces text actually sits on, for the readability check.
 *
 * Not just `background`: a muted line sits on `--muted` and a card's text on `--card`, and at the ends
 * of the brightness range those can sit on very different luminances. Checking every one of them is
 * strictly stronger than checking the page background alone, which is the pair a rendered page would
 * otherwise hide its worst case behind.
 */
export const TEXT_SURFACES = ['background', 'card', 'popover', 'muted', 'accent', 'secondary'] as const

/** A pair `ensureReadable` can be asked to move, named for what the user sees rather than for a slot. */
export type ReadablePair = 'foreground' | 'muted-foreground' | 'primary'

/**
 * Which surfaces each guarded pair is drawn on.
 *
 * Exported because this is the pass's definition rather than its implementation: the suite checks the
 * same list the engine enforces, so "every surface it can be drawn on" cannot quietly mean the page
 * background in one place and the whole ladder in the other.
 *
 * Both foregrounds are held against every surface in the ladder. The primary pair is not: it is a
 * filled button's label on the button itself, which a theme may colour however it likes, so its one
 * surface is the one it is drawn on.
 */
export const PAIR_SURFACES: Record<ReadablePair, readonly ThemeVariable[]> = {
  foreground: TEXT_SURFACES,
  'muted-foreground': TEXT_SURFACES,
  primary: ['primary'],
}

/** The result of the readability pass: the variables, and the pairs whose value it had to change. */
export interface ReadableResult {
  vars: ThemeVars
  moved: ReadablePair[]
}

/** Parsed HSL, with alpha only where the source carried it. */
export interface Hsl {
  h: number
  s: number
  l: number
  a?: number
}

/** Red, green and blue, 0..255 for anything a screen can paint. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * `hsl(H S% L%)`, `hsl(H S% L% / A)`, and the comma form some tools emit.
 *
 * Whitespace and commas are both accepted because both spellings are in the wild and a parser that
 * refused one of them would fail on a value that is perfectly valid CSS. Alpha is left `undefined`
 * when it is absent, so a round trip through `formatHsl` cannot invent an opacity that was not there.
 */
export function parseHsl(value: string): Hsl | null {
  const match = /^hsl\(\s*([-.\d]+)\s*[,\s]\s*([-.\d]+)%\s*[,\s]\s*([-.\d]+)%\s*(?:[,/]\s*([-.\d]+)\s*)?\)$/i.exec(
    value.trim()
  )
  if (!match) return null
  const [, h, s, l, a] = match
  const parsed: Hsl = { h: Number(h), s: Number(s), l: Number(l) }
  if (a !== undefined) parsed.a = Number(a)
  return parsed
}

/**
 * A number as a string, short enough not to carry float noise and long enough to keep every digit a
 * colour needs.
 *
 * Pure arithmetic is not tidy: 61.373 plus 20 is 81.37299999999999, and a token written that way is
 * valid CSS but is no longer the value anyone authored — it would also make a comparison against a
 * hand-written expectation fail for a reason that has nothing to do with colour. Five decimals is past
 * what any palette carries and past what a display resolves, so it rounds the noise away and leaves
 * real values untouched.
 */
function number(value: number): number {
  return Number(value.toFixed(5))
}

/** A parsed colour back to a string, in the spelling the registry (and CSS) uses. */
export function formatHsl(hsl: Hsl): string {
  const base = `hsl(${number(hsl.h)} ${number(hsl.s)}% ${number(hsl.l)}%`
  return hsl.a === undefined ? `${base})` : `${base} / ${number(hsl.a)})`
}

/** A channel inside 0..255, which is where a display can put it. */
function clamp(channel: number): number {
  return Math.min(255, Math.max(0, channel))
}

/**
 * A brightness value as the store may have stored it: any number inside the range, and the default for
 * anything else — a missing key, a string, a `NaN` from an older record.
 */
export function clampBrightness(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BRIGHTNESS_DEFAULT
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, value))
}

/**
 * The same colour, `deltaPoints` further up or down the lightness ladder, clamped to 0..100.
 *
 * A delta of zero returns the input unchanged, and so does a value the engine cannot read: the one
 * thing worse than an unreadable token is a plausible one rewritten around it. The identity at zero is
 * what makes the default experience the stylesheet's own values rather than a re-spelling of them.
 */
export function adjustLightness(value: string, deltaPoints: number): string {
  const hsl = parseHsl(value)
  if (!hsl || !Number.isFinite(deltaPoints) || deltaPoints === 0) return value
  return formatHsl({ ...hsl, l: Math.min(100, Math.max(0, hsl.l + deltaPoints)) })
}

/** The channels of an HSL colour, clamped into the gamut a screen can paint — what a browser shows. */
export function hslToRgb(value: string): Rgb | null {
  const strict = hslToRgbStrict(value)
  if (!strict) return null
  return { r: Math.round(clamp(strict.r)), g: Math.round(clamp(strict.g)), b: Math.round(clamp(strict.b)) }
}

/**
 * The same conversion with the clamp left off: a channel can come back above 255 or below 0.
 *
 * Internal, and the reason `hslToRgb` can be one line: a component above 255 or below 0 is a value no
 * screen can paint, and this is where that becomes visible rather than being rounded into something
 * that looks fine. The registry is authored to stay inside the gamut (the suite asserts it), so for a
 * healthy theme the clamp removes nothing — it is here so that a theme which drifts out of range
 * renders as the browser would render it instead of as a number the engine invented.
 */
function hslToRgbStrict(value: string): Rgb | null {
  const hsl = parseHsl(value)
  if (!hsl) return null
  const s = hsl.s / 100
  const l = hsl.l / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const sector = hsl.h / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const m = l - chroma / 2
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/** One channel's linear value, as WCAG defines it. */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an RGB triple. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
}

/**
 * A colour's luminance, or null when it is not a colour the engine can read at all.
 *
 * The clamped conversion, deliberately: the ratio a theme is judged by is the ratio a person sees, and
 * what a browser paints is the clamped colour. Asserting somewhere else that nothing in the registry
 * leaves the gamut is what keeps this reading and the palette's intent the same number.
 */
function luminanceForCheck(value: string): number | null {
  const rgb = hslToRgb(value)
  return rgb ? relativeLuminance(rgb) : null
}

/**
 * The contrast ratio between two colours, from 1 (identical) to 21 (black on white).
 *
 * A pair the engine cannot read scores 1, the bottom of the scale, rather than being skipped or treated
 * as black. That is the fail-closed direction: an unreadable token makes a contrast claim fail, and a
 * token that has been deleted or mistyped shows up as a failing pair instead of as a pair nobody
 * measured.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminanceForCheck(foreground)
  const b = luminanceForCheck(background)
  if (a === null || b === null) return 1
  const [light, dark] = a >= b ? [a, b] : [b, a]
  return number((light + 0.05) / (dark + 0.05))
}

/**
 * A theme's variables for one mode at one brightness: the registry's map, with the surface family
 * shifted by the delta and everything else left exactly as authored.
 *
 * An id the registry does not know resolves to the default theme rather than throwing, and a variable
 * the chosen theme does not set is filled from that same default theme. The first is what the persisted
 * settings rely on: a record written before themes existed, or one naming a theme that has since been
 * removed, has to open the app rather than break it. The second is the same promise one level down — a
 * hole in a theme would otherwise leave a custom property unset and one corner of the window inheriting
 * whichever palette the stylesheet happened to declare.
 */
export function resolveThemeVars(themeId: string, mode: ThemeMode, brightness: number): ThemeVars {
  const theme = themeById(themeId)
  const fallback = themeById(DEFAULT_THEME_ID)
  const pick = (name: ThemeVariable): string => theme.tokens[mode][name] ?? fallback.tokens[mode][name]

  const delta = clampBrightness(brightness)
  const shifted = new Set<string>(SURFACE_VARIABLES)
  const vars = {} as ThemeVars
  for (const name of THEME_VARIABLES) {
    vars[name] = shifted.has(name) ? adjustLightness(pick(name), delta) : pick(name)
  }
  return vars
}

/** Whether a foreground clears the floor on every surface it is drawn on. */
function clearsFloor(foreground: string, surfaces: readonly ThemeVariable[], vars: ThemeVars): boolean {
  return surfaces.every((surface) => contrastRatio(foreground, vars[surface]) >= MIN_CONTRAST)
}

/**
 * Move one foreground until it clears the floor against every surface it is drawn on, or the lightness
 * bounds stop it. Returns the value to use and whether it differs from the one passed in.
 *
 * The direction is read from the pair itself: the ink is moved *away* from the surfaces it sits on, so
 * a dark foreground on a light page is darkened and a light one on a dark page is lightened. Deciding it
 * per pair rather than per theme is what makes the primary pair work — a filled button's label is light
 * on a dark fill in light mode and dark on a light fill in dark mode, which is the opposite of the page
 * around it. Comparing lightnesses rather than luminances keeps the decision away from the gamut
 * boundary, where two adjacent surfaces can straddle a threshold and pick the direction that reduces
 * contrast instead of increasing it.
 *
 * The step is half a point: small enough that the result still reads as the palette's own colour, large
 * enough that the loop cannot run long. The bound is what "or the bounds stop it" means — the walk ends
 * at 0 or 100, the value is the last one reached, and the caller is told the pair moved. A theme whose
 * ink cannot reach the floor is therefore reported as a moved pair that still fails, never as a silent
 * pass; the contrast suite is what turns that report into a failure.
 */
function shiftToReadable(
  vars: ThemeVars,
  foregroundVar: ThemeVariable,
  surfaces: readonly ThemeVariable[]
): { value: string; moved: boolean } {
  const origin = vars[foregroundVar]
  if (clearsFloor(origin, surfaces, vars)) return { value: origin, moved: false }

  const hsl = parseHsl(origin)
  if (!hsl) return { value: origin, moved: false }

  const direction = hsl.l <= surfaceLightness(vars, surfaces) ? -0.5 : 0.5
  let l = hsl.l
  let value = origin
  while (l > 0 && l < 100) {
    l = Math.min(100, Math.max(0, l + direction))
    value = formatHsl({ ...hsl, l })
    if (clearsFloor(value, surfaces, vars)) break
  }
  return { value, moved: value !== origin }
}

/** The mean lightness of the surfaces a pair is drawn on, which is the line its ink has to move away from. */
function surfaceLightness(vars: ThemeVars, surfaces: readonly ThemeVariable[]): number {
  const total = surfaces.reduce((sum, surface) => sum + (parseHsl(vars[surface])?.l ?? 0), 0)
  return total / surfaces.length
}

/** Which variable carries each pair's ink, by the name the pass reports it under. */
const PAIR_FOREGROUNDS: { key: ReadablePair; variable: ThemeVariable }[] = [
  { key: 'foreground', variable: 'foreground' },
  { key: 'muted-foreground', variable: 'muted-foreground' },
  { key: 'primary', variable: 'primary-foreground' },
]

/**
 * The readability pass: every pair that has to be legible is measured, and any that is not is moved.
 *
 * Pure with respect to its argument — the returned map is a new object — so a caller can compare what
 * it sent with what came back, and the suite can assert on both the result and the report.
 */
export function ensureReadable(vars: ThemeVars): ReadableResult {
  const next: ThemeVars = { ...vars }
  const moved: ReadablePair[] = []

  for (const { key, variable } of PAIR_FOREGROUNDS) {
    const shifted = shiftToReadable(next, variable, PAIR_SURFACES[key])
    next[variable] = shifted.value
    if (shifted.moved) moved.push(key)
  }

  return { vars: next, moved }
}
