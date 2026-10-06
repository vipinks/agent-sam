/**
 * Verifies what a conversation list row says about who ran the turn.
 *
 * The row's meta line is where a user reads back which model answered, and a conversation that runs an
 * engine is answered by neither of the two ids the record stores in `providerId`/`model`: the engine runs
 * its own model and provider, so the pair names the Sam loop this conversation is not running. The label is
 * therefore one rule, exercised here without a DOM — `testing/session-row-label-wiring.test.tsx` covers the
 * row that renders it.
 *
 * Three cases, and each is a different reading of the record. An engine id this build ships is named by the
 * engine's own label. No engine id at all is the Sam loop, and keeps the pair it has always shown. An engine
 * id this build does not ship is named as the id the record carries, which is `engineLabel`'s own rule,
 * deliberately reused rather than restated: a row and the header above it have to call an engine the same
 * thing, and a name invented for an engine nobody can name would be an invention rather than a reading.
 */
import { strict as assert } from 'node:assert'
import { sessionRowLabel } from '../../conveyor/protocol/session-row'
import { ENGINE_LABELS } from '../../conveyor/protocol/engine'
import type { ChatSession } from '../../conveyor/stores/chat-sessions'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** The engine this build ships, and the one every case below writes. */
const CODEX = 'codex'

/** An engine id no release of this app has shipped. */
const UNSHIPPED = 'codex-next'

/**
 * A conversation that runs the Sam loop: no engine key at all.
 *
 * Absence rather than a sentinel, because that is what every record written before engines existed holds,
 * and what the picker writes for the app's own row.
 */
function samSession(): ChatSession {
  return {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    title: 'the first conversation',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerId: 'deepseek',
    model: 'deepseek-chat',
  }
}

// ---------------------------------------------------------------- the rule

/**
 * An engine session is named by the engine, not by the pair it stores.
 *
 * The assertion is against the shipped label rather than against the sentence `ChatGPT (Codex)`, so a
 * relabelled row is caught here rather than in the suite that renders it — the row's job is to print the
 * label, and this suite's is to decide it.
 */
function anEngineSessionIsNamedByItsLabel() {
  const label = sessionRowLabel({ ...samSession(), engineId: CODEX })
  assert.equal(label, ENGINE_LABELS[CODEX], 'an engine session is drawn under the engine register label')
  assert.equal(label, 'ChatGPT (Codex)', 'and that label is the product name the picker offers')
  assert.notEqual(label, 'deepseek/deepseek-chat', 'never the pair, which names the loop it is not running')
  results.push('rule: an engine session is named by its engine')
}

/**
 * A Sam session keeps the pair it has always shown.
 *
 * `providerId/model` with a slash, which is the row's own spelling rather than the header's middot one:
 * the row is a glance at a truncated 11px line, and the separator is what this rule has to reproduce
 * exactly, because every list suite and every user's habit reads it that way.
 */
function aSamSessionKeepsThePair() {
  const session = samSession()
  assert.equal(sessionRowLabel(session), 'deepseek/deepseek-chat', 'a session with no engine keeps its pair')
  results.push('rule: a Sam session keeps the provider and model pair')
}

/**
 * An engine id this build cannot name is drawn as the id itself.
 *
 * The fallback is the record's own id and not a word like "Engine": the id is the only name anybody has for
 * that engine, it is what the header shows for the same conversation, and a generic word would hide which
 * engine the turn was run by — which is the whole subject of this row.
 */
function anEngineThisBuildCannotNameIsDrawnAsItsId() {
  const label = sessionRowLabel({ ...samSession(), engineId: UNSHIPPED })
  assert.equal(label, UNSHIPPED, 'an engine this build does not ship is named as the id it carries')
  assert.equal(label.length > 0, true, 'and it is a word rather than an empty line')
  assert.notEqual(label, 'deepseek/deepseek-chat', 'still never the pair, which is not who ran the turn')
  results.push('rule: an engine this build cannot name is drawn as its id')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('engine: named by its label', anEngineSessionIsNamedByItsLabel)
  step('sam: the pair', aSamSessionKeepsThePair)
  step('engine: unnamed', anEngineThisBuildCannotNameIsDrawnAsItsId)

  console.log(`session row: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('SESSION ROW TEST FAILED:', err)
  process.exit(1)
}
