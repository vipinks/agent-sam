import type { DiscardResult, GitBranch, GitStatusEntry } from '@/conveyor/protocol/git'

/**
 * The changes panel's rules: which list a row belongs to, what it shows, and what a failure says.
 *
 * Pure and renderer-only, kept out of the component for the reason `mentions.ts` and `session-rules.ts`
 * are: grouping is the part that can be wrong while looking right — a misgrouped row is a row in the
 * wrong list, not a visible error — so a test should be able to call a function rather than read a
 * rendered panel.
 *
 * Nothing here touches git, a disk, or a process. The entries arrive already parsed from main.
 */

/** Which side of the change a row is being shown for. */
export type ChangeSide = 'staged' | 'unstaged'

/** The two lists the panel draws, in the order it draws them. */
export interface ChangeGroups {
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
}

/**
 * Split the entries into the staged and unstaged lists.
 *
 * An entry can be in both, and that is the point of keeping the two states apart: a file that was
 * staged and then edited again has one half in the next commit and another half still in the worktree,
 * so it is genuinely two rows in two lists.
 *
 * The two edges are deliberate. An untracked file has nothing in the index to compare with, but it is
 * something the user can stage, so it belongs in the unstaged list rather than in a group of its own.
 * A conflicted file has no clean side at all, and filing it under unstaged is what makes it reachable
 * — a conflict visible in neither list would be a conflict the user could not act on.
 *
 * Ignored entries are in neither: git only reports them because the walk asks for everything, and a
 * row offering to stage a file the repository is configured to ignore would be a control that cannot
 * do what it says.
 *
 * Order is git's own within each list, because a list that re-sorted itself between refreshes would be
 * unusable.
 */
export function groupChanges(entries: readonly GitStatusEntry[]): ChangeGroups {
  const staged: GitStatusEntry[] = []
  const unstaged: GitStatusEntry[] = []

  for (const entry of entries) {
    if (entry.kind === 'ignored') continue

    if (entry.kind === 'untracked' || entry.kind === 'unmerged') {
      unstaged.push(entry)
      continue
    }

    if (entry.indexState !== '.') staged.push(entry)
    if (entry.worktreeState !== '.') unstaged.push(entry)
  }

  return { staged, unstaged }
}

/**
 * The badge a row shows.
 *
 * The staged side reads the index state and the unstaged side the worktree state, because that is what
 * the row is about: `M` on a staged row means the index differs from `HEAD`, and `M` on an unstaged row
 * means the file differs from the index. Untracked and unmerged keep git's own letters, `?` and `U` —
 * giving `U` to both would make a new file and a conflict indistinguishable at a glance.
 */
export function rowState(entry: GitStatusEntry, side: ChangeSide): string {
  if (entry.kind === 'untracked') return '?'
  if (entry.kind === 'unmerged') return 'U'
  if (entry.kind === 'renamed') return 'R'

  const letter = side === 'staged' ? entry.indexState : entry.worktreeState
  // A row only exists because something changed on the side it is shown for, so the clean marker would
  // be a badge with nothing to say.
  return letter === '.' ? 'M' : letter
}

/** The previous path of a rename, so the row can say where the file came from. */
export function renameNote(entry: GitStatusEntry): string | null {
  return entry.kind === 'renamed' && entry.origPath ? entry.origPath : null
}

/**
 * A path shortened for a narrow row.
 *
 * The last two segments, which is enough to tell one file from another in almost every tree while
 * still fitting: `app/components/workbench/changes.ts` reads as `workbench/changes.ts`. The full path
 * is the row's tooltip, so nothing is lost by shortening it here.
 */
export function shortPath(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '')
  return segments.length <= 2 ? path : segments.slice(-2).join('/')
}

/**
 * The divergence line, or null when there is nothing truthful to say.
 *
 * Null when the branch has no upstream: "0 ahead, 0 behind" would claim it is in sync with something
 * that does not exist, which is a different statement from having nothing to compare against.
 */
export function aheadBehindLabel(branch: GitBranch): string | null {
  if (!branch.upstream) return null
  if (branch.ahead === 0 && branch.behind === 0) return `Up to date with ${branch.upstream}`

  const parts: string[] = []
  if (branch.ahead > 0) parts.push(`${branch.ahead} ahead`)
  if (branch.behind > 0) parts.push(`${branch.behind} behind`)
  return parts.join(', ')
}

/**
 * Whether a code means "there is no repository here".
 *
 * Read as a state rather than as a failure, because that is what it is: a folder without a repository
 * is an ordinary thing to open, and the panel says so plainly instead of offering a retry for
 * something that is not broken.
 */
export function isNotARepository(code: string): boolean {
  return code === 'GIT_NOT_REPO'
}

/**
 * What the panel says about a git failure, in its own words.
 *
 * Branched on the code, never on git's message: the wording is the renderer's to own, and a sentence
 * main wrote is free to change without the UI changing with it. The code itself is shown beside the
 * wording by the panel, because that is the half that does not move.
 */
export function gitErrorMessage(code: string): string {
  switch (code) {
    case 'GIT_NOT_REPO':
      return 'This folder is not a git repository.'
    case 'GIT_NOT_INSTALLED':
      return 'Git is not installed, or is not on your PATH.'
    case 'GIT_INVALID_INPUT':
      return 'That request was not something git can do.'
    case 'GIT_DIFF_TOO_LARGE':
      return 'That file is too large to show as a diff.'
    case 'BRANCH_NOT_FOUND':
      return 'There is no local branch by that name.'
    case 'GIT_FAILED':
      return 'Git refused that. Nothing was changed.'
    default:
      return 'Git could not do that.'
  }
}

/**
 * What a discard did, in one line.
 *
 * Both halves are reported, because a discard that silently dropped the paths it could not restore
 * would look like it had succeeded — and the paths it cannot restore are the untracked ones, which are
 * exactly the ones a user would be alarmed to think had been removed.
 */
export function discardSummary(result: Pick<DiscardResult, 'discarded' | 'failed'>): string {
  const parts: string[] = []
  if (result.discarded.length > 0) {
    parts.push(`Discarded ${result.discarded.length} ${result.discarded.length === 1 ? 'file' : 'files'}.`)
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} could not be restored.`)
  }
  return parts.join(' ') || 'Nothing was discarded.'
}
