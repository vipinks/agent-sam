/**
 * The git vocabulary: the codes a failure carries, and the parsers that turn git's own output into
 * something the renderer can draw.
 *
 * Pure and shared rather than main-only, for the same reason `mentions.ts` is: main runs the binary,
 * but the *reading* of what it printed is a decision a test should be able to make without a
 * repository. Porcelain v2 is a machine format, and a machine format parsed in the wrong place is the
 * kind of bug that shows up as a row in the wrong group rather than as an error — so it is parsed
 * here, by functions that take a string and return data.
 *
 * Nothing in this file touches a disk, a process, or electron. It is imported by
 * `conveyor/modules/git.ts` in main and by the node suites, and by nothing in `app/`.
 */

/**
 * The codes a git failure is reported under.
 *
 * Stable strings rather than wording, so the renderer branches on the code and the sentence stays
 * free to change — the rule every other failure in this app follows. `GIT_NOT_INSTALLED` and
 * `GIT_NOT_REPO` are separate from `GIT_FAILED` because they are not failures of an operation: they
 * are the two situations in which there is no operation to attempt, and the UI says something
 * different for each.
 */
export const GIT_ERROR_CODES = [
  'GIT_NOT_INSTALLED',
  'GIT_NOT_REPO',
  'GIT_FAILED',
  'GIT_INVALID_INPUT',
  'GIT_DIFF_TOO_LARGE',
  'BRANCH_NOT_FOUND',
] as const

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number]

/** How an entry got into the status list. Drives grouping and the row's wording, not its state. */
export type GitEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'

/**
 * One status entry.
 *
 * The index and worktree states are kept apart rather than collapsed into one letter, because they
 * describe two different things a user can act on separately: what the next commit would contain, and
 * what is sitting unsaved on disk. A file that is staged and then edited again is `M` on both sides,
 * and that is precisely the case a single letter loses.
 *
 * `origPath` is present only for a rename, where git reports the old name alongside the new one.
 */
export interface GitStatusEntry {
  /** Repository-relative, forward-slashed, exactly as git printed it. */
  path: string
  /** The previous path, for a rename. */
  origPath?: string
  /** `.` when the index matches HEAD; otherwise the index's own state letter. */
  indexState: string
  /** `.` when the worktree matches the index; otherwise the worktree's own state letter. */
  worktreeState: string
  kind: GitEntryKind
}

/** The current branch, its upstream when there is one, and how far apart the two are. */
export interface GitBranch {
  /** The branch name, or `(detached)` when HEAD is not on one. */
  name: string
  detached: boolean
  /** `null` when the branch tracks nothing — which is not the same as being level with something. */
  upstream: string | null
  ahead: number
  behind: number
}

/** One commit, as the log shows it. */
export interface GitCommit {
  hash: string
  subject: string
}

/** Which two versions of a file a diff compares. */
export type GitDiffSide = 'staged' | 'unstaged'

/**
 * A path a discard could not restore, and why.
 *
 * Shared rather than main-only, because the renderer reports the outcome: it is the result of an
 * action the panel offers, so its shape belongs with the rest of the vocabulary both processes use.
 * A `conveyor/modules/*` file is main-only, and the renderer imports that directory for nothing at
 * all — not even a type.
 */
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
 * Split a porcelain record into its leading whitespace-separated fields and the path tail.
 *
 * The path is the *tail* of the line, never a field: a file called `my file.ts` would otherwise be
 * silently truncated to `my`, and since that string is then handed back to git as the thing to stage,
 * the wrong file would be staged. Splitting a fixed number of fields from the front is what keeps the
 * whole path intact while still reading the states positionally.
 */
function splitFields(body: string, count: number): { fields: string[]; tail: string } {
  const fields: string[] = []
  let index = 0

  for (let taken = 0; taken < count; taken += 1) {
    const space = body.indexOf(' ', index)
    // Fewer fields than the record kind promises: the caller drops it rather than guessing.
    if (space === -1) return { fields, tail: '' }
    fields.push(body.slice(index, space))
    index = space + 1
  }

  return { fields, tail: body.slice(index) }
}

/**
 * Read `git status --porcelain=v2 --branch` output into entries.
 *
 * Header lines (`# branch.…`) are the branch block and are read by `parseBranchHeaders`, so they are
 * skipped here. An unrecognised line is dropped rather than guessed at: a line this build does not
 * understand is a line it cannot offer a truthful action for, and inventing an entry from it would put
 * a row in the UI that stages or discards something other than what it names.
 */
export function parsePorcelainV2(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '' || line.startsWith('#')) continue

    // Untracked and ignored records carry a path and nothing else.
    if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), indexState: '?', worktreeState: '?', kind: 'untracked' })
      continue
    }
    if (line.startsWith('! ')) {
      entries.push({ path: line.slice(2), indexState: '!', worktreeState: '!', kind: 'ignored' })
      continue
    }

    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — an ordinary changed entry.
    if (line.startsWith('1 ')) {
      const { fields, tail } = splitFields(line.slice(2), 7)
      if (fields.length < 7 || !tail) continue
      entries.push({
        path: tail,
        indexState: fields[0][0],
        worktreeState: fields[0][1],
        kind: 'ordinary',
      })
      continue
    }

    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>` — a rename or copy.
    if (line.startsWith('2 ')) {
      const [record, origPath] = splitRecordAndOrigin(line.slice(2))
      const { fields, tail } = splitFields(record, 8)
      if (fields.length < 8 || !tail) continue
      entries.push({
        path: tail,
        // Absent when git reported a rename without an original (a `-z`-less edge), which the UI
        // renders as a plain rename rather than as "renamed from undefined".
        ...(origPath ? { origPath } : {}),
        indexState: fields[0][0],
        worktreeState: fields[0][1],
        kind: 'renamed',
      })
      continue
    }

    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — an unmerged entry.
    if (line.startsWith('u ')) {
      const { fields, tail } = splitFields(line.slice(2), 9)
      if (fields.length < 9 || !tail) continue
      entries.push({
        path: tail,
        // Both sides are unmerged, and reading the pair as anything else would show a conflict as a
        // deletion on one side. The two letters git prints are preserved verbatim.
        indexState: fields[0][0],
        worktreeState: fields[0][1],
        kind: 'unmerged',
      })
      continue
    }

    // Anything else: a record kind from a newer git, or a line that is not a record at all.
  }

  return entries
}

/**
 * Split a `2 ` record from the original path git appends to it.
 *
 * The separator is a tab rather than a space, which is what lets both paths contain spaces. The
 * original path is taken as everything after the *first* tab: a filename may itself contain one.
 */
function splitRecordAndOrigin(body: string): [string, string] {
  const tab = body.indexOf('\t')
  if (tab === -1) return [body, '']
  return [body.slice(0, tab), body.slice(tab + 1)]
}

/**
 * The branch block from a `--branch` status run.
 *
 * Defaults describe the honest state of a repository with no commits: an unborn `HEAD` prints
 * `branch.oid (initial)` and neither an upstream nor a divergence line. Reading those absent lines as
 * "level with upstream" would claim a branch is in sync with something that does not exist, so an
 * absent upstream stays `null` and the counts stay zero — and only a present upstream gives the zero a
 * meaning.
 */
export function parseBranchHeaders(stdout: string): GitBranch {
  const branch: GitBranch = { name: '', detached: false, upstream: null, ahead: 0, behind: 0 }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('# branch.')) continue

    const body = line.slice('# branch.'.length)
    const space = body.indexOf(' ')
    const key = space === -1 ? body : body.slice(0, space)
    const value = space === -1 ? '' : body.slice(space + 1)

    if (key === 'head') {
      branch.name = value
      branch.detached = value === '(detached)'
      continue
    }
    if (key === 'upstream') {
      branch.upstream = value
      continue
    }
    if (key === 'ab') {
      // `+<ahead> -<behind>`. Anything unparseable leaves the counts at zero rather than becoming NaN
      // through the UI.
      const match = /^\+(\d+)\s+-(\d+)$/.exec(value)
      if (match) {
        branch.ahead = Number(match[1])
        branch.behind = Number(match[2])
      }
    }
  }

  return branch
}

/**
 * Parse `git log --pretty=format:%h%x1f%s%x1e`.
 *
 * Unit and record separators rather than a delimiter a subject could contain: a commit subject
 * legitimately holds spaces, colons, commas and dashes, so anything printable as a delimiter would
 * eventually split one in the wrong place.
 */
export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = []

  for (const record of raw.split('\u001e')) {
    const trimmed = record.replace(/^\s+/, '')
    if (trimmed === '') continue
    const separator = trimmed.indexOf('\u001f')
    if (separator === -1) continue
    const hash = trimmed.slice(0, separator).trim()
    const subject = trimmed.slice(separator + 1).trim()
    if (!hash) continue
    commits.push({ hash, subject })
  }

  return commits
}

/** The local branch names, one per line. Empty lines are how git pads, not branches. */
export function parseLocalBranches(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line).trim())
    .filter((line) => line !== '')
}

/**
 * Whether a string is usable as a branch name.
 *
 * Called after checking the name against the repository's own local branch list, so this is the
 * second gate rather than the only one. It exists because the name is the one value here that reaches
 * git's argv as a positional argument: a name beginning with `-` would be read as an option, and
 * `checkout --orphan` or a similar trick is not something a "switch to this branch" control should be
 * able to reach. The character rules are git's own ref syntax, applied up front so a rejection is a
 * clear refusal rather than git's paragraph of advice.
 */
export function isSafeBranchName(name: string): boolean {
  if (name === '' || name.startsWith('-')) return false
  // `HEAD` is a revision, not a branch, and detaching is not a checkout of a branch.
  if (name === 'HEAD') return false
  // Whitespace and control characters, including the newline that would split an argument list.
  // Tested per code point rather than as a regular-expression range: a range covering the control
  // block is what `no-control-regex` exists to discourage, and a branch name is short enough that the
  // explicit loop costs nothing.
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f || /\s/.test(char)) return false
  }
  // The characters git's ref syntax forbids outright.
  if (/[~^:?*[\\]/.test(name)) return false
  if (name.includes('..') || name.includes('@{')) return false
  if (name.includes('//')) return false
  if (name.endsWith('.') || name.endsWith('.lock') || name.endsWith('/')) return false

  return true
}
