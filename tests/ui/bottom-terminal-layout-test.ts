/**
 * The bottom terminal panel's place in the layout record: its open flag, its height per window state,
 * and the vertical group those two are declared into.
 *
 * Pure by construction, for the reason the other rule suites are — this is arithmetic and a reading of
 * a stored record, so it has to be provable without a window, a bridge or a rendered tree. The DOM
 * suite then asserts only what a rendered workbench can: that the group receives these numbers and that
 * a drag of its separator comes back here.
 *
 * Three of the four rules are about a record that is *not* the one this version writes. The keys are
 * additive in the record `sam-ai-layout-preferences` already holds, so every launch — including every
 * launch after an upgrade — is a read of a record that may have neither key in it: absent means the
 * closed panel at the default height, and a height that is present but out of range is a number some
 * earlier version, or a hand edit, left behind. The clamp is what keeps a two-percent panel from being
 * restored as a two-pixel one.
 */
import { strict as assert } from 'node:assert'
import {
  DEFAULT_BOTTOM_HEIGHT,
  MAX_BOTTOM_HEIGHT,
  MIN_BOTTOM_HEIGHT,
  bottomHeightKey,
  bottomPanelHeightFor,
  bottomPanelOpenFrom,
  chatGroupLayout,
  defaultLayoutForState,
  mergeSavedBottomHeight,
  mergeSavedLayout,
  type LayoutSizes,
  type StoredLayoutSets,
} from '../../app/components/workbench/layout'
import { bottomHeightChangeFor } from '../../app/components/workbench/layout-memory'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ------------------------------------------------------- the keys, and what absent means

function oneStoredKeyPerWindowState() {
  // Named by the state rather than spelled at the call site, for the reason `layoutSetKey` is: the
  // write and the read are in different files, and a key spelled at one of them and misspelled at the
  // other is a height that silently never applies.
  assert.equal(bottomHeightKey('windowed'), 'bottomPanelHeightWindowed')
  assert.equal(bottomHeightKey('maximized'), 'bottomPanelHeightMaximized')

  results.push('each window state names its own stored height key')
}

function aRecordWithoutThePanelOpensClosed() {
  assert.equal(bottomPanelOpenFrom(undefined), false, 'absent means closed')
  assert.equal(bottomPanelOpenFrom(false), false)
  assert.equal(bottomPanelOpenFrom(true), true)

  // And nothing else opens it. The flag is a `true` that was left behind or it is the closed panel
  // every other value describes — which is the state a first launch opens in, so the reader has to be
  // strict rather than truthy: `"yes"` and `1` are record corruption, not a decision to show a panel.
  for (const unusable of ['yes', 1, 0, null, {}, []]) {
    assert.equal(bottomPanelOpenFrom(unusable), false, `${JSON.stringify(unusable)} must not open the panel`)
  }

  results.push('the open flag is a stored true, and absent means closed')
}

function aRecordWithoutAHeightOpensAtTheDefault() {
  assert.equal(bottomPanelHeightFor('windowed', {}), DEFAULT_BOTTOM_HEIGHT)
  assert.equal(bottomPanelHeightFor('maximized', {}), DEFAULT_BOTTOM_HEIGHT)
}

function aPersistedHeightIsClampedIntoTheRangeAPanelCanBeReadIn() {
  // Out of range, in both directions and at both ends of the range: a panel restored at two percent is
  // a strip of nothing, and one restored at ninety-eight leaves the conversation a title bar.
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: 1 }), MIN_BOTTOM_HEIGHT)
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: 0 }), MIN_BOTTOM_HEIGHT)
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: 99 }), MAX_BOTTOM_HEIGHT)
  assert.equal(bottomPanelHeightFor('maximized', { bottomPanelHeightMaximized: 250 }), MAX_BOTTOM_HEIGHT)

  // In range is left exactly as it was stored: clamping is a repair, not a rounding.
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: 42.5 }), 42.5)
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: MIN_BOTTOM_HEIGHT }), MIN_BOTTOM_HEIGHT)
  assert.equal(bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: MAX_BOTTOM_HEIGHT }), MAX_BOTTOM_HEIGHT)

  results.push('a persisted height is clamped into the panel’s range')
}

function aHeightThatIsNotANumberIsTheDefaultRatherThanARangeEnd() {
  // The distinction the clamp makes: a number outside the range is a *height* this panel cannot be
  // read in, and a value that is not a number at all is not a height — so it falls back the way an
  // absent key does rather than being pulled to the nearest boundary.
  for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, '35', null, {}, []] as unknown[]) {
    assert.equal(
      bottomPanelHeightFor('windowed', { bottomPanelHeightWindowed: unusable } as StoredLayoutSets),
      DEFAULT_BOTTOM_HEIGHT,
      `${JSON.stringify(unusable)} is not a height`
    )
  }

  results.push('a value that is not a number falls back to the default, like an absent key')
}

function theHeightIsPerStateAndNotAcrossStates() {
  // The whole point of two keys: a height dragged in a windowed window says nothing about the
  // maximized one, and the state that was never dragged opens at the default.
  const saved: StoredLayoutSets = { bottomPanelHeightWindowed: 60 }

  assert.equal(bottomPanelHeightFor('windowed', saved), 60)
  assert.equal(bottomPanelHeightFor('maximized', saved), DEFAULT_BOTTOM_HEIGHT)

  results.push('a stored height belongs to the window state it was dragged in')
}

// ------------------------------------------------------- the vertical group under the chat

function theVerticalGroupFillsItsColumnExactly() {
  // The same rule the other two groups keep: the library normalises a layout to 100, so a pair that
  // does not add up is a record of some other shape. The conversation takes the remainder, which is
  // what makes the two numbers one declaration rather than two.
  assert.deepEqual(chatGroupLayout(DEFAULT_BOTTOM_HEIGHT), {
    conversation: 100 - DEFAULT_BOTTOM_HEIGHT,
    terminal: DEFAULT_BOTTOM_HEIGHT,
  })

  for (const height of [MIN_BOTTOM_HEIGHT, 40, 62.5, MAX_BOTTOM_HEIGHT]) {
    const layout = chatGroupLayout(height)
    assert.equal(layout.conversation + layout.terminal, 100, `a ${height} percent panel fills its group`)
    assert.ok(layout.terminal < 100 && layout.conversation > 0)
  }

  results.push('the vertical group’s declaration fills its column exactly')
}

// ------------------------------------------------------- a drag of the panel's separator

function aDragBecomesTheActiveStateHeight() {
  const change = bottomHeightChangeFor({
    active: 'windowed',
    layout: { conversation: 62, terminal: 38 },
  })

  assert.deepEqual(change, { state: 'windowed', height: 38 })

  // The state that is in force when the drag ends is the one it belongs to, which is why the caller
  // hands it in rather than this reading it off anything.
  assert.deepEqual(bottomHeightChangeFor({ active: 'maximized', layout: { conversation: 55, terminal: 45 } }), {
    state: 'maximized',
    height: 45,
  })

  results.push('a drag of the separator becomes the active state’s height')
}

function aDragThatIsNotALayoutWritesNothing() {
  // The library hands back panel id to share, so a report that does not name the panel — or names a
  // share that is not a positive number below a hundred — describes no panel that could be restored.
  // Writing it would replace a good height with one that resolves to a default.
  for (const layout of [
    { conversation: 100 },
    { conversation: 100, terminal: 0 },
    { conversation: -10, terminal: 110 },
    { conversation: Number.NaN, terminal: Number.NaN },
    { conversation: 65, terminal: '35' },
  ] as Array<Record<string, unknown>>) {
    assert.equal(
      bottomHeightChangeFor({ active: 'windowed', layout: layout as Record<string, number> }),
      null,
      `${JSON.stringify(layout)} is not a layout`
    )
  }

  results.push('a report that describes no panel writes nothing')
}

function aDragOutsideTheRangeIsStoredAtTheBoundary() {
  // Clamped rather than refused, and by the same judge the read path uses: the panel's own pixel
  // minimum keeps a real drag inside the range, so a number out here is a report from a group that was
  // measured before it had a height — and the honest repair is the range's end, not a discarded drag.
  assert.deepEqual(bottomHeightChangeFor({ active: 'windowed', layout: { conversation: 98, terminal: 2 } }), {
    state: 'windowed',
    height: MIN_BOTTOM_HEIGHT,
  })

  results.push('a drag beyond the range is stored at its boundary')
}

// ------------------------------------------------------- writing one back

function writingAHeightLeavesEverythingElseAsItWas() {
  const windowed: LayoutSizes = defaultLayoutForState('windowed')
  const maximized: LayoutSizes = defaultLayoutForState('maximized')

  // A height dragged while windowed, over a record that already had both sets and the other state's
  // height in it. Every one of them has to survive: this is the same "one state's fact, written
  // without dropping the rest of the record" rule the sets keep.
  const saved: StoredLayoutSets = {
    layoutWindowed: windowed,
    layoutMaximized: maximized,
    bottomPanelHeightMaximized: 48,
  }
  const next = mergeSavedBottomHeight(saved, 'windowed', 55)

  assert.deepEqual(next, {
    layoutWindowed: windowed,
    layoutMaximized: maximized,
    bottomPanelHeightWindowed: 55,
    bottomPanelHeightMaximized: 48,
  })
  // Nor the record that was handed in: a stored record is replaced, not edited in place.
  assert.equal(saved.bottomPanelHeightWindowed, undefined)

  // And a layout drag carries the heights with it. The two writes reach one record, so a separator
  // dragged in the outer group must not cost the user the terminal's height.
  const afterASetDrag = mergeSavedLayout(next, 'maximized', { ...maximized, outer: { drawer: 25, main: 75 } })
  assert.equal(afterASetDrag.bottomPanelHeightWindowed, 55)
  assert.equal(afterASetDrag.bottomPanelHeightMaximized, 48)
  assert.deepEqual(afterASetDrag.layoutWindowed, windowed)

  results.push('writing a height leaves the other state and both sets alone')
}

async function main() {
  await step('the stored keys', oneStoredKeyPerWindowState)
  await step('the open flag', aRecordWithoutThePanelOpensClosed)
  await step('the height', aRecordWithoutAHeightOpensAtTheDefault)
  await step('the height, out of range', aPersistedHeightIsClampedIntoTheRangeAPanelCanBeReadIn)
  await step('the height, not a number', aHeightThatIsNotANumberIsTheDefaultRatherThanARangeEnd)
  await step('the height, per state', theHeightIsPerStateAndNotAcrossStates)
  await step('the vertical group', theVerticalGroupFillsItsColumnExactly)
  await step('a drag', aDragBecomesTheActiveStateHeight)
  await step('a drag that is not a layout', aDragThatIsNotALayoutWritesNothing)
  await step('a drag out of range', aDragOutsideTheRangeIsStoredAtTheBoundary)
  await step('writing a height back', writingAHeightLeavesEverythingElseAsItWas)

  console.log(`bottom terminal layout: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('BOTTOM TERMINAL LAYOUT TEST FAILED:', err)
  process.exit(1)
})
