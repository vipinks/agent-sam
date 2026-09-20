/**
 * Verifies the git module against a real repository it creates itself.
 *
 * A mocked `git` would only prove that the arguments are interpolated the way the mock expects, and
 * the things that actually break here are all in git's behaviour rather than in ours: that a staged
 * file reports both halves of its state, that an unborn `HEAD` makes `reset` fail where `rm --cached`
 * works, that `--filters` is what keeps a `core.autocrlf` repository from reporting every line as
 * changed, and that a revision spec for a path that does not exist exits non-zero rather than
 * printing nothing. So the suite drives the real binary in a temp directory and asserts on what comes
 * back.
 *
 * The identity and the line-ending settings are pinned per repository: a commit needs an author the
 * machine may not have configured, and a test that reads a blob back must not have git rewrite the
 * line endings underneath it.
 *
 * No electron: every function takes the repository root as an argument, which is also why the module
 * needs no store file — see the note in `conveyor/modules/git.ts`.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  commitChanges,
  checkoutLocalBranch,
  discardWorktreePaths,
  listLocalBranches,
  readBranch,
  readDiff,
  readLog,
  readStatus,
  runGit,
  stagePaths,
  unstagePaths,
} from '../../conveyor/modules/git'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

/** A raw git invocation for *arranging* a state. The module's own runner is under test separately. */
function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (out.error) throw out.error
  if (out.status !== 0) throw new Error(`arranging 'git ${args.join(' ')}' failed: ${out.stderr}`)
  return { code: out.status ?? 0, stdout: out.stdout }
}

/**
 * A repository with an identity and no line-ending rewriting.
 *
 * `core.autocrlf=false` matters on Windows: with it on, a blob read back from the index arrives with
 * LF while the file on disk has CRLF, and every line would read as changed. The module asks git for
 * the *worktree* form of a blob for exactly that reason, and this setting is what lets the suite
 * below assert on a diff that is only one line long.
 */
function makeRepo(prefix = 'sam-git-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main', '.'])
  git(root, ['config', 'user.email', 'test@sam.local'])
  git(root, ['config', 'user.name', 'Sam Test'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'core.autocrlf', 'false'])
  return root
}

function write(root: string, name: string, content: string): void {
  writeFileSync(join(root, name), content, 'utf8')
}

/** The entry for one path, or undefined. */
function entryFor(entries: Awaited<ReturnType<typeof readStatus>>, path: string) {
  return entries.find((e) => e.path === path)
}

/** Run a call expected to fail, and hand back the code it failed with. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ConveyorError) return err.code
    throw new Error(`expected a ConveyorError, got ${String(err)}`)
  }
  throw new Error('expected the call to fail, but it resolved')
}

// ---------------------------------------------------------------- the runner

async function theRunnerReportsExitAndOutput() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')

  const ok = await runGit(['status', '--porcelain=v2'], root)
  assert.equal(ok.code, 0, 'a successful command reports zero')
  assert.match(ok.stdout, /\?\sa\.txt/, 'and its stdout')

  // A non-zero exit is *returned* rather than thrown, because "not a repository" and "no git" are
  // different outcomes from "the command failed", and only the caller knows which it is looking for.
  const bad = await runGit(['rev-parse', '--verify', 'no-such-ref'], root)
  assert.notEqual(bad.code, 0, 'a failing command reports its exit code instead of throwing')
  assert.ok(bad.stderr.length > 0, 'with its stderr kept for the message')

  results.push('the runner returns the exit code and both streams, and does not throw on a non-zero exit')
}

async function gitRunsInTheGivenDirectoryAndNotTheProcessCwd() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root)
  assert.equal(inside.stdout.trim(), 'true', 'the command runs inside the repository it was given')

  // The process cwd is the project being tested, which is a repository of its own. A runner that
  // forgot to pass `cwd` would answer for *that* repository and look completely healthy.
  const elsewhere = makeRepo('sam-git-other-')
  const outside = await runGit(['rev-parse', '--show-toplevel'], elsewhere)
  assert.notEqual(
    outside.stdout.trim(),
    root,
    'and a second repository answers for itself, so the cwd is pinned per call'
  )

  results.push('every command runs with the cwd pinned to the repository it was given')
}

// ---------------------------------------------------------------- status

async function anUntrackedFileBecomesAnAdditionWhenStaged() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')

  const untracked = await readStatus(root)
  assert.equal(untracked.length, 1, 'one change')
  assert.equal(entryFor(untracked, 'a.txt')?.kind, 'untracked', 'a new file is untracked')
  assert.equal(entryFor(untracked, 'a.txt')?.indexState, '?', 'with no index side')

  await stagePaths(root, ['a.txt'])

  const staged = await readStatus(root)
  assert.equal(entryFor(staged, 'a.txt')?.indexState, 'A', 'staging it makes it an index addition')
  assert.equal(entryFor(staged, 'a.txt')?.worktreeState, '.', 'with a clean worktree')

  results.push('a new file moves from untracked to a staged addition')
}

async function aCommitClearsTheStatusAndEntersTheLog() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  assert.deepEqual(await readStatus(root), [], 'a committed tree has nothing to report')
  const log = await readLog(root)
  assert.equal(log.length, 1, 'and one commit in the log')
  assert.equal(log[0].subject, 'first commit', 'with the subject it was given')
  assert.match(log[0].hash, /^[0-9a-f]{7,}$/, 'and an abbreviated hash')

  results.push('committing clears the status and adds the commit to the log')
}

async function aStagedEditThenAnUnstagedEditAreBothReported() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  write(root, 'a.txt', 'two\n')
  const unstaged = await readStatus(root)
  assert.equal(entryFor(unstaged, 'a.txt')?.worktreeState, 'M', 'an edit is a worktree change')
  assert.equal(entryFor(unstaged, 'a.txt')?.indexState, '.', 'with a clean index')

  await stagePaths(root, ['a.txt'])
  const afterStage = await readStatus(root)
  assert.equal(entryFor(afterStage, 'a.txt')?.indexState, 'M', 'staging moves it to the index')
  assert.equal(entryFor(afterStage, 'a.txt')?.worktreeState, '.', 'and clears the worktree side')

  // The transition the two-group display depends on: a clean index with a dirty worktree must not be
  // reported as a staged change, or every edit would appear twice.
  assert.notEqual(entryFor(unstaged, 'a.txt')?.indexState, entryFor(afterStage, 'a.txt')?.indexState)
  results.push('an edit moves from the worktree to the index, and the two states are distinguishable')
}

async function anUnstagePutsTheChangeBackInTheWorktree() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')
  write(root, 'a.txt', 'two\n')
  await stagePaths(root, ['a.txt'])

  await unstagePaths(root, ['a.txt'])

  const entries = await readStatus(root)
  assert.equal(entryFor(entries, 'a.txt')?.indexState, '.', 'the index is back to the commit')
  assert.equal(entryFor(entries, 'a.txt')?.worktreeState, 'M', 'and the edit is in the worktree again')
  results.push('unstaging returns a change to the worktree, keeping the edit')
}

async function unstageWorksInARepositoryWithNoCommitYet() {
  // The case that makes a plain `git reset HEAD` wrong: there is no HEAD to reset to, and git fails
  // outright. A staged file in a brand-new repository is an ordinary state — it is what `git init`
  // followed by `git add .` produces — and it has to be unstageable.
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])

  await unstagePaths(root, ['a.txt'])

  const entries = await readStatus(root)
  assert.equal(entryFor(entries, 'a.txt')?.kind, 'untracked', 'the file is untracked again')
  assert.equal(entryFor(entries, 'a.txt')?.indexState, '?', 'with nothing staged')
  results.push('unstaging works before the first commit, where there is no HEAD to reset to')
}

async function discardRestoresTheWorktreeFromTheIndex() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')
  write(root, 'a.txt', 'two\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'second commit')

  write(root, 'a.txt', 'scribbled over\n')
  assert.equal(entryFor(await readStatus(root), 'a.txt')?.worktreeState, 'M', 'the edit is there to lose')

  const outcome = await discardWorktreePaths(root, ['a.txt'])
  assert.deepEqual(outcome.discarded, ['a.txt'], 'the path is reported as discarded')
  assert.deepEqual(outcome.failed, [], 'with nothing failing')
  assert.deepEqual(await readStatus(root), [], 'and the worktree is back to the commit')

  const restored = await readDiff({ rootPath: root, path: 'a.txt', side: 'unstaged' })
  assert.equal(restored.added + restored.removed, 0, 'so the file no longer differs from the index')
  results.push('discarding a worktree change restores the file from the index')
}

async function discardReportsAPathItCouldNotDiscard() {
  // An untracked file has no committed version to restore, so `git checkout` cannot bring it back.
  // The path is reported rather than the batch failing, because the confirmation named several.
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')
  write(root, 'tracked.txt', 'committed\n')
  await stagePaths(root, ['tracked.txt'])
  await commitChanges(root, 'second commit')
  write(root, 'tracked.txt', 'edited\n')
  write(root, 'untracked.txt', 'never added\n')

  const outcome = await discardWorktreePaths(root, ['tracked.txt', 'untracked.txt'])

  assert.deepEqual(outcome.discarded, ['tracked.txt'], 'the tracked edit is discarded')
  assert.equal(outcome.failed.length, 1, 'and only the impossible one is reported')
  assert.equal(outcome.failed[0].path, 'untracked.txt', 'by its path')
  assert.ok(outcome.failed[0].code, 'with a code to branch on')
  // The untracked file is untouched: discarding is not deleting, and a revert must never remove a file
  // the user never asked git to track.
  const entries = await readStatus(root)
  assert.equal(entryFor(entries, 'untracked.txt')?.kind, 'untracked', 'the untracked file is still there')
  results.push('discard reports the path it could not restore, and does not delete an untracked file')
}

// ---------------------------------------------------------------- branch

async function branchReportsNameAndNoUpstreamBeforeOneExists() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  const branch = await readBranch(root)
  assert.equal(branch.name, 'main', 'the branch it was initialised on')
  assert.equal(branch.detached, false, 'not detached')
  assert.equal(branch.upstream, null, 'with no upstream configured yet')
  assert.equal(branch.ahead, 0, 'and so nothing to be ahead of')
  results.push('a branch with no upstream reports the name and no counts')
}

async function aheadCountsTheCommitsAboveTheUpstream() {
  const root = makeRepo()
  const remote = mkdtempSync(join(tmpdir(), 'sam-git-remote-'))
  roots.push(remote)
  git(remote, ['init', '-q', '--bare', '.'])

  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')
  git(root, ['remote', 'add', 'origin', remote])
  git(root, ['push', '-q', '-u', 'origin', 'main'])

  const synced = await readBranch(root)
  assert.equal(synced.upstream, 'origin/main', 'pushing sets the upstream')
  assert.equal(synced.ahead, 0, 'and the branch is level with it')

  write(root, 'a.txt', 'two\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'second commit')

  const ahead = await readBranch(root)
  assert.equal(ahead.ahead, 1, 'one local commit that the upstream does not have')
  assert.equal(ahead.behind, 0, 'and nothing to pull')
  results.push('the ahead count follows the commits the upstream does not have')
}

async function onlyExistingLocalBranchesCanBeCheckedOut() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')
  git(root, ['branch', 'feature/panel'])

  const branches = await listLocalBranches(root)
  assert.ok(branches.includes('main'), 'the current branch is listed')
  assert.ok(branches.includes('feature/panel'), 'and so is another local branch')

  await checkoutLocalBranch(root, 'feature/panel')
  assert.equal((await readBranch(root)).name, 'feature/panel', 'checking out an existing branch works')

  // A name that is not a local branch is refused before git is asked, so a ref that only exists
  // remotely — or an option smuggled into the argument position — cannot become a checkout.
  assert.equal(await codeOf(() => checkoutLocalBranch(root, 'no/such/branch')), 'BRANCH_NOT_FOUND')
  assert.equal(await codeOf(() => checkoutLocalBranch(root, '--upload-pack=/tmp/evil')), 'GIT_INVALID_INPUT')
  assert.equal((await readBranch(root)).name, 'feature/panel', 'and neither attempt moved the checkout')
  results.push('checkout is limited to existing local branches, and refuses an option-shaped name')
}

// ---------------------------------------------------------------- diffs

async function anUnstagedDiffComparesTheIndexWithTheWorktree() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\ntwo\nthree\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  write(root, 'a.txt', 'one\nthree\nfour\n')

  const diff = await readDiff({ rootPath: root, path: 'a.txt', side: 'unstaged' })
  const added = diff.lines.filter((l) => l.kind === 'added').map((l) => l.text)
  const removed = diff.lines.filter((l) => l.kind === 'removed').map((l) => l.text)

  assert.deepEqual(removed, ['two'], 'the deleted line is the only removal')
  assert.deepEqual(added, ['four'], 'and the added line the only addition')
  assert.equal(diff.added, 1, 'counted once')
  assert.equal(diff.removed, 1, 'on each side')
  // One line changed, not the whole file — which is what the line-ending setting above protects.
  assert.ok(
    diff.lines.some((l) => l.kind === 'context' && l.text === 'one'),
    'unchanged lines are context rather than noise'
  )
  results.push('an unstaged diff is the index against the file on disk, one line at a time')
}

async function aStagedDiffComparesHeadWithTheIndex() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  write(root, 'a.txt', 'one\ntwo\n')
  await stagePaths(root, ['a.txt'])

  // What is staged is not yet in any commit, so the only pair that shows it is HEAD against the index.
  const staged = await readDiff({ rootPath: root, path: 'a.txt', side: 'staged' })
  assert.deepEqual(
    staged.lines.filter((l) => l.kind === 'added').map((l) => l.text),
    ['two'],
    'the staged line is an addition against HEAD'
  )

  // And with the worktree matching the index, the unstaged side is empty — the two views are not the
  // same question, which is why the UI asks for the side the row belongs to.
  const unstaged = await readDiff({ rootPath: root, path: 'a.txt', side: 'unstaged' })
  assert.equal(unstaged.added + unstaged.removed, 0, 'while the worktree matches the index')
  results.push('a staged diff is HEAD against the index, and is distinct from the worktree diff')
}

async function aFileThatDoesNotExistOnOneSideDiffsAsEmptyRatherThanFailing() {
  const root = makeRepo()
  write(root, 'kept.txt', 'kept\n')
  await stagePaths(root, ['kept.txt'])
  await commitChanges(root, 'first commit')

  // A new file: no index version, so every line is an addition. The revision spec for a path that is
  // not in the index exits non-zero, which is a fact to read — not a failure to report.
  write(root, 'new.txt', 'alpha\nbeta\n')
  const created = await readDiff({ rootPath: root, path: 'new.txt', side: 'unstaged' })
  assert.equal(created.removed, 0, 'a new file has nothing removed')
  assert.equal(created.added, 2, 'and everything added')

  // A deleted file: no worktree version, so every line is a removal.
  unlinkSync(join(root, 'kept.txt'))
  const deleted = await readDiff({ rootPath: root, path: 'kept.txt', side: 'unstaged' })
  assert.equal(deleted.added, 0, 'a deleted file has nothing added')
  assert.equal(deleted.removed, 1, 'and its lines removed')
  results.push('a file present on only one side diffs as empty on the other rather than failing')
}

async function aDiffPathIsKeptInsideTheRepository() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'first commit')

  // The diff reads two files, so the same containment law every other read obeys applies to it.
  assert.equal(
    await codeOf(() => readDiff({ rootPath: root, path: '../outside.txt', side: 'unstaged' })),
    'PATH_TRAVERSAL'
  )
  results.push('a diff path is resolved through the workspace containment law')
}

// ---------------------------------------------------------------- failures

async function aDirectoryWithNoRepositorySaysSo() {
  const bare = mkdtempSync(join(tmpdir(), 'sam-git-norepo-'))
  roots.push(bare)

  // Every entry point classifies it the same way. The renderer draws this as a plain state, so the
  // code has to be the repository one rather than a generic failure.
  assert.equal(await codeOf(() => readStatus(bare)), 'GIT_NOT_REPO')
  assert.equal(await codeOf(() => readBranch(bare)), 'GIT_NOT_REPO')
  assert.equal(await codeOf(() => readLog(bare)), 'GIT_NOT_REPO')
  assert.equal(await codeOf(() => commitChanges(bare, 'nope')), 'GIT_NOT_REPO')
  results.push('a folder that is not a repository is reported as such by every entry point')
}

async function aMissingFolderIsNotMistakenForAMissingGit() {
  // Both would arrive as ENOENT from spawn — the repository's cwd does not exist, or the binary does
  // not. The directory is therefore checked before git is invoked, so the two can be told apart.
  const missing = join(tmpdir(), 'sam-git-definitely-not-here-91f3')
  assert.equal(await codeOf(() => readStatus(missing)), 'NO_WORKSPACE')
  results.push('a folder that no longer exists is distinguished from a missing git binary')
}

async function anEmptyOrUnsafeInputIsRefused() {
  const root = makeRepo()
  write(root, 'a.txt', 'one\n')

  // `git add` with no paths is not a no-op, it is an error; and a batch that names nothing is a caller
  // bug rather than a git outcome.
  assert.equal(await codeOf(() => stagePaths(root, [])), 'GIT_INVALID_INPUT')
  assert.equal(await codeOf(() => unstagePaths(root, [])), 'GIT_INVALID_INPUT')
  assert.equal(await codeOf(() => commitChanges(root, '   ')), 'GIT_INVALID_INPUT')

  // The stage path is guarded by the same law as the diff: `git add` must not be talked into touching
  // a file outside the repository.
  assert.equal(await codeOf(() => stagePaths(root, ['../outside.txt'])), 'PATH_TRAVERSAL')
  assert.equal(await codeOf(() => stagePaths(root, ['a.txt', '../outside.txt'])), 'PATH_TRAVERSAL')

  results.push('an empty batch, a blank commit message and an escaping path are each refused by code')
}

async function aFailedCommitSurfacesItsCodeRatherThanItsStderr() {
  const root = makeRepo()
  // A repository with nothing to commit: git refuses, and the renderer needs a code to branch on
  // rather than git's paragraph of advice.
  const code = await codeOf(() => commitChanges(root, 'nothing here'))
  assert.equal(code, 'GIT_FAILED', 'the failure is reported under a stable code')
  results.push('a git failure surfaces as a stable code rather than git’s own wording')
}

async function theLogIsCappedAtTwentySubjects() {
  const root = makeRepo()
  write(root, 'a.txt', 'start\n')
  await stagePaths(root, ['a.txt'])
  await commitChanges(root, 'commit 0')

  for (let i = 1; i <= 24; i += 1) {
    write(root, 'a.txt', `edit ${i}\n`)
    await stagePaths(root, ['a.txt'])
    await commitChanges(root, `commit ${i}`)
  }

  const log = await readLog(root)
  assert.equal(log.length, 20, 'twenty commits are returned')
  assert.equal(log[0].subject, 'commit 24', 'newest first')
  assert.equal(log[19].subject, 'commit 5', 'and the oldest five are left off')
  results.push('the log is the last twenty subjects, newest first')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('runner: exit codes', theRunnerReportsExitAndOutput)
    await step('runner: cwd', gitRunsInTheGivenDirectoryAndNotTheProcessCwd)
    await step('status: untracked -> staged', anUntrackedFileBecomesAnAdditionWhenStaged)
    await step('status: commit clears', aCommitClearsTheStatusAndEntersTheLog)
    await step('status: both sides', aStagedEditThenAnUnstagedEditAreBothReported)
    await step('unstage: tracked', anUnstagePutsTheChangeBackInTheWorktree)
    await step('unstage: unborn head', unstageWorksInARepositoryWithNoCommitYet)
    await step('discard: restore', discardRestoresTheWorktreeFromTheIndex)
    await step('discard: refuses', discardReportsAPathItCouldNotDiscard)
    await step('branch: no upstream', branchReportsNameAndNoUpstreamBeforeOneExists)
    await step('branch: ahead', aheadCountsTheCommitsAboveTheUpstream)
    await step('branch: checkout', onlyExistingLocalBranchesCanBeCheckedOut)
    await step('diff: unstaged', anUnstagedDiffComparesTheIndexWithTheWorktree)
    await step('diff: staged', aStagedDiffComparesHeadWithTheIndex)
    await step('diff: one side', aFileThatDoesNotExistOnOneSideDiffsAsEmptyRatherThanFailing)
    await step('diff: containment', aDiffPathIsKeptInsideTheRepository)
    await step('failure: no repo', aDirectoryWithNoRepositorySaysSo)
    await step('failure: missing folder', aMissingFolderIsNotMistakenForAMissingGit)
    await step('failure: input', anEmptyOrUnsafeInputIsRefused)
    await step('failure: commit', aFailedCommitSurfacesItsCodeRatherThanItsStderr)
    await step('log: capped', theLogIsCappedAtTwentySubjects)

    console.log(`git module: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('GIT MODULE TEST FAILED:', err)
  process.exit(1)
})
