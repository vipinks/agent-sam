/**
 * The glyph palette: what a Buddy's mark is chosen from, and what every surface draws from that choice.
 *
 * A `glyph` is an id stored on the record, and the surfaces that draw a Buddy — the settings card, the
 * header's chip and the picker's rows — all resolve it through one registry. That makes the registry the
 * single thing that can go wrong, so this suite holds it closed and consistent:
 *
 * - every option resolves to a component, and the palette is the curated set rather than a list that
 *   quietly grew or shrank;
 * - the twelve ids the app shipped with keep their name and their icon forever, because a stored record
 *   holds the id and nothing else;
 * - every id the three built-ins carry resolves, so the app's own Buddies cannot ship a mark nobody
 *   draws;
 * - an id this build does not know is not a failure: the plate falls back to the record's own monogram,
 *   which is what keeps a record written by another build from drawing an empty badge;
 * - a glyph id fits the record's own bound, and a row carries the description the cards draw.
 *
 * Pure data, no disk and no window — the registry is renderer code, so the icons are the only imports
 * this suite shares with a component.
 */
import { strict as assert } from 'node:assert'
import {
  AlertTriangle,
  BookOpen,
  ChartColumn,
  ChartLine,
  FileText,
  GitBranch,
  GraduationCap,
  KeyRound,
  MessageSquare,
  Pencil,
  PenLine,
  Search,
  Table2,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { BUDDY_GLYPHS, buddyGlyphFor, buddyMonogram } from '../../app/components/workbench/buddy-glyphs'
import {
  BUILTIN_BUDDIES,
  checkBuddy,
  listBuddies,
  MAX_BUDDY_GLYPH_CHARS,
  type BuddyRecord,
} from '../../conveyor/protocol/buddies'

const results: string[] = []

/** How many marks the curated palette holds: the twelve originals plus the twenty added since. */
const PALETTE_SIZE = 32

// ---------------------------------------------------------------- fixtures

/** A custom record that declares everything a record may declare. */
function custom(overrides: Partial<BuddyRecord> = {}): BuddyRecord {
  return {
    id: 'release-captain',
    name: 'Release Captain',
    glyph: 'PenLine',
    description: 'Ships the thing and says what shipped.',
    rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
    skillIds: [],
    mcpIds: [],
    starters: [],
    builtin: false,
    ...overrides,
  }
}

/**
 * The id-to-icon pairs the palette shipped with, written out rather than read back from the registry.
 *
 * A table is the point: reading the expected icon out of the thing under test would assert that the
 * registry agrees with itself. These twelve are what every stored record from those builds carries, so
 * each one's icon is permanent.
 */
const ORIGINAL_MARKS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ['A', AlertTriangle],
  ['B', BookOpen],
  ['C', ChartColumn],
  ['F', FileText],
  ['G', GitBranch],
  ['K', KeyRound],
  ['M', MessageSquare],
  ['P', Pencil],
  ['S', Search],
  ['T', Table2],
  ['W', Wrench],
  ['Z', Zap],
]

/**
 * The id-to-icon pairs the three built-ins were given, by the lucide name each one draws.
 *
 * Written out for the same reason as the table above, and because these three are the app's own data: a
 * built-in whose glyph id stopped resolving would be the app's own Buddy drawing a monogram.
 */
const BUILTIN_MARKS: ReadonlyArray<readonly [string, string, LucideIcon]> = [
  ['writer-editor', 'PenLine', PenLine],
  ['study-tutor', 'GraduationCap', GraduationCap],
  ['analyst', 'ChartLine', ChartLine],
]

/** Whether a value is a React component, as the registry's `Icon` field has to be. */
function isComponent(value: unknown): boolean {
  if (typeof value === 'function') return true
  const candidate = value as { render?: unknown; $$typeof?: unknown } | null
  return candidate !== null && typeof candidate === 'object' && typeof candidate.render === 'function'
}

// ---------------------------------------------------------------- the palette

/** The palette is the curated set: its size, and one id and one label per mark. */
function thePaletteIsTheCuratedSet() {
  assert.equal(
    BUDDY_GLYPHS.length,
    PALETTE_SIZE,
    'the palette holds the twelve originals plus the twenty the wider picker adds'
  )

  const ids = BUDDY_GLYPHS.map((glyph) => glyph.id)
  assert.equal(new Set(ids).size, ids.length, 'every id is unique: an id is what a record stores')

  const labels = BUDDY_GLYPHS.map((glyph) => glyph.label)
  assert.equal(new Set(labels).size, labels.length, 'every label is unique: it is what the button is read by')
  assert.equal(
    labels.every((label) => label.trim().length > 0),
    true,
    'every mark has a name to be read by'
  )

  results.push(`the palette is the curated ${PALETTE_SIZE}, with one unique id and label per mark`)
}

/** Every option is a component: a mark with no icon to draw would be an empty button in the picker. */
function everyOptionResolvesToAnIcon() {
  for (const glyph of BUDDY_GLYPHS) {
    assert.equal(isComponent(glyph.Icon), true, `${glyph.id} draws a component`)
    assert.equal(buddyGlyphFor(glyph.id)?.id, glyph.id, `${glyph.id} resolves to itself`)
  }
  results.push('every picker option resolves to a component, and every id resolves to its own mark')
}

/**
 * The twelve original ids keep their icon.
 *
 * The ids are single letters because the field used to hold the character itself; a record saved then
 * still holds one, so the letter has to keep meaning what it meant.
 */
function theTwelveKeepTheirIdsAndIcons() {
  for (const [id, Icon] of ORIGINAL_MARKS) {
    const glyph = buddyGlyphFor(id)
    assert.notEqual(glyph, null, `${id} is still in the palette`)
    assert.equal(glyph?.Icon, Icon, `${id} still draws the icon it shipped with`)
    assert.equal(glyph?.label, id, `${id} keeps the name it is read by`)
  }
  results.push('the twelve original ids keep their names and their icons')
}

/** The three built-ins carry palette marks, and the marks are the families the entries describe. */
function theBuiltInsCarryPaletteMarks() {
  for (const [buddyId, glyphId, Icon] of BUILTIN_MARKS) {
    const buddy = BUILTIN_BUDDIES.find((entry) => entry.id === buddyId)
    assert.notEqual(buddy, undefined, `${buddyId} is one of the app's own three`)
    assert.equal(buddy?.glyph, glyphId, `${buddyId} carries ${glyphId} in the catalogue`)

    const glyph = buddyGlyphFor(buddy?.glyph)
    assert.notEqual(glyph, null, `${glyphId} resolves for ${buddyId}`)
    assert.equal(glyph?.Icon, Icon, `${buddyId} draws the ${glyphId} mark`)
    assert.equal(buddy?.builtin, true, `${buddyId} stays locked: the mark ships with the entry`)
  }

  // The catalogue itself is unchanged in every other way: three entries, the same ids, still the app's.
  assert.deepEqual(
    BUILTIN_BUDDIES.map((buddy) => buddy.id),
    ['writer-editor', 'study-tutor', 'analyst'],
    'the three built-ins keep their ids and their order'
  )
  assert.deepEqual(
    [...new Set(BUILTIN_BUDDIES.map((buddy) => buddy.builtin))],
    [true],
    'and every one of them is still the app’s own'
  )
  results.push('the three built-ins carry PenLine, GraduationCap and ChartLine, and stay locked')
}

// ---------------------------------------------------------------- the fallback

/**
 * An id this build does not know still draws.
 *
 * Two shapes arrive here: a record from a build whose field held a letter, and a record from a build
 * whose palette had a mark this one dropped. Neither is a failure to report on a row — the plate falls
 * back to the record's own monogram.
 */
function anUnknownIdFallsBackToItsMonogram() {
  // 'R' is what the stored-record fixtures carry and has never been a palette id.
  assert.equal(buddyGlyphFor('R'), null, 'an id the palette never held resolves to no icon')
  assert.equal(buddyMonogram('R'), 'R', 'and draws the letter the record carries')
  assert.equal(buddyGlyphFor(''), null, 'an empty id resolves to no icon')
  assert.equal(buddyMonogram(''), '?', 'and draws a placeholder rather than nothing')
  assert.equal(buddyGlyphFor(null), null, 'an absent id resolves to no icon')
  assert.equal(buddyMonogram(null), '?', 'and draws the same placeholder')

  // The ids the existing suites and stored-record fixtures use, plus every id in the palette: each one
  // has to draw something, whether that is an icon or its own monogram.
  const stored = [...ORIGINAL_MARKS.map(([id]) => id), 'R', 'S', ...BUDDY_GLYPHS.map((glyph) => glyph.id)]
  for (const id of stored) {
    const glyph = buddyGlyphFor(id)
    const mark = glyph === null ? buddyMonogram(id) : glyph.id
    assert.equal(mark.length > 0, true, `${id} still draws a mark`)
  }
  results.push('an unknown id falls back to its monogram, and every id stored records use still draws')
}

// ---------------------------------------------------------------- the row and the bound

/** A row carries the description the card draws under the name. */
function aRowCarriesTheDescription() {
  const mine = custom()
  const rows = listBuddies({ custom: [mine], disabledIds: [] })

  const builtin = rows[0]
  assert.equal(
    builtin.description,
    BUILTIN_BUDDIES[0].description,
    'a built-in row states the description the catalogue holds'
  )

  const row = rows[rows.length - 1]
  assert.equal(row.description, mine.description, 'a custom row states its own description')
  assert.equal(
    typeof row.description,
    'string',
    'the slot is always a string, so a card without a description still reserves it'
  )
  results.push('every row carries its description, so the card can reserve the slot on all of them')
}

/**
 * A glyph id fits the record's own bound.
 *
 * The bound was written for a character or two, and an id is a name: the longest mark the palette ships
 * is what the field has to hold, or the picker would offer a mark the store then refuses.
 */
function aGlyphIdIsStorable() {
  const longest = BUDDY_GLYPHS.reduce(
    (longestId, glyph) => (glyph.id.length > longestId.length ? glyph.id : longestId),
    ''
  )
  assert.equal(
    MAX_BUDDY_GLYPH_CHARS >= longest.length,
    true,
    `the bound holds the longest id the palette offers (${longest})`
  )

  const accepted = checkBuddy(custom({ glyph: 'GraduationCap' }))
  assert.equal(accepted.ok, true, 'a record naming a palette id is accepted')

  const refused = checkBuddy(custom({ glyph: 'x'.repeat(MAX_BUDDY_GLYPH_CHARS + 1) }))
  assert.equal(refused.ok, false, 'a glyph past the bound is refused')
  assert.equal(refused.ok === false && refused.field, 'glyph', 'and names the glyph field')
  results.push(`a palette id is storable, and the bound holds the longest one (${MAX_BUDDY_GLYPH_CHARS} chars)`)
}

// ---------------------------------------------------------------- main

async function main() {
  thePaletteIsTheCuratedSet()
  everyOptionResolvesToAnIcon()
  theTwelveKeepTheirIdsAndIcons()
  theBuiltInsCarryPaletteMarks()
  anUnknownIdFallsBackToItsMonogram()
  aRowCarriesTheDescription()
  aGlyphIdIsStorable()

  console.log(`buddy glyphs: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('BUDDY GLYPHS TEST FAILED:', err)
  process.exit(1)
})
