/**
 * Verifies the JSONL mapper: what each captured `codex exec --json` line becomes in the update dialect
 * the ACP client already speaks, and what happens to a line this build has no opinion about.
 *
 * The fixture is the capture itself — the verbatim stdout of two runs of the CLI installed on this
 * machine, copied byte for byte into `tests/engines/fixtures/` — so every assertion here is a statement
 * about what the binary actually printed rather than about a shape someone wrote down. What that proves
 * is the mapper; it is not a claim about the CLI beyond those two runs, and the disclosure recording the
 * runs lives beside the fixtures in `codex-exec-capture.md`.
 *
 * The mapper is pure and declares one import, so it is asserted as a rule: a line in, updates out, in
 * order; a thread id carried forward rather than invented; an event or item kind this build does not act
 * on reported as `other` rather than dropped; and a half line sitting in the frame buffer until the rest
 * of it arrives.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mapCodexChunk,
  mapCodexLine,
  codexTurnEndCause,
  CODEX_TURN_END_CAUSES,
  type CodexUpdate,
} from '../../conveyor/protocol/codex-jsonl'
import { overviewTiles } from '../../conveyor/protocol/session-usage'
import { TURN_END_CAUSES } from '../../conveyor/protocol/turn-end'

const results: string[] = []

/** The fixtures, read from the repo rather than from a string in this file: they are the capture. */
const FIXTURES = join(process.cwd(), 'tests', 'engines', 'fixtures')

function captureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
}

/** Fold a whole capture through the mapper, exactly as the client does, and answer the updates. */
function mapAll(lines: string[]): CodexUpdate[] {
  let threadId: string | null = null
  const updates: CodexUpdate[] = []
  for (const line of lines) {
    const mapped = mapCodexLine(line, threadId)
    threadId = mapped.threadId
    updates.push(...mapped.updates)
  }
  return updates
}

/** The update kinds, in order, as one readable string — the shape most of these cases assert. */
function kinds(updates: CodexUpdate[]): string[] {
  return updates.map((update) => (update.type === 'other' ? `other:${update.kind}` : update.type))
}

// ---------------------------------------------------------------- the captured vocabulary

/**
 * The trivial run: a thread, a turn, one ignored error item, the reply's prose, and the turn's usage.
 *
 * The thread id is the only thing the first line carries, and it is what every later update is filed
 * under — read off the capture rather than written here, so a mapper that stopped carrying it would
 * fail on the fixture rather than on a value this suite made up.
 */
function theTrivialRunMapsEventByEvent() {
  const lines = captureLines('codex-exec-capture.jsonl')
  assert.ok(lines.length > 0, 'the trivial capture is on disk')

  const first = mapCodexLine(lines[0], null)
  assert.equal(first.threadId, '01a110c9-3f32-7842-a46a-8e19a7456a1d', 'the thread id is carried out of it')
  assert.equal(first.updates.length, 0, 'and nothing is drawn for the thread itself')

  const updates = mapAll(lines)
  assert.deepEqual(kinds(updates), ['other:turn.started', 'other:error', 'message_chunk', 'usage'])

  const prose = updates[2]
  assert.equal(prose.type === 'message_chunk' ? prose.text : '', 'pong', 'the reply is the agent text')

  const usage = updates[3]
  assert.ok(usage.type === 'usage' && usage.prompt === 18347 && usage.completion === 5, 'the turn carries tokens')
  assert.ok(usage.type === 'usage' && usage.cached === 11008, 'and the cached half of them')
  assert.equal(
    updates.every((update) => update.type === 'other' || update.sessionId === first.threadId),
    true,
    'every update is filed under the thread the capture opened'
  )

  results.push('the trivial capture maps: thread, turn, prose, usage — in the order it was printed')
}

/** The tool run: the same vocabulary, plus a command crossing the wire as a call and then an outcome. */
function theToolRunMapsToACallAndItsOutcome() {
  const lines = captureLines('codex-exec-tool-capture.jsonl')
  const updates = mapAll(lines)

  assert.deepEqual(kinds(updates), [
    'other:turn.started',
    'other:error',
    'message_chunk',
    'tool_call',
    'tool_call_update',
    'message_chunk',
    'usage',
  ])

  const call = updates[3]
  assert.equal(call.type, 'tool_call')
  assert.ok(call.type === 'tool_call', 'read as the call it is')
  assert.equal(call.toolCallId, 'item_2', 'the call is addressed by the id the CLI gave it')
  assert.equal(call.kind, 'command_execution', 'the kind is the CLI own word for it, verbatim')
  assert.equal(call.status, 'in_progress', 'and the status it printed while it ran')
  assert.equal(
    call.title.includes('echo hello'),
    true,
    'the title is the command itself rather than a sentence this app wrote'
  )

  const done = updates[4]
  assert.ok(done.type === 'tool_call_update', 'the outcome is an update to the same call')
  assert.equal(done.toolCallId, 'item_2', 'addressed to the same id, which is what settles the card')
  assert.equal(done.status, 'completed')
  assert.equal(done.code, '0', 'the exit code travels, as a string, because the card branches on a code')
  assert.equal(done.output.includes('hello'), true, 'and the aggregated output travels with it')

  const usage = updates[6]
  assert.ok(usage.type === 'usage' && usage.prompt === 38314 && usage.completion === 131, 'the turn is measured')
  assert.ok(usage.type === 'usage' && usage.cached === 25088)

  results.push('a command maps to a call and then to its outcome, both addressed by the same id')
}

/** The two runs are one dialect: the same event kinds, and nothing the mapper had to guess at. */
function theTwoRunsSpeakOneVocabulary() {
  const both = [...captureLines('codex-exec-capture.jsonl'), ...captureLines('codex-exec-tool-capture.jsonl')]
  const types = both.map((line) => (JSON.parse(line) as { type: string }).type)
  const known = new Set([
    'thread.started',
    'turn.started',
    'turn.completed',
    'turn.failed',
    'item.started',
    'item.updated',
    'item.completed',
  ])

  for (const type of types) assert.equal(known.has(type), true, `every captured line is a known event: ${type}`)
  assert.equal(types.includes('item.started'), true, 'the tool run is where a started item appears')

  results.push('both captures are lines of one event vocabulary, and every one of them is known')
}

// ---------------------------------------------------------------- leniency

/** An event this build does not act on is reported as `other`, never dropped and never a throw. */
function anUnknownKindIsReportedRatherThanDroppedOrThrown() {
  const unknownEvent = JSON.stringify({ type: 'turn.something.newer', detail: 'x' })
  const mapped = mapCodexLine(unknownEvent, 'thread-1')

  assert.equal(mapped.updates.length, 1, 'an unknown event is still one update')
  assert.deepEqual(mapped.updates[0], { type: 'other', sessionId: 'thread-1', kind: 'turn.something.newer' })
  assert.equal(mapped.threadId, 'thread-1', 'and it does not lose the thread it arrived on')

  const unknownItem = JSON.stringify({ type: 'item.completed', item: { id: 'i9', type: 'todo_list' } })
  const item = mapCodexLine(unknownItem, 'thread-1')
  assert.deepEqual(item.updates, [{ type: 'other', sessionId: 'thread-1', kind: 'todo_list' }])

  const prose = mapCodexLine('not json at all', 'thread-1')
  assert.equal(prose.updates.length, 0, 'a line that is not JSON is not an update')
  assert.equal(prose.threadId, 'thread-1', 'and it does not derail the thread')

  results.push('an event or item kind this build does not act on is reported as other, leniently')
}

/** A chunk that splits a line keeps the remainder, exactly as the ACP framer does for its own peer. */
function aSplitLineIsFramedRatherThanParsed() {
  const lines = captureLines('codex-exec-capture.jsonl')
  const whole = lines[4]
  const half = Math.floor(whole.length / 2)

  const first = mapCodexChunk('', whole.slice(0, half), null)
  assert.equal(first.updates.length, 0, 'half a line is not a message yet')
  assert.equal(first.rest, whole.slice(0, half), 'the remainder is handed back')

  const second = mapCodexChunk(first.rest, whole.slice(half) + '\n', first.threadId)
  assert.equal(second.malformed.length, 0, 'and completing it parses cleanly')
  assert.equal(second.updates.length, 1, 'into the one update the whole line means')
  assert.ok(second.updates[0].type === 'usage', 'which is the usage the frame carried')
  assert.equal(second.rest, '', 'with nothing left over')

  const several = mapCodexChunk('', lines[0] + '\n' + lines[4] + '\n', null)
  assert.equal(several.updates.length, 1, 'two messages in one read are two messages, both framed')
  assert.equal(several.threadId, '01a110c9-3f32-7842-a46a-8e19a7456a1d', 'and the thread is read from the first')

  results.push('a chunk carrying half a line, one line or several is framed rather than assumed away')
}

// ---------------------------------------------------------------- usage, and its absence

/**
 * A turn the stream never measured is one the tiles draw an em dash for.
 *
 * Both halves are asserted together because they are one rule: the mapper sends no usage update for a
 * turn that carried none, and the display rule that reads a session with no usage puts an em dash where
 * a number would be — so an engine that reports nothing cannot light the tile with a zero.
 */
function aTurnWithoutUsageIsAnEmDashAndNotAZero() {
  const lines = captureLines('codex-exec-capture.jsonl').filter((line) => !line.includes('turn.completed'))
  const updates = mapAll(lines)

  assert.equal(
    updates.some((update) => update.type === 'usage'),
    false,
    'no usage line, no usage update — the mapper does not invent counters'
  )

  const tiles = overviewTiles({ rates: null, turns: 2 })
  assert.equal(tiles.tokens, '—', 'and the tile that reads it draws an em dash')
  assert.equal(tiles.cache, '—')

  const measured = mapAll(captureLines('codex-exec-capture.jsonl')).find((update) => update.type === 'usage')
  assert.ok(measured && measured.type === 'usage', 'where a measured turn does carry counters')
  assert.equal(
    overviewTiles({ usage: measured, rates: null, turns: 2 }).tokens === '—',
    false,
    'which is not an em dash'
  )

  results.push('a usage-less turn maps to nothing, which the tiles draw as an em dash rather than a zero')
}

/** The child exiting is a turn-end cause, in the vocabulary this app already words endings with. */
function theChildExitIsATurnEndCause() {
  assert.equal(codexTurnEndCause(0, true), 'model_stop', 'a clean exit with an answer is the ordinary ending')
  assert.equal(codexTurnEndCause(0, false), 'empty_stop', 'a clean exit with no answer is the one that needs said')
  assert.equal(codexTurnEndCause(1, true), 'stream_error', 'a non-zero exit is a stream that stopped mid-sentence')
  assert.equal(codexTurnEndCause(null, false), 'stream_error', 'and an exit with no code at all is not a clean one')

  const failed = mapCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }), 'thread-1')
  assert.deepEqual(kinds(failed.updates), ['turn_end'], 'a failed turn is an ending, reported as one')
  assert.equal(
    failed.updates[0].type === 'turn_end' ? failed.updates[0].cause : '',
    'stream_error',
    'with the cause this app words rather than the CLI own sentence'
  )

  results.push('the CLI own failure and the child exit both land on the turn-end vocabulary')
}

/** One import, and it is the framer: a mapper that reached for a clock or a pipe would not be pure. */
function theMapperDeclaresOneImport() {
  const source = readFileSync(join(process.cwd(), 'conveyor', 'protocol', 'codex-jsonl.ts'), 'utf8')
  const imports = source.match(/^[ \t]*import[^']*'([^']+)'/gm) ?? []

  assert.deepEqual(imports, ["import { parseAcpChunk } from './acp'"], 'the mapper imports the framer and nothing else')
  assert.equal(/child_process|require\(/.test(source), false, 'and starts nothing to answer a line')

  // The one thing the mapper spells for itself, because it imports nothing that could lend it: the endings
  // it names are the app's own vocabulary, and a second copy of a closed set is entitled to drift only if
  // something says so. This is that something — the mapping is proved against the real set, here.
  assert.deepEqual(
    [...CODEX_TURN_END_CAUSES].sort(),
    [...TURN_END_CAUSES].sort(),
    'the causes the mapper names are the causes the app words'
  )

  results.push('the mapper is pure — the framer is its one import — and its endings are the app own set')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  step('capture (trivial)', theTrivialRunMapsEventByEvent)
  step('capture (tool)', theToolRunMapsToACallAndItsOutcome)
  step('vocabulary', theTwoRunsSpeakOneVocabulary)
  step('leniency', anUnknownKindIsReportedRatherThanDroppedOrThrown)
  step('framing', aSplitLineIsFramedRatherThanParsed)
  step('usage', aTurnWithoutUsageIsAnEmDashAndNotAZero)
  step('turn end', theChildExitIsATurnEndCause)
  step('purity', theMapperDeclaresOneImport)

  console.log('codex jsonl mapper: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('CODEX JSONL MAPPER TEST FAILED:', err)
  process.exit(1)
})
