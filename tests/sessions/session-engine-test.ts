/**
 * Verifies `engineId` on the session record: that the key is additive-optional, that an absent one means
 * the Sam loop, and that a session written by an earlier build stays a valid read.
 *
 * Three records are involved and each is asserted where it lives. The stored snapshot
 * (`conveyor/protocol/transcript.ts`) is the file on disk, and the whole point of the key is that it did
 * *not* move `TRANSCRIPT_VERSION`: a file with no key and a file with one are both version 3, because a
 * reader that does not know the key loses it rather than getting the rest of the file wrong. The
 * renderer's own state (`session-transcript.ts`) is the second, and it is asserted as a round trip —
 * write, read back — because a key written and not read is a key that does nothing.
 *
 * The store record is the third, and it is where the picker's lock comes from: `engineId` is snapshotted
 * at creation the way `buddyId` is, so the header can read which engine a conversation runs as without
 * opening its transcript. Its schema is exercised through the store's own declaration, so a payload that
 * crosses the boundary is refused or accepted by the same rule main applies.
 */
import { strict as assert } from 'node:assert'
import {
  TRANSCRIPT_VERSION,
  emptySnapshot,
  transcriptSnapshotSchema,
  type TranscriptSnapshot,
} from '../../conveyor/protocol/transcript'
import {
  blankTranscript,
  rehydrateTranscript,
  serializeTranscript,
  type TranscriptState,
} from '../../app/components/workbench/session-transcript'
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import { createStoreHarness } from './chat-sessions-store-harness'

const results: string[] = []

/** A stored snapshot with no engine key: what every session written before this field looked like. */
const SAM_SESSION: TranscriptSnapshot = { version: TRANSCRIPT_VERSION, turns: [], interrupted: false }

/** The id the picker offers, and the one every case below writes. */
const CODEX = 'codex'

/** A schema, as the store declares it, narrowed to the one method this suite calls. */
type ParsedSchema = { safeParse: (value: unknown) => { success: boolean } }

// ---------------------------------------------------------------- the stored record

/**
 * The key is optional, and its absence is the Sam loop rather than a missing record.
 *
 * The absent case is the load-bearing one: a file written before engines existed has no key, and a
 * reader that defaulted it to anything — an empty string, a `null`, a `'sam'` sentinel — would be
 * inventing a value for a session nobody ever configured.
 */
function theKeyIsAdditiveOptionalOnTheStoredRecord() {
  const absent = transcriptSnapshotSchema.safeParse(SAM_SESSION)
  assert.equal(absent.success, true, 'a snapshot with no engine key is a valid snapshot')
  if (absent.success) {
    assert.equal('engineId' in absent.data, false, 'and reads back with no key rather than a default')
  }

  const present = transcriptSnapshotSchema.safeParse({ ...SAM_SESSION, engineId: CODEX })
  assert.equal(present.success, true, 'a snapshot naming an engine is a valid snapshot')
  if (present.success) assert.equal(present.data.engineId, CODEX, 'and reads back as the id it stored')

  // An empty string is not a third state: it is a key with nothing in it, which is what the absent key
  // already says. Refused at the boundary rather than stored and then misread by the picker.
  assert.equal(
    transcriptSnapshotSchema.safeParse({ ...SAM_SESSION, engineId: '' }).success,
    false,
    'a blank engine id is refused'
  )

  assert.equal(TRANSCRIPT_VERSION, 3, 'the version does not move for an additive-optional key')
  const empty = emptySnapshot()
  assert.equal(empty.version, TRANSCRIPT_VERSION, 'an empty snapshot carries the current version')
  assert.equal('engineId' in empty, false, 'and names no engine, which is the Sam default')

  results.push('the stored snapshot takes engineId as an optional key, and its absence is the Sam loop')
}

/**
 * A file written by an earlier build stays a valid read, key for key.
 *
 * The unknown-key half is the other direction: a snapshot carrying keys this build does not know — a
 * newer build's, or a hand-edited one — is read for the keys it does know rather than refused, which is
 * the behaviour the optional field relies on.
 */
function anOlderFileStaysAValidRead() {
  const legacy = transcriptSnapshotSchema.safeParse({
    version: TRANSCRIPT_VERSION,
    turns: [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'answer',
        steps: [{ callId: 'c1', tool: 'read_file', args: { path: 'a.ts' }, status: 'ok' }],
      },
    ],
    interrupted: false,
    autoApprove: true,
  })

  assert.equal(legacy.success, true, 'a transcript with no engine key is read')
  if (legacy.success) {
    assert.equal(legacy.data.autoApprove, true, 'and keeps the keys it does carry')
    assert.equal(legacy.data.turns.length, 1, 'including its turns')
    assert.equal('engineId' in legacy.data, false, 'while carrying no engine of its own')
  }

  const unknownKey = transcriptSnapshotSchema.safeParse({ ...SAM_SESSION, somethingNewer: 42 })
  assert.equal(unknownKey.success, true, 'an unknown key is stripped rather than refused')

  results.push('a file written before the key existed is still a valid read, and unknown keys are stripped')
}

// ---------------------------------------------------------------- the renderer's own state

/**
 * The renderer writes the key only when there is one, and reads it back.
 *
 * Written-only-when-present is the same rule every additive field here follows: writing
 * `engineId: undefined` or an empty string for a session that runs the Sam loop would be a second way to
 * say "no engine", and every session in the app would be rewritten on the first save after this landed.
 */
function theRendererRoundTripsTheKey() {
  const underEngine: TranscriptState = { ...blankTranscript(), engineId: CODEX }
  const written = serializeTranscript(underEngine)

  assert.equal(written.version, TRANSCRIPT_VERSION, 'the renderer writes the current version')
  assert.equal(written.engineId, CODEX, 'and the engine the conversation runs as')

  const read = rehydrateTranscript(written)
  assert.equal(read.engineId, CODEX, 'which reads back off the same snapshot')

  const sam: TranscriptState = { ...blankTranscript() }
  const samSnapshot = serializeTranscript(sam)
  assert.equal('engineId' in samSnapshot, false, 'a Sam session writes no engine key at all')
  assert.equal(rehydrateTranscript(samSnapshot).engineId, undefined, 'and reads back with none')
  assert.equal(rehydrateTranscript(null).engineId, undefined, 'as does a conversation with no file')

  results.push('the renderer writes engineId only when a conversation runs as an engine, and reads it back')
}

// ---------------------------------------------------------------- the store record

/**
 * The store record carries the key, and creation is the only thing that writes it.
 *
 * A snapshot taken at creation, like the Buddy's role and server subset and for the same reason: what a
 * conversation runs as must not change under it because a control was touched later, so the picker locks
 * and the record it locked on is the record the conversation keeps.
 */
function theStoreRecordSnapshotsTheEngine() {
  const schema = chatSessionsStore.schemas?.addSession as unknown as ParsedSchema | undefined
  assert.ok(schema !== undefined, 'the store declares an addSession payload schema')

  // UUIDs, because the session id schema is the app's own and refuses anything else — a suite invented
  // against a laxer id would be a suite that never touched the boundary main actually enforces.
  const base = {
    id: '4f2b1c7e-9a3d-4f6b-8c21-0d5e7a9b1c34',
    title: 'the release',
    providerId: 'deepseek',
    model: 'deepseek-chat',
  }
  assert.equal(schema.safeParse({ ...base, engineId: CODEX }).success, true, 'a payload naming an engine is accepted')
  assert.equal(schema.safeParse(base).success, true, 'and one naming none is still accepted')
  assert.equal(
    schema.safeParse({ ...base, engineId: '' }).success,
    false,
    'a blank engine id is refused at the boundary rather than stored'
  )

  const withEngine = createStoreHarness()
  const engineId = 'b7e4d2a1-3c5f-49b8-9e6a-1f2d3c4b5a69'
  withEngine.run('addSession', { ...base, id: engineId, engineId: CODEX })
  const engineRow = withEngine.state().sessions.find((s) => s.id === engineId)
  assert.equal(engineRow?.engineId, CODEX, 'the action stores the engine on the created row')

  const sam = createStoreHarness()
  const samId = 'c8f5e3b2-4d6a-4ac9-8f7b-2a3e4d5c6b70'
  sam.run('addSession', { ...base, id: samId })
  const samRow = sam.state().sessions.find((s) => s.id === samId)
  assert.ok(samRow !== undefined, 'a conversation created without an engine is created')
  assert.equal(
    samRow !== undefined && 'engineId' in samRow,
    false,
    'and carries no engine key, which is how the Sam loop is spelled'
  )

  results.push('the store snapshots engineId at creation and writes nothing for the Sam default')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('stored record', theKeyIsAdditiveOptionalOnTheStoredRecord)
  step('older files', anOlderFileStaysAValidRead)
  step('renderer state', theRendererRoundTripsTheKey)
  step('store record', theStoreRecordSnapshotsTheEngine)

  console.log('session engine: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('SESSION ENGINE TEST FAILED:', err)
  process.exit(1)
})
