/**
 * Verifies the versions a message has been through, as the record keeps them.
 *
 * An edit and a regenerate used to cut the transcript back and send it again, so the words a message
 * used to have were gone the moment the user changed them. They are kept now, beside the live message
 * rather than in place of it, and this suite holds the three things that only the record can settle:
 * the version arrays are optional-additive, so a file written before them reads as the single version
 * it is; a version-less turn is one version and nothing else; and every reader of a message's text —
 * the export, the search — reads the version that is live, never the ones parked beside it.
 *
 * The history a re-run is handed is pinned here too, through the rule the panel itself asks: the turns
 * before the target, with the target's *active* question when the target is that question, and with the
 * reply being written again left out. That claim belongs on the record rather than in the pane, because
 * the pane's transcript now deliberately disagrees with it — nothing is dropped, and what the model is
 * given is still the conversation up to the question it is answering.
 */
import { strict as assert } from 'node:assert'
import {
  TRANSCRIPT_VERSION,
  transcriptSnapshotSchema,
  type TranscriptSnapshot,
} from '../../conveyor/protocol/transcript'
import { renderExport } from '../../conveyor/protocol/export'
import { conversationText } from '../../conveyor/protocol/search'
import { runHistoryFor } from '../../conveyor/protocol/truncate'

const results: string[] = []

const QUESTION = 'set up the parser'
const SECOND_QUESTION = 'also update the docs'
const EDITED_QUESTION = 'refactor the lexer, and keep the tokens split'
const FIRST_CHIPS = ['src/lexer.ts', 'src/tokens.ts']
const SECOND_CHIPS = ['src/tokens.ts']
const ANSWER = 'Set up.'
const REWRITTEN = 'Tokens split.'
const DISCARDED_ANSWER = 'The lexer is rewritten.'

/**
 * A conversation a user has edited and regenerated in: the reply to the first question was written
 * again, and the second question carries a second version of itself.
 *
 * The parked text is deliberately unlike the live text, in both places — not a prefix of it, not a
 * phrase of it. A reader that read a version array by mistake, and a suite that asserted on a value
 * both versions happen to share, would both look correct otherwise.
 */
function versionedSnapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: QUESTION, steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: REWRITTEN,
        steps: [],
        replyVersions: [{ content: ANSWER }],
      },
      {
        id: 'user-3',
        role: 'user',
        content: EDITED_QUESTION,
        steps: [],
        mentionPaths: [...SECOND_CHIPS],
        userVersions: [{ content: SECOND_QUESTION, mentionPaths: [...FIRST_CHIPS] }],
      },
      { id: 'assistant-4', role: 'assistant', content: DISCARDED_ANSWER, steps: [] },
    ],
  }
}

/** The same conversation with no version arrays anywhere, as every stored file today is. */
function versionlessSnapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: QUESTION, steps: [], mentionPaths: [...FIRST_CHIPS] },
      { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
    ],
  }
}

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- the shape on disk

function theArraysAreOptionalAdditive() {
  const parsed = transcriptSnapshotSchema.parse(versionedSnapshot())

  assert.deepEqual(
    parsed.turns[2].userVersions,
    [{ content: SECOND_QUESTION, mentionPaths: FIRST_CHIPS }],
    'the versions a message has been through must survive a read'
  )
  assert.deepEqual(parsed.turns[1].replyVersions, [{ content: ANSWER }], 'a rewritten reply keeps the one it replaced')
  assert.equal(parsed.turns[2].content, EDITED_QUESTION, 'and the message itself is the version that is live')
  assert.deepEqual(parsed.turns[2].mentionPaths, SECOND_CHIPS, 'the live chips, not the parked ones')
  // The arrays are additive and optional, so the version does not move: a file written before them has
  // no key, an absent optional key is stripped rather than defaulted, and both read as the conversation
  // they are. A bump here would make every stored transcript a file this build refuses.
  assert.equal(TRANSCRIPT_VERSION, 3, 'the version does not move for an additive-optional key')

  results.push('the version arrays are optional-additive and survive a read')
}

function aVersionlessTurnIsOneVersion() {
  const parsed = transcriptSnapshotSchema.parse(versionlessSnapshot())

  // Absence is not an empty archive: a turn that has never been revised carries no array at all, and
  // the message it shows is its content and the chips it holds. There is no second version to walk to,
  // which is what the pane draws no pager for.
  assert.equal(parsed.turns[0].userVersions, undefined, 'a turn written before versions has no archive')
  assert.equal(parsed.turns[0].content, QUESTION, 'and reads as the one version it is')
  assert.deepEqual(parsed.turns[0].mentionPaths, FIRST_CHIPS, 'with the chips that version was sent with')

  results.push('a version-less turn reads as a single version')
}

// ---------------------------------------------------------------- what the readers see

function exportCarriesTheLiveVersion() {
  const rendered = renderExport(versionedSnapshot(), {
    title: 'a conversation',
    format: 'markdown',
    instructionsFile: null,
    instructionsTruncated: false,
  })

  assert.ok(rendered.includes(EDITED_QUESTION), 'the export carries the question as it stands')
  assert.ok(rendered.includes(REWRITTEN), 'and the reply as it stands')
  assert.ok(!rendered.includes(SECOND_QUESTION), 'a previous version of a message is not the message')
  assert.ok(!rendered.includes(ANSWER), 'and neither is the reply a regenerate replaced')

  results.push('the export carries the live version and nothing parked behind it')
}

function searchReadsTheLiveVersion() {
  const text = conversationText(versionedSnapshot())

  assert.ok(text.includes(EDITED_QUESTION), 'search reads the question as it stands')
  assert.ok(!text.includes(SECOND_QUESTION), 'and never a previous version of it')

  results.push('search reads the live version only')
}

// ---------------------------------------------------------------- what a re-run is handed

function aRerunsHistoryEndsAtTheActiveQuestion() {
  const turns = versionedSnapshot().turns

  // Regenerating the first reply: the reply is what is being written again, so it is not part of the
  // history it is written from, and neither is anything that followed it.
  assert.deepEqual(
    runHistoryFor(turns, 'assistant-2').map((turn) => turn.id),
    ['user-1'],
    'a regenerated reply continues from the turns before it'
  )

  // Editing the second question: the turns before it, plus that question itself. The reply it is being
  // re-run for is left out — it is what is being written — and so is the turn after it, which is the
  // divergence an in-place rewrite accepts and the reason nothing has to be dropped.
  const history = runHistoryFor(turns, 'user-3')
  assert.deepEqual(
    history.map((turn) => turn.id),
    ['user-1', 'assistant-2', 'user-3'],
    "a re-run's history is the turns before the target plus the target itself"
  )
  assert.deepEqual(
    history.map((turn) => ({ role: turn.role, content: turn.content })),
    [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: REWRITTEN },
      { role: 'user', content: EDITED_QUESTION },
    ],
    'and the question it carries is the version in force, never one parked behind the pager'
  )

  results.push("a re-run's history ends at the target's active question, with the versioned reply excluded")
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('the shape on disk', theArraysAreOptionalAdditive)
  step('a version-less turn', aVersionlessTurnIsOneVersion)
  step('the export', exportCarriesTheLiveVersion)
  step('the search', searchReadsTheLiveVersion)
  step('a re-run history', aRerunsHistoryEndsAtTheActiveQuestion)

  console.log(`transcript versions: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
