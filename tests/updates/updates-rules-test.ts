/**
 * Verifies the auto-update status rule: every state the updater's events can leave the mirror in, what
 * the surface calls that state, and which of the three actions it offers.
 *
 * The rule lives in `conveyor/protocol` rather than in the module that wraps electron-updater, because
 * the decision is the thing worth testing and a rule test can state the whole of it: the seven states, the
 * user's auto-download preference, and the error code that travels instead of a message. `conveyor/
 * modules/updates.ts` is where the traced events become these states — and only a packaged build can
 * exercise the updater itself, so what is provable here is the rule, and the wiring is proved by the types
 * the module has to satisfy.
 *
 * The error cases are the interesting ones. Every failure the module records carries a code rather than the
 * sentence electron-updater's own Error arrived with, so the assertions below cover the codes, the word each
 * one maps to, and — the load-bearing half — that the answer is always drawn from the rule's own finite
 * table, so a message reaching the rule cannot travel back out of it wearing the status word's clothes.
 *
 * Purity is asserted rather than assumed: the rule is called on a frozen input, equal inputs are compared,
 * the answer is shown to be a fresh object, and the module's own source is read to confirm it imports
 * nothing at all — so it cannot consult a store, a component, or a clock.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  UPDATE_ERROR_CODES,
  UPDATE_ERROR_WORDS,
  UPDATE_STATES,
  UPDATE_STATUS_WORDS,
  UPDATES_CHECK_FAILED,
  UPDATES_DISABLED_IN_DEV,
  UPDATES_DOWNLOAD_FAILED,
  updateAvailability,
  updateFailureCode,
  updateStatusWord,
  type UpdateErrorCode,
  type UpdateState,
} from '../../conveyor/protocol/updates'

const results: string[] = []

/** The preference, both ways: the one input besides the state that the offered actions depend on. */
const PREFERENCE_VALUES = [true, false] as const

/**
 * What the surface offers in each state, with auto-download *off*.
 *
 * One action at a time is the shape of it: a state offers a check while nothing is in flight, a download
 * once an update is known and the app is not fetching it by itself, and an install once the bits are here.
 * `available` is the one row the preference moves, which is why it is crossed below rather than folded into
 * this table.
 */
const OFFERED: Record<UpdateState, { canCheck: boolean; canDownload: boolean; canInstall: boolean }> = {
  idle: { canCheck: true, canDownload: false, canInstall: false },
  checking: { canCheck: false, canDownload: false, canInstall: false },
  available: { canCheck: false, canDownload: true, canInstall: false },
  downloading: { canCheck: false, canDownload: false, canInstall: false },
  ready: { canCheck: false, canDownload: false, canInstall: true },
  'up-to-date': { canCheck: true, canDownload: false, canInstall: false },
  error: { canCheck: true, canDownload: false, canInstall: false },
}

/** Where the module under test lives, from the root the suite is run from. */
const MODULE_PATH = join(process.cwd(), 'conveyor', 'protocol', 'updates.ts')

// ---------------------------------------------------------------- the words

/**
 * Every state has a word, the words do not collide, and the preference does not move them.
 *
 * A collision would be a surface that cannot say which of two states it is in, and the word is what a
 * status line prints — so it is asserted to be the same utterance whether or not an update is being
 * fetched automatically: the preference changes what the app does next, never what has happened.
 */
function everyStateCarriesItsOwnWord() {
  const seen = new Map<string, UpdateState>()

  for (const state of UPDATE_STATES) {
    for (const autoDownload of PREFERENCE_VALUES) {
      const word = updateAvailability({ state, autoDownload }).statusWord
      assert.equal(typeof word, 'string', `${state}: the status word is a string`)
      assert.ok(word.length > 0, `${state}: the status word is not empty`)
      assert.equal(word, UPDATE_STATUS_WORDS[state], `${state}: the word is the rule's own`)
      assert.equal(
        word,
        updateAvailability({ state, autoDownload }).statusWord,
        `${state}: the preference does not change the word`
      )

      const other = seen.get(word)
      assert.ok(other === undefined || other === state, `${state}: shares its word with ${other}`)
      seen.set(word, state)
    }
  }

  assert.equal(seen.size, UPDATE_STATES.length, 'every state is covered, and no two share a word')
  assert.equal(UPDATE_STATES.length, 7, 'the union is the seven events can leave the mirror in')

  results.push('each of the seven states has its own word, and the preference never moves it')
}

// ---------------------------------------------------------------- the offered actions

/**
 * The three offers follow the state, and only `available` answers to the preference.
 *
 * With auto-download on, an available update is being fetched by the module and there is nothing for the
 * user to start — the state passes through to `downloading` on the first progress event. With it off the
 * download is the one thing the surface can offer, which is exactly the branch the preference gates.
 */
function theOfferedActionsFollowTheStateAndThePreference() {
  for (const state of UPDATE_STATES) {
    for (const autoDownload of PREFERENCE_VALUES) {
      const answer = updateAvailability({ state, autoDownload })
      const expected = {
        canCheck: OFFERED[state].canCheck,
        canDownload: state === 'available' && !autoDownload,
        canInstall: OFFERED[state].canInstall,
      }

      assert.deepEqual(
        { canCheck: answer.canCheck, canDownload: answer.canDownload, canInstall: answer.canInstall },
        expected,
        `${state} with autoDownload=${autoDownload}`
      )

      const offered = [answer.canCheck, answer.canDownload, answer.canInstall].filter(Boolean).length
      assert.ok(offered <= 1, `${state}: the surface offers at most one action at a time`)
    }
  }

  const automatic = updateAvailability({ state: 'available', autoDownload: true })
  const manual = updateAvailability({ state: 'available', autoDownload: false })
  assert.equal(automatic.canDownload, false, 'an automatic download offers no manual one')
  assert.equal(manual.canDownload, true, 'and with the preference off it is the offered action')
  assert.equal(automatic.statusWord, manual.statusWord, 'the word is the state’s, not the preference’s')

  assert.equal(updateAvailability({ state: 'ready', autoDownload: false }).canInstall, true, 'ready installs')
  assert.equal(updateAvailability({ state: 'checking', autoDownload: false }).canCheck, false, 'in flight holds')

  results.push('the offers follow the state, and only an available update answers to the preference')
}

// ---------------------------------------------------------------- codes, not messages

/**
 * The error state carries a code, and the rule answers with a word from its own table or not at all.
 *
 * The updater's `error` event hands over an `Error`, whose message is a sentence about an HTTP status or a
 * filesystem path. None of it may reach the surface: the words are a closed set, the answer's keys are
 * exactly the four the rule declares, and a value that is not one of the codes — the smuggled-message case
 * — falls back to the state's own word instead of being echoed back.
 */
function theErrorCodeTravelsInsteadOfAMessage() {
  const declared = new Set([...Object.values(UPDATE_STATUS_WORDS), ...Object.values(UPDATE_ERROR_WORDS)])

  for (const code of UPDATE_ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `${code}: a code is a code, not a sentence`)
    assert.equal(updateStatusWord('error', code), UPDATE_ERROR_WORDS[code], `${code}: maps to its own word`)
    assert.ok(declared.has(UPDATE_ERROR_WORDS[code]), `${code}: the word is one the rule declares`)
  }

  assert.equal(new Set(Object.values(UPDATE_ERROR_WORDS)).size, UPDATE_ERROR_CODES.length, 'no two codes share a word')

  assert.equal(updateStatusWord('error'), UPDATE_STATUS_WORDS.error, 'an uncoded error is still an error')
  assert.equal(
    updateStatusWord('error', 'ECONNREFUSED at https://api.github.com/…' as UpdateErrorCode),
    UPDATE_STATUS_WORDS.error,
    'a message offered as a code is refused, not printed'
  )

  for (const state of UPDATE_STATES) {
    for (const autoDownload of PREFERENCE_VALUES) {
      const answer = updateAvailability({
        state,
        autoDownload,
        errorCode: state === 'error' ? UPDATE_ERROR_CODES[0] : null,
      })
      assert.deepEqual(
        Object.keys(answer).sort(),
        ['canCheck', 'canDownload', 'canInstall', 'statusWord'],
        `${state}: the answer carries no message field`
      )
      assert.ok(declared.has(answer.statusWord), `${state}: every emitted word is one the rule declares`)
    }
  }

  results.push('error states carry codes, and every emitted word comes from the rule’s own table')
}

/**
 * Which code a failure gets is decided by the phase it happened in.
 *
 * electron-updater raises one `error` event for both a check and a download, so the code cannot come from
 * the event — it comes from the state the mirror was in when it arrived. A download that fails is the case
 * worth naming: it is the one a user has to act on, and it must not be reported as a check that failed.
 */
function aFailureIsCodedByThePhaseItHappenedIn() {
  assert.equal(updateFailureCode('downloading'), UPDATES_DOWNLOAD_FAILED, 'a download failure is a download failure')

  for (const state of UPDATE_STATES) {
    const code = updateFailureCode(state)
    assert.ok(
      (UPDATE_ERROR_CODES as readonly string[]).includes(code),
      `${state}: the code is one the surface declares`
    )
    if (state !== 'downloading') {
      assert.equal(code, UPDATES_CHECK_FAILED, `${state}: anything but a download failed during the check`)
    }
  }

  assert.equal(UPDATES_DISABLED_IN_DEV, 'UPDATES_DISABLED_IN_DEV', 'the module’s own refusal code is this one')
  assert.ok(
    (UPDATE_ERROR_CODES as readonly string[]).includes(UPDATES_DISABLED_IN_DEV),
    'and it is a state the surface knows how to word'
  )

  results.push('a failure is coded by its phase: a download failure is never reported as a failed check')
}

// ---------------------------------------------------------------- purity

/**
 * A frozen input is the probe: a write to it throws inside the rule, so a passing call is proof that the
 * answer was computed rather than stored. Equal inputs are then asked twice, because a rule that answered
 * differently the second time would be reading something besides them — and a mutated answer is asked
 * again, because a shared object would let one caller's edit change the next caller's surface.
 */
function theRuleIsPure() {
  const frozen = Object.freeze({ state: 'available', autoDownload: false }) as {
    state: UpdateState
    autoDownload: boolean
  }

  const first = updateAvailability(frozen)
  const second = updateAvailability({ state: 'available', autoDownload: false })
  assert.deepEqual(first, second, 'equal inputs give equal answers')
  assert.notEqual(first, second, 'and each call is a new object')

  first.statusWord = 'something the caller made up'
  assert.equal(
    updateAvailability(frozen).statusWord,
    UPDATE_STATUS_WORDS.available,
    'editing an answer does not reach the next one'
  )
  assert.equal(frozen.state, 'available', 'the input is not written through')
  assert.equal(frozen.autoDownload, false, 'on either field')

  const error = updateAvailability({ state: 'error', autoDownload: true, errorCode: UPDATES_CHECK_FAILED })
  const again = updateAvailability({ state: 'error', autoDownload: true, errorCode: UPDATES_CHECK_FAILED })
  assert.deepEqual(error, again, 'the error answer is a function of its inputs too')

  results.push('the rule is pure: frozen inputs survive it, and each answer is a fresh object')
}

/**
 * The module imports nothing, which is how it stays pure.
 *
 * Read rather than inferred: an import of a store or of a component would be a second input the rule could
 * consult, and the renderer would then be answering a different question depending on what had been written
 * elsewhere — the preference store is read by the renderer that calls this rule, not by the rule.
 */
function theModuleHoldsNoSecondInput() {
  assert.ok(existsSync(MODULE_PATH), `the rule module is where this suite reads it: ${MODULE_PATH}`)
  const source = readFileSync(MODULE_PATH, 'utf8')
  const imports = source.match(/^\s*import\b/gm) ?? []

  assert.equal(imports.length, 0, `the rule declares no imports, found ${imports.length}`)

  results.push('the rule module declares no imports at all — no store, no component, no clock')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('words', everyStateCarriesItsOwnWord)
  step('offers', theOfferedActionsFollowTheStateAndThePreference)
  step('codes', theErrorCodeTravelsInsteadOfAMessage)
  step('failure phase', aFailureIsCodedByThePhaseItHappenedIn)
  step('purity', theRuleIsPure)
  step('module', theModuleHoldsNoSecondInput)

  console.log('updates rules: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('UPDATES RULES TEST FAILED:', err)
  process.exit(1)
})
