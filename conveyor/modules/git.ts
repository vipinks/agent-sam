import { execFile } from 'child_process'
import { readFile as readFileFromDisk, stat } from 'fs/promises'
import { ConveyorError } from 'electron-conveyor/main'
import { z } from 'zod'
import { defineModule, query, command } from '../init'
import { computeFileDiff, type FileDiff } from '../protocol/diff'
import {
  isSafeBranchName,
  parseBranchHeaders,
  parseLocalBranches,
  parseLog,
  parsePorcelainV2,
  type GitBranch,
  type GitCommit,
  type GitDiffSide,
  type GitStatusEntry,
} from '../protocol/git'
import { notifyWorkspaceChanged } from '../events'
import { MAX_FILE_BYTES } from './workspace'
import { resolveWorkspacePath } from './workspace-paths'

/**
 * Git, as a repository view the app owns: reading the working tree's state, and the actions a user
 * takes on it.
 *
 * Main-only, and deliberately the only file in the app that runs `git`. The renderer asks for a
 * status, a branch, a log or an already-computed diff and receives structured data or a diff string —
 * never a raw line of git's output, and never a path it chose for itself.
 *
 * Two decisions shape everything below.
 *
 * The repository root arrives as an argument rather than being read from the persisted workspace store
 * file the way `mentions.ts` reads it. That store is written on a 200ms debounce, so opening a folder
 * and immediately asking for its status would read the *previous* folder — and report "not a
 * repository" about a folder that is one. The root is therefore taken from the renderer's live store
 * mirror, which is the same value the workspace queries are already called with.
 *
 * Every git invocation runs with `cwd` pinned to that root, and every path crossing this boundary is
 * put through `resolveWorkspacePath` before it reaches git's argv. Containment is checked by the same
 * function the agent's tools and the file viewer obey, so a path like `../outside.txt` is refused for
 * the same reason in all three places rather than by a fourth implementation of the same rule.
 */

/** How many subjects the log returns. */
export const GIT_LOG_LIMIT = 20

/** One completed git invocation. A non-zero exit is a result here, not an exception. */
export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
  /** True when the binary could not be spawned at all, which is a different thing from a failure. */
  missing: boolean
}

/**
 * Run one git command in a directory and report what happened.
 *
 * Never throws for a non-zero exit. "There is no repository here", "there is no such revision" and
 * "the user has no commit identity" are all outcomes the caller is looking for, and a throw would
 * flatten three distinguishable situations into one. The only thing that becomes an error is the
 * binary being absent, and that is reported as a flag so each entry point can raise its own
 * `GIT_NOT_INSTALLED` with its own subject.
 *
 * `execFile` rather than a shell: the arguments below include paths and a commit message, both of
 * which are user data, and a shell would be a second parser between that data and the process.
 * `--` separates the revisions from the paths in every call that takes both, so a path that looks
 * like a branch name or an option cannot be read as one.
 */
export async function runGit(args: string[], rootPath: string): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve) => {
    execFile(
      'git',
      args,
      { cwd: rootPath, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: string | number }) | null
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          missing: failure?.code === 'ENOENT',
        })
      }
    )
  })
}

/** The message for an absent binary, worded once so every entry point agrees on it. */
const NOT_INSTALLED = 'Git is not installed, or is not on PATH. Install git to see changes here.'

/** The message for a folder that is not a repository. */
const NOT_REPO = 'This folder is not a git repository.'

/**
 * Confirm the folder is inside a working tree, or refuse with the reason.
 *
 * Checked before every operation rather than cached, because a folder can stop being a repository
 * while it is open — a `.git` directory deleted, a drive unmounted — and an action that silently
 * no-ops in that state is worse than one that says so.
 */
export async function assertRepository(rootPath: string | null): Promise<string> {
  if (!rootPath) throw new ConveyorError('GIT_NOT_REPO', NOT_REPO)

  // The folder is checked *before* git is spawned, and by the same containment law the file reads
  // obey. `execFile` reports a missing cwd and a missing binary identically — both are ENOENT — so
  // without this check a folder that has been deleted or unmounted would be diagnosed as git not
  // being installed, and every window would be told so. `resolveWorkspacePath` raises NO_WORKSPACE
  // for a folder that is gone, which is the truthful answer, and its result is what git runs in.
  const root = resolveWorkspacePath(rootPath, '.')

  const result = await runGit(['rev-parse', '--is-inside-work-tree'], root)
  // Safe to read ENOENT as "no binary" here: the working directory above is known to exist, so the
  // only thing left to be missing is the executable itself.
  if (result.missing) throw new ConveyorError('GIT_NOT_INSTALLED', NOT_INSTALLED)
  if (result.code !== 0 || result.stdout.trim() !== 'true') {
    throw new ConveyorError('GIT_NOT_REPO', NOT_REPO)
  }

  return root
}

/** Whether HEAD resolves to a commit. A fresh repository has a branch name but no commit behind it. */
async function hasHead(rootPath: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], rootPath)
  return result.code === 0
}

/**
 * A failed git call, as a stable code.
 *
 * The stderr is carried into the message because a person reading a commit failure wants to know
 * which one it was, but the *code* is what the renderer branches on — the rule this app follows
 * everywhere a failure crosses the boundary.
 */
function failed(operation: string, result: GitRunResult): ConveyorError {
  const detail = result.stderr.trim().split('\n')[0] ?? ''
  if (result.missing) return new ConveyorError('GIT_NOT_INSTALLED', NOT_INSTALLED)
  return new ConveyorError('GIT_FAILED', detail ? `${operation} failed: ${detail}` : `${operation} failed.`)
}

/**
 * Validate the paths of a batch action and hand back the form git should receive.
 *
 * Containment first, then separator normalisation: git reports and expects forward slashes, and a
 * path that arrived with backslashes would name a different file to `git add` on the platforms where
 * the backslash is an escape rather than a separator.
 */
function resolveBatchPaths(rootPath: string, requested: readonly string[]): string[] {
  const paths: string[] = []
  for (const raw of requested) {
    // Throws `PATH_TRAVERSAL` / `INVALID_PATH` for anything outside the open folder.
    resolveWorkspacePath(rootPath, raw)
    paths.push(raw.replace(/\\/g, '/'))
  }
  return paths
}

// ---------------------------------------------------------------- reads

/** The working tree's state, as entries the UI groups. */
export async function readStatus(rootPath: string | null): Promise<GitStatusEntry[]> {
  const root = await assertRepository(rootPath)
  const result = await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], root)
  if (result.code !== 0) throw failed('git status', result)
  return parsePorcelainV2(result.stdout)
}

/** The current branch, its upstream, and the divergence from it. */
export async function readBranch(rootPath: string | null): Promise<GitBranch> {
  const root = await assertRepository(rootPath)
  // `--untracked-files=no` because the branch block is all this needs, and the entries are
  // `readStatus`'s job: walking the worktree twice per refresh would pay the same cost twice.
  const result = await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=no'], root)
  if (result.code !== 0) throw failed('git status', result)
  return parseBranchHeaders(result.stdout)
}

/** The last few commits, newest first. An empty repository logs nothing rather than failing. */
export async function readLog(rootPath: string | null): Promise<GitCommit[]> {
  const root = await assertRepository(rootPath)
  // An unborn HEAD makes `git log` exit non-zero with a paragraph about the branch not having any
  // commits yet. That is an empty history, which is an ordinary state for a repository to be in.
  if (!(await hasHead(root))) return []

  const result = await runGit(['log', `-${GIT_LOG_LIMIT}`, '--pretty=format:%h%x1f%s%x1e'], root)
  if (result.code !== 0) throw failed('git log', result)
  return parseLog(result.stdout)
}

/** The local branches, for the checkout control. */
export async function listLocalBranches(rootPath: string | null): Promise<string[]> {
  const root = await assertRepository(rootPath)
  const result = await runGit(['branch', '--list', '--format=%(refname:short)'], root)
  if (result.code !== 0) throw failed('git branch', result)
  return parseLocalBranches(result.stdout)
}

// ---------------------------------------------------------------- actions

/**
 * Stage paths, so the next commit would contain them.
 *
 * An empty batch is refused rather than passed on: `git add` with no pathspec exits non-zero with
 * usage text, which would surface as a puzzling `GIT_FAILED` for what is really a bug in the caller.
 */
export async function stagePaths(rootPath: string | null, requested: readonly string[]): Promise<void> {
  const root = await assertRepository(rootPath)
  if (requested.length === 0) throw new ConveyorError('GIT_INVALID_INPUT', 'No files were given to stage.')

  const paths = resolveBatchPaths(root, requested)
  // `--` so a path that reads as a revision or an option is treated as a path.
  const result = await runGit(['add', '--', ...paths], root)
  if (result.code !== 0) throw failed('git add', result)

  notifyWorkspaceChanged({ kind: 'command-exited' })
}

/**
 * Unstage paths, putting the change back in the worktree without losing it.
 *
 * Two commands, because a repository with no commit yet has no `HEAD` to reset against, and
 * `git reset HEAD -- <path>` fails there with an unborn-branch error. `git rm --cached` is what
 * removes a path from the index when there is no earlier revision to restore from — which is exactly
 * the state a brand-new repository is in.
 */
export async function unstagePaths(rootPath: string | null, requested: readonly string[]): Promise<void> {
  const root = await assertRepository(rootPath)
  if (requested.length === 0) throw new ConveyorError('GIT_INVALID_INPUT', 'No files were given to unstage.')

  const paths = resolveBatchPaths(root, requested)
  const args = (await hasHead(root))
    ? ['reset', '-q', 'HEAD', '--', ...paths]
    : ['rm', '--cached', '-r', '-q', '--', ...paths]
  const result = await runGit(args, root)
  if (result.code !== 0) throw failed('git reset', result)

  notifyWorkspaceChanged({ kind: 'command-exited' })
}

/**
 * Commit what is staged.
 *
 * A blank message is refused here rather than by git, because "please supply a message" is our rule
 * and git's answer to a blank one is an editor prompt — which this process must never open, since
 * there is no terminal attached to it.
 */
export async function commitChanges(rootPath: string | null, message: string): Promise<void> {
  const root = await assertRepository(rootPath)
  const trimmed = message.trim()
  if (!trimmed) throw new ConveyorError('GIT_INVALID_INPUT', 'A commit message is required.')

  const result = await runGit(['commit', '-q', '-m', trimmed], root)
  if (result.code !== 0) throw failed('git commit', result)

  notifyWorkspaceChanged({ kind: 'command-exited' })
}

/** A path a discard could not restore, and why. */
export interface DiscardFailure {
  path: string
  /** A stable code, so the panel can name the reason rather than print git's sentence. */
  code: string
}

/** What a discard managed to do, per path. */
export interface DiscardResult {
  discarded: string[]
  /** Paths git refused to restore — untracked files, most often. Reported rather than thrown. */
  failed: DiscardFailure[]
}

/**
 * Throw away the worktree changes to paths, restoring them from the index.
 *
 * Per path rather than one batch, because `git checkout -- a b c` fails as a unit: one path that is
 * untracked or already absent would leave the others untouched while reporting a single failure, and
 * the user would have no way to tell which. Restoring what can be restored and naming what could not
 * is the honest version, and it is why this returns a result instead of throwing.
 *
 * The changes are gone once this runs — which is why the UI puts it behind a confirmation naming the
 * paths, and why this function does not: by the time it is called the user has already said yes.
 */
export async function discardWorktreePaths(
  rootPath: string | null,
  requested: readonly string[]
): Promise<DiscardResult> {
  const root = await assertRepository(rootPath)
  if (requested.length === 0) throw new ConveyorError('GIT_INVALID_INPUT', 'No files were given to discard.')

  const paths = resolveBatchPaths(root, requested)
  const discarded: string[] = []
  const failedPaths: DiscardFailure[] = []

  for (const path of paths) {
    const result = await runGit(['checkout', '--', path], root)
    if (result.code === 0) discarded.push(path)
    // The reason is classified rather than copied: an untracked path is the ordinary case here (there
    // is nothing in the index to restore it from), and that is a different thing to tell the user than
    // a checkout that failed for a reason of its own.
    else
      failedPaths.push({ path, code: /did not match any file|pathspec/i.test(result.stderr) ? 'UNTRACKED' : 'FAILED' })
  }

  if (discarded.length > 0) {
    // A restored file is a file whose contents changed, so the viewer and any listing of it are stale.
    for (const path of discarded) notifyWorkspaceChanged({ kind: 'written', path: `${root}/${path}` })
  }

  return { discarded, failed: failedPaths }
}

/**
 * Switch to an existing local branch.
 *
 * The name is checked against the repository's own local list, and then against git's ref syntax,
 * before it reaches argv. An unknown name is `BRANCH_NOT_FOUND` rather than `GIT_FAILED`, because
 * "that branch does not exist" is a different thing from "the checkout failed" — and because the
 * check against the real list is what keeps a name like `--orphan` from ever being passed along.
 */
export async function checkoutLocalBranch(rootPath: string | null, requested: string): Promise<void> {
  const root = await assertRepository(rootPath)

  // Syntax first, then membership, because they are two different refusals. A name that is not valid
  // ref syntax at all — empty, or `--upload-pack=…` dressed as a branch — is a malformed request and
  // never reaches git. A well-formed name that simply is not a local branch here is an ordinary
  // outcome the user can act on.
  if (!isSafeBranchName(requested)) {
    throw new ConveyorError('GIT_INVALID_INPUT', `That is not a usable branch name: ${requested}`)
  }

  const branches = await listLocalBranches(root)
  if (!branches.includes(requested)) {
    throw new ConveyorError('BRANCH_NOT_FOUND', `There is no local branch called ${requested}.`)
  }

  const result = await runGit(['checkout', requested], root)
  if (result.code !== 0) throw failed('git checkout', result)

  notifyWorkspaceChanged({ kind: 'command-exited' })
}

// ---------------------------------------------------------------- diffs

/**
 * One version of a file, read from a revision, or an empty string when there is nothing there.
 *
 * `--filters --path=<path>` asks git for the *worktree* form of the blob rather than the raw object,
 * which is what makes this comparable with the file on disk. Without it a repository with
 * `core.autocrlf` on reads a CRLF file back as LF, and the diff would report every line of an
 * untouched file as changed — the phantom whole-file diff this option exists to prevent.
 *
 * A path that is absent from the revision is empty rather than an error: adding a file diffs against
 * nothing, and that is the diff, not a failure.
 *
 * `spec` is the whole revision expression (`HEAD:path`, or `:path` for the index) rather than a
 * revision the path is appended to. Building it here from a revision and a path is how the index side
 * became `::path`, which git rejects — and a rejected read comes back empty, which would have shown
 * every unstaged change as a whole-file addition.
 */
async function readRevision(rootPath: string, spec: string, path: string): Promise<string> {
  const result = await runGit(['cat-file', '--filters', `--path=${path}`, spec], rootPath)
  if (result.code !== 0) return ''
  return result.stdout
}

/**
 * One version of a file, read from disk, or an empty string when it is not there.
 *
 * The size is checked before the read, like every other read in this app, so a large file is refused
 * rather than loaded — and refused under its own code, because "this file is too big to diff" is
 * something the pane can say plainly instead of showing an empty diff that reads as no change.
 */
async function readWorktreeFile(rootPath: string, path: string): Promise<string> {
  const absolute = resolveWorkspacePath(rootPath, path)

  let size: number
  try {
    size = (await stat(absolute)).size
  } catch {
    // Deleted in the worktree: the diff of a deletion has nothing on this side.
    return ''
  }

  if (size > MAX_FILE_BYTES) {
    throw new ConveyorError('GIT_DIFF_TOO_LARGE', `${path} is too large to diff (the cap is 1 MB).`)
  }

  try {
    return await readFileFromDisk(absolute, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The diff for one selected entry, computed here and sent as a finished result.
 *
 * The two sides are chosen by which question the row asks. An unstaged change compares the index with
 * the worktree ("what have I not staged yet"); a staged one compares `HEAD` with the index ("what
 * would this commit contain"). Those are two different things a user acts on separately, so each pane
 * has to answer its own question rather than the merged one.
 *
 * The computation reuses the phase 9 line-level diff — the same function the agent's write card
 * renders through — so a diff looks and behaves identically wherever it appears, and the LCS is not
 * written a second time for git's benefit.
 */
export async function readDiff(input: {
  rootPath: string | null
  path: string
  side: GitDiffSide
  /** The previous name, for a rename: the old side has to be read from where the file used to be. */
  origPath?: string
}): Promise<FileDiff> {
  const root = await assertRepository(input.rootPath)
  const path = input.path.replace(/\\/g, '/')
  // Containment is enforced before a path reaches git or the disk, by the shared law.
  resolveWorkspacePath(root, path)

  const before =
    input.side === 'staged'
      ? await readRevision(root, `HEAD:${input.origPath ?? path}`, input.origPath ?? path)
      : // The index, as the empty revision: `:path` is the staged version of that path.
        await readRevision(root, `:${input.origPath ?? path}`, input.origPath ?? path)

  const after =
    input.side === 'staged'
      ? // The index is the "after" side of a staged change. A rename whose new name is not in the
        // index under this path reads as an addition here, which is the truthful description of that
        // half of the change viewed on its own.
        await readRevision(root, `:${path}`, path)
      : await readWorktreeFile(root, path)

  return computeFileDiff(before, after)
}

// ---------------------------------------------------------------- the module

/**
 * The repository view, as the renderer sees it.
 *
 * `rootPath` is an input on every member, nullable because the open folder is nullable. A null root is
 * `GIT_NOT_REPO` from `assertRepository` — not a validation error — so a window with no folder open
 * gets the same plain answer as a folder that is not a repository, which is what the Changes panel
 * renders either way.
 */
export const gitModule = defineModule({
  /** Every changed path, staged and unstaged, with both of its states. */
  status: query(z.object({ rootPath: z.string().nullable() }), async ({ input }) => readStatus(input.rootPath)),

  /** The current branch, its upstream, and the divergence from it. */
  branch: query(z.object({ rootPath: z.string().nullable() }), async ({ input }) => readBranch(input.rootPath)),

  /** The last commits' subjects, for the recent list. */
  log: query(z.object({ rootPath: z.string().nullable() }), async ({ input }) => readLog(input.rootPath)),

  /** The local branches the checkout control may offer. */
  localBranches: query(z.object({ rootPath: z.string().nullable() }), async ({ input }) =>
    listLocalBranches(input.rootPath)
  ),

  /** A finished diff for one entry, in the same shape the agent's write card renders. */
  diff: query(
    z.object({
      rootPath: z.string().nullable(),
      path: z.string().min(1),
      side: z.enum(['staged', 'unstaged']),
      origPath: z.string().optional(),
    }),
    async ({ input }) =>
      readDiff({ rootPath: input.rootPath, path: input.path, side: input.side, origPath: input.origPath })
  ),

  /**
   * Paths to stage. The array is capped rather than trusted: it is renderer-supplied and every entry
   * becomes an argument to a process, so an unbounded list would be an unbounded command line.
   */
  stage: command(
    z.object({ rootPath: z.string().nullable(), paths: z.array(z.string().min(1)).min(1).max(500) }),
    async ({ input }) => {
      await stagePaths(input.rootPath, input.paths)
      return { staged: input.paths.length }
    }
  ),

  /** Paths to take back out of the index, leaving their changes in the worktree. */
  unstage: command(
    z.object({ rootPath: z.string().nullable(), paths: z.array(z.string().min(1)).min(1).max(500) }),
    async ({ input }) => {
      await unstagePaths(input.rootPath, input.paths)
      return { unstaged: input.paths.length }
    }
  ),

  /** Commit what is staged, under a message the user typed. */
  commit: command(
    z.object({ rootPath: z.string().nullable(), message: z.string().min(1).max(5000) }),
    async ({ input }) => {
      await commitChanges(input.rootPath, input.message)
      return { committed: true }
    }
  ),

  /** Throw away worktree changes to paths. Destructive, and confirmed in the UI before it is called. */
  discardWorktree: command(
    z.object({ rootPath: z.string().nullable(), paths: z.array(z.string().min(1)).min(1).max(500) }),
    async ({ input }) => discardWorktreePaths(input.rootPath, input.paths)
  ),

  /** Switch to an existing local branch. A name that is not one of them is refused. */
  checkoutBranch: command(z.object({ rootPath: z.string().nullable(), name: z.string().min(1) }), async ({ input }) => {
    await checkoutLocalBranch(input.rootPath, input.name)
    return { branch: input.name }
  }),
})
