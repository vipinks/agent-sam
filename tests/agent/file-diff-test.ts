/**
 * Verifies the pure line diff behind the `write_file` approval card.
 *
 * Before this existed the card showed a path and nothing else, so consent for a write — the one
 * action that changes the user's files — was asked for without showing what the change was. The
 * diff is computed in main (it needs the file on disk) and only its result crosses the IPC hop, so
 * the rule that the renderer never touches `fs` is what makes this function the whole test surface.
 *
 * The cases here are the ones the card has to get right on its own: nothing changed, one line
 * changed, and a file that does not exist yet.
 */
import { strict as assert } from 'node:assert'
import { computeFileDiff, MAX_DIFF_LINES } from '../../conveyor/protocol/diff'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** Anything at all that is not context, i.e. a line the user is being asked to accept. */
function changes(diff: ReturnType<typeof computeFileDiff>) {
  return diff.lines.filter((line) => line.kind !== 'context')
}

function identicalInputsProduceNoDiff() {
  const diff = computeFileDiff('one\ntwo\nthree\n', 'one\ntwo\nthree\n')
  assert.deepEqual(diff.lines, [], 'an unchanged file has nothing to show')
  assert.equal(diff.added, 0)
  assert.equal(diff.removed, 0)
  assert.equal(diff.truncated, false)

  // And the same contents without the trailing newline: rewriting a file the agent just read back
  // must not present itself as a whole-file change.
  assert.deepEqual(computeFileDiff('one\ntwo\n', 'one\ntwo').lines, [])

  results.push('identical contents produce no diff, trailing newline and all')
}

function oneLineChangeIsOneRemovalAndOneAddition() {
  const diff = computeFileDiff('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')

  assert.equal(diff.removed, 1, `expected one removal: ${JSON.stringify(diff.lines)}`)
  assert.equal(diff.added, 1, `expected one addition: ${JSON.stringify(diff.lines)}`)
  assert.deepEqual(
    changes(diff),
    [
      { kind: 'removed', text: 'beta' },
      { kind: 'added', text: 'BETA' },
    ],
    'the change must say what it was, not just that there was one'
  )
  // The untouched neighbours are context rather than changes, so the card does not colour them.
  assert.ok(
    diff.lines.some((line) => line.kind === 'context' && line.text === 'alpha'),
    'surrounding lines are context'
  )

  results.push('a one-line change is one removal and one addition')
}

function missingFileIsAllAdditions() {
  const diff = computeFileDiff(null, 'first\nsecond\n')

  assert.equal(diff.removed, 0, 'a file that does not exist has nothing to remove')
  assert.equal(diff.added, 2, `every line of a new file is an addition: ${JSON.stringify(diff.lines)}`)
  assert.deepEqual(
    diff.lines,
    [
      { kind: 'added', text: 'first' },
      { kind: 'added', text: 'second' },
    ],
    'a new file shows all of its lines as additions'
  )
  assert.ok(
    diff.lines.every((line) => line.kind !== 'removed'),
    'no removal may be invented for a file that was not there'
  )

  results.push('a missing file becomes a diff of pure additions')
}

function emptyNewFileHasNoDiff() {
  // A write of an empty file: a real action, but there is no content to be consented to.
  const diff = computeFileDiff(null, '')
  assert.deepEqual(diff.lines, [])
  assert.equal(diff.added, 0)

  results.push('a new empty file has no lines to show')
}

function aLargeDiffIsCapped() {
  const before = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n')
  const diff = computeFileDiff(before, after)

  assert.equal(diff.truncated, true, 'a huge diff must be reported as truncated')
  assert.ok(diff.lines.length <= MAX_DIFF_LINES, `lines must be capped, got ${diff.lines.length}`)
  // The counts are of the real change, not of what was shipped, so the card can say "600 of 600
  // lines" rather than quietly under-reporting.
  assert.equal(diff.added, 600)
  assert.equal(diff.removed, 600)

  results.push('a very large diff is capped, with its true size still reported')
}

function main() {
  step('identical', identicalInputsProduceNoDiff)
  step('one line', oneLineChangeIsOneRemovalAndOneAddition)
  step('missing file', missingFileIsAllAdditions)
  step('empty new file', emptyNewFileHasNoDiff)
  step('cap', aLargeDiffIsCapped)

  console.log(`file diff: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
