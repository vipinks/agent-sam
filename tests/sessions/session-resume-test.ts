/**
 * Reproduces the two Phase 7 defects against the pure coordination function, then pins the fix.
 *
 * These are written against the *reported symptoms*, not against the implementation: a click on a
 * persisted-but-unloaded session must load and render its turns, and a first message in an untitled
 * session must name it. Both fail against the Phase 7 code, which is the point — a test that passes
 * before the fix would not be reproducing anything.
 */
import { strict as assert } from 'node:assert'
import {
  deriveRepairTitle,
  planFirstSend,
  planResume,
  planIsNoop,
} from '../../app/components/workbench/session-resume'
import { serializeTranscript, type TranscriptState } from '../../app/components/workbench/session-transcript'
import { titleFromMessage, UNTITLED } from '../../app/components/workbench/session-rules'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- fixtures

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'

/** A saved conversation with prose and a tool card — the shape the pane has to render. */
function savedTranscript(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'Write fibonacci.py and run it', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Done — it prints the first ten.',
        steps: [
          {
            callId: 'call_1',
            tool: 'write_file',
            args: { path: 'fibonacci.py' },
            status: 'ok',
            output: 'Wrote 42 bytes.',
          },
        ],
      },
    ],
  }
}

function emptyTranscript(): TranscriptState {
  return { turns: [], interrupted: false }
}

// ---------------------------------------------------------------- Bug A

/**
 * The reported failure: the app restarts, the store restores `activeSessionId`, and the user clicks
 * that very row. The transcript is on screen as empty; the click must load it.
 */
function clickingTheRestoredActiveSessionLoads() {
  const loaded = savedTranscript()
  const plan = planResume({
    requestedId: A,
    // Nothing has been loaded yet — this is the state the bug lived in.
    hydratedId: null,
    transcript: emptyTranscript(),
    savedSnapshot: null,
    loaded,
    metadataTitle: 'Write fibonacci.py and run it',
  })

  assert.equal(plan.loadId, A, 'clicking the active-but-unloaded session must load it from disk')
  assert.ok(plan.apply, 'and the loaded turns must be applied to the transcript')
  assert.equal(plan.apply.turns.length, 2, 'both turns reach the pane')
  assert.ok(
    plan.apply.turns[1].steps.length === 1,
    'including the tool card, which is the thing that proves it rehydrated rather than re-created'
  )

  results.push('clicking the restored active session loads and applies its transcript')
}

/**
 * The other half of the guard's intent, which must keep working: clicking the row you are already
 * looking at should not throw away what is on screen and reload it.
 */
function clickingTheAlreadyLoadedSessionIsANoop() {
  const loaded = savedTranscript()
  const onScreen: TranscriptState = {
    turns: [
      { id: 'user-1', role: 'user', content: 'Write fibonacci.py and run it', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Done — it prints the first ten.',
        steps: [{ callId: 'call_1', tool: 'write_file', args: { path: 'fibonacci.py' }, status: 'ok', output: 'Wrote 42 bytes.' }],
      },
    ],
    interrupted: false,
  }

  const plan = planResume({
    requestedId: A,
    // Loaded: this is the case the guard was written for.
    hydratedId: A,
    transcript: onScreen,
    savedSnapshot: serializeTranscript(onScreen),
    loaded,
    metadataTitle: 'Write fibonacci.py and run it',
  })

  assert.equal(planIsNoop(plan), true, 're-clicking the loaded session must not reload or re-save it')
  results.push('clicking the session already on screen is a no-op')
}

function switchingSavesFirst() {
  const onScreen = savedTranscript()
  const loaded = serializeTranscript({
    turns: [{ id: 'user-1', role: 'user', content: 'a different conversation', steps: [] }],
    interrupted: false,
  })

  const plan = planResume({
    requestedId: B,
    hydratedId: A,
    transcript: { turns: onScreen.turns, interrupted: false },
    // Nothing written yet, so it is dirty.
    savedSnapshot: null,
    loaded,
    metadataTitle: 'a different conversation',
  })

  assert.equal(plan.saveFirst, true, 'leaving a session with unsaved turns must save first')
  assert.equal(plan.activateId, B, 'and activate the requested session')
  assert.equal(plan.loadId, B, 'and load it')

  results.push('switching sessions saves the current transcript first')
}

function switchingFromNothingLoadedDoesNotSave() {
  // The dangerous case: with no transcript loaded, "save before switching" would write an empty
  // conversation over an existing one on disk.
  const plan = planResume({
    requestedId: B,
    hydratedId: null,
    transcript: emptyTranscript(),
    savedSnapshot: null,
    loaded: savedTranscript(),
    metadataTitle: 'anything',
  })

  assert.equal(plan.saveFirst, false, 'there is nothing on screen worth saving')
  assert.equal(plan.loadId, B, 'and the requested session still loads')
  results.push('switching with nothing loaded does not save an empty transcript')
}

function aSessionWithNoFileOpensEmpty() {
  // A session created but never used has no file. Loading must not be treated as a failure.
  const plan = planResume({
    requestedId: B,
    hydratedId: null,
    transcript: emptyTranscript(),
    savedSnapshot: null,
    loaded: null,
    metadataTitle: UNTITLED,
  })

  assert.equal(plan.loadId, B, 'the load still happens')
  assert.equal(plan.apply?.turns.length, 0, 'and it opens empty')
  assert.equal(plan.repairTitle, null, 'with no title to derive, since there is no message yet')
  results.push('a session with no file opens empty rather than failing')
}

// ---------------------------------------------------------------- Bug B

/**
 * The reported failure: every row says "Untitled conversation" after a first message.
 */
function aFirstMessageNamesAnUntitledSession() {
  const plan = planFirstSend({
    // Active from the store, but never named and never hydrated — the state live use reached.
    activeId: A,
    activeTitle: UNTITLED,
    message: 'Write me a fibonacci script please',
    isHydrated: false,
  })

  assert.equal(plan.title, 'Write me a fibonacci script please', 'the first message must name the session')
  results.push('a first message in an untitled session derives and returns its title')
}

function aFirstMessageInAnUnloadedSessionStillNamesIt() {
  // The same case reached by a different route: the session exists in the store as active (restored
  // on restart), the user types, and the title must still be derived.
  const plan = planFirstSend({
    activeId: B,
    activeTitle: UNTITLED,
    message: 'help me debug this',
    isHydrated: false,
  })
  assert.equal(plan.title, 'help me debug this')
  results.push('an untitled session restored as active is still named by the next message')
}

function aLongMessageIsTruncated() {
  const plan = planFirstSend({
    activeId: A,
    activeTitle: UNTITLED,
    message: 'z'.repeat(200),
    isHydrated: true,
  })
  assert.ok(plan.title && plan.title.length <= 48, `the derived title must be clipped: ${plan.title?.length}`)
  assert.ok(plan.title?.endsWith('…'), 'and marked as clipped')
  results.push('a long first message is clipped to 48 characters')
}

function aNamedSessionIsNeverRenamed() {
  const plan = planFirstSend({
    activeId: A,
    activeTitle: 'Write me a fibonacci script please',
    message: 'and now something completely different',
    isHydrated: true,
  })

  // Later sends must not rename: the user recognises the session by its first-message name.
  assert.equal(plan.title, null, 'a named session must not be renamed by a later message')
  results.push('later messages do not rename a named session')
}

function sendingWithNoSessionCreatesOne() {
  const plan = planFirstSend({ activeId: null, activeTitle: null, message: 'first ever message', isHydrated: false })
  assert.equal(plan.create, true, 'with no session at all, one is created')
  assert.equal(plan.title, 'first ever message', 'and named from the message')
  results.push('sending with no session creates one and names it')
}

// ---------------------------------------------------------------- requirement 3

function anUntitledSessionRepairsItselfOnLoad() {
  // An existing row from before titles were applied: no name in the store, but a first user message
  // in the transcript. Loading it is the moment to fix it.
  const loaded = savedTranscript()
  const plan = planResume({
    requestedId: A,
    hydratedId: null,
    transcript: emptyTranscript(),
    savedSnapshot: null,
    loaded,
    metadataTitle: UNTITLED,
  })

  assert.equal(
    plan.repairTitle,
    'Write fibonacci.py and run it',
    'loading an untitled transcript must derive its title from the first user message'
  )
  results.push('an untitled session repairs its title when loaded')
}

function aNamedSessionIsNotRepaired() {
  const title = deriveRepairTitle('An existing name', {
    turns: [{ id: 'user-1', role: 'user', content: 'something else', steps: [] }],
    interrupted: false,
  })
  assert.equal(title, null, 'a session that already has a name must not be renamed on load')
  results.push('a named session is left alone on load')
}

function anEmptyTranscriptHasNothingToDeriveFrom() {
  assert.equal(deriveRepairTitle(UNTITLED, emptyTranscript()), null, 'no user message, no title')
  // A user turn whose content is blank is not a message worth naming a session after.
  assert.equal(
    deriveRepairTitle(UNTITLED, {
      turns: [{ id: 'user-1', role: 'user', content: '   ', steps: [] }],
      interrupted: false,
    }),
    null,
    'a blank message is not a title'
  )
  results.push('there is no repair without a real user message')
}

function theRepairUsesTheSameTruncation() {
  const long = 'q'.repeat(100)
  const title = deriveRepairTitle(UNTITLED, {
    turns: [{ id: 'user-1', role: 'user', content: long, steps: [] }],
    interrupted: false,
  })
  assert.equal(title, titleFromMessage(long), 'the repair and the send path derive titles identically')
  results.push('repair and first-send derive titles the same way')
}

// ---------------------------------------------------------------- report

function main() {
  step('Bug A: restored active session', clickingTheRestoredActiveSessionLoads)
  step('Bug A: already loaded is a no-op', clickingTheAlreadyLoadedSessionIsANoop)
  step('Bug A: save before switch', switchingSavesFirst)
  step('Bug A: nothing loaded', switchingFromNothingLoadedDoesNotSave)
  step('Bug A: no file', aSessionWithNoFileOpensEmpty)
  step('Bug B: first message names', aFirstMessageNamesAnUntitledSession)
  step('Bug B: unloaded session named', aFirstMessageInAnUnloadedSessionStillNamesIt)
  step('Bug B: truncation', aLongMessageIsTruncated)
  step('Bug B: no rename', aNamedSessionIsNeverRenamed)
  step('Bug B: create when none', sendingWithNoSessionCreatesOne)
  step('self-heal: on load', anUntitledSessionRepairsItselfOnLoad)
  step('self-heal: named left alone', aNamedSessionIsNotRepaired)
  step('self-heal: nothing to derive', anEmptyTranscriptHasNothingToDeriveFrom)
  step('self-heal: same truncation', theRepairUsesTheSameTruncation)

  console.log(`session resume: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
