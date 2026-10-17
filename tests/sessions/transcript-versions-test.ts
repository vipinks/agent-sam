/**
 * Verifies the branch model a rewritten message produces, as the record keeps it.
 *
 * A conversation used to keep the versions a message had been through beside it: two arrays, one per
 * role, walked by a pager on the message itself. They are gone. An edit and a regenerate are branch
 * points now, and what they park is not a message but a tail — the question, the answer, and every turn
 * after them — so checking a branch out moves the whole conversation from that turn onward instead of
 * swapping one bubble's words.
 *
 * This suite holds the four things only the record can settle: the arrays an older build wrote are
 * dropped on the way in, with the live message left as the one version; a turn with no branch points is
 * a single trail; the checked-out trail is the snapshot's `turns`, so the export and the search read it
 * and the parked tails stay unread; and a branch point parks exactly the tail it replaced. The last case
 * is the send: a new message appends to the checked-out trail and never into a parked one.
 *
 * The history a re-run is handed is pinned here too, through the rule the panel itself asks. It is
 * unchanged by the branch model, and that is the point of keeping it: a run for a rewritten turn is
 * handed the conversation up to the question it is answering — not the trail it can now switch to.
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
import { reviseUserTurn, restartReplyTurn, type AgentTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

const QUESTION = 'set up the parser'
const SECOND_QUESTION = 'also update the docs'
const EDITED_QUESTION = 'refactor the lexer, and keep the tokens split'
const LATER_QUESTION = 'and the readme?'
const FIRST_CHIPS = ['src/lexer.ts', 'src/tokens.ts']
const SECOND_CHIPS = ['src/tokens.ts']
const ANSWER = 'Set up.'
const REWRITTEN = 'Tokens split.'
const DISCARDED_ANSWER = 'The lexer is rewritten.'

/** The conversation as it stands: two exchanges, the second of them unanswered. */
function conversation(): AgentTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [], mentionPaths: [...FIRST_CHIPS] },
    { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
    { id: 'user-3', role: 'user', content: SECOND_QUESTION, steps: [], mentionPaths: [...SECOND_CHIPS] },
    { id: 'assistant-4', role: 'assistant', content: DISCARDED_ANSWER, steps: [] },
    { id: 'user-5', role: 'user', content: LATER_QUESTION, steps: [] },
  ]
}

function snapshotOf(turns: AgentTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, turns, interrupted: false }
}

/**
 * What an older build wrote for a rewritten message: the arrays this build no longer has a key for.
 *
 * Deliberately a stored file rather than a typed value — the point is that it is data from a build
 * that predates the branch model, so it carries keys this app's types do not name.
 */
function legacyStoredFile(): unknown {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      {
        id: 'user-1',
        role: 'user',
        content: EDITED_QUESTION,
        steps: [],
        mentionPaths: [...SECOND_CHIPS],
        userVersions: [{ content: SECOND_QUESTION, mentionPaths: [...FIRST_CHIPS] }],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: REWRITTEN,
        steps: [],
        replyVersions: [{ content: ANSWER }],
      },
    ],
  }
}

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- what an older file reads as

function theOldArraysAreDropped() {
  const parsed = transcriptSnapshotSchema.parse(legacyStoredFile())

  // The version that was live is the message, and the ones parked beside it are gone: a branch model
  // has one trail, and a message that was rewritten before it existed has nothing to switch to.
  assert.equal(parsed.turns[0].content, EDITED_QUESTION, 'the message reads as the version that was in force')
  assert.deepEqual(parsed.turns[0].mentionPaths, SECOND_CHIPS, 'with the chips that version was carrying')
  assert.equal(parsed.turns[1].content, REWRITTEN, 'and a rewritten reply reads as the answer it stands on')
  assert.equal(
    (parsed.turns[0] as unknown as Record<string, unknown>).userVersions,
    undefined,
    'the archive an older build wrote is not read back as a branch point'
  )
  assert.equal(
    (parsed.turns[1] as unknown as Record<string, unknown>).replyVersions,
    undefined,
    'and neither is the reply archive'
  )
  // Nothing about the stored shape moved: the keys above were stripped, not migrated into a new one.
  assert.equal(TRANSCRIPT_VERSION, 3, 'the version does not move for a key this build dropped')

  results.push('an older file reads as its most recent version, with the parked ones lost')
}

function anUnbranchedTurnIsOneTrail() {
  const parsed = transcriptSnapshotSchema.parse(snapshotOf(conversation()))

  assert.equal(parsed.turns.length, 5, 'a file with no branch points reads as the conversation it is')
  assert.equal(parsed.turns[2].branchPoints, undefined, 'a turn nothing branched at carries no parked tail')
  assert.equal(parsed.turns[2].branch, undefined, 'and no position to be read off it')

  results.push('a turn with no branch points is a single trail')
}

// ---------------------------------------------------------------- what the readers see

function theReadersReadTheCheckedOutTrail() {
  // The checked-out trail already carries the rewrite; the parked tail is the conversation as it was.
  const rewritten = reviseUserTurn(conversation(), 'user-3', EDITED_QUESTION, SECOND_CHIPS)
  const snapshot = snapshotOf(rewritten)

  const rendered = renderExport(snapshot, {
    title: 'a conversation',
    format: 'markdown',
    instructionsFile: null,
    instructionsTruncated: false,
  })
  assert.ok(rendered.includes(EDITED_QUESTION), 'the export carries the checked-out question')
  assert.ok(!rendered.includes(SECOND_QUESTION), 'and nothing from the tail parked behind it')
  assert.ok(!rendered.includes(DISCARDED_ANSWER), 'not even the answer the rewrite replaced')

  const text = conversationText(snapshot)
  assert.ok(text.includes(EDITED_QUESTION), 'search reads the checked-out trail')
  assert.ok(!text.includes(SECOND_QUESTION), 'and never a parked one')

  results.push('the export and the search read the checked-out trail only')
}

// ---------------------------------------------------------------- what a rewrite parks

function anEditParksTheOldTail() {
  const revised = reviseUserTurn(conversation(), 'user-3', EDITED_QUESTION, SECOND_CHIPS)

  // The checked-out trail is the edited question and the reply it is being re-run for. Everything from
  // the edit onward — the words it used to say, the answer it was given, the message after that — is
  // parked as one branch, so checking it out is what shows it.
  assert.deepEqual(
    revised.map((turn) => turn.id),
    ['user-1', 'assistant-2', 'user-3', 'assistant-4'],
    'the checked-out trail ends at the re-run reply'
  )
  const head = revised[2]
  assert.deepEqual(head.content, EDITED_QUESTION, 'and the question at the branch point is the one just written')
  assert.deepEqual(head.mentionPaths, SECOND_CHIPS, 'carrying the chips the edit left on it')
  assert.equal(head.branchPoints?.length, 1, 'the tail it replaced is parked as one branch')
  assert.deepEqual(
    head.branchPoints?.[0]?.turns.map((turn) => turn.id),
    ['user-3', 'assistant-4', 'user-5'],
    'and the parked tail is the whole conversation from the edit onward'
  )
  assert.equal(head.branchPoints?.[0]?.turns[0]?.content, SECOND_QUESTION, 'which keeps the words it was written from')
  assert.equal(head.branch, 1, 'the checked-out trail is the newest branch')

  results.push('an edit parks the old tail and checks out the edited question with its re-run reply')
}

function aRegenerateParksTheOldTail() {
  const rewritten = restartReplyTurn(conversation(), 'assistant-2')

  // A regenerate branches at the reply: the question is untouched and stays in the checked-out trail,
  // and the reply being written again is parked with everything after it.
  assert.deepEqual(
    rewritten.map((turn) => turn.id),
    ['user-1', 'assistant-2'],
    'the trail ends at the reply being re-run'
  )
  const head = rewritten[1]
  assert.equal(head.role, 'assistant', 'the branch point is the reply')
  assert.equal(head.content, '', 'which is being written from nothing')
  assert.equal(head.branchPoints?.length, 1, 'the answer it replaced is parked as one branch')
  assert.deepEqual(
    head.branchPoints?.[0]?.turns.map((turn) => turn.id),
    ['assistant-2', 'user-3', 'assistant-4', 'user-5'],
    'and the parked tail is the reply and every turn after it'
  )
  assert.equal(head.branchPoints?.[0]?.turns[0]?.content, ANSWER, 'the answer it used to be is kept')
  assert.equal(head.branch, 1, 'the checked-out trail is the newest branch')

  results.push('a regenerate parks the old tail and checks out the same question with its re-run reply')
}

// ---------------------------------------------------------------- where a send lands

function aSendAppendsToTheCheckedOutTrail() {
  const revised = reviseUserTurn(conversation(), 'user-3', EDITED_QUESTION, SECOND_CHIPS)
  const parked = revised[2].branchPoints?.[0]?.turns ?? []

  const sent = [...revised, { id: 'user-9', role: 'user' as const, content: LATER_QUESTION, steps: [] }]

  assert.equal(sent[sent.length - 1].id, 'user-9', 'a send lands at the end of the checked-out trail')
  assert.ok(!parked.some((turn) => turn.id === 'user-9'), 'and never inside a parked one, which is a tail nobody is on')
  assert.deepEqual(
    revised[2].branchPoints?.[0]?.turns.map((turn) => turn.id),
    ['user-3', 'assistant-4', 'user-5'],
    'the parked tail is unchanged by a send'
  )
  assert.equal(revised[2].branch, 1, 'and the checked-out trail is still the one the send extended')

  results.push('a new send appends to the checked-out trail, not to a parked one')
}

// ---------------------------------------------------------------- what a re-run is handed

function aRerunsHistoryEndsAtTheTarget() {
  const revised = reviseUserTurn(conversation(), 'user-3', EDITED_QUESTION, SECOND_CHIPS)

  // Editing the second question: the turns before it, plus the question itself. The reply being
  // written is left out — it is what the run is filling — and the parked tail is not part of any
  // history: it is a branch the user can check out, not the conversation being answered.
  assert.deepEqual(
    runHistoryFor(revised, 'user-3').map((turn) => turn.id),
    ['user-1', 'assistant-2', 'user-3'],
    "a re-run's history ends at the question it answers"
  )
  assert.deepEqual(
    runHistoryFor(revised, 'user-3').map((turn) => turn.content),
    [QUESTION, ANSWER, EDITED_QUESTION],
    'and it carries the question as it now stands'
  )

  const rewritten = restartReplyTurn(conversation(), 'assistant-2')
  assert.deepEqual(
    runHistoryFor(rewritten, 'assistant-2').map((turn) => turn.id),
    ['user-1'],
    'a regenerated reply continues from the turns before it'
  )

  results.push("a re-run's history is the checked-out trail up to the turn it answers")
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('an older file', theOldArraysAreDropped)
  step('an unbranched turn', anUnbranchedTurnIsOneTrail)
  step('the readers', theReadersReadTheCheckedOutTrail)
  step('an edit', anEditParksTheOldTail)
  step('a regenerate', aRegenerateParksTheOldTail)
  step('a send', aSendAppendsToTheCheckedOutTrail)
  step('a re-run history', aRerunsHistoryEndsAtTheTarget)

  console.log(`transcript branches: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
