/**
 * The explorer's file-icon rules, and the assets they name.
 *
 * Two claims are proved here. The first is the mapping itself: which exact names, dotfile prefixes,
 * compound suffixes and last extensions win, in that order, and that an unknown name stays unknown
 * rather than being dressed up as known. The second is the vendored set: one svg per key, every
 * shipped base fill clearing the 2:1 floor against both page and card surfaces in both modes, and the
 * eighteen declared recolours being the only fills changed from upstream.
 *
 * The fills are read from the assets rather than from a table, and the surfaces from `globals.css`
 * rather than from constants, so a palette edit or a stray asset fails here instead of only on screen.
 * The mapping module imports nothing, which is what lets this suite run under plain node.
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FILE_ICON_KEYS,
  FOLDER_ICON_KEYS,
  ICON_KEYS,
  fileIconKey,
  folderIconKey,
} from '../../conveyor/protocol/file-icons'

const ICON_DIR = join(process.cwd(), 'app', 'assets', 'file-icons')
const THEME_CSS = join(process.cwd(), 'app', 'styles', 'globals.css')

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
  results.push(label)
}

// ------------------------------------------------------------------ contrast

type Rgb = readonly [number, number, number]

/** A colour as `globals.css` writes it: a hex triple, or an `hsl()` with space- or comma-separated parts. */
function parseColour(value: string): Rgb {
  const text = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1]
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ]
  }

  const hsl = /^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i.exec(text)
  if (hsl) {
    const hue = Number(hsl[1]) % 360
    const saturation = Number(hsl[2]) / 100
    const lightness = Number(hsl[3]) / 100
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
    const sector = ((hue + 360) % 360) / 60
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
    const floor = lightness - chroma / 2
    return [(r + floor) * 255, (g + floor) * 255, (b + floor) * 255]
  }

  throw new Error(`unparseable colour in globals.css: ${value}`)
}

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function luminance(colour: Rgb): number {
  return 0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2])
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/** One declaration block from the theme file, from its selector to the closing brace at its own indent. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `${selector} is missing from globals.css`)
  const end = css.indexOf('\n  }', start)
  assert.ok(end > start, `${selector}'s block in globals.css is unterminated`)
  return css.slice(start, end)
}

function variable(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(source)
  assert.ok(match, `${name} is missing from globals.css`)
  return match[1]
}

interface Surface {
  label: string
  colour: Rgb
}

/** The four surfaces a row can be drawn on, read from the tokens the theme declares. */
function surfaces(): Surface[] {
  const css = readFileSync(THEME_CSS, 'utf8')
  const light = block(css, ':root')
  const dark = block(css, '.dark')
  return [
    { label: 'light page', colour: parseColour(variable(light, '--background')) },
    { label: 'light card', colour: parseColour(variable(light, '--card')) },
    { label: 'dark page', colour: parseColour(variable(dark, '--background')) },
    { label: 'dark card', colour: parseColour(variable(dark, '--card')) },
  ]
}

// ------------------------------------------------------------------ the mapping

/** The names the contract pins directly, and the key each one asks for. */
const FILE_CASES: Array<[name: string, expected: string | null]> = [
  // Exact names win over both the compound-suffix and last-extension stages.
  ['package-lock.json', 'lock'],
  ['PACKAGE-LOCK.JSON', 'lock'],
  ['docker-compose.yml', 'docker'],
  ['tailwind.config.ts', 'tailwindcss'],
  ['postcss.config.ts', 'tailwindcss'],
  ['vite.config.ts', 'vite'],
  ['electron.vite.config.ts', 'vite'],
  ['tsconfig.json', 'tsconfig'],
  ['tsconfig.node.json', 'tsconfig'],
  // README* is a name shape, so every spelling of it resolves.
  ['README.md', 'readme'],
  ['README', 'readme'],
  ['readme.markdown', 'readme'],
  // A known dotfile prefix beats the last extension: `.local` asks for nothing on its own.
  ['.env', 'settings'],
  ['.env.local', 'settings'],
  // A compound suffix beats the last extension's own answer.
  ['notes.d.ts', 'typescript'],
  ['component.test.ts', 'typescript'],
  // Then the last extension, then nothing.
  ['notes.ts', 'typescript'],
  ['app.tsx', 'react'],
  ['styles.css', 'css'],
  ['asset.svg', 'svg'],
  ['weird.zzz', null],
  ['notes.txt', null],
]

const FOLDER_CASES: Array<[name: string, expected: string | null]> = [
  ['src', 'folder-src'],
  ['SRC', 'folder-src'],
  ['lib', 'folder-lib'],
  ['components', 'folder-components'],
  ['resources', 'folder-resource'],
  ['api', 'folder-api'],
  ['db', 'folder-database'],
  ['dist', 'folder-dist'],
  // The two other names a build output carries.
  ['build', 'folder-dist'],
  ['out', 'folder-dist'],
  ['.github', 'folder-github'],
  // No icon is assigned to a vendor folder, and none is invented for a name nobody mapped.
  ['vendor', null],
  ['mystery', null],
  ['', null],
]

/**
 * The eighteen fills the contract declares as recolours: the base fill upstream ships, and the one
 * this app ships instead. Every other key keeps its upstream fill untouched.
 */
const RECOLOURED: Record<string, { original: string; shipped: string }> = {
  js: { original: '#ffca28', shipped: '#ff8f00' },
  mdx: { original: '#ffca28', shipped: '#ff8f00' },
  database: { original: '#ffca28', shipped: '#ff8f00' },
  'folder-database': { original: '#ffca28', shipped: '#ff8f00' },
  json: { original: '#f9a825', shipped: '#f57f17' },
  lock: { original: '#ffd54f', shipped: '#ff8f00' },
  favicon: { original: '#ffd54f', shipped: '#ff8f00' },
  svg: { original: '#ffb300', shipped: '#ff8f00' },
  toml: { original: '#cfd8dc', shipped: '#78909c' },
  editorconfig: { original: '#ede7f6', shipped: '#78909c' },
  nodejs: { original: '#8bc34a', shipped: '#689f38' },
  table: { original: '#8bc34a', shipped: '#689f38' },
  xml: { original: '#8bc34a', shipped: '#689f38' },
  changelog: { original: '#8bc34a', shipped: '#689f38' },
  'folder-lib': { original: '#c0ca33', shipped: '#9e9d24' },
  'folder-components': { original: '#c0ca33', shipped: '#9e9d24' },
  'folder-resource': { original: '#fbc02d', shipped: '#f57f17' },
  'folder-api': { original: '#fbc02d', shipped: '#f57f17' },
}

/** The base fill of a vendored icon: the first fill it declares, which is the body the glyph reads as. */
function baseFill(svg: string): string {
  const match = /fill="(#[0-9a-fA-F]{3,8})"/.exec(svg)
  assert.ok(match, 'an icon declares no hex fill')
  return match[1]
}

function iconText(key: string): string {
  return readFileSync(join(ICON_DIR, `${key}.svg`), 'utf8')
}

// ------------------------------------------------------------------ the claims

function theFileRules() {
  for (const [name, expected] of FILE_CASES) {
    assert.equal(fileIconKey(name), expected, `${name} should resolve to ${String(expected)}`)
  }
  results.push('file names resolve by exact name, dotfile prefix, compound suffix, then extension')
}

function theFolderRules() {
  for (const [name, expected] of FOLDER_CASES) {
    assert.equal(folderIconKey(name), expected, `${name} should resolve to ${String(expected)}`)
  }
  results.push('folder names resolve case-insensitively; vendor and unknown folders stay default')
}

function theVendoredSet() {
  assert.equal(FILE_ICON_KEYS.length, 51, 'the file icon list changed size')
  assert.equal(FOLDER_ICON_KEYS.length, 20, 'the folder icon list changed size')
  assert.equal(ICON_KEYS.length, 71, 'the universe is not 71 keys')
  assert.equal(new Set(ICON_KEYS).size, ICON_KEYS.length, 'a key is listed twice')

  const files = readdirSync(ICON_DIR)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.slice(0, -'.svg'.length))
    .sort()
  assert.deepEqual(files, [...ICON_KEYS].sort(), 'the asset folder and the key list disagree')
  results.push('one svg per key and no asset without a key')
}

function theRecolours() {
  const keys = Object.keys(RECOLOURED)
  assert.equal(keys.length, 18, 'the recolour record is not eighteen keys')
  for (const key of keys) {
    assert.ok((ICON_KEYS as readonly string[]).includes(key), `${key} is not in the universe`)
    const svg = iconText(key)
    const { original, shipped } = RECOLOURED[key]
    assert.equal(baseFill(svg), shipped, `${key} should ship ${shipped}`)
    assert.ok(!svg.includes(original), `${key} still carries its upstream ${original}`)
  }
  results.push('exactly eighteen base fills are recoloured, and each ships its declared value')
}

function theContrastFloor() {
  const surfacesToCheck = surfaces()
  for (const key of ICON_KEYS) {
    const fill = baseFill(iconText(key))
    for (const surface of surfacesToCheck) {
      const ratio = contrast(parseColour(fill), surface.colour)
      assert.ok(
        ratio >= 2,
        `${key}'s ${fill} is ${ratio.toFixed(2)}:1 on the ${surface.label}, below the 2:1 floor`
      )
    }
  }
  results.push('every shipped base fill clears 2:1 on page and card, in both modes')
}

async function main() {
  step('file name rules', theFileRules)
  step('folder name rules', theFolderRules)
  step('vendored set', theVendoredSet)
  step('declared recolours', theRecolours)
  step('contrast floor', theContrastFloor)

  console.log(`file icon rules: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

void main().catch((error) => {
  console.error('FILE ICON RULES TEST FAILED:', error)
  process.exit(1)
})
