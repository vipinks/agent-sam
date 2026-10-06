/**
 * The folder name the chat header's chip states for a session's root.
 *
 * A root is an absolute path and a header is nine pixels of height, so the chip names the folder rather
 * than the path: the last segment, with the whole path kept for the tooltip. That is a rule rather than
 * a render, and it is exercised here without a DOM for the reason the other protocol rules are — the
 * renderer may not reach for a path module, so the string work has to be right on its own.
 *
 * The three cases pinned are the three a reader would check by hand: an ordinary root names its last
 * segment, a root written with a trailing separator names the same folder rather than nothing, and a
 * session with no project names nothing at all — which is the absent answer the chip draws as no chip.
 *
 * The separator cases are both here on purpose. Main hands over the platform's own spelling, and a
 * stored root may have been written on another one, so the rule splits on either and is asserted to.
 */
import { strict as assert } from 'node:assert'
import { rootFolderName } from '../../conveyor/protocol/root-name'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
  results.push(label)
}

/** A root names its own last segment. */
function aRootNamesItsLastSegment(): void {
  assert.equal(rootFolderName('C:/xampp8212/htdocs/sam-ai'), 'sam-ai')
  assert.equal(rootFolderName('C:\\xampp8212\\htdocs\\sam-ai'), 'sam-ai')
  assert.equal(rootFolderName('/home/boss/notes'), 'notes')
}

/** A trailing separator names the same folder, not an empty one. */
function aTrailingSeparatorNamesTheSameFolder(): void {
  assert.equal(rootFolderName('C:/xampp8212/htdocs/sam-ai/'), 'sam-ai')
  assert.equal(rootFolderName('C:\\xampp8212\\htdocs\\sam-ai\\'), 'sam-ai')
  assert.equal(rootFolderName('/home/boss/notes//'), 'notes')
}

/** No project is the absent answer, and it is what hides the chip. */
function noProjectNamesNothing(): void {
  assert.equal(rootFolderName(null), null)
  assert.equal(rootFolderName(undefined), null)
  assert.equal(rootFolderName(''), null)
  // Whitespace is not a folder. A root of spaces would otherwise draw a chip with nothing in it.
  assert.equal(rootFolderName('   '), null)
}

/** A root that is nothing but separators has no folder to name. */
function aRootOfSeparatorsHasNoName(): void {
  assert.equal(rootFolderName('/'), null)
  assert.equal(rootFolderName('///'), null)
}

/** The name is the segment, never a reconstruction: no separators survive in it. */
function theNameCarriesNoSeparator(): void {
  assert.equal(rootFolderName('C:/work/sam-ai/')?.includes('/'), false)
  assert.equal(rootFolderName('C:\\work\\sam-ai\\')?.includes('\\'), false)
  // A single-segment root still names that segment rather than vanishing.
  assert.equal(rootFolderName('sam-ai'), 'sam-ai')
}

function main(): void {
  step('a root names its last segment', aRootNamesItsLastSegment)
  step('a trailing separator names the same folder', aTrailingSeparatorNamesTheSameFolder)
  step('no project names nothing', noProjectNamesNothing)
  step('a root of separators has no name', aRootOfSeparatorsHasNoName)
  step('the name carries no separator', theNameCarriesNoSeparator)

  console.log(`root name: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('ROOT NAME TEST FAILED:', err)
  process.exit(1)
}
