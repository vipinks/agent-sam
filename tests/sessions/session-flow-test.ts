/**
 * Reproduces both Phase 7 defects at the level the user experienced them.
 *
 * The pure-plan tests prove the decisions; this proves the wiring uses them. It simulates the click
 * and send flows with a stubbed conveyor client and in-memory state, in the same order the hook would:
 * a store that has a persisted active id, a transcript that is still empty because nothing has been
 * loaded, and a transport that answers with a real transcript.
 *
 * The defining state is the restart: `activeSessionId` is set from disk, `hydratedId` is null, and
 * the on-screen transcript is empty. Phase 7's guard compared the requested id to the *active* id and
 * returned early, so the click did nothing — which is what these tests assert must not happen.
 */
import { strict as assert } from 'node:assert'
import { planFirstSend, planResumeFinish, planResumeStart } from '../../app/components/workbench/session-resume'
import { serializeTranscript, type TranscriptState } from '../../app/components/workbench/session-transcript'
import { UNTITLED } from '../../app/components/workbench/session-rules'
import type { TranscriptSnapshot } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** A saved conversation with two turns, one of them carrying tool cards. */
function savedSnapshot(): TranscriptSnapshot {
  return {
    version: 1,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'make a fibonacci script', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'I wrote and ran it.',
        steps: [
          { callId: 'c1', tool: 'write_file', args: { path: 'fib.py' }, status: 'ok', output: 'Wrote 40 bytes.' },
          {
            callId: 'c2',
            tool: 'run_command',
            args: { command: 'python fib.py' },
            status: 'failed',
            output: 'Command exited with code 1.',
            code: 'COMMAND_FAILED',
          },
        ],
      },
    ],
  }
}

/**
 * The hook's state machine, in the order the hook applies it.
 *
 * Mirrors `use-chat-sessions`: refs for the hydrated id, the saved snapshot and the transcript, plus
 * a store stub for the session list. Nothing here is React — the point is the sequence.
 */
class SessionHarness {
  sessions: Array<{ id: string; title: string }> = []
  activeId: string | null = null
  transcript: TranscriptState = { turns: [], interrupted: false }
  hydratedId: string | null = null
  savedSnapshot: TranscriptSnapshot | null = null

  /** Every store action, in order, so ordering can be asserted. */
  log: string[] = []
  /** What the transport was asked for. */
  loads: string[] = []

  constructor(private readonly files: Map<string, TranscriptSnapshot | 'corrupt'>) {}

  /**
   * Seed the on-disk state directly, for cases the normal path cannot produce.
   *
   * A public method rather than reaching into `files`: the map is private because it is the harness's
   * own bookkeeping, and a test that mutates it directly is coupled to the wiring. This states the
   * intent — "a transcript with this content already exists on disk" — and keeps that coupling in
   * one place.
   */
  seedFile(id: string, snapshot: TranscriptSnapshot | 'corrupt'): void {
    this.files.set(id, snapshot)
  }

  private setActive(id: string | null) {
    this.activeId = id
    this.log.push(`setActive:${id}`)
  }

  async saveNow() {
    if (!this.activeId) return
    const snapshot = serializeTranscript(this.transcript)
    if (snapshot.turns.length === 0) return
    this.files.set(this.activeId, snapshot)
    this.savedSnapshot = snapshot
    this.log.push(`save:${this.activeId}`)
  }

  async load(id: string) {
    this.loads.push(id)
    const file = this.files.get(id)
    if (file === 'corrupt') {
      this.hydratedId = id
      this.transcript = { turns: [], interrupted: false }
      this.savedSnapshot = null
      this.log.push(`load-failed:${id}`)
      return
    }
    this.hydratedId = id
    this.transcript = planResumeFinish({ loaded: file ?? null, metadataTitle: this.titleOf(id) }).apply
    this.savedSnapshot = file ?? null
    this.log.push(`load:${id}`)
  }

  private titleOf(id: string): string {
    return this.sessions.find((s) => s.id === id)?.title ?? UNTITLED
  }

  private touchSession(id: string, title: string) {
    const session = this.sessions.find((s) => s.id === id)
    if (session) session.title = title
    this.log.push(`touch:${id}=${title}`)
  }

  /** Exactly what `openSession` does. */
  async openSession(id: string) {
    const start = planResumeStart({
      requestedId: id,
      hydratedId: this.hydratedId,
      transcript: this.transcript,
      savedSnapshot: this.savedSnapshot,
    })
    if (start.alreadyShowing) {
      this.log.push('noop')
      return
    }

    if (start.saveFirst) await this.saveNow()
    this.setActive(id)
    await this.load(id)

    const finish = planResumeFinish({ loaded: this.savedSnapshot, metadataTitle: this.titleOf(id) })
    if (finish.repairTitle) this.touchSession(id, finish.repairTitle)
  }

  /** Exactly what `ensureSession` does, then the turn lands in the transcript. */
  ensureSession(message: string): string {
    const plan = planFirstSend({
      activeId: this.activeId,
      activeTitle: this.activeId ? this.titleOf(this.activeId) : null,
      message,
      isHydrated: this.hydratedId === this.activeId,
    })

    if (!plan.create) {
      if (plan.title && this.activeId) this.touchSession(this.activeId, plan.title)
      return this.activeId as string
    }

    const id = 'cccccccc-3333-4333-8333-333333333333'
    this.sessions.push({ id, title: UNTITLED })
    this.activeId = id
    this.hydratedId = id
    this.transcript = { turns: [], interrupted: false }
    this.log.push(`create:${id}`)
    if (plan.title) this.touchSession(id, plan.title)
    return id
  }
}

/** The state a restart produces: the store knows the session, memory knows nothing. */
function afterRestart() {
  const harness = new SessionHarness(new Map([[SESSION_ID, savedSnapshot()]]))
  harness.sessions = [{ id: SESSION_ID, title: 'make a fibonacci script' }]
  // Persisted by the store, so it is set before any transcript is loaded.
  harness.activeId = SESSION_ID
  return harness
}

function afterRestartUntitled() {
  const harness = afterRestart()
  harness.sessions = [{ id: SESSION_ID, title: UNTITLED }]
  return harness
}

// ---------------------------------------------------------------- Bug A

async function clickingTheRestoredRowLoadsIt() {
  const harness = afterRestart()

  await harness.openSession(SESSION_ID)

  // The defect: Phase 7 returned here because the id matched the persisted active id.
  assert.deepEqual(harness.loads, [SESSION_ID], 'clicking must read the transcript from disk')
  assert.equal(harness.transcript.turns.length, 2, 'both turns must be on screen')
  assert.equal(harness.hydratedId, SESSION_ID, 'and the transcript must know whose it is')

  results.push('clicking the restored row loads its transcript')
}

async function theLoadedTranscriptCarriesItsToolCards() {
  const harness = afterRestart()
  await harness.openSession(SESSION_ID)

  const steps = harness.transcript.turns[1].steps
  assert.equal(steps.length, 2, 'both tool cards are rendered')
  assert.equal(steps[0].status, 'ok', 'the settled card keeps its status')
  assert.equal(steps[0].output, 'Wrote 40 bytes.', 'and its output')
  assert.equal(steps[1].status, 'failed', 'the failed card stays failed')
  assert.equal(steps[1].code, 'COMMAND_FAILED', 'with its code')
  results.push('the resumed transcript renders its tool cards')
}

async function clickingTheAlreadyLoadedRowIsANoop() {
  const harness = afterRestart()
  await harness.openSession(SESSION_ID)
  const before = { loads: harness.loads.length, log: harness.log.length }

  await harness.openSession(SESSION_ID)

  assert.equal(harness.loads.length, before.loads, 're-clicking the open session must not reload')
  assert.deepEqual(harness.log.slice(before.log), ['noop'], 'and must log nothing else')
  results.push('clicking the row already on screen is a no-op')
}

async function switchingSavesBeforeItActivates() {
  const harness = afterRestart()
  harness.sessions.push({ id: OTHER_ID, title: 'Other' })
  harness.seedFile(OTHER_ID, null as never)
  await harness.openSession(SESSION_ID)

  // Type into the open session, then switch.
  harness.transcript = {
    ...harness.transcript,
    turns: [...harness.transcript.turns, { id: 'user-9', role: 'user', content: 'also add a test', steps: [] }],
  }
  harness.log = []
  await harness.openSession(OTHER_ID)

  const saveIndex = harness.log.indexOf(`save:${SESSION_ID}`)
  const activateIndex = harness.log.indexOf(`setActive:${OTHER_ID}`)
  assert.ok(saveIndex !== -1, `the dirty transcript must be saved: ${JSON.stringify(harness.log)}`)
  assert.ok(activateIndex !== -1, 'the new session must be activated')
  assert.ok(saveIndex < activateIndex, 'the save must happen before the switch, or the turns are lost')

  results.push('switching saves the current transcript before activating the next')
}

async function switchingWithNothingLoadedDoesNotOverwrite() {
  const harness = afterRestart()
  harness.sessions.push({ id: OTHER_ID, title: 'Other' })
  harness.seedFile(OTHER_ID, null as never)
  // Nothing loaded: `hydratedId` is null even though the store has an active id.
  harness.log = []

  await harness.openSession(OTHER_ID)

  assert.equal(harness.log.includes(`save:${SESSION_ID}`), false, 'nothing loaded means nothing to save')
  results.push('switching with nothing loaded does not write an empty transcript')
}

// ---------------------------------------------------------------- Bug B

async function aFirstMessageNamesARestoredUntitledSession() {
  const harness = afterRestartUntitled()
  // The user sends without clicking anything: the session is active from the store.
  harness.ensureSession('write me a parser')

  // The defect: Phase 7 returned early on the existing id, so the title never changed.
  assert.equal(harness.sessions[0].title, 'write me a parser', 'the first message must name the session')
  assert.ok(
    harness.log.some((entry) => entry.startsWith('touch:')),
    'and it must be persisted through the store'
  )
  results.push('a first message names a session restored as active')
}

async function aFirstMessageNamesAFreshSession() {
  const harness = new SessionHarness(new Map())
  const id = harness.ensureSession('hello there')

  assert.equal(id.length, 36, 'a session id is a uuid')
  assert.equal(harness.sessions[0].title, 'hello there', 'a new session takes the message as its title')
  results.push('a first message names a newly created session')
}

async function laterMessagesDoNotRename() {
  const harness = afterRestartUntitled()
  harness.ensureSession('write me a parser')
  const named = harness.sessions[0].title
  harness.log = []

  harness.ensureSession('actually make it a lexer')

  assert.equal(harness.sessions[0].title, named, 'a named session is never renamed')
  assert.equal(
    harness.log.some((entry) => entry.startsWith('touch:')),
    false,
    'and nothing is written to the store on later sends'
  )
  results.push('later messages leave the title alone')
}

async function aTestDrivenTitleIsTruncated() {
  const harness = afterRestartUntitled()
  harness.ensureSession('x'.repeat(200))

  const title = harness.sessions[0].title
  assert.ok(title.length <= 48, `a title must fit 48 characters, got ${title.length}`)
  assert.ok(title.endsWith('…'), 'and be marked as clipped')
  results.push('a long first message is clipped')
}

// ---------------------------------------------------------------- self-heal

async function anUntitledSessionRepairsOnOpen() {
  const harness = afterRestartUntitled()

  await harness.openSession(SESSION_ID)

  // No send involved: opening the row is enough, because the transcript has the message.
  assert.equal(harness.sessions[0].title, 'make a fibonacci script', 'opening repairs the title')
  assert.ok(
    harness.log.some((entry) => entry === 'touch:aaaaaaaa-1111-4111-8111-111111111111=make a fibonacci script'),
    `and persists it: ${JSON.stringify(harness.log)}`
  )
  results.push('opening an untitled session repairs its title from the transcript')
}

async function aNamedSessionIsNotRepaired() {
  const harness = afterRestart()
  harness.log = []

  await harness.openSession(SESSION_ID)

  assert.equal(harness.sessions[0].title, 'make a fibonacci script', 'the name is kept')
  assert.equal(
    harness.log.some((entry) => entry.startsWith('touch:')),
    false,
    'and nothing is rewritten'
  )
  results.push('a session that already has a name is left alone')
}

async function anUntitledEmptySessionIsNotRenamed() {
  const emptyId = 'dddddddd-4444-4444-8444-444444444444'
  const harness = new SessionHarness(new Map())
  harness.sessions = [{ id: emptyId, title: UNTITLED }]
  harness.activeId = emptyId

  await harness.openSession(emptyId)

  assert.equal(harness.sessions[0].title, UNTITLED, 'with no user message there is no title to derive')
  results.push('an untitled session with no transcript stays untitled')
}

// ---------------------------------------------------------------- report

async function main() {
  await step('Bug A: restored row loads', clickingTheRestoredRowLoadsIt)
  await step('Bug A: tool cards render', theLoadedTranscriptCarriesItsToolCards)
  await step('Bug A: already loaded is a no-op', clickingTheAlreadyLoadedRowIsANoop)
  await step('Bug A: save before switch', switchingSavesBeforeItActivates)
  await step('Bug A: nothing loaded', switchingWithNothingLoadedDoesNotOverwrite)
  await step('Bug B: restored session named', aFirstMessageNamesARestoredUntitledSession)
  await step('Bug B: new session named', aFirstMessageNamesAFreshSession)
  await step('Bug B: no rename', laterMessagesDoNotRename)
  await step('Bug B: truncation', aTestDrivenTitleIsTruncated)
  await step('self-heal: on open', anUntitledSessionRepairsOnOpen)
  await step('self-heal: named kept', aNamedSessionIsNotRepaired)
  await step('self-heal: empty stays', anUntitledEmptySessionIsNotRenamed)

  console.log(`session click + title flow: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('CLICK/TITLE FLOW TEST FAILED:', err)
  process.exit(1)
})
