/**
 * Verifies the chips home offers for the folders it remembers.
 *
 * The derivation pinned here is the join of two things the screen reads separately — the workspace
 * store's recents list and the chat-sessions store's metadata — into what one chip has to say: which
 * folder it stands for, how many conversations were last used there, and which of them a click
 * resumes. Each is invisible when it is wrong in its own way: a count that belongs to another folder
 * reads as an ordinary number, and a chip that resumes the wrong conversation opens something the user
 * never clicked.
 *
 * Rules rather than wiring, so they are exercised without a DOM — the click itself is covered by
 * `testing/home-wiring.test.tsx`, and the store order this preserves is pinned by
 * `tests/workspace/recent-roots-store-test.ts`.
 *
 * Nothing to clean up afterwards: the inputs are plain arrays, and the function copies rather than
 * mutating them.
 */
import { strict as assert } from 'node:assert'
import { projectChips } from '../../conveyor/protocol/recent-roots'
import type { ChatSession } from '../../conveyor/stores/chat-sessions'

const results: string[] = []

async function step(label: string, fn: () => void): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const SAM = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'
const THIRD = 'cccccccc-3333-4333-8333-333333333333'

/**
 * One conversation, as the metadata the chip derivation reads.
 *
 * `lastRoot` is left off rather than passed as an empty string when a test wants a conversation with
 * no project, because that is how the store spells it: the key is absent, and a blank path is refused
 * at the boundary.
 */
function conversation(
  id: string,
  options: { lastRoot?: string; createdAt?: number; updatedAt?: number } = {}
): ChatSession {
  return {
    id,
    title: `conversation ${id.slice(0, 4)}`,
    createdAt: options.createdAt ?? 1_700_000_000_000,
    updatedAt: options.updatedAt ?? 1_700_000_000_000,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(options.lastRoot !== undefined ? { lastRoot: options.lastRoot } : {}),
  }
}

// ---------------------------------------------------------------- one chip per root

function oneChipPerRootInTheStoresOrder() {
  // Deliberately not alphabetical, and deliberately not the order the folders were opened in: the
  // store's own order is the only order stated here, and it is most-recent-first.
  const chips = projectChips([NOTES, SAM, ARCHIVE], [])

  assert.deepEqual(
    chips.map((chip) => chip.root),
    [NOTES, SAM, ARCHIVE],
    'the order the workspace store holds is the order the row draws'
  )
  results.push('a chip per recent root, in the store’s own order')
}

function aChipIsNamedByTheFoldersLastSegment() {
  const chips = projectChips([SAM, NOTES, 'C:/work/deeply/nested/project/'], [])

  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['sam-ai', 'notes', 'project'],
    'the label is the folder’s last segment, with a trailing separator dropped'
  )
  // The path is kept as well, because it is what a click opens and what the chip's title shows.
  assert.equal(chips[0]?.root, SAM, 'and the full path is still on the chip')
  results.push('a chip is named by the folder’s own last segment')
}

// ---------------------------------------------------------------- the count

function theCountIsTheConversationsLastUsedThere() {
  const chips = projectChips(
    [SAM, NOTES, ARCHIVE],
    [
      conversation(FIRST, { lastRoot: SAM, updatedAt: 5 }),
      conversation(SECOND, { lastRoot: SAM, updatedAt: 4 }),
      conversation(THIRD, { lastRoot: NOTES, updatedAt: 3 }),
      // No project yet: it did not run in any of these folders, so it is none of their counts.
      conversation('dddddddd-4444-4444-8444-444444444444', { updatedAt: 9 }),
    ]
  )

  assert.deepEqual(
    chips.map((chip) => chip.count),
    [2, 1, 0],
    'each chip counts the conversations stamped with its folder'
  )
  results.push('the count is the conversations last used in that folder, and nobody else’s')
}

function aRootWithNoConversationsHasNone() {
  const [chip] = projectChips([ARCHIVE], [])

  assert.equal(chip?.count, 0, 'a folder nothing ran in counts nothing')
  assert.equal(chip?.sessionId, null, 'and has no conversation to resume')
  results.push('a root with no conversations counts zero and carries no session id')
}

function theSameFolderSpelledAnotherWayCountsTheSame() {
  const chips = projectChips([SAM], [conversation(FIRST, { lastRoot: 'c:/WORK/sam-ai' })])

  assert.equal(chips[0]?.count, 1, 'the store’s own comparison decides which folders are the same folder')
  assert.equal(chips[0]?.sessionId, FIRST, 'and which conversation belongs to the chip')
  results.push('a differently-cased spelling is the same folder, counted the same way')
}

// ---------------------------------------------------------------- which conversation

function theMostRecentlyTouchedConversationIsTheOneOfferedBack() {
  // Arrival order says one thing and `updatedAt` says another: the list arrives newest-first in
  // practice, and this is the function that has to keep that true rather than inherit it. `createdAt`
  // is set to the opposite of `updatedAt` so a derivation that read the wrong field would pick the
  // other conversation.
  const chips = projectChips(
    [SAM],
    [
      conversation(FIRST, { lastRoot: SAM, createdAt: 9_000, updatedAt: 1 }),
      conversation(SECOND, { lastRoot: SAM, createdAt: 1_000, updatedAt: 2 }),
    ]
  )

  assert.equal(chips[0]?.sessionId, SECOND, 'the newest activity is what a chip resumes')
  results.push('the conversation a chip resumes is the most recently touched, not the first listed')
}

function everyRootPicksItsOwn() {
  const chips = projectChips(
    [SAM, NOTES],
    [
      conversation(FIRST, { lastRoot: SAM, updatedAt: 2 }),
      conversation(SECOND, { lastRoot: NOTES, updatedAt: 3 }),
      conversation(THIRD, { lastRoot: SAM, updatedAt: 4 }),
    ]
  )

  assert.deepEqual(
    chips.map((chip) => chip.sessionId),
    [THIRD, SECOND],
    'each chip resumes its own folder’s most recent conversation'
  )
  results.push('each chip resumes the newest conversation of its own folder')
}

// ---------------------------------------------------------------- the inputs

function nothingToOfferBackIsAnEmptyRow() {
  assert.deepEqual(projectChips([], [conversation(FIRST, { lastRoot: SAM })]), [])
  results.push('no recent roots means no chips, however many conversations exist')
}

function theInputsAreLeftAlone() {
  const roots = [SAM, NOTES]
  const sessions = [conversation(FIRST, { lastRoot: SAM })]

  projectChips(roots, sessions)

  assert.deepEqual(roots, [SAM, NOTES], 'the recents list is not reordered in place')
  assert.equal(sessions.length, 1, 'and nothing is added to the session list')
  results.push('the lists it was given are left as they arrived')
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('chips: one per root', oneChipPerRootInTheStoresOrder)
  await step('chips: label', aChipIsNamedByTheFoldersLastSegment)
  await step('count: stamped', theCountIsTheConversationsLastUsedThere)
  await step('count: none', aRootWithNoConversationsHasNone)
  await step('count: case', theSameFolderSpelledAnotherWayCountsTheSame)
  await step('resume: newest', theMostRecentlyTouchedConversationIsTheOneOfferedBack)
  await step('resume: per root', everyRootPicksItsOwn)
  await step('chips: none', nothingToOfferBackIsAnEmptyRow)
  await step('inputs: untouched', theInputsAreLeftAlone)

  console.log(`recent project chips: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('RECENT PROJECT CHIPS TEST FAILED:', err)
  process.exit(1)
})
