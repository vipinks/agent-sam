import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The stylesheet's own token values, read from `app/styles/globals.css`.
 *
 * This is the only place in the suite that reads the repository, and it exists because the claim worth
 * testing is a comparison: `crimson` at the default brightness has to render exactly what the
 * stylesheet already renders, and the only honest source for "what the stylesheet renders" is the
 * stylesheet. Comparing the document's inline properties against `resolveThemeVars` instead would only
 * ever prove that the engine agrees with itself.
 *
 * Deliberately its own small colour parser rather than the engine's: hex and `rgba()` on this side, HSL
 * in the engine, so an error in either conversion shows up as a mismatch between the two instead of
 * cancelling out.
 */

/** One block's declarations, keyed by custom property name without the leading `--`. */
export type TokenMap = Record<string, string>

/** The stylesheet, read once per call so a test can never assert against a cached older file. */
function stylesheet(): string {
  return readFileSync(resolve(process.cwd(), 'app/styles/globals.css'), 'utf8')
}

/** The `:root` and `.dark` blocks, as the stylesheet writes them. */
export function stylesheetTokens(): { light: TokenMap; dark: TokenMap } {
  const css = stylesheet()
  return { light: block(css, ':root'), dark: block(css, '.dark') }
}

/**
 * The `@theme` block, where Tailwind's colour utilities are pointed at the variables above.
 *
 * Read for one reason: a utility whose `--color-*` entry mentioned a variable no theme sets would paint
 * a component with a value from nowhere, and that is a wiring mistake no amount of contrast arithmetic
 * would catch.
 */
export function themeLayer(): TokenMap {
  return block(stylesheet(), '@theme')
}

/**
 * One declaration block's custom properties.
 *
 * Line-based rather than a real CSS parser on purpose: every property in these blocks is declared one
 * per line, and a parser that understood the whole grammar would be more machinery than the blocks it
 * reads. A line that is not a custom property — a comment, `color-scheme`, a font stack — is skipped,
 * which is how these blocks end up comparable to a token list that is also only custom properties.
 *
 * A missing selector or an unterminated block throws rather than returning an empty map: silence here
 * would turn every comparison in the suite into a comparison against nothing, which is a failing test
 * that reads as passing.
 *
 * The end of a block is found by counting braces rather than by looking for the next `\n}`. The theme
 * blocks sit inside `@layer base`, so their closing braces are indented — and searching for a brace at
 * column zero ran the `:root` block all the way to the layer's own end, swallowing `.dark` and leaving
 * the light map holding the dark values. Depth counting cannot be fooled by indentation.
 */
function block(css: string, selector: string): TokenMap {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`globals.css has no ${selector} block`)

  let depth = 0
  let end = -1
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`globals.css has no end for the ${selector} block`)

  const tokens: TokenMap = {}
  for (const line of css.slice(start, end).split('\n')) {
    const match = /^\s*--([a-z-]+):\s*(.+?);\s*$/.exec(line)
    if (match) tokens[match[1]] = match[2]
  }
  return tokens
}

/** A `#rrggbb` or `rgb()`/`rgba()` colour as channels, for comparing against the engine's HSL. */
export function rgbOf(value: string): { r: number; g: number; b: number; a: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const packed = Number.parseInt(hex[1], 16)
    return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255, a: 1 }
  }

  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim())
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) }
  }

  const hsl = parseHslString(value)
  if (hsl) {
    const rgb = strictRgbOf(hsl)
    return { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b), a: hsl.a ?? 1 }
  }

  throw new Error(`not a colour this suite can read: ${value}`)
}

/**
 * An `hsl()` string as its four parts, parsed here rather than by the engine.
 *
 * The suite's own reading of the same syntax, for the same reason `rgbOf` is its own converter: a
 * claim about a *value* has to come from a second implementation, or it is only the engine agreeing
 * with itself.
 */
export function parseHslString(value: string): { h: number; s: number; l: number; a?: number } | null {
  const match = /^hsl\(\s*([-.\d]+)\s*[,\s]\s*([-.\d]+)%\s*[,\s]\s*([-.\d]+)%\s*(?:[,/]\s*([-.\d]+)\s*)?\)$/i.exec(
    value.trim()
  )
  if (!match) return null
  const parsed = { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) } as {
    h: number
    s: number
    l: number
    a?: number
  }
  if (match[4] !== undefined) parsed.a = Number(match[4])
  return parsed
}

/**
 * HSL to channels with no gamut clamp, so a channel outside 0..255 is visible rather than rounded away.
 *
 * The registry is asserted to stay inside the range at every brightness step, and this is the reading
 * that makes that assertion mean something: `Math.round`-ing a clamped value first would report 0 and
 * 255 for a colour that a browser can only approximate.
 */
export function strictRgbOf(hsl: { h: number; s: number; l: number }): { r: number; g: number; b: number } {
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
