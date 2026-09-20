/**
 * Verifies the session rules and the transcript round trip — no React, no disk.
 *
 * These are the decisions that are easy to get subtly wrong: what a title becomes, when a save is
 * worth doing, when a transcript must not be written at all, and whether a conversation with tool
 * cards survives a trip through JSON in a shape the reducer can still render.
 */
import { strict as assert } from 'node:assert'
import { backdateStore, createStoreHarness } from './chat-sessions-store-harness'
import {
  createDebouncedSave,
  isDirty,
  mayPersist,
  TITLE_MAX,
  titleFromMessage,
} from '../../app/components/workbench/session-rules'
import {
  blankTranscript,
  rehydrateTranscript,
  serializeTranscript,
  INTERRUPTED_NOTE,
  type TranscriptState,
} from '../../app/components/workbench/session-transcript'
import { resumeTurnNumbering, startAssistantTurn, startUserTurn } from '../../app/components/workbench/agent-session'
import { formatRelativeTime } from '../../app/components/workbench/relative-time'
import { isSearchable, planVisibleSessions, snippetsFor } from '../../app/components/workbench/session-search'
import { SEARCH_MIN_TERM } from '../../conveyor/protocol/search'
import { transcriptSnapshotSchema } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

/** A conversation with prose, tool cards, and a denied approval — the awkward case. */
function transcriptWithTools(): TranscriptState {
  return {
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'read a.txt then delete it', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'I read it, and I will not delete it.',
        steps: [
          { callId: 'c1', tool: 'read_file', args: { path: 'a.txt' }, status: 'ok', output: 'hello\n' },
          {
            callId: 'c2',
            tool: 'run_command',
            args: { command: 'rm a.txt' },
            status: 'denied',
            output: 'Denied by you.',
            code: 'DENIED',
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------- titles

function titles() {
  assert.equal(titleFromMessage('  fix the parser  '), 'fix the parser', 'whitespace is trimmed')
  assert.equal(titleFromMessage('a\nb\tc'), 'a b c', 'newlines and tabs collapse to single spaces')

  const long = 'x'.repeat(120)
  const title = titleFromMessage(long)
  assert.ok(title.length <= TITLE_MAX, `a title must fit ${TITLE_MAX} characters, got ${title.length}`)
  assert.ok(title.endsWith('…'), 'a clipped title is marked as clipped')

  // Exactly at the limit is not clipped.
  const exact = 'y'.repeat(TITLE_MAX)
  assert.equal(titleFromMessage(exact), exact, 'a title of exactly the limit is not clipped')

  // Trailing whitespace must not eat into the budget — the 48th character counts.
  assert.ok(titleFromMessage(`${'z'.repeat(TITLE_MAX)}   `).startsWith('z'.repeat(TITLE_MAX - 1)))

  results.push('a title is the trimmed first message, clipped at 48 characters')
}

// ---------------------------------------------------------------- dirtiness

function dirtyRules() {
  const state = transcriptWithTools()

  // Nothing saved yet: a conversation with turns is dirty, an empty one is not.
  assert.equal(isDirty(state, null), true, 'an unsaved conversation with turns is dirty')
  assert.equal(isDirty(blankTranscript(), null), false, 'an empty conversation is never dirty')

  // Saved and unchanged: not dirty.
  const saved = serializeTranscript(state)
  assert.equal(isDirty(state, saved), false, 'an unchanged conversation is not dirty')

  // One more turn makes it dirty again.
  const extended: TranscriptState = {
    ...state,
    turns: [...state.turns, { id: 'user-3', role: 'user', content: 'thanks', steps: [] }],
  }
  assert.equal(isDirty(extended, saved), true, 'a new turn makes it dirty')

  results.push('only a changed, non-empty transcript is worth saving')
}

function thePauseIsNotPersisted() {
  const awaiting: TranscriptState = {
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'delete it', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        steps: [{ callId: 'c1', tool: 'run_command', args: { command: 'rm x' }, status: 'awaiting' }],
      },
    ],
  }
  // The run behind a pause cannot survive a restart, so writing it would restore a card that looks
  // actionable but is not.
  assert.equal(mayPersist(awaiting), false, 'a pause awaiting approval must not be written')

  // The same pause seen from the queue: the call behind the one being decided is part of the same
  // unresumable state, so it must hold the save back just as the awaiting card does.
  const queued: TranscriptState = {
    interrupted: false,
    turns: [
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        steps: [
          { callId: 'c1', tool: 'write_file', args: { path: 'a' }, status: 'awaiting' },
          { callId: 'c2', tool: 'write_file', args: { path: 'b' }, status: 'queued' },
        ],
      },
    ],
  }
  assert.equal(mayPersist(queued), false, 'a queue behind the decision must not be written either')
  assert.equal(mayPersist(transcriptWithTools()), true, 'ordinary turns are written')

  results.push('a transcript paused for approval is not persisted')
}

// ---------------------------------------------------------------- the round trip

function roundTripWithTools() {
  const state = transcriptWithTools()
  const snapshot = serializeTranscript(state)

  // It must be JSON-clean and schema-valid, or the main-side validation would refuse it.
  const throughJson = JSON.parse(JSON.stringify(snapshot)) as unknown
  const parsed = transcriptSnapshotSchema.safeParse(throughJson)
  assert.equal(parsed.success, true, `the snapshot must satisfy the shared schema: ${parsed.error?.message}`)

  const restored = rehydrateTranscript(parsed.data ?? null)
  assert.deepEqual(restored.turns, state.turns, 'turns survive the round trip exactly')

  // The denied card in particular: its status and code are what the UI branches on.
  const denied = restored.turns[1].steps[1]
  assert.equal(denied.status, 'denied', 'a denied approval stays denied')
  assert.equal(denied.code, 'DENIED', 'and keeps its code')
  assert.equal(denied.output, 'Denied by you.', 'and its note')

  results.push('a transcript with tool cards and a denial round-trips through JSON and the schema')
}

function theReaderAcceptsWhatTheWriterProduces() {
  // Written and read by the same schema, which is the property that keeps a save from producing a
  // file the loader then calls corrupt.
  for (const state of [blankTranscript(), transcriptWithTools()]) {
    const parsed = transcriptSnapshotSchema.safeParse(JSON.parse(JSON.stringify(serializeTranscript(state))))
    assert.equal(parsed.success, true, 'what we write must parse with what we read')
  }
  results.push('the writer and the reader agree on one schema')
}

function absentIsEmpty() {
  const restored = rehydrateTranscript(null)
  assert.deepEqual(restored.turns, [], 'a session with no file opens empty')
  assert.equal(restored.interrupted, false)
  results.push('a session with no saved file opens as an empty conversation')
}

function theInstructionsRecordRoundTrips() {
  const state: TranscriptState = {
    interrupted: false,
    turns: [
      {
        id: 'user-1',
        role: 'user',
        content: 'tighten the loop',
        steps: [],
        instructionsFile: 'AGENTS.md',
        instructionsTruncated: true,
      },
      { id: 'assistant-2', role: 'assistant', content: 'Done.', steps: [], instructionsFile: 'AGENTS.md' },
    ],
  }

  const snapshot = serializeTranscript(state)
  assert.equal(snapshot.turns[0].instructionsFile, 'AGENTS.md', 'the name is written')
  assert.equal(snapshot.turns[0].instructionsTruncated, true, 'the cap is written')
  // A turn that recorded a name but not the flag carries only the name, rather than a false `false`.
  assert.equal(snapshot.turns[1].instructionsFile, 'AGENTS.md')
  assert.equal(
    'instructionsTruncated' in snapshot.turns[1],
    false,
    'an unrecorded flag is omitted rather than defaulted'
  )

  const parsed = transcriptSnapshotSchema.safeParse(JSON.parse(JSON.stringify(snapshot)))
  assert.equal(parsed.success, true, 'the record survives the shared schema')
  assert.deepEqual(
    rehydrateTranscript(parsed.data ?? null).turns,
    state.turns,
    'and comes back on the turns it was recorded on'
  )

  // An ordinary conversation gains no key at all: this is what keeps it reading exactly as it did
  // before the record existed, which is the additive-schema property stated as a test.
  const plain = serializeTranscript({
    interrupted: false,
    turns: [{ id: 'user-1', role: 'user', content: 'hello', steps: [] }],
  })
  assert.deepEqual(Object.keys(plain.turns[0]).sort(), ['content', 'id', 'role', 'steps'])
  results.push('the instructions record round-trips, and a conversation without one is written unchanged')
}

// ---------------------------------------------------------------- interruption

function anUnfinishedTurnIsInterrupted() {
  const midRun: TranscriptState = {
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'run the tests', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Running them. ',
        steps: [{ callId: 'c1', tool: 'run_command', args: { command: 'npm test' }, status: 'running' }],
      },
    ],
  }

  const snapshot = serializeTranscript(midRun)
  assert.equal(snapshot.interrupted, true, 'a turn cut off mid-run is recorded as interrupted')

  const restored = rehydrateTranscript(snapshot)
  assert.equal(restored.interrupted, true, 'and comes back interrupted')
  assert.equal(restored.turns.length, 2, 'the turns are still there — nothing is lost')
  assert.ok(INTERRUPTED_NOTE.length > 0, 'there is wording for it')
  results.push('a turn interrupted mid-run is marked, and keeps its turns')
}

function aPauseIsNotAnInterruption() {
  const paused: TranscriptState = {
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'go', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        steps: [{ callId: 'c1', tool: 'write_file', args: {}, status: 'awaiting' }],
      },
    ],
  }
  // `awaiting` is a legitimate state, not an interruption: the user stepped away, the app did not.
  assert.equal(serializeTranscript(paused).interrupted, false, 'a pause is not an interruption')
  results.push('a pause for approval is not reported as an interruption')
}

// ---------------------------------------------------------------- numbering

function numberingResumesPastRestoredTurns() {
  // The reducer counts turns from a module-level counter. Reopening a saved conversation must not
  // restart it, or new turns would reuse ids already in the file.
  const restored = rehydrateTranscript(serializeTranscript(transcriptWithTools()))
  resumeTurnNumbering(restored.turns)

  const next = startAssistantTurn()
  assert.ok(!restored.turns.some((t) => t.id === next.id), `a new turn must not reuse a restored id (${next.id})`)

  // And a user turn, from the same counter.
  const nextUser = startUserTurn('hello')
  assert.ok(!restored.turns.some((t) => t.id === nextUser.id), 'nor for a user turn')
  results.push('turn numbering resumes past a restored transcript, so ids cannot collide')
}

// ---------------------------------------------------------------- debounce

function debouncedSavesCoalesce() {
  const pending = new Set<() => void>()
  const clock = {
    schedule: ((fn: () => void) => {
      pending.add(fn)
      return fn as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    cancel: ((handle: unknown) => pending.delete(handle as () => void)) as unknown as typeof clearTimeout,
    advance: () => {
      for (const fn of [...pending]) {
        pending.delete(fn)
        fn()
      }
    },
  }

  let saves = 0
  const debounced = createDebouncedSave(() => {
    saves += 1
  }, clock)

  debounced.schedule()
  debounced.schedule()
  debounced.schedule()
  assert.equal(saves, 0, 'nothing is saved before the window closes')
  assert.equal(pending.size, 1, 'three schedules share one timer')

  clock.advance()
  assert.equal(saves, 1, 'one save for the burst')

  // A flush with nothing pending must not save.
  debounced.flush()
  assert.equal(saves, 1, 'flushing with nothing queued does nothing')

  // Scheduled then flushed early: one save, not two.
  debounced.schedule()
  debounced.flush()
  assert.equal(saves, 2, 'an early flush saves once')
  clock.advance()
  assert.equal(saves, 2, 'and the timer it replaced must not fire again')

  results.push('post-turn saves coalesce into one, and flush exactly once')
}

// ---------------------------------------------------------------- relative time

function relativeTimes() {
  const now = 1_700_000_000_000
  const ago = (ms: number) => formatRelativeTime(now - ms, now)

  assert.equal(ago(5_000), 'just now', 'seconds read as just now')
  assert.equal(ago(90_000), '1m ago')
  assert.equal(ago(2 * 3_600_000), '2h ago', 'the documented example')
  assert.equal(ago(3 * 86_400_000), '3d ago')
  assert.equal(ago(10 * 86_400_000), '1w ago')
  assert.equal(ago(60 * 86_400_000), '2mo ago')
  assert.equal(ago(400 * 86_400_000), '1y ago')

  // A timestamp ahead of the clock reads as "just now", never as a negative age.
  assert.equal(formatRelativeTime(now + 60_000, now), 'just now', 'clock skew must not read as negative')
  results.push('relative ages read as minutes, hours, days, weeks, months, and years')
}

// ---------------------------------------------------------------- the store

async function storeOrderingAndLifecycle() {
  const harness = createStoreHarness()

  harness.run('addSession', { id: uuid(1), title: 'First', providerId: 'deepseek', model: 'm' })
  backdateStore(harness, uuid(1), 1_000)
  harness.run('addSession', { id: uuid(2), title: 'Second', providerId: 'deepseek', model: 'm' })
  backdateStore(harness, uuid(2), 2_000)

  // Most recent first.
  assert.deepEqual(
    harness.state().sessions.map((s) => s.title),
    ['Second', 'First'],
    'sessions are ordered most recent first'
  )

  // Touching an older one moves it to the top.
  harness.run('touchSession', { id: uuid(1) })
  assert.equal(harness.state().sessions[0].title, 'First', 'touching a session moves it to the top')

  // addSession is idempotent.
  harness.run('addSession', { id: uuid(1), title: 'Duplicate', providerId: 'deepseek', model: 'm' })
  assert.equal(harness.state().sessions.length, 2, 're-adding an id does not duplicate the row')
  assert.equal(harness.state().sessions.find((s) => s.id === uuid(1))?.title, 'First', 'and does not rename it')

  // Removing the active session clears the pointer.
  harness.run('setActive', { id: uuid(2) })
  assert.equal(harness.state().activeSessionId, uuid(2))
  harness.run('removeSession', { id: uuid(2) })
  assert.equal(harness.state().activeSessionId, null, 'removing the active session clears it')
  assert.equal(harness.state().sessions.length, 1)

  results.push('the store orders by recency, is idempotent, and clears a removed active id')
}

function uuid(n: number): string {
  const tail = String(n).padStart(12, '0')
  return `11111111-2222-4333-8444-${tail}`
}

// ---------------------------------------------------------------- search rows

/** Two conversations from the store, in the order the store would give them. */
function twoRows() {
  const base = { createdAt: 1, updatedAt: 1, providerId: 'deepseek', model: 'deepseek-chat' }
  return [
    { id: uuid(1), title: 'the parser drops newlines', ...base },
    { id: uuid(2), title: 'unrelated subject entirely', ...base },
  ]
}

function aBodyOnlyMatchStillGetsARow() {
  const rows = twoRows()

  // The defect this rule exists for: "fibonacci" appears in no title, only in session 2's
  // transcript. Before the union, the panel filtered on titles and the scan could only decorate the
  // rows that survived — so a body match produced an empty list, and the panel said no conversation
  // matched about a conversation that did.
  const bodyOnly = planVisibleSessions(rows, 'fibonacci', [uuid(2)])
  assert.deepEqual(
    bodyOnly.map((s) => s.id),
    [uuid(2)],
    'a session matched only in its body must appear, on its own'
  )

  // Its snippets come from the same result set, keyed by id.
  const scanResults = [{ id: uuid(2), matchCount: 2, snippets: ['…fibonacci script…'] }]
  const match = snippetsFor(uuid(2), scanResults)
  assert.equal(match?.matchCount, 2, 'the body match carries its count')
  assert.deepEqual(match?.snippets, ['…fibonacci script…'], 'and its snippets')
  results.push('a body-only match yields that session id, with its snippets and count')
}

function aTitleOnlyMatchHasNoSnippets() {
  const rows = twoRows()

  // "newlines" is in session 1's title and, per the scan's answer, nowhere in any body: the row is
  // there because of its name, and there is nothing to excerpt under it.
  const titleOnly = planVisibleSessions(rows, 'newlines', [])
  assert.deepEqual(
    titleOnly.map((s) => s.id),
    [uuid(1)],
    'a title match stands with an empty scan result'
  )
  assert.equal(snippetsFor(uuid(1), []), undefined, 'and has no snippets to attach')
  assert.equal(snippetsFor(uuid(1), undefined), undefined, 'nor while the scan is in flight')
  results.push('a title-only match yields that session id with zero snippets')
}

function theUnionKeepsBothAndTheScanOrderDoesNotWin() {
  const rows = twoRows()

  // Session 1 matches by title, session 2 by body: both are in the list, in the *store's* order.
  const both = planVisibleSessions(rows, 'e', [uuid(2)])
  assert.deepEqual(
    both.map((s) => s.id),
    [uuid(1), uuid(2)],
    'the union keeps both, in metadata order'
  )

  // The scan answers in directory order, which is not the list's order. Reversing the ids it returns
  // must not reorder the rows: the scan decides *membership*, never position.
  const reversed = planVisibleSessions(rows, 'zzz', [uuid(2), uuid(1)])
  assert.deepEqual(
    reversed.map((s) => s.id),
    [uuid(1), uuid(2)],
    'the scan cannot reorder the list'
  )

  // A scan id that names no known session is ignored rather than invented as a row.
  const unknown = planVisibleSessions(rows, 'zzz', ['99999999-8888-4777-8666-555555555555'])
  assert.deepEqual(unknown, [], 'an unknown id contributes nothing')
  results.push('the union is by membership only: store order holds, and unknown ids add nothing')
}

function anEmptyTermIsNotAFilter() {
  const rows = twoRows()

  // No needle means there is nothing to be a match of, so the metadata list is the answer — even if a
  // scan from a previous term is somehow still in hand.
  assert.deepEqual(
    planVisibleSessions(rows, '', [uuid(2)]).map((s) => s.id),
    [uuid(1), uuid(2)]
  )
  assert.deepEqual(
    planVisibleSessions(rows, '   ', [uuid(1)]).map((s) => s.id),
    [uuid(1), uuid(2)]
  )

  // And an undefined scan result — the in-flight state — leaves the title rule standing alone.
  assert.deepEqual(
    planVisibleSessions(rows, 'parser', undefined).map((s) => s.id),
    [uuid(1)],
    'before the scan answers, the title rule alone decides'
  )
  results.push('an empty term is not a filter, and an in-flight scan does not widen the list')
}

function titleMatchingIsCaseInsensitiveAndTrimmed() {
  const rows = twoRows()
  assert.deepEqual(
    planVisibleSessions(rows, 'PARSER', []).map((s) => s.id),
    [uuid(1)],
    'casing is ignored'
  )
  assert.deepEqual(
    planVisibleSessions(rows, '  parser  ', []).map((s) => s.id),
    [uuid(1)],
    'the term is trimmed'
  )
  assert.equal(isSearchable('ab', SEARCH_MIN_TERM), false, 'two characters is below the floor')
  assert.equal(isSearchable('par', SEARCH_MIN_TERM), true, 'three characters reaches it')
  results.push('the title rule is case-insensitive and trimmed, and the floor is shared')
}

// ---------------------------------------------------------------- report

async function main() {
  await step('titles', titles)
  await step('dirtiness', dirtyRules)
  await step('pause not persisted', thePauseIsNotPersisted)
  await step('round trip', roundTripWithTools)
  await step('schema agreement', theReaderAcceptsWhatTheWriterProduces)
  await step('absent file', absentIsEmpty)
  await step('instructions record', theInstructionsRecordRoundTrips)
  await step('interruption', anUnfinishedTurnIsInterrupted)
  await step('pause is not interruption', aPauseIsNotAnInterruption)
  await step('numbering', numberingResumesPastRestoredTurns)
  await step('debounce', debouncedSavesCoalesce)
  await step('relative time', relativeTimes)
  await step('store lifecycle', storeOrderingAndLifecycle)
  await step('search rows: body match', aBodyOnlyMatchStillGetsARow)
  await step('search rows: title match', aTitleOnlyMatchHasNoSnippets)
  await step('search rows: union order', theUnionKeepsBothAndTheScanOrderDoesNotWin)
  await step('search rows: empty term', anEmptyTermIsNotAFilter)
  await step('search rows: title matching', titleMatchingIsCaseInsensitiveAndTrimmed)

  console.log(`chat sessions: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CHAT SESSIONS TEST FAILED:', err)
  process.exit(1)
})
