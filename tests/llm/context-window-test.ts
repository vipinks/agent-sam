/**
 * Verifies the rules that measure a request and place it against a model's window — no network, no
 * session, no store.
 *
 * Every rule here has a boundary that is cheap to get wrong and expensive to notice: a division
 * rounded the wrong way, an image charged as its base64 rather than as an image, a window that falls
 * through a partial declaration when it should fall through to the table, a compact point that is one
 * token away from flipping. Asserted at those boundaries rather than at comfortable middles, because
 * the number a card draws next turn is assembled out of exactly these.
 */
import { strict as assert } from 'node:assert'
import {
  checkCompactPoint,
  compactPoint,
  compactRemaining,
  CONTEXT_WINDOWS,
  contextSnapshotSchema,
  contextStatus,
  DEFAULT_COMPACT_PERCENT,
  estimateBreakdown,
  estimateTokens,
  IMAGE_REF_TOKENS,
  MAX_COMPACT_PERCENT,
  MIN_COMPACT_PERCENT,
  readContextSnapshot,
  resolveWindow,
  snapshotRequest,
  type AssembledParts,
} from '../../conveyor/protocol/context-window'

const results: string[] = []

/** The parts one request carries, sized so each category's answer is obvious by hand. */
function parts(overrides: Partial<AssembledParts> = {}): AssembledParts {
  return {
    tools: 'aaaaaaaa', // 8 chars
    systemPrompt: 'abcd', // 4
    projectInstructions: '', // 0
    skills: '123456789012', // 12
    messages: 'abcdefghijklmnop', // 16
    other: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------- the estimate

function theEstimateIsAQuarter() {
  // Absent text is no tokens rather than a token: a category nobody wrote to must not cost anything.
  assert.equal(estimateTokens(''), 0)
  // Four characters are one token, five are two: the division rounds up, so a request is never
  // measured as cheaper than the text it carries.
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('a'), 1)
  assert.equal(estimateTokens('12345678'), 2)
  assert.equal(estimateTokens('x'.repeat(4000)), 1000)

  results.push('the estimate is a quarter of the characters, rounded up')
}

// ---------------------------------------------------------------- the breakdown

function theBreakdownSumsItsCategories() {
  const measured = estimateBreakdown(parts(), 0)

  assert.deepEqual(measured, {
    tools: 2,
    systemPrompt: 1,
    projectInstructions: 0,
    skills: 3,
    messages: 4,
    other: 0,
    used: 10,
  })

  // The total is the categories added up, never a second measurement of the same thing: a `used` that
  // disagreed with the parts it is drawn beside would be the one number a reader could not check.
  for (const refs of [0, 1, 3, 12]) {
    const withImages = estimateBreakdown(parts(), refs)
    const sum =
      withImages.tools +
      withImages.systemPrompt +
      withImages.projectInstructions +
      withImages.skills +
      withImages.messages +
      withImages.other
    assert.equal(withImages.used, sum, `the total is the sum of the categories at ${refs} refs`)
  }

  results.push('the breakdown sums its categories into the used total')
}

function anImageIsAnAllowanceNotItsBytes() {
  // An image is not text, and its transport is a base64 data URL no token count describes. So it is
  // charged a flat allowance, folded into `other` — the category for what the parts do not name.
  const one = estimateBreakdown(parts(), 1)
  assert.equal(one.other, IMAGE_REF_TOKENS)
  assert.equal(one.used, 10 + IMAGE_REF_TOKENS)

  const three = estimateBreakdown(parts(), 3)
  assert.equal(three.other, 3 * IMAGE_REF_TOKENS)
  assert.equal(three.used, 10 + 3 * IMAGE_REF_TOKENS)

  // The allowance is added to whatever `other` already holds rather than replacing it.
  const residual = estimateBreakdown(parts({ other: '12345678' }), 1)
  assert.equal(residual.other, 2 + IMAGE_REF_TOKENS)

  // A count that is not a count is not a ref: a negative or fractional one cannot subtract an
  // allowance, and cannot buy a fractional image either.
  assert.equal(estimateBreakdown(parts(), -3).other, 0)
  assert.equal(estimateBreakdown(parts(), 2.7).other, 2 * IMAGE_REF_TOKENS)
  assert.equal(estimateBreakdown(parts(), Number.NaN).other, 0)

  results.push('an image ref costs its allowance, not its bytes')
}

// ---------------------------------------------------------------- the window

function theWindowFallsThroughToTheTable() {
  const table = CONTEXT_WINDOWS['gpt-4o-mini']
  assert.ok(typeof table === 'number' && table > 0, 'the shipped table prices the models this app offers')
  assert.equal(resolveWindow({ model: 'gpt-4o-mini' }), table)

  // Absent and empty maps are the same fact as no map at all: a provider nobody has declared a window
  // for reads exactly as a record written before the key existed.
  assert.equal(resolveWindow({ model: 'gpt-4o-mini', modelWindows: undefined }), table)
  assert.equal(resolveWindow({ model: 'gpt-4o-mini', modelWindows: {} }), table)
  assert.equal(resolveWindow({ model: 'gpt-4o-mini', modelWindows: null }), table)

  // Nothing known and nothing declared: the window is unknown rather than defaulted, which is what
  // lets a reader say so instead of drawing a share of a number nobody supplied.
  assert.equal(resolveWindow({ model: 'nobody-knows-this' }), null)
  assert.equal(resolveWindow({ model: '' }), null)

  results.push('the window comes from the table when nothing declares one')
}

function aDeclarationWinsForItsOwnModelOnly() {
  const modelWindows = { 'gpt-4o-mini': { contextWindow: 32_000 } }

  assert.equal(resolveWindow({ model: 'gpt-4o-mini', modelWindows }), 32_000)
  assert.notEqual(resolveWindow({ model: 'gpt-4o-mini', modelWindows }), CONTEXT_WINDOWS['gpt-4o-mini'])

  // The model beside it keeps the table's window, which is the whole reason the window belongs to a
  // model rather than to the provider serving it.
  assert.equal(resolveWindow({ model: 'deepseek-chat', modelWindows }), CONTEXT_WINDOWS['deepseek-chat'])

  // A model nothing else knows is declared into existence: this is the case a gateway's own model id
  // needs, since no table this build ships will ever list it.
  assert.equal(
    resolveWindow({ model: 'llama-3.1-8b', modelWindows: { 'llama-3.1-8b': { contextWindow: 131_072 } } }),
    131_072
  )

  results.push('a declared window prices its own model and leaves its siblings on the table')
}

function aPartialEntryIsNotADeclaration() {
  // One entry is one number, and half of one is not a window: an empty declaration, a zero, a
  // negative and a non-number all fall through to the table rather than being read as a window.
  for (const entry of [{}, { contextWindow: undefined }, { contextWindow: 0 }, { contextWindow: -1 }]) {
    assert.equal(
      resolveWindow({ model: 'gpt-4o-mini', modelWindows: { 'gpt-4o-mini': entry } }),
      CONTEXT_WINDOWS['gpt-4o-mini'],
      `a partial declaration falls through to the table: ${JSON.stringify(entry)}`
    )
  }

  // And on a model the table has never heard of, falling through means unknown.
  assert.equal(resolveWindow({ model: 'nobody-knows-this', modelWindows: { 'nobody-knows-this': {} } }), null)

  results.push('a partial window declaration is not a declaration')
}

// ---------------------------------------------------------------- the compact point

function theCompactMathIsAWindowShare() {
  // A whole percent of the window, floored, so the point is a token count a request can actually reach.
  assert.equal(compactPoint(128_000, 70), 89_600)
  assert.equal(compactPoint(200_000, 50), 100_000)
  assert.equal(compactPoint(200_000, 95), 190_000)
  assert.equal(compactPoint(70, 70), 49)

  // What is left before the point: positive below it, zero at it, negative past it. The sign is the
  // whole answer, which is why nothing clamps it at zero.
  assert.equal(compactRemaining(80_000, 128_000, 70), 9_600)
  assert.ok(compactRemaining(80_000, 128_000, 70) > 0, 'below the point there is room left')
  assert.equal(compactRemaining(89_600, 128_000, 70), 0)
  assert.equal(compactRemaining(90_000, 128_000, 70), -400)
  assert.ok(compactRemaining(130_000, 128_000, 70) < 0, 'past the point the remainder is a deficit')

  results.push('the compact math returns a remainder that changes sign at the point')
}

function theStatusFlipsAtBothBoundaries() {
  // Below the point: healthy. At it: past the compact point, which is the moment the setting becomes
  // true rather than a token later.
  assert.equal(contextStatus(89_599, 128_000, 70), 'healthy')
  assert.equal(contextStatus(89_600, 128_000, 70), 'pastCompact')

  // Between the point and the window: still past the point, and not yet over.
  assert.equal(contextStatus(100_000, 128_000, 70), 'pastCompact')
  assert.equal(contextStatus(127_999, 128_000, 70), 'pastCompact')

  // At the window and beyond: over it. The window itself is the boundary, not one token past it.
  assert.equal(contextStatus(128_000, 128_000, 70), 'overWindow')
  assert.equal(contextStatus(130_000, 128_000, 70), 'overWindow')

  // Nothing measured is healthy, not past: a conversation that has sent nothing has nothing to compact.
  assert.equal(contextStatus(0, 128_000, 70), 'healthy')

  results.push('the status flips at exactly the compact point and exactly the window')
}

function theBoundsRefuseOutsideTheRange() {
  assert.equal(MIN_COMPACT_PERCENT, 50)
  assert.equal(MAX_COMPACT_PERCENT, 95)
  assert.equal(DEFAULT_COMPACT_PERCENT, 70)

  // Both bounds are inclusive, and one either side is refused rather than clamped: a value the user
  // typed is either the one they meant or a value they are asked to repair.
  assert.deepEqual(checkCompactPoint('50'), { ok: true, value: 50 })
  assert.deepEqual(checkCompactPoint('95'), { ok: true, value: 95 })
  assert.equal(checkCompactPoint('49').ok, false)
  assert.equal(checkCompactPoint('96').ok, false)

  const below = checkCompactPoint('49')
  const above = checkCompactPoint('96')
  assert.ok(!below.ok && below.reason === 'out-of-range', '49 is out of range rather than unreadable')
  assert.ok(!above.ok && above.reason === 'out-of-range', '96 is out of range as well')

  // Not a count at all: everything that is not whole digits is one repair.
  assert.equal(checkCompactPoint('').ok, false)
  assert.equal(checkCompactPoint('seventy').ok, false)
  assert.equal(checkCompactPoint('75.5').ok, false)
  assert.equal(checkCompactPoint('7e1').ok, false)
  assert.equal(checkCompactPoint('abc').ok, false)
  assert.equal(checkCompactPoint('50').ok, true)
  // Surrounding space is the user's, not the value's.
  assert.deepEqual(checkCompactPoint(' 70 '), { ok: true, value: 70 })

  // The default is inside its own bounds, so a store that starts at it can never start invalid.
  assert.equal(checkCompactPoint(String(DEFAULT_COMPACT_PERCENT)).ok, true)

  results.push('the bounds accept 50 through 95 and refuse what is outside them')
}

// ---------------------------------------------------------------- the snapshot

function theSnapshotIsTheBreakdownPlusWhenItWasTaken() {
  const snapshot = snapshotRequest(parts(), 2, 1_700_000_000_000)

  assert.equal(snapshot.tools, 2)
  assert.equal(snapshot.systemPrompt, 1)
  assert.equal(snapshot.skills, 3)
  assert.equal(snapshot.messages, 4)
  assert.equal(snapshot.other, 2 * IMAGE_REF_TOKENS)
  assert.equal(snapshot.used, 10 + 2 * IMAGE_REF_TOKENS)
  assert.equal(snapshot.at, 1_700_000_000_000, 'a measurement without a moment cannot be read as current')

  assert.equal(contextSnapshotSchema.safeParse(snapshot).success, true, 'what this module builds is a snapshot')

  results.push('a snapshot is the breakdown plus the moment it was taken')
}

function aStoredSnapshotIsReadOrStripped() {
  const snapshot = snapshotRequest(parts(), 0, 1)

  assert.deepEqual(readContextSnapshot({ contextSnapshot: snapshot }), snapshot)
  // Absent, the wrong shape, and half of one: stripped rather than defaulted, so an old record reads
  // as a record rather than as a measurement of nothing.
  assert.equal(readContextSnapshot({}), undefined)
  assert.equal(readContextSnapshot(null), undefined)
  assert.equal(readContextSnapshot('nonsense'), undefined)
  assert.equal(readContextSnapshot({ contextSnapshot: {} }), undefined)
  assert.equal(readContextSnapshot({ contextSnapshot: { ...snapshot, used: -1 } }), undefined)
  assert.equal(readContextSnapshot({ contextSnapshot: { ...snapshot, at: 'now' } }), undefined)

  results.push('a stored snapshot either reads back whole or is stripped')
}

// ---------------------------------------------------------------- main

async function main() {
  theEstimateIsAQuarter()
  theBreakdownSumsItsCategories()
  anImageIsAnAllowanceNotItsBytes()
  theWindowFallsThroughToTheTable()
  aDeclarationWinsForItsOwnModelOnly()
  aPartialEntryIsNotADeclaration()
  theCompactMathIsAWindowShare()
  theStatusFlipsAtBothBoundaries()
  theBoundsRefuseOutsideTheRange()
  theSnapshotIsTheBreakdownPlusWhenItWasTaken()
  aStoredSnapshotIsReadOrStripped()

  console.log(`context window: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CONTEXT WINDOW TEST FAILED:', err)
  process.exit(1)
})
