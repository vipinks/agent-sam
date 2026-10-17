/**
 * Verifies conversation compaction: the summary turn, the seam it draws, and the send-time projection.
 *
 * A compacted conversation keeps every turn it ever had. What changes is what a send is handed: the
 * turns a summary turn names are skipped, and the summary itself travels in their place. That is the
 * whole mechanism, and it lives in three places this suite pins: the range rule that decides what a
 * compaction replaces, the projection that decides what the model is told, and the record, which has
 * to round-trip the summary without moving `TRANSCRIPT_VERSION`.
 *
 * The stubbed summary is still asserted as it is: it is what a compaction writes when the Sam loop is
 * unavailable or refuses, and this turn adds the real path beside it rather than replacing the rule.
 * Real summarisation is asserted by `theSummaryComesFromTheSamLoop`, so the stub's own expectations
 * below are the fallback's rather than the only answer.
 */
import { strict as assert } from 'node:assert'
import { TRANSCRIPT_VERSION } from '../../conveyor/protocol/transcript'
import {
  compactionRange,
  seamLabel,
  summarizedIds,
  summarizedTurns,
  summarizeRange,
  summaryText,
} from '../../conveyor/protocol/truncate'
import { pastCompactPoint, type ContextSnapshot } from '../../conveyor/protocol/context-window'
import { rehydrateTranscript, serializeTranscript } from '../../app/components/workbench/session-transcript'
import { startSummaryTurn, toHistory, type AgentTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
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

/**
 * The summary a compaction writes is the Sam loop's answer to the range, and the range travels as the
 * request's context. The stub is what is written only when the loop cannot answer.
 */
async function theSummaryComesFromTheSamLoop(): Promise<void> {
  const range = compactionRange(conversation())
  let asked: ReadonlyArray<{ role: string; content: string }> = []
  const text = await summarizeRange(range, async (messages) => {
    asked = messages
    return 'The user counted the turns and stopped at four.'
  })

  const summary = startSummaryTurn(
    text,
    range.map((turn) => turn.id)
  )
  assert.equal(summary.content, 'The user counted the turns and stopped at four.')
  assert.notEqual(summary.content, summaryText(range), 'a real summary is not the stub header')
  assert.ok(!summary.content.startsWith('Summary of turns'), 'the stub header is the fallback, not the answer')
  assert.ok(
    asked.some((message) => message.content.includes('one') && message.content.includes('four')),
    "the summarized turns travel as the model's context"
  )
}

/** A loop that is unavailable, refuses, or answers with nothing leaves the Turn 1 stub in its place. */
async function anUnavailableLoopFallsBackToTheStub(): Promise<void> {
  const range = compactionRange(conversation())
  const refused = await summarizeRange(range, async () => {
    throw new Error('NO_API_KEY')
  })
  assert.equal(refused, summaryText(range))
  const silent = await summarizeRange(range, async () => '   ')
  assert.equal(silent, summaryText(range))
}

/**
 * A second compaction folds the turns that arrived after the first one, and its summary reaches the
 * next send in place of exactly those turns.
 */
async function aSecondCompactionStartsAfterTheLastRange(): Promise<void> {
  const first = compacted()
  const grown: AgentTurn[] = [...first, turn('assistant-7', 'assistant', 'seven'), turn('user-8', 'user', 'eight')]
  const range = compactionRange(grown)

  assert.deepEqual(
    range.map((t) => t.id),
    ['user-5', 'assistant-7'],
    'the range starts at the first turn after the previous summary and never names the summary'
  )

  const summary = startSummaryTurn(
    await summarizeRange(range, async () => 'two more turns about five and seven'),
    range.map((t) => t.id)
  )
  const twice: AgentTurn[] = [summary, ...grown]
  assert.equal(toHistory(twice)[0].content, 'two more turns about five and seven')
  assert.equal(summarizedIds(twice).length, 6, 'both ranges are remembered, and neither repeats')
}

/**
 * The trigger's measurement: a send that leaves the conversation at or past its compact point is one
 * that compacts, and a send below it is not.
 */
function aSendPastTheCompactPointCompacts(): void {
  function spent(used: number): ContextSnapshot {
    return {
      tools: 0,
      systemPrompt: 0,
      projectInstructions: 0,
      skills: 0,
      messages: used,
      other: 0,
      used,
      at: 1_700_000_000_000,
    }
  }

  // `deepseek-chat`'s shipped window, at the launch compact point: 44 800 tokens.
  assert.equal(pastCompactPoint({ snapshot: spent(44_800), window: 64_000, compactPercent: 70 }), true)
  assert.equal(pastCompactPoint({ snapshot: spent(50_000), window: 64_000, compactPercent: 70 }), true)
  assert.equal(pastCompactPoint({ snapshot: spent(10_000), window: 64_000, compactPercent: 70 }), false)
  // Nothing measured, or no window to measure against, is not a reason to fold anything.
  assert.equal(pastCompactPoint({ snapshot: undefined, window: 64_000, compactPercent: 70 }), false)
  assert.equal(pastCompactPoint({ snapshot: spent(50_000), window: null, compactPercent: 70 }), false)

  // And the conversation that measurement names has something to fold.
  assert.ok(compactionRange(conversation()).length > 0)
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

async function main(): Promise<void> {
  await step('the range', theRangeStopsBeforeTheLastTurn)
  await step('the summary', theSummaryNamesItsTurns)
  await step('the sam loop', theSummaryComesFromTheSamLoop)
  await step('the fallback', anUnavailableLoopFallsBackToTheStub)
  await step('a second range', aSecondCompactionStartsAfterTheLastRange)
  await step('the trigger', aSendPastTheCompactPointCompacts)
  await step('a send', aSendSkipsTheSummarizedTurns)
  await step('an uncompacted send', anUncompactedTranscriptSendsEveryTurn)
  await step('the record', theSummaryTurnRoundTrips)
  await step('the expansion', theSummaryKnowsWhatItStandsFor)

  console.log(`compaction: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
