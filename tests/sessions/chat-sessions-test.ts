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

// ---------------------------------------------------------------- report

async function main() {
  await step('titles', titles)
  await step('dirtiness', dirtyRules)
  await step('pause not persisted', thePauseIsNotPersisted)
  await step('round trip', roundTripWithTools)
  await step('schema agreement', theReaderAcceptsWhatTheWriterProduces)
  await step('absent file', absentIsEmpty)
  await step('interruption', anUnfinishedTurnIsInterrupted)
  await step('pause is not interruption', aPauseIsNotAnInterruption)
  await step('numbering', numberingResumesPastRestoredTurns)
  await step('debounce', debouncedSavesCoalesce)
  await step('relative time', relativeTimes)
  await step('store lifecycle', storeOrderingAndLifecycle)

  console.log(`chat sessions: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CHAT SESSIONS TEST FAILED:', err)
  process.exit(1)
})
