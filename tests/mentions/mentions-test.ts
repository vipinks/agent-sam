/**
 * Verifies the pure mention rules: what is skipped, what is capped, in what order, and how a read is
 * turned into a context section.
 *
 * Pure on purpose. These are the decisions that decide what the model is shown and what it is not —
 * a `node_modules` that leaked into the picker, a cap applied after the walk instead of during it, a
 * file that failed to read being silently dropped rather than reported. Every one of those is a rule
 * about data, so none of them needs a filesystem to be wrong.
 *
 * Written before the module exists: the first run of this file is the red half of the exercise.
 */
import { strict as assert } from 'node:assert'
import {
  assembleMentionContext,
  isSkippedPath,
  isSkippedSegment,
  MAX_MENTION_ENTRIES,
  MAX_MENTION_PATHS,
  orderDirectoryEntries,
  SKIP_SEGMENTS,
  type MentionRead,
} from '../../conveyor/protocol/mentions'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- what is skipped

function theSkipSegmentsAreTheNamedFive() {
  assert.deepEqual(
    [...SKIP_SEGMENTS].sort(),
    ['.git', 'dist', 'node_modules', 'out', 'vendor'].sort(),
    'exactly the five named segments are skipped'
  )

  for (const segment of SKIP_SEGMENTS) {
    assert.equal(isSkippedSegment(segment), true, `${segment} is a skipped segment`)
  }

  // Ordinary names are not skipped, and the match is on the whole segment rather than a prefix.
  assert.equal(isSkippedSegment('src'), false, 'an ordinary directory is not skipped')
  assert.equal(isSkippedSegment('outbox'), false, 'a name that merely starts with a skipped one is kept')
  assert.equal(isSkippedSegment('my_out'), false, 'and one that merely ends with it')
  assert.equal(isSkippedSegment('outs'), false, 'and one that is a superset')

  // Case-insensitive, because the filesystems this runs on are: a `Node_Modules` that slipped through
  // on Windows would be a directory of thousands of files offered as mention targets.
  assert.equal(isSkippedSegment('NODE_MODULES'), true, 'the match ignores case')
  assert.equal(isSkippedSegment('Dist'), true, 'for every segment')
  results.push('the five skip segments are exact whole-segment matches, case-insensitively')
}

function aPathIsSkippedWhenAnySegmentIs() {
  // A nested occurrence counts: the segments are what matters, not the depth.
  assert.equal(isSkippedPath('node_modules/react/index.js'), true, 'a leading segment')
  assert.equal(isSkippedPath('src/node_modules/x.js'), true, 'a middle segment')
  assert.equal(isSkippedPath('a/b/vendor/c.js'), true, 'a deeply nested segment')
  assert.equal(isSkippedPath('out'), true, 'the segment alone')
  assert.equal(isSkippedPath('dist/bundle.js'), true, 'under dist')

  // Both separators, because a path may have been produced on either platform by the time it is here.
  assert.equal(isSkippedPath('src\\node_modules\\x.js'), true, 'a windows-style separator')
  assert.equal(isSkippedPath('src\\.git\\config'), true, 'for every skipped segment')

  // Kept paths: the segment match must not degrade into a substring match.
  assert.equal(isSkippedPath('src/app.ts'), false, 'an ordinary path is kept')
  assert.equal(isSkippedPath('src/outbox/app.ts'), false, 'a lookalike directory is kept')
  assert.equal(isSkippedPath('docs/vendors.md'), false, 'a file whose name merely resembles a segment is kept')
  assert.equal(isSkippedPath('app/outer.ts'), false, 'and another')
  results.push('a path is skipped when any one of its segments is a skipped segment')
}

// ---------------------------------------------------------------- the cap and the order

function theCapIsTheDocumentedOne() {
  assert.equal(MAX_MENTION_ENTRIES, 2000, 'the walk cap is 2000 entries')
  // The send cap is a separate, much smaller bound: the walk answers "what could be mentioned", and
  // this answers "how many one message may carry". Tying them together would either make the picker
  // truncate a large repo or let one send carry a thousand files.
  assert.ok(MAX_MENTION_PATHS > 0 && MAX_MENTION_PATHS < MAX_MENTION_ENTRIES, 'the send cap is smaller')
  results.push('the walk cap and the send cap are both bounded, and the send cap is the smaller one')
}

function entriesComeBackInDeterministicOrder() {
  const scrambled = ['zeta.ts', 'Alpha.ts', 'alpha.ts', 'Beta.ts', 'beta.ts']

  const once = orderDirectoryEntries(scrambled)
  const twice = orderDirectoryEntries([...scrambled].reverse())

  // Same answer from a different starting order: that is what deterministic means here.
  assert.deepEqual(once, twice, 'the order does not depend on the order the names arrived in')
  assert.deepEqual(scrambled, ['zeta.ts', 'Alpha.ts', 'alpha.ts', 'Beta.ts', 'beta.ts'], 'and the input is not mutated')

  // Case-insensitive first, so `Alpha.ts` and `alpha.ts` sit together rather than a capital letter
  // sorting every uppercase name above every lowercase one.
  assert.ok(once.indexOf('alpha.ts') < once.indexOf('beta.ts'), 'ordering is case-insensitive on the name')
  assert.ok(once.indexOf('Alpha.ts') < once.indexOf('Beta.ts'), 'for the whole list')

  // The tie between two names differing only by case is broken deterministically rather than left to
  // whatever the listing happened to return — otherwise the cap could keep either of them.
  assert.equal(once.indexOf('Alpha.ts') < once.indexOf('alpha.ts'), true, 'a stable tiebreak settles a case tie')
  results.push('directory entries are ordered deterministically, case-insensitively, without mutating the input')
}

// ---------------------------------------------------------------- the assembled section

function anEmptyRequestAsksForNothing() {
  const { section, notices } = assembleMentionContext([])
  assert.equal(section, '', 'no mentions means no section, so nothing is appended to the message')
  assert.deepEqual(notices, [], 'and no notices')
  results.push('no mentions produces no section at all, so an ordinary send is untouched')
}

function theSectionPreservesRequestOrder() {
  const entries: MentionRead[] = [
    { path: 'src/b.ts', status: 'ok', text: 'export const b = 1' },
    { path: 'src/a.ts', status: 'ok', text: 'export const a = 1' },
    { path: 'z.ts', status: 'ok', text: 'export const z = 1' },
  ]

  const { section, notices } = assembleMentionContext(entries)
  assert.deepEqual(notices, [], 'nothing was skipped')

  // The order the user picked, not a sorted one: the section is a record of the request.
  const bAt = section.indexOf('src/b.ts')
  const aAt = section.indexOf('src/a.ts')
  const zAt = section.indexOf('z.ts')
  assert.ok(bAt >= 0 && aAt >= 0 && zAt >= 0, 'every path is named')
  assert.ok(bAt < aAt, 'the first mentioned file comes first')
  assert.ok(aAt < zAt, 'and the rest follow in request order')

  // Contents, not just names: that is the whole point of mentioning a file.
  assert.ok(section.includes('export const b = 1'), 'the first file content is carried')
  assert.ok(section.includes('export const z = 1'), 'and the last')
  results.push('the assembled section carries every file in request order, contents included')
}

function aSkippedFileIsNamedWithItsCode() {
  const entries: MentionRead[] = [
    { path: 'src/ok.ts', status: 'ok', text: 'const ok = true' },
    { path: 'src/huge.ts', status: 'too-large' },
    { path: 'src/gone.ts', status: 'missing' },
    { path: 'src/outside.ts', status: 'refused' },
  ]

  const { section, notices } = assembleMentionContext(entries)

  assert.deepEqual(
    notices,
    [
      { path: 'src/huge.ts', code: 'CONTEXT_FILE_TOO_LARGE' },
      { path: 'src/gone.ts', code: 'CONTEXT_FILE_NOT_FOUND' },
      { path: 'src/outside.ts', code: 'CONTEXT_FILE_REFUSED' },
    ],
    'each skip is reported once, in request order, with its own code'
  )

  // The model has to be told, not left to assume: a mention that vanished silently would read as
  // though the file were empty, which is a different and much more misleading thing.
  assert.ok(section.includes('src/huge.ts'), 'the oversized file is named in the section')
  assert.ok(section.includes('CONTEXT_FILE_TOO_LARGE'), 'with its code')
  assert.ok(section.includes('src/gone.ts'), 'so is the missing one')
  assert.ok(section.includes('CONTEXT_FILE_NOT_FOUND'), 'with its code')
  assert.ok(section.includes('src/outside.ts'), 'and the refused one')
  // The readable file is still there.
  assert.ok(section.includes('const ok = true'), 'the readable file is still carried')
  results.push('a file that could not be read is named with its code rather than silently dropped')
}

function aRequestOfNothingButFailuresStillSaysSo() {
  // Every mention failed. The section is still worth sending: the model should know the user pointed
  // at a file that could not be included, rather than being told nothing at all.
  const { section, notices } = assembleMentionContext([{ path: 'src/nope.ts', status: 'missing' }])
  assert.ok(section.length > 0, 'the section still says something')
  assert.ok(section.includes('src/nope.ts'), 'naming the file')
  assert.equal(notices.length, 1, 'and the notice is reported')
  results.push('a request whose every file failed still produces a section that says so')
}

function theAssemblerNeverThrows() {
  // The assembler is fed by a disk read, so it is the last place a surprise should become a failed
  // send. None of these may throw; the send must survive whatever the filesystem produced.
  const hostile: MentionRead[][] = [
    [],
    [{ path: '', status: 'ok', text: '' }],
    [{ path: 'src/x.ts', status: 'ok', text: '' }],
    [{ path: 'a\nb.ts', status: 'ok', text: 'newline in the path' }],
    [{ path: 'src/x.ts', status: 'ok', text: '\u0000\uFFFD' }],
    Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, status: 'missing' as const })),
  ]

  for (const [index, entries] of hostile.entries()) {
    const out = assembleMentionContext(entries)
    assert.equal(typeof out.section, 'string', `case ${index} must produce a string section`)
    assert.ok(Array.isArray(out.notices), `case ${index} must produce a notices array`)
  }
  results.push('the assembler returns a section for any input rather than throwing')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('skip segments', theSkipSegmentsAreTheNamedFive)
  step('skipped paths', aPathIsSkippedWhenAnySegmentIs)
  step('caps', theCapIsTheDocumentedOne)
  step('order', entriesComeBackInDeterministicOrder)
  step('no request', anEmptyRequestAsksForNothing)
  step('request order', theSectionPreservesRequestOrder)
  step('skips reported', aSkippedFileIsNamedWithItsCode)
  step('all failed', aRequestOfNothingButFailuresStillSaysSo)
  step('never throws', theAssemblerNeverThrows)

  console.log(`mentions rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('MENTIONS TEST FAILED:', err)
  process.exit(1)
}
