/**
 * Verifies the pure git parsers: porcelain v2 status, the branch header block, the log, and the
 * local-branch list.
 *
 * Seeded output rather than a repository, because the interesting properties are the ones a fixture
 * states exactly and a repo makes awkward to produce on demand: a rename with its original path, an
 * unmerged pair of `U`s, an untracked entry, a file whose name contains a space, and a path field
 * that must be read by field position rather than by splitting on whitespace.
 *
 * Every failure mode here is a parsing one, and a parser is the piece that has to be trusted: the
 * renderer draws exactly what these functions return, so a misread status letter is a row in the
 * wrong group rather than a visible error.
 */
import { strict as assert } from 'node:assert'
import {
  GitErrorCode,
  GIT_ERROR_CODES,
  isSafeBranchName,
  parseBranchHeaders,
  parseLocalBranches,
  parseLog,
  parsePorcelainV2,
} from '../../conveyor/protocol/git'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** A status block with one line per shape the parser has to know about. */
const FULL_STATUS = [
  '# branch.oid 3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 src/app.ts',
  '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 src/staged.ts',
  '1 MM N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 src/both.ts',
  '1 A. N... 000000 100644 000000 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 src/added.ts',
  '1 D. N... 100644 000000 000000 4444444444444444444444444444444444444444 0000000000000000000000000000000000000000 src/deleted.ts',
  '2 R. N... 100644 100644 100644 5555555555555555555555555555555555555555 6666666666666666666666666666666666666666 R100 src/renamed.ts\tsrc/original.ts',
  'u UU N... 100644 100644 100644 100644 7777777777777777777777777777777777777777 8888888888888888888888888888888888888888 9999999999999999999999999999999999999999 src/conflict.ts',
  '? src/untracked.ts',
  '! build/ignored.log',
].join('\n')

// ---------------------------------------------------------------- the parser

function ordinaryEntriesCarryBothStates() {
  const entries = parsePorcelainV2(FULL_STATUS)
  const byPath = new Map(entries.map((e) => [e.path, e]))

  assert.equal(byPath.get('src/app.ts')?.indexState, '.', 'an unstaged modification has a clean index')
  assert.equal(byPath.get('src/app.ts')?.worktreeState, 'M', 'and a modified worktree')

  assert.equal(byPath.get('src/staged.ts')?.indexState, 'M', 'a staged modification has a modified index')
  assert.equal(byPath.get('src/staged.ts')?.worktreeState, '.', 'and a clean worktree')

  // Both halves at once is the case a single "status" letter could not express, and it is what makes
  // the two-group display correct rather than lossy.
  assert.equal(byPath.get('src/both.ts')?.indexState, 'M', 'a file staged and then edited again')
  assert.equal(byPath.get('src/both.ts')?.worktreeState, 'M', 'must appear as modified on both sides')

  assert.equal(byPath.get('src/added.ts')?.indexState, 'A', 'an addition is an index change')
  assert.equal(byPath.get('src/added.ts')?.worktreeState, '.', 'with nothing further in the worktree')

  assert.equal(byPath.get('src/deleted.ts')?.indexState, 'D', 'a staged deletion is an index change')

  results.push('an ordinary entry keeps its index and worktree states separately')
}

function renamesKeepBothPaths() {
  const entries = parsePorcelainV2(FULL_STATUS)
  const renamed = entries.find((e) => e.path === 'src/renamed.ts')

  assert.ok(renamed, 'a rename is parsed')
  assert.equal(renamed.kind, 'renamed', 'and is recognised as one')
  // The original path is what lets the UI say "renamed from …" instead of only naming the new file,
  // and the similarity score is not part of the path.
  assert.equal(renamed.origPath, 'src/original.ts', 'with the original path carried alongside')
  assert.equal(renamed.indexState, 'R', 'and the rename in the index state')
  results.push('a renamed entry carries its original path and its score is not part of it')
}

function unmergedAndUntrackedAreTheirOwnKinds() {
  const entries = parsePorcelainV2(FULL_STATUS)

  const conflicted = entries.find((e) => e.path === 'src/conflict.ts')
  assert.ok(conflicted, 'a conflicted file is parsed')
  assert.equal(conflicted.kind, 'unmerged', 'as an unmerged entry')
  assert.equal(conflicted.indexState, 'U', 'with both sides marked unmerged')
  assert.equal(conflicted.worktreeState, 'U', 'rather than being read as a deletion on either side')

  const untracked = entries.find((e) => e.path === 'src/untracked.ts')
  assert.ok(untracked, 'an untracked file is parsed')
  assert.equal(untracked.kind, 'untracked', 'as untracked')
  assert.equal(untracked.indexState, '?', 'with no index version to speak of')
  assert.equal(untracked.worktreeState, '?', 'and no worktree version either')

  const ignored = entries.find((e) => e.path === 'build/ignored.log')
  assert.ok(ignored, 'an ignored entry is parsed when git is asked to report them')
  assert.equal(ignored.kind, 'ignored', 'and is distinguishable from untracked')

  results.push('unmerged, untracked and ignored entries are each their own kind')
}

function pathsAreReadByFieldNotByWhitespace() {
  // The path is the tail of the line, so a name with a space is intact. Splitting the whole line on
  // whitespace would silently truncate it to `src/my`, and then stage the wrong thing.
  const spaced = parsePorcelainV2('1 .M N... 100644 100644 100644 aaa bbb src/my file.ts')
  assert.equal(spaced.length, 1, 'one entry')
  assert.equal(spaced[0].path, 'src/my file.ts', 'a path containing a space survives parsing')

  const tabbed = parsePorcelainV2('? src/with\tinside\tname.ts')
  assert.equal(tabbed[0].path, 'src/with\tinside\tname.ts', 'and so does one containing a tab')

  results.push('a path is taken as the trailing field, so spaces and tabs survive')
}

function theJunkShapesAreIgnoredRatherThanGuessedAt() {
  // A build newer or older than this one, or a locale that changed something: anything not
  // recognised is dropped instead of being turned into a row the user cannot act on.
  const junk = parsePorcelainV2(
    ['', 'not a status line', '1', '1 .M', '99 zz whatever', '# a header', 'X unknown-kind path'].join('\n')
  )
  assert.deepEqual(junk, [], 'no entry is invented from a line the parser does not understand')

  assert.deepEqual(parsePorcelainV2(''), [], 'an empty output is an empty list')
  assert.deepEqual(parsePorcelainV2('\n\n'), [], 'and so is whitespace')

  results.push('an unrecognised line is dropped rather than guessed at')
}

// ---------------------------------------------------------------- branch

function branchHeadersGiveNameAndTracking() {
  const branch = parseBranchHeaders(FULL_STATUS)
  assert.equal(branch.name, 'main', 'the current branch name')
  assert.equal(branch.detached, false, 'not detached')
  assert.equal(branch.upstream, 'origin/main', 'with its upstream')
  assert.equal(branch.ahead, 2, 'ahead by two')
  assert.equal(branch.behind, 1, 'and behind by one')

  results.push('the branch block yields the name, its upstream and both counts')
}

function noUpstreamIsReportedRatherThanInvented() {
  // A fresh repository: an unborn branch, no upstream, no counts. Reading the absent lines as
  // zero-ahead would claim the branch is in sync with something that does not exist.
  const fresh = parseBranchHeaders(['# branch.oid (initial)', '# branch.head main'].join('\n'))
  assert.equal(fresh.name, 'main', 'the name is still known')
  assert.equal(fresh.upstream, null, 'there is no upstream')
  assert.equal(fresh.ahead, 0, 'and no count to report')
  assert.equal(fresh.behind, 0, 'in either direction')

  // A branch with an upstream but no divergence prints no `ab` line either. That is genuinely level,
  // and it is only distinguishable from the case above by the upstream being present.
  const level = parseBranchHeaders(['# branch.head main', '# branch.upstream origin/main'].join('\n'))
  assert.equal(level.upstream, 'origin/main', 'an upstream with no divergence is still an upstream')
  assert.equal(level.ahead, 0, 'and reads as level')

  results.push('a branch with no upstream reports null for its upstream rather than a misleading count')
}

function detachedHeadIsFlagged() {
  const detached = parseBranchHeaders(['# branch.oid 3f2a1b0', '# branch.head (detached)'].join('\n'))
  assert.equal(detached.detached, true, 'a detached head is stated as such')
  assert.equal(detached.name, '(detached)', 'and has no branch name to offer')

  results.push('a detached head is flagged rather than named as a branch')
}

// ---------------------------------------------------------------- log and branches

function theLogIsParsedIntoHashAndSubject() {
  // Unit and record separators rather than a delimiter the subject could contain: a commit subject
  // legitimately holds spaces, colons, and dashes.
  const raw =
    'a1b2c3d\u001ffeat(workbench): add a panel\u001e' +
    'e4f5a6b\u001ffix: a subject with: colons, commas and — dashes\u001e' +
    'c7d8e9f\u001fmerge branch main\u001e'

  const log = parseLog(raw)
  assert.equal(log.length, 3, 'three commits')
  assert.deepEqual(log[0], { hash: 'a1b2c3d', subject: 'feat(workbench): add a panel' })
  assert.equal(
    log[1].subject,
    'fix: a subject with: colons, commas and — dashes',
    'a subject keeps its own punctuation intact'
  )
  assert.equal(log[2].subject, 'merge branch main', 'and a plain one is unaffected')

  // Newest first is git's own order and is what the UI shows; an empty repository logs nothing.
  assert.deepEqual(parseLog(''), [], 'no commits is an empty list, not an error')
  assert.deepEqual(parseLog('   \n'), [], 'and whitespace logs nothing')

  results.push('the log is parsed into hash and subject, and an empty history is not an error')
}

function localBranchesAreListedOnePerLine() {
  const branches = parseLocalBranches(['main', 'feature/changes-panel', ' fix/space ', ''].join('\n'))
  assert.deepEqual(branches, ['main', 'feature/changes-panel', 'fix/space'], 'each branch, trimmed')

  assert.deepEqual(parseLocalBranches(''), [], 'no branches is an empty list')

  results.push('local branches are listed one per line and trimmed')
}

function onlySafeBranchNamesAreAccepted() {
  // Membership in the local list already rejects most nonsense; this is the second gate, and it is
  // what stops an option being smuggled in where a branch name is expected.
  assert.equal(isSafeBranchName('main'), true)
  assert.equal(isSafeBranchName('feature/changes-panel'), true)
  assert.equal(isSafeBranchName('release-14.0'), true)

  assert.equal(isSafeBranchName('--upload-pack=/tmp/evil'), false, 'a leading dash is not a branch')
  assert.equal(isSafeBranchName('-x'), false, 'not even a short one')
  assert.equal(isSafeBranchName(''), false, 'and neither is an empty name')
  assert.equal(isSafeBranchName('has space'), false, 'a branch name cannot contain a space')
  assert.equal(isSafeBranchName('has\nnewline'), false, 'nor a newline')
  assert.equal(isSafeBranchName('has:colon'), false, 'nor any of the characters refs forbid')
  assert.equal(isSafeBranchName('has..dots'), false, 'nor a double dot')
  assert.equal(isSafeBranchName('ends.lock'), false, 'nor a .lock suffix')

  results.push('a branch name is checked for ref syntax before it is ever passed to git')
}

function theCodesAreStable() {
  // The renderer branches on these strings. Pinning them here means a rename fails loudly in a test
  // rather than silently in the UI, where it would fall through to a generic message.
  const expected: GitErrorCode[] = [
    'GIT_NOT_INSTALLED',
    'GIT_NOT_REPO',
    'GIT_FAILED',
    'GIT_INVALID_INPUT',
    'GIT_DIFF_TOO_LARGE',
    'BRANCH_NOT_FOUND',
  ]
  for (const code of expected) {
    assert.ok(GIT_ERROR_CODES.includes(code), `${code} is part of the published set`)
  }

  results.push('the error codes the renderer branches on are pinned')
}

// ---------------------------------------------------------------- harness

function main() {
  step('parse: ordinary', ordinaryEntriesCarryBothStates)
  step('parse: rename', renamesKeepBothPaths)
  step('parse: kinds', unmergedAndUntrackedAreTheirOwnKinds)
  step('parse: paths', pathsAreReadByFieldNotByWhitespace)
  step('parse: junk', theJunkShapesAreIgnoredRatherThanGuessedAt)
  step('branch: headers', branchHeadersGiveNameAndTracking)
  step('branch: untracked', noUpstreamIsReportedRatherThanInvented)
  step('branch: detached', detachedHeadIsFlagged)
  step('log', theLogIsParsedIntoHashAndSubject)
  step('branches', localBranchesAreListedOnePerLine)
  step('branches: safety', onlySafeBranchNamesAreAccepted)
  step('codes', theCodesAreStable)

  console.log(`git porcelain: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
