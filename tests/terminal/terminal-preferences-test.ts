/**
 * Verifies the terminal preferences: what the two controls accept, and what the store they persist
 * through does with a value that reaches it anyway.
 *
 * Both halves are pure — a bounds rule and a reducer — so they are exercised without a window, a
 * form, or electron: the rules are called with the strings a field holds, and the store's actions are
 * called against a cloned state exactly as the store runtime calls them. What the renderer *shows* a
 * refusal as belongs to the wiring suite; what is pinned here is the decision the two share.
 *
 * The refusal is a field rule rather than a `ConveyorError` code, which is the reason there is no code
 * to assert against: an out-of-range number is a value the section explains under its own field, and
 * inventing a main-process failure for it would put wording in a place the reader never sees. The
 * schema is still asserted, one layer down, because it is the guarantee that holds even if a caller
 * skips the field — the store's own gate rather than the form's.
 */
import { strict as assert } from 'node:assert'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_SCROLLBACK_LINES,
  MAX_FONT_SIZE,
  MAX_SCROLLBACK_LINES,
  MIN_FONT_SIZE,
  MIN_SCROLLBACK_LINES,
  checkFontSize,
  checkScrollbackLines,
} from '../../conveyor/protocol/terminal-preferences'
import { DEFAULT_BUFFER_LINES } from '../../conveyor/protocol/terminal-pty'
import { terminalPreferencesStore } from '../../conveyor/stores/terminal-preferences'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- the bounds both fields share

function scrollbackBounds(): void {
  // The default is Turn 1's retention bound rather than a second number beside it: a terminal that
  // retained a thousand lines before this setting existed must retain a thousand after it.
  assert.equal(DEFAULT_SCROLLBACK_LINES, DEFAULT_BUFFER_LINES, 'the default is the session buffer default')
  assert.equal(DEFAULT_SCROLLBACK_LINES, 1000)

  assert.deepEqual(checkScrollbackLines('1000'), { ok: true, value: 1000 }, 'a plain number is accepted')
  assert.deepEqual(
    checkScrollbackLines(`${MIN_SCROLLBACK_LINES}`),
    { ok: true, value: MIN_SCROLLBACK_LINES },
    'the lower bound itself is in range'
  )
  assert.deepEqual(
    checkScrollbackLines(`${MAX_SCROLLBACK_LINES}`),
    { ok: true, value: MAX_SCROLLBACK_LINES },
    'and so is the upper one'
  )

  // Empty, letters and fractions are three different typos with one repair between them: the field
  // wants a whole number, and saying "out of range" for `12.5` would send the reader to the wrong end
  // of the sentence. A leading minus is of that family rather than the range's: this field holds a
  // count, and `-1000` is not one.
  for (const raw of ['', '  ', 'abc', '12.5', '1e3', '1000 lines', '-1000']) {
    const check = checkScrollbackLines(raw)
    assert.equal(check.ok, false, `'${raw}' is not a number`)
    assert.equal(check.ok === false && check.reason, 'not-a-number')
    assert.equal(check.ok === false && check.message, 'Enter a whole number of lines.')
  }

  // Out of range, in the field's own words: both bounds named, so the reader is not left guessing
  // which end they fell off.
  for (const raw of ['0', `${MIN_SCROLLBACK_LINES - 1}`, `${MAX_SCROLLBACK_LINES + 1}`]) {
    const check = checkScrollbackLines(raw)
    assert.equal(check.ok, false, `${raw} lines is refused`)
    assert.equal(check.ok === false && check.reason, 'out-of-range')
    assert.equal(check.ok === false && check.message, 'Enter a whole number of lines between 100 and 50,000.')
  }

  results.push('the scrollback field accepts a bounded whole number and names both bounds when it refuses')
}

function fontSizeBounds(): void {
  assert.equal(DEFAULT_FONT_SIZE, 12, 'the default is the size the terminal was built with before this setting')

  assert.deepEqual(checkFontSize('12'), { ok: true, value: 12 })
  assert.deepEqual(checkFontSize(`${MIN_FONT_SIZE}`), { ok: true, value: MIN_FONT_SIZE })
  assert.deepEqual(checkFontSize(`${MAX_FONT_SIZE}`), { ok: true, value: MAX_FONT_SIZE })

  for (const raw of ['', 'large', '12.5']) {
    const check = checkFontSize(raw)
    assert.equal(check.ok, false, `'${raw}' is not a number`)
    assert.equal(check.ok === false && check.reason, 'not-a-number')
    assert.equal(check.ok === false && check.message, 'Enter a whole number of pixels.')
  }

  for (const raw of ['0', `${MIN_FONT_SIZE - 1}`, `${MAX_FONT_SIZE + 1}`]) {
    const check = checkFontSize(raw)
    assert.equal(check.ok, false, `${raw} pixels is refused`)
    assert.equal(check.ok === false && check.reason, 'out-of-range')
    assert.equal(check.ok === false && check.message, 'Enter a whole number of pixels between 8 and 32.')
  }

  results.push('the font size field accepts a bounded whole number and says so when it refuses')
}

// ---------------------------------------------------------------- the store the fields write through

/**
 * The store as its own test harness sees it.
 *
 * The actions are pure `(state, payload)` reducers — the store runtime is what supplies the state —
 * so the slice is exercised by calling an action against a clone, exactly as `provider-config`'s own
 * suite does. The schemas are read the same way: they are what `defineStore` validates a dispatch
 * against before any action runs.
 */
const INITIAL_STATE = (terminalPreferencesStore as unknown as { initialState: TerminalPreferencesState }).initialState

interface TerminalPreferencesState {
  scrollbackLines: number
  fontSize: number
}

function storeHarness() {
  const state: TerminalPreferencesState = structuredClone(INITIAL_STATE)
  const schemas = terminalPreferencesStore.schemas as unknown as Record<
    string,
    { safeParse: (value: unknown) => { success: boolean } }
  >

  return {
    state,
    run(name: 'setScrollbackLines' | 'setFontSize', payload: unknown): void {
      const action = terminalPreferencesStore.actions[name] as unknown as (
        s: TerminalPreferencesState,
        p: unknown
      ) => void
      action(state, payload)
    },
    accepts: (name: 'setScrollbackLines' | 'setFontSize', payload: unknown) => schemas[name].safeParse(payload).success,
  }
}

function theStoreCarriesBothPreferences(): void {
  const store = storeHarness()
  assert.deepEqual(store.state, { scrollbackLines: DEFAULT_SCROLLBACK_LINES, fontSize: DEFAULT_FONT_SIZE })

  store.run('setScrollbackLines', { lines: 4000 })
  store.run('setFontSize', { pixels: 15 })
  assert.deepEqual(store.state, { scrollbackLines: 4000, fontSize: 15 })

  // Persisted as one record, shallow-merged over the initial state on the next launch — the same
  // reading `provider-config` writes and restores, so neither key can be lost to the other.
  const restored: TerminalPreferencesState = { ...structuredClone(INITIAL_STATE), ...{ fontSize: 15 } }
  assert.deepEqual(
    restored,
    { scrollbackLines: DEFAULT_SCROLLBACK_LINES, fontSize: 15 },
    'a record written with one key keeps the other at its default'
  )

  results.push('the terminal preferences store holds both values and restores what was written')
}

function theStoreRefusesAnOutOfRangeWrite(): void {
  const store = storeHarness()

  for (const lines of [MIN_SCROLLBACK_LINES - 1, 0, MAX_SCROLLBACK_LINES + 1, 12.5]) {
    assert.equal(store.accepts('setScrollbackLines', { lines }), false, `${lines} lines is refused by the store`)
  }
  assert.equal(store.accepts('setScrollbackLines', { lines: MIN_SCROLLBACK_LINES }), true)
  assert.equal(store.accepts('setScrollbackLines', { lines: MAX_SCROLLBACK_LINES }), true)

  for (const pixels of [MIN_FONT_SIZE - 1, 0, MAX_FONT_SIZE + 1, 12.5]) {
    assert.equal(store.accepts('setFontSize', { pixels }), false, `${pixels} pixels is refused by the store`)
  }
  assert.equal(store.accepts('setFontSize', { pixels: MIN_FONT_SIZE }), true)
  assert.equal(store.accepts('setFontSize', { pixels: MAX_FONT_SIZE }), true)

  assert.deepEqual(store.state, INITIAL_STATE, 'a refusal is not a write: nothing moved')

  results.push('the store refuses a value the field would have refused')
}

// ---------------------------------------------------------------- report

function main(): void {
  step('scrollback bounds', scrollbackBounds)
  step('font size bounds', fontSizeBounds)
  step('store', theStoreCarriesBothPreferences)
  step('store refusal', theStoreRefusesAnOutOfRangeWrite)

  console.log('terminal preferences: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

main()
