/**
 * Verifies what a conversation knows about its project, and what the window does with it.
 *
 * Three subjects, each of which is invisible when it is wrong: which folder a session click opens,
 * whether that click is allowed while a turn is live, and which folder a turn start records. They are
 * rules rather than wiring, so they are exercised here without a DOM — the click itself is covered by
 * `testing/session-project-wiring.test.tsx`.
 *
 * The store half is asserted at the layer that actually persists: main registers the store with
 * `persist`, the state is serialised as JSON under `userData`, and it is shallow-merged over the
 * definition's initial state on the next launch. `rehydrate` below is that merge, so what is pinned is
 * that a project written by one run is read back by the next, and that an entry written before
 * sessions had projects reads as one that has none. Nothing to clean up: the harness clones its state
 * and the JSON is a string.
 */
import { strict as assert } from 'node:assert'
import { chatSessionsStore, type ChatSession } from '../../conveyor/stores/chat-sessions'
import { backdateStore, createStoreHarness } from './chat-sessions-store-harness'
import {
  groupSessionsByRoot,
  planRootStamp,
  planSelectRoot,
  planSessionSwitch,
  selectNotice,
  SELECT_REFUSED_DECISION,
  SELECT_REFUSED_TURN,
} from '../../app/components/workbench/session-project'
import { WORKSPACE_MISSING } from '../../conveyor/protocol/recent-roots'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

const SAM = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'
const THIRD = 'cccccccc-3333-4333-8333-333333333333'

/** What main's registration does with the persisted file: shallow-merged over the initial state. */
function rehydrate(persisted: unknown): { sessions: ChatSession[]; activeSessionId: string | null } {
  const initial = structuredClone(
    (chatSessionsStore as unknown as { initialState: { sessions: ChatSession[]; activeSessionId: string | null } })
      .initialState
  )
  return { ...initial, ...(persisted as Record<string, unknown>) }
}

/** One row as the list would hold it. Absent is spelled by leaving the field out entirely. */
function row(id: string, updatedAt: number, lastRoot?: string): ChatSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(lastRoot === undefined ? {} : { lastRoot }),
  }
}

// ---------------------------------------------------------------- selecting a session

function aStampedSessionOpensItsOwnProject() {
  const plan = planSelectRoot({ sessionLastRoot: NOTES, currentRoot: SAM })

  assert.equal(plan.switchTo, NOTES, 'the click opens the folder the session was last used in')
  results.push('select: a stamped session opens its own project')
}

function anUnstampedSessionLeavesTheWindowAlone() {
  // No project yet — a conversation from before sessions recorded one, or one that has never had a
  // turn. Its first turn is what stamps it, and that turn runs where the user is already working.
  const plan = planSelectRoot({ sessionLastRoot: undefined, currentRoot: SAM })

  assert.equal(plan.switchTo, null, 'nothing to open, nothing to report')
  results.push('select: a session with no project keeps the open folder, silently')
}

function aSessionAlreadyInTheOpenFolderOpensNothing() {
  assert.equal(planSelectRoot({ sessionLastRoot: SAM, currentRoot: SAM }).switchTo, null)
  // The same folder spelled with another case is the same folder: re-opening it would be a `stat` and
  // a store write to arrive back where the user already is.
  assert.equal(planSelectRoot({ sessionLastRoot: 'c:/WORK/sam-ai', currentRoot: SAM }).switchTo, null)
  assert.equal(
    planSelectRoot({ sessionLastRoot: NOTES, currentRoot: null }).switchTo,
    NOTES,
    'with no folder open, the session supplies one'
  )
  results.push('select: the open project is not re-opened, whatever case it is spelled in')
}

// ---------------------------------------------------------------- the guards

function aStreamingTurnRefusesTheClick() {
  const refusal = planSessionSwitch({ streaming: true, pendingDecision: false, movesRoot: true })

  assert.equal(refusal, SELECT_REFUSED_TURN)
  // Unconditional, and that is the point: a run is writing into the transcript on screen, so opening
  // another conversation would hand it the rest of an answer it was never about — whichever folder
  // the other session belongs to.
  assert.equal(planSessionSwitch({ streaming: true, pendingDecision: false, movesRoot: false }), SELECT_REFUSED_TURN)
  results.push('guard: a streaming turn refuses a session click')
}

function aPendingDecisionRefusesAClickThatMovesTheProject() {
  const refusal = planSessionSwitch({ streaming: false, pendingDecision: true, movesRoot: true })

  // The resume behind the card runs with the folder the window is showing when it is answered, so a
  // selection that moved the workspace would redirect that turn's tool paths.
  assert.equal(refusal, SELECT_REFUSED_DECISION)
  results.push('guard: a pending decision refuses a click that would move the workspace')
}

function aPendingDecisionDoesNotBlockAnotherProject() {
  // A pause is a question about one conversation and is held per conversation, so leaving one standing
  // to read something else is safe — and is what the app did before this guard existed. What is
  // refused is moving the workspace under a turn that is still to be resumed, not switching as such.
  assert.equal(planSessionSwitch({ streaming: false, pendingDecision: true, movesRoot: false }), null)
  assert.equal(planSessionSwitch({ streaming: false, pendingDecision: false, movesRoot: true }), null)
  results.push('guard: a pending decision leaves a click inside the same project alone')
}

// ---------------------------------------------------------------- the notices

function theMissingFolderIsNamedAndTheOpenOneStays() {
  const notice = selectNotice(WORKSPACE_MISSING, { path: ARCHIVE, currentRoot: SAM })

  assert.ok(notice.includes(ARCHIVE), 'the notice names the folder that is gone')
  assert.ok(/no longer there/i.test(notice))
  assert.ok(notice.includes('sam-ai'), 'and the folder that stays open, by its last segment')
  results.push('notice: a missing project is named, and the open folder stays')
}

function anUnknownCodeStillSaysTheWorkspaceWasKept() {
  const notice = selectNotice('SOMETHING_ELSE', { path: NOTES, currentRoot: SAM })

  // Never main's sentence, and never silence: an unrecognised failure still has to leave the user
  // knowing that nothing moved.
  assert.ok(notice.includes(NOTES))
  assert.ok(!notice.includes('SOMETHING_ELSE'), 'a code is not a sentence to show')
  results.push('notice: an unrecognised code says the workspace stayed where it was')
}

// ---------------------------------------------------------------- stamping at a turn start

function aTurnInAnotherFolderRecordsIt() {
  assert.equal(planRootStamp({ sessionLastRoot: NOTES, windowRoot: SAM }), SAM)
  assert.equal(
    planRootStamp({ sessionLastRoot: undefined, windowRoot: SAM }),
    SAM,
    'an unstamped session is stamped by its first turn'
  )
  results.push('stamp: a turn records the folder it started in')
}

function aTurnInTheSameFolderWritesNothing() {
  assert.equal(planRootStamp({ sessionLastRoot: SAM, windowRoot: SAM }), null)
  // A differently-cased spelling is the same folder, so it is not a reason to write.
  assert.equal(planRootStamp({ sessionLastRoot: 'C:/WORK/sam-ai', windowRoot: SAM }), null)
  results.push('stamp: a turn in the recorded folder writes nothing')
}

function noFolderOpenWritesNothing() {
  // Absent means "no project yet". An empty stamp would mean something else, and be wrong.
  assert.equal(planRootStamp({ sessionLastRoot: undefined, windowRoot: null }), null)
  assert.equal(planRootStamp({ sessionLastRoot: NOTES, windowRoot: null }), null)
  results.push('stamp: no folder open is not a project, so nothing is recorded')
}

// ---------------------------------------------------------------- the store

/** The action schemas, read the way main reads them: as the gate every renderer payload passes. */
interface ParsedSchema {
  safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> }
}

function theProjectFieldIsOptionalAndNothingIsInvented() {
  const schema = (chatSessionsStore.schemas as unknown as { touchSession: ParsedSchema }).touchSession

  const without = schema.safeParse({ id: FIRST, title: 'a title' })
  assert.ok(without.success, 'a payload that says nothing about a project is still valid')
  assert.equal('lastRoot' in (without.data ?? {}), false, 'and no project is invented for it')

  const withRoot = schema.safeParse({ id: FIRST, lastRoot: NOTES })
  assert.ok(withRoot.success)
  assert.equal(withRoot.data?.lastRoot, NOTES)

  assert.equal(schema.safeParse({ id: FIRST, lastRoot: '' }).success, false, 'an empty path is not a project')

  const extra = schema.safeParse({ id: FIRST, lastRoot: NOTES, nonsense: 1 })
  assert.ok(extra.success)
  assert.equal('nonsense' in (extra.data ?? {}), false, 'unknown keys are stripped rather than written through')
  results.push('schema: the project is optional, absent stays absent, unknown keys are stripped')
}

function aStampedProjectSurvivesSaveAndRehydrate() {
  const before = createStoreHarness()
  before.run('addSession', { id: FIRST, title: 'notes work', providerId: 'deepseek', model: 'deepseek-chat' })
  before.run('touchSession', { id: FIRST, lastRoot: NOTES })

  const after = rehydrate(JSON.parse(JSON.stringify(before.state())) as unknown)
  const restored = after.sessions.find((session) => session.id === FIRST)

  assert.equal(restored?.lastRoot, NOTES, 'the project is still there on the next launch')
  results.push('store: a stamped project survives the round trip')
}

function aLegacyEntryReadsAbsentAndStaysAbsent() {
  // An entry written before sessions had projects: no key at all, and nothing may invent one — an
  // invented project would move the window on a click that has no business moving it.
  const harness = createStoreHarness()
  harness.run('addSession', { id: SECOND, title: 'old conversation', providerId: 'deepseek', model: 'deepseek-chat' })

  const persisted = JSON.parse(JSON.stringify(harness.state())) as { sessions: ChatSession[] }
  const after = rehydrate(persisted)
  const restored = after.sessions.find((session) => session.id === SECOND)

  assert.ok(restored)
  assert.equal('lastRoot' in restored, false, 'a legacy entry stays unstamped')
  assert.equal(planSelectRoot({ sessionLastRoot: restored.lastRoot, currentRoot: SAM }).switchTo, null)
  results.push('store: a legacy entry reads absent and keeps today’s behaviour')
}

function aTouchThatSaysNothingAboutTheProjectLeavesTheStamp() {
  const harness = createStoreHarness()
  harness.run('addSession', { id: THIRD, title: 'work', providerId: 'deepseek', model: 'deepseek-chat' })
  harness.run('touchSession', { id: THIRD, lastRoot: NOTES })
  // A rename, or a model switch: the caller names neither the project nor anything else it is not
  // changing, so the stamp must survive it.
  harness.run('touchSession', { id: THIRD, title: 'renamed' })

  const session = harness.state().sessions.find((row) => row.id === THIRD)
  assert.equal(session?.title, 'renamed')
  assert.equal(session?.lastRoot, NOTES, 'an unrelated touch does not lose the project')

  // And the stamp is a store write like any other, so the list's own order follows it.
  backdateStore(harness, THIRD, 1)
  harness.run('touchSession', { id: THIRD, lastRoot: SAM })
  assert.equal(harness.state().sessions.find((row) => row.id === THIRD)?.lastRoot, SAM)
  results.push('store: touching a session for another reason leaves its project alone')
}

// ---------------------------------------------------------------- grouping

function theOpenProjectComesFirstThenByActivityThenUnstamped() {
  const sessions = [row(FIRST, 300, NOTES), row(SECOND, 200, ARCHIVE), row(THIRD, 400, SAM)]
  const older = row('dddddddd-4444-4444-8444-444444444444', 100, NOTES)
  const legacy = row('eeeeeeee-5555-4555-8555-555555555555', 500)

  const groups = groupSessionsByRoot([...sessions, older, legacy], SAM)

  assert.deepEqual(
    groups.map((group) => group.root),
    [SAM, NOTES, ARCHIVE, null],
    'the open project, then the others by activity, then the ones with no project'
  )
  assert.deepEqual(
    groups.find((group) => group.root === NOTES)?.sessions.map((session) => session.id),
    [FIRST, older.id],
    'a project keeps the store’s order inside it'
  )
  assert.deepEqual(
    groups[groups.length - 1].sessions.map((session) => session.id),
    [legacy.id]
  )
  results.push('grouping: the open project first, other projects by activity, unstamped last')
}

function oneFolderIsOneGroupWhateverItsCase() {
  const groups = groupSessionsByRoot([row(FIRST, 300, NOTES), row(SECOND, 200, 'c:/WORK/notes')], null)

  assert.equal(groups.length, 1, 'two spellings of one folder are one project')
  assert.equal(groups[0].sessions.length, 2)
  results.push('grouping: one folder is one group, however it is spelled')
}

function aGroupIsLabelledWithTheSpellingItsNewestSessionCarries() {
  const groups = groupSessionsByRoot([row(FIRST, 300, NOTES), row(SECOND, 200, 'c:/WORK/notes')], null)

  assert.equal(groups[0].root, NOTES, 'the spelling the user last saw the folder under')
  assert.deepEqual(
    groups[0].sessions.map((session) => session.updatedAt),
    [300, 200],
    'newest first'
  )
  results.push('grouping: a group takes the newest spelling it holds')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('select: opens its project', aStampedSessionOpensItsOwnProject)
  step('select: no project', anUnstampedSessionLeavesTheWindowAlone)
  step('select: already open', aSessionAlreadyInTheOpenFolderOpensNothing)
  step('guard: streaming', aStreamingTurnRefusesTheClick)
  step('guard: pending move', aPendingDecisionRefusesAClickThatMovesTheProject)
  step('guard: pending, same project', aPendingDecisionDoesNotBlockAnotherProject)
  step('notice: missing', theMissingFolderIsNamedAndTheOpenOneStays)
  step('notice: unknown', anUnknownCodeStillSaysTheWorkspaceWasKept)
  step('stamp: another folder', aTurnInAnotherFolderRecordsIt)
  step('stamp: same folder', aTurnInTheSameFolderWritesNothing)
  step('stamp: no folder', noFolderOpenWritesNothing)
  step('schema: optional', theProjectFieldIsOptionalAndNothingIsInvented)
  step('store: round trip', aStampedProjectSurvivesSaveAndRehydrate)
  step('store: legacy entry', aLegacyEntryReadsAbsentAndStaysAbsent)
  step('store: unrelated touch', aTouchThatSaysNothingAboutTheProjectLeavesTheStamp)
  step('grouping: order', theOpenProjectComesFirstThenByActivityThenUnstamped)
  step('grouping: one folder', oneFolderIsOneGroupWhateverItsCase)
  step('grouping: label', aGroupIsLabelledWithTheSpellingItsNewestSessionCarries)

  console.log(`session project: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('SESSION PROJECT TEST FAILED:', err)
  process.exit(1)
}
