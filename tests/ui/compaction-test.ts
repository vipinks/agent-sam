/**
 * Verifies conversation compaction: the summary turn, the seam it draws, and the send-time projection.
 *
 * A compacted conversation keeps every turn it ever had. What changes is what a send is handed: the
 * turns a summary turn names are skipped, and the summary itself travels in their place. That is the
 * whole mechanism, and it lives in three places this suite pins: the range rule that decides what a
 * compaction replaces, the projection that decides what the model is told, and the record, which has
 * to round-trip the summary without moving `TRANSCRIPT_VERSION`.
 *
 * The stubbed summary is asserted as it is rather than as it will be: this turn concatenates the user
 * messages of the summarized range under a header, so the suite states exactly that text. Real
 * summarisation through the Sam loop is the next turn, and it will change this expectation rather
 * than the projection around it.
 */
import { strict as assert } from 'node:assert'
import { TRANSCRIPT_VERSION } from '../../conveyor/protocol/transcript'
import {
  compactionRange,
  seamLabel,
  summarizedIds,
  summarizedTurns,
  summaryText,
} from '../../conveyor/protocol/truncate'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { toHistory, type AgentTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
  results.push(label)
}

function turn(id: string, role: 'user' | 'assistant', content: string): AgentTurn {
  return { id, role, content, steps: [] }
}

/** Five turns, as a conversation that has been going for a while: question, answer, question, answer, question. */
function conversation(): AgentTurn[] {
  return [
    turn('user-1', 'user', 'one'),
    turn('assistant-2', 'assistant', 'two'),
    turn('user-3', 'user', 'three'),
    turn('assistant-4', 'assistant', 'four'),
    turn('user-5', 'user', 'five'),
  ]
}

/** The same conversation after a compaction: the summary at the head, every turn still behind it. */
function compacted(): AgentTurn[] {
  const turns = conversation()
  const range = compactionRange(turns)
  return [
    {
      id: 'summary-6',
      role: 'user',
      content: summaryText(range),
      steps: [],
      summarizesTurns: range.map((t) => t.id),
    },
    ...turns,
  ]
}

/** The range stops before the last turn, and there is no range worth making from fewer than two. */
function theRangeStopsBeforeTheLastTurn(): void {
  const turns = conversation()
  assert.deepEqual(
    compactionRange(turns).map((t) => t.id),
    ['user-1', 'assistant-2', 'user-3', 'assistant-4']
  )
  assert.deepEqual(
    compactionRange(turns.slice(0, 2)).map((t) => t.id),
    ['user-1']
  )
  assert.deepEqual(compactionRange(turns.slice(0, 1)), [])
  assert.deepEqual(compactionRange([]), [])
}

/** The summary is the range's own words: a header naming the turns, then what the user asked. */
function theSummaryNamesItsTurns(): void {
  const text = summaryText(compactionRange(conversation()))
  assert.equal(text, 'Summary of turns 1 through 4:\none\nthree')
  assert.equal(seamLabel(4), 'Turns 1 through 4 summarized')
  // A range with nothing said in it is still a range; the header is the whole of it.
  assert.equal(summaryText([]), 'Summary of turns 1 through 0:')
}

/** A send is handed the summary and the turns after it, and nothing the summary stands for. */
function aSendSkipsTheSummarizedTurns(): void {
  const turns = compacted()
  const messages = toHistory(turns)
  assert.deepEqual(
    messages.map((m) => m.content),
    ['Summary of turns 1 through 4:\none\nthree', 'five']
  )
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'user']
  )
}

/** A transcript with no summary turn is sent whole, exactly as it was before compaction existed. */
function anUncompactedTranscriptSendsEveryTurn(): void {
  assert.equal(toHistory(conversation()).length, 5)
}

/** The record carries the summary turn's range without a version bump, and reading it back keeps it. */
function theSummaryTurnRoundTrips(): void {
  const turns = compacted()
  const snapshot = serializeTranscript({ turns, interrupted: false })

  assert.equal(TRANSCRIPT_VERSION, 3)
  assert.equal(snapshot.version, 3)
  assert.deepEqual(snapshot.turns[0].summarizesTurns, ['user-1', 'assistant-2', 'user-3', 'assistant-4'])
  // Every summarized turn is still in the file: compaction adds, it never rewrites history away.
  assert.equal(snapshot.turns.length, turns.length)

  const reopened = rehydrateTranscript(snapshot)
  assert.deepEqual(reopened.turns[0].summarizesTurns, ['user-1', 'assistant-2', 'user-3', 'assistant-4'])
  assert.deepEqual(
    toHistory(reopened.turns).map((m) => m.content),
    ['Summary of turns 1 through 4:\none\nthree', 'five']
  )
}

/** The ids a summary stands for, and the records behind them, are what the seam row expands to. */
function theSummaryKnowsWhatItStandsFor(): void {
  const turns = compacted()
  assert.deepEqual(summarizedIds(turns), ['user-1', 'assistant-2', 'user-3', 'assistant-4'])
  assert.deepEqual(
    summarizedTurns(turns, turns[0]).map((t) => t.content),
    ['one', 'two', 'three', 'four']
  )
}

function main(): void {
  step('the range', theRangeStopsBeforeTheLastTurn)
  step('the summary', theSummaryNamesItsTurns)
  step('a send', aSendSkipsTheSummarizedTurns)
  step('an uncompacted send', anUncompactedTranscriptSendsEveryTurn)
  step('the record', theSummaryTurnRoundTrips)
  step('the expansion', theSummaryKnowsWhatItStandsFor)

  console.log(`compaction: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
