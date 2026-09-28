/**
 * Verifies the strings the Overview's context card is made of — no DOM, no store, no session.
 *
 * The card is the one place where a measurement becomes a sentence, and that is where the failure
 * modes live: a remainder drawn as a negative number, a share of a window nobody knows drawn as a
 * percent, a badge that says a conversation is comfortable when it is past the point its own setting
 * names. Every one of those is cheap to write and expensive to notice in a screenshot, so they are
 * asserted here, at the boundaries, rather than left to the eye that will read the card once.
 *
 * The strings are asserted whole rather than by substring wherever the wording *is* the answer: the
 * past-point sentence has to flip at exactly the compact point, and a test that accepted a fragment
 * would accept the negative it is here to refuse.
 */
import { strict as assert } from 'node:assert'
import {
  CONTEXT_EM_DASH,
  CONTEXT_ESTIMATOR_FOOTNOTE,
  CONTEXT_PILL_CAPTION,
  contextCard,
  type ContextSnapshot,
} from '../../conveyor/protocol/context-window'

const results: string[] = []

/** A window a reader can divide by hand: the compact point at 70% is 70 000 tokens. */
const WINDOW = 100_000
const PERCENT = 70

/**
 * A snapshot whose categories are each a different size, so every row's own string is checkable.
 *
 * The categories add up to `used` by construction, which is the property the card leans on: the rows
 * it draws are the parts beside the total, and a total that disagreed with its parts would be the one
 * number on the card a reader could not add up themselves.
 */
const SNAPSHOT: ContextSnapshot = {
  tools: 10_000,
  systemPrompt: 5_000,
  projectInstructions: 0,
  skills: 2_500,
  messages: 20_000,
  other: 1_500,
  used: 39_000,
  at: 1_700_000_000_000,
}

/**
 * A conversation that has spent a given total, for the two boundaries above the compact point.
 *
 * One category carries the whole total, so the fixture is a partition of `used` for every value the
 * boundary tests pass — including zero, which a fixture that shrank a fixed category would have had to
 * draw as a negative count.
 */
function spent(used: number): ContextSnapshot {
  return {
    tools: 0,
    systemPrompt: 0,
    projectInstructions: 0,
    skills: 0,
    messages: used,
    other: 0,
    used,
    at: SNAPSHOT.at,
  }
}

/** The card for one snapshot, against the window the tests above name. */
function card(snapshot: ContextSnapshot | null, window: number | null = WINDOW) {
  return contextCard({ snapshot, window, compactPercent: PERCENT })
}

// ---------------------------------------------------------------- a measured conversation

function aKnownWindowDrawsTheFigureTheBadgeAndTheRows() {
  const view = card(SNAPSHOT)

  assert.equal(view.state, 'measured')
  assert.equal(view.sentence, null, 'a measured card draws no empty-state sentence')
  assert.equal(view.usedText, '39k', 'the used tokens are drawn compactly, as the tiles draw them')
  assert.equal(view.figure, '39k / 100k', 'the figure is the used-over-window pair')
  assert.equal(view.usedPercentText, '39%', 'the badge is the whole percent of the window')
  assert.equal(view.fillPercent, 39, 'the fill is the share of the bar the badge rides')
  assert.equal(view.tickPercent, 70, 'the tick sits at the configured compact percent')

  // The six parts, in the order a request is assembled from them, each carrying its own two strings.
  assert.deepEqual(
    view.categories.map((row) => [row.key, row.label, row.tokensText, row.percentText]),
    [
      ['tools', 'Tool schemas', '10k', '10%'],
      ['systemPrompt', 'System prompt', '5k', '5%'],
      ['projectInstructions', 'Project instructions', '0', '0%'],
      ['skills', 'Skills', '2.5k', '3%'],
      ['messages', 'Conversation', '20k', '20%'],
      ['other', 'Other and images', '1.5k', '2%'],
    ]
  )

  // The free space is what is left of the window, with the same two readings the rows carry.
  assert.equal(view.freeLabel, 'Free space')
  assert.equal(view.freeText, '61k')
  assert.equal(view.freeCaption, '61% of the window')

  // Below the point: the remainder is counted towards it, not away from it.
  assert.equal(view.remainderLabel, 'To compact point')
  assert.equal(view.remainderText, '31k tokens')

  // The pill and the two sentences that are the same on every card.
  assert.equal(view.pill, 'healthy')
  assert.equal(view.pillLabel, 'Healthy')
  assert.equal(view.pillCaption, CONTEXT_PILL_CAPTION)
  assert.equal(view.footnote, CONTEXT_ESTIMATOR_FOOTNOTE)
  assert.equal(view.pointed, null, 'a window that is known needs no sentence pointing at the model row')

  results.push('a known window draws the figure, the badge, the tick, the rows and the free space')
}

function theRowsAddBackToTheUsedTotal() {
  const view = card(SNAPSHOT)

  const tokens = view.categories.map((row) => Number(row.tokensText.replace(/[^\d.]/g, '')))
  // Read back through the same compaction the card draws with, so the sum is asserted at the strings
  // a reader sees rather than at the numbers behind them: 10 + 5 + 0 + 2.5 + 20 + 1.5 = 39k.
  assert.equal(
    tokens.reduce((total, next) => total + next, 0),
    39,
    'the compact rows add back to the used total, in the unit they are drawn in'
  )

  for (const row of view.categories) {
    assert.match(row.percentText, /^\d+%$/, `${row.key} states a whole percent of the window`)
  }

  // And the badge is the same reading as its parts: the whole percent of the window the used total
  // occupies, which is what makes the rows and the badge one arithmetic rather than two.
  assert.equal(view.usedPercentText, '39%')

  results.push('the category rows carry compact tokens and whole percents that add back to the used total')
}

// ---------------------------------------------------------------- the point itself

function theWordingFlipsAtTheCompactPoint() {
  // One token short of the point: still counting towards it.
  const below = card(spent(69_999))
  assert.equal(below.pill, 'healthy')
  assert.equal(below.remainderLabel, 'To compact point')
  assert.equal(below.remainderText, '1 tokens', 'a single token left is stated as one token left')

  // Exactly at it: the wording flips, and the count is zero rather than a negative.
  const at = card(spent(70_000))
  assert.equal(at.pill, 'pastCompact')
  assert.equal(at.remainderLabel, 'Past compact point')
  assert.equal(at.remainderText, '0 tokens over — consider a new session')

  // Past it: the amount over, stated as an amount.
  const past = card(spent(75_000))
  assert.equal(past.pill, 'pastCompact')
  assert.equal(past.remainderText, '5k tokens over — consider a new session')

  // And no rendering of the remainder is ever a negative number, whichever side of the point it is on.
  for (const used of [0, 1, 69_999, 70_000, 75_000, 100_000, 150_000]) {
    const view = card(spent(used))
    assert.doesNotMatch(view.remainderText, /-\d/, `the remainder for ${used} tokens renders no negative`)
  }

  results.push('the remainder wording flips at exactly the compact point and never renders a negative')
}

function thePillStatesFlipAtTheWindowToo() {
  assert.equal(card(spent(69_999)).pill, 'healthy')
  assert.equal(card(spent(70_000)).pill, 'pastCompact')
  assert.equal(card(spent(99_999)).pill, 'pastCompact')
  // At the window the request has stopped being sendable, which is its own state rather than a worse
  // version of the point: the point is a preference and the window is the model's own limit.
  assert.equal(card(spent(100_000)).pill, 'overWindow')
  assert.equal(card(spent(150_000)).pill, 'overWindow')
  assert.equal(card(spent(150_000)).fillPercent, 100, 'a bar cannot be filled past its own end')
  assert.equal(card(spent(150_000)).usedPercentText, '150%', 'the badge still states the whole truth')

  results.push('the pill flips at the point and again at the window, with the fill clamped to the bar')
}

// ---------------------------------------------------------------- no window to place it against

function anUnknownWindowKeepsTheTokensAndDashesTheRest() {
  const view = card(SNAPSHOT, null)

  // The measurement stands on its own: it happened, and nothing about an unknown window un-happens it.
  assert.equal(view.state, 'measured')
  assert.equal(view.usedText, '39k')

  assert.equal(view.figure, `39k / ${CONTEXT_EM_DASH}`, 'the window side of the figure is a dash')
  assert.equal(view.usedPercentText, CONTEXT_EM_DASH)
  assert.equal(view.tickPercent, null, 'there is no point in a window of nothing to tick')
  assert.equal(view.fillPercent, 0, 'no share of an unknown window can be filled')
  assert.equal(view.pill, 'unknown')
  assert.equal(view.pillLabel, 'Window unknown')
  assert.equal(view.remainderText, CONTEXT_EM_DASH)
  assert.equal(view.freeText, CONTEXT_EM_DASH)
  assert.equal(view.freeCaption, CONTEXT_EM_DASH)
  for (const row of view.categories) {
    assert.equal(row.percentText, CONTEXT_EM_DASH, `${row.key} states no percent of a window nobody declared`)
    assert.notEqual(row.tokensText, CONTEXT_EM_DASH, `${row.key} still states what it costs`)
  }

  // One sentence, and it names the surface the window is declared on rather than leaving the reader to
  // find it: an em dash with no way out of it is a dead end.
  assert.notEqual(view.pointed, null)
  assert.match(view.pointed as string, /Settings/)
  assert.match(view.pointed as string, /window/)

  results.push('an unknown window keeps the used tokens, dashes the shares, and points at the model row')
}

// ---------------------------------------------------------------- nothing measured yet

function nothingMeasuredDrawsOneSentenceAndNoZeros() {
  const view = card(null)

  assert.equal(view.state, 'empty')
  assert.equal(view.pill, null)
  assert.equal(view.tickPercent, null)
  assert.deepEqual(view.categories, [], 'an unmeasured conversation has no parts to draw')
  assert.equal(view.pointed, null)

  // No zeros anywhere: a card full of noughts is the app claiming it measured something that does not
  // exist, which is the same lie the em dashes exist to avoid.
  assert.notEqual(view.sentence, null)
  const sentence = view.sentence as string
  assert.match(sentence, /spend/, 'the empty sentence says what the card is waiting for')
  for (const value of [view.usedText, view.figure, view.usedPercentText, view.remainderText, view.freeText]) {
    assert.equal(value, '', 'an empty card draws no figure at all')
  }
  assert.equal(view.remainderLabel, '')
  assert.equal(view.freeLabel, '')

  results.push('an unmeasured conversation draws one sentence and no zeros')
}

// ---------------------------------------------------------------- main

async function main() {
  aKnownWindowDrawsTheFigureTheBadgeAndTheRows()
  theRowsAddBackToTheUsedTotal()
  theWordingFlipsAtTheCompactPoint()
  thePillStatesFlipAtTheWindowToo()
  anUnknownWindowKeepsTheTokensAndDashesTheRest()
  nothingMeasuredDrawsOneSentenceAndNoZeros()

  console.log(`context card: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CONTEXT CARD TEST FAILED:', err)
  process.exit(1)
})
