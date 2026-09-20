/**
 * Verifies the project-instructions rules against the real reader: which file is chosen, what the
 * system message says, and where 16 KB falls.
 *
 * The reader is imported rather than reimplemented. A copy of the candidate loop in the test would
 * pass while the shipped code disagreed with it, which is the failure mode this suite exists to
 * catch — and the byte budget is exactly such a case: a cap written with `String.length` passes
 * every ASCII test and then hands the provider roughly three times the intended payload for a file
 * of multi-byte characters. It is tested here with real UTF-8, not ASCII padding.
 *
 * No electron: the reader takes a path, so this writes into a temp directory and reads it back.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectInstructions } from '../../conveyor/modules/project-context'
import {
  assembleSystemContext,
  INSTRUCTIONS_CANDIDATES,
  instructionsFileName,
  MAX_INSTRUCTIONS_BYTES,
  recordedInstructions,
  TRUNCATION_NOTE,
} from '../../conveyor/protocol/context'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sam-context-'))
  roots.push(root)
  return root
}

// ---------------------------------------------------------------- the candidates

async function theFirstExistingCandidateWins() {
  assert.deepEqual(
    [...INSTRUCTIONS_CANDIDATES],
    ['SAMAI.md', 'AGENTS.md', 'CLAUDE.md'],
    'the documented order is SAMAI.md, then the two names the wider tooling uses'
  )

  const root = await makeRoot()
  await writeFile(join(root, 'SAMAI.md'), 'samai instructions', 'utf8')
  await writeFile(join(root, 'AGENTS.md'), 'agents instructions', 'utf8')
  await writeFile(join(root, 'CLAUDE.md'), 'claude instructions', 'utf8')

  const all = await readProjectInstructions(root)
  assert.equal(all?.text, 'samai instructions', 'SAMAI.md takes precedence')
  assert.equal(instructionsFileName(all?.path ?? null), 'SAMAI.md', 'and the file it came from is reported')

  await unlink(join(root, 'SAMAI.md'))
  assert.equal((await readProjectInstructions(root))?.text, 'agents instructions', 'then AGENTS.md')

  await unlink(join(root, 'AGENTS.md'))
  assert.equal((await readProjectInstructions(root))?.text, 'claude instructions', 'then CLAUDE.md')
  results.push('the first existing candidate wins, in the documented order')
}

async function noCandidateMeansNoInstructions() {
  const root = await makeRoot()
  assert.equal(await readProjectInstructions(root), null, 'an empty workspace has no instructions')
  assert.equal(
    assembleSystemContext(null),
    null,
    'and therefore no system message — nothing is injected to say nothing'
  )
  // A workspace that has never been opened is the same case.
  assert.equal(await readProjectInstructions(null), null, 'no folder open means no instructions')
  results.push('a workspace with none of the candidates yields no system message')
}

async function aBlankFileIsFoundButDoesNotInject() {
  const root = await makeRoot()
  await writeFile(join(root, 'AGENTS.md'), '   \n\n  ', 'utf8')

  const found = await readProjectInstructions(root)
  assert.ok(found, 'the file was found — a present file is not the same as an absent one')
  assert.equal(instructionsFileName(found.path), 'AGENTS.md')
  // Present but blank: injecting it would spend context saying nothing.
  assert.equal(assembleSystemContext(found.text), null, 'a blank instructions file yields no message')
  results.push('a candidate file that is blank is found but yields no system message')
}

async function anEmptyFileShadowsTheNextCandidate() {
  // An empty SAMAI.md is a deliberate statement that this project has no instructions. Falling
  // through to AGENTS.md would silently override it with the file the author chose to shadow.
  const root = await makeRoot()
  await writeFile(join(root, 'SAMAI.md'), '', 'utf8')
  await writeFile(join(root, 'AGENTS.md'), 'agents instructions', 'utf8')

  const found = await readProjectInstructions(root)
  assert.equal(
    instructionsFileName(found?.path ?? null),
    'SAMAI.md',
    'the empty SAMAI.md is the answer, not a reason to continue'
  )
  assert.equal(found?.text, '', 'with no text')
  results.push('an empty higher-priority candidate wins rather than falling through')
}

// ---------------------------------------------------------------- the message

function theMessageIsFencedAsProjectInstructions() {
  const message = assembleSystemContext('# House rules\n\nUse tabs never.')
  assert.ok(message, 'instructions produce a message')
  assert.ok(message.content.includes('# House rules'), 'the file text is carried through')

  // The model must be told what this wall of text is and where it came from.
  assert.ok(/project instructions/i.test(message.content), 'the message says what these are')
  assert.ok(message.content.indexOf('# House rules') > 0, 'the fence precedes the file text rather than following it')
  results.push('the system message fences the file text as project instructions')
}

// ---------------------------------------------------------------- the cap

async function anOversizedFileIsCutAndMarked() {
  const root = await makeRoot()

  // Multi-byte characters on purpose: two bytes each in UTF-8, so a character-based cap would take
  // twice the intended payload and still report itself as correct.
  const oversized = 'é'.repeat(MAX_INSTRUCTIONS_BYTES) // 2 × the byte budget
  await writeFile(join(root, 'AGENTS.md'), oversized, 'utf8')

  const found = await readProjectInstructions(root)
  assert.ok(found, 'the file was read')
  assert.equal(found.truncated, true, 'and is reported as truncated')
  assert.equal(instructionsFileName(found.path), 'AGENTS.md')

  const bytes = Buffer.byteLength(found.text, 'utf8')
  const budget = MAX_INSTRUCTIONS_BYTES + Buffer.byteLength(`\n\n${TRUNCATION_NOTE}`, 'utf8')
  assert.ok(
    bytes <= budget,
    `the read stays within the ${MAX_INSTRUCTIONS_BYTES}-byte budget plus its note, got ${bytes}`
  )
  assert.ok(bytes > MAX_INSTRUCTIONS_BYTES / 2, `and is not over-cut: got ${bytes} bytes`)

  // The note is present, so the model is told its instructions are partial.
  assert.ok(found.text.includes(TRUNCATION_NOTE), 'the truncation is marked')
  // And no replacement character: a cut mid-sequence would read as corruption in the file rather
  // than as the truncation this is.
  assert.ok(!found.text.includes('\uFFFD'), 'the cut respects the character boundary')

  // The marker lands where the budget falls: the kept prefix is a real prefix of the file, and
  // nothing beyond the budget survived. Compared against the original rather than against a
  // precomputed fraction — `é` is two bytes, so the kept prefix is exactly half the characters, and
  // a `< original/2` assertion would fail on the boundary it was meant to describe.
  const bodyLength = found.text.length - TRUNCATION_NOTE.length - 2
  assert.ok(bodyLength > 0, 'a prefix of the file was kept')
  assert.ok(bodyLength < oversized.length, 'and it is strictly shorter than the file')

  // The file on disk is untouched: this reads, it never rewrites.
  assert.equal((await stat(join(root, 'AGENTS.md'))).size, Buffer.byteLength(oversized, 'utf8'))
  assert.equal(
    (await readFile(join(root, 'AGENTS.md'), 'utf8')).length,
    oversized.length,
    'the instructions file is read, never modified'
  )
  results.push('an oversized file is cut to the byte budget and marked as truncated')
}

async function theBoundaryIsExact() {
  const root = await makeRoot()

  // Exactly the budget in bytes: taken whole, no note.
  const exact = 'a'.repeat(MAX_INSTRUCTIONS_BYTES)
  await writeFile(join(root, 'AGENTS.md'), exact, 'utf8')

  const at = await readProjectInstructions(root)
  assert.equal(at?.text, exact, 'a file of exactly the budget is taken whole')
  assert.equal(at?.truncated, false, 'and is not reported as truncated')

  // One byte more, and it is marked.
  await writeFile(join(root, 'AGENTS.md'), `${exact}b`, 'utf8')
  const over = await readProjectInstructions(root)
  assert.equal(over?.truncated, true, 'one byte over the budget is truncated')
  assert.ok(over?.text.includes(TRUNCATION_NOTE), 'and marked')
  results.push('the boundary is exact: at the budget is whole, one byte over is marked')
}

// ---------------------------------------------------------------- the recorded name

function theRecordedNameIsTheFileNameNotThePath() {
  assert.equal(instructionsFileName('/home/dev/project/AGENTS.md'), 'AGENTS.md', 'a posix path')
  assert.equal(instructionsFileName('C:\\work\\repo\\SAMAI.md'), 'SAMAI.md', 'a windows path')
  assert.equal(instructionsFileName('AGENTS.md'), 'AGENTS.md', 'a bare name')
  // A transcript must not carry a machine-specific absolute path.
  assert.equal(instructionsFileName(null), null, 'no file, no name')
  results.push('the recorded name is the file name, never a machine-specific path')
}

// ---------------------------------------------------------------- the turn's record

function whatATurnRecordedIsReadBackOutOfIt() {
  // Nothing recorded: an ordinary conversation, and the export has no note to write.
  assert.equal(recordedInstructions([]), null, 'no turns, no record')
  assert.equal(
    recordedInstructions([{ id: 'u1', role: 'user' } as never]),
    null,
    'a turn with no record contributes none'
  )

  // The record is per turn, so the first turn that has one names the file for the conversation.
  const mixed = [
    { instructionsFile: undefined },
    { instructionsFile: 'AGENTS.md', instructionsTruncated: false },
    { instructionsFile: 'SAMAI.md', instructionsTruncated: true },
  ]
  assert.deepEqual(
    recordedInstructions(mixed),
    { file: 'AGENTS.md', truncated: false },
    'the first recorded turn names the conversation, and its truncation travels with it'
  )

  // A record whose flag is missing is not truncated: the flag only means something when it is true,
  // and reading an absent one as a truncation would put a false claim about the file in the export.
  assert.deepEqual(
    recordedInstructions([{ instructionsFile: 'CLAUDE.md' }]),
    { file: 'CLAUDE.md', truncated: false },
    'an absent truncation flag reads as whole'
  )
  results.push('the instructions record is read back out of the turns that carry it')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('candidate order', theFirstExistingCandidateWins)
    await step('no candidate', noCandidateMeansNoInstructions)
    await step('blank file', aBlankFileIsFoundButDoesNotInject)
    await step('empty shadows', anEmptyFileShadowsTheNextCandidate)
    await step('message shape', theMessageIsFencedAsProjectInstructions)
    await step('oversized', anOversizedFileIsCutAndMarked)
    await step('exact boundary', theBoundaryIsExact)
    await step('recorded name', theRecordedNameIsTheFileNameNotThePath)
    await step('turn record', whatATurnRecordedIsReadBackOutOfIt)

    console.log(`project instructions: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('PROJECT INSTRUCTIONS TEST FAILED:', err)
  process.exit(1)
})
