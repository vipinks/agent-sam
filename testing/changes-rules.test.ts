import { describe, expect, it } from 'vitest'
import type { GitBranch, GitStatusEntry } from '@/conveyor/protocol/git'
import {
  aheadBehindLabel,
  discardSummary,
  groupChanges,
  isNotARepository,
  gitErrorMessage,
  renameNote,
  rowState,
  shortPath,
  type ChangeGroups,
} from '@/app/components/workbench/changes'

/**
 * The changes panel's rules, tested without a DOM.
 *
 * Which group a row belongs to, what letter it shows, and what a failure says are decisions rather
 * than rendering — and the first of them is the one that can be wrong while looking right, since a
 * misgrouped row is a row in the wrong list rather than a visible error. They live in `changes.ts` so
 * they can be asserted here by calling a function instead of by reading a rendered panel.
 */

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    indexState: '.',
    worktreeState: '.',
    kind: 'ordinary',
    ...partial,
  }
}

describe('grouping', () => {
  it('puts an index-only change in staged and a worktree-only change in unstaged', () => {
    const groups: ChangeGroups = groupChanges([
      entry({ path: 'staged.ts', indexState: 'M' }),
      entry({ path: 'unstaged.ts', worktreeState: 'M' }),
    ])

    expect(groups.staged.map((e) => e.path)).toEqual(['staged.ts'])
    expect(groups.unstaged.map((e) => e.path)).toEqual(['unstaged.ts'])
  })

  it('shows a file that is both staged and edited again in both groups', () => {
    // The case a single status letter loses, and the reason the two states are parsed apart: the
    // next commit contains the staged half, and the worktree has more on top of it.
    const groups = groupChanges([entry({ path: 'both.ts', indexState: 'M', worktreeState: 'M' })])
    expect(groups.staged.map((e) => e.path)).toEqual(['both.ts'])
    expect(groups.unstaged.map((e) => e.path)).toEqual(['both.ts'])
  })

  it('treats an addition and a staged deletion as staged changes', () => {
    const groups = groupChanges([
      entry({ path: 'added.ts', indexState: 'A' }),
      entry({ path: 'deleted.ts', indexState: 'D' }),
    ])
    expect(groups.staged.map((e) => e.path)).toEqual(['added.ts', 'deleted.ts'])
    expect(groups.unstaged).toEqual([])
  })

  it('keeps an untracked file in the unstaged group', () => {
    // There is nothing in the index to compare against, so it is not a staged change — but it is still
    // something the user can stage, which is why it is not its own group.
    const groups = groupChanges([entry({ path: 'new.ts', kind: 'untracked', indexState: '?', worktreeState: '?' })])
    expect(groups.unstaged.map((e) => e.path)).toEqual(['new.ts'])
    expect(groups.staged).toEqual([])
  })

  it('keeps a conflicted file in the unstaged group rather than in neither', () => {
    // An unmerged path has no clean side to put it on. Filing it under unstaged is what makes it
    // reachable: a conflict visible in no group would be a conflict the user cannot act on.
    const groups = groupChanges([entry({ path: 'conflict.ts', kind: 'unmerged', indexState: 'U', worktreeState: 'U' })])
    expect(groups.unstaged.map((e) => e.path)).toEqual(['conflict.ts'])
  })

  it('leaves an ignored entry out of both groups', () => {
    const groups = groupChanges([entry({ path: 'build/x.log', kind: 'ignored', indexState: '!', worktreeState: '!' })])
    expect(groups.staged).toEqual([])
    expect(groups.unstaged).toEqual([])
  })

  it('keeps the order git reported', () => {
    const many = ['c.ts', 'a.ts', 'b.ts'].map((path) => entry({ path, worktreeState: 'M' }))
    expect(groupChanges(many).unstaged.map((e) => e.path)).toEqual(['c.ts', 'a.ts', 'b.ts'])
  })
})

describe('a row', () => {
  it('shows the index state for a staged row and the worktree state for an unstaged one', () => {
    const both = entry({ path: 'both.ts', indexState: 'M', worktreeState: 'D' })
    expect(rowState(both, 'staged')).toBe('M')
    expect(rowState(both, 'unstaged')).toBe('D')
  })

  it('uses the conventional letter for each kind', () => {
    // `?` for untracked and `U` for unmerged, which is what git itself prints — using `U` for both
    // would make a conflict and a new file indistinguishable at a glance.
    expect(rowState(entry({ path: 'n.ts', kind: 'untracked', indexState: '?', worktreeState: '?' }), 'unstaged')).toBe(
      '?'
    )
    expect(rowState(entry({ path: 'c.ts', kind: 'unmerged', indexState: 'U', worktreeState: 'U' }), 'unstaged')).toBe(
      'U'
    )
    expect(rowState(entry({ path: 'r.ts', kind: 'renamed', indexState: 'R' }), 'staged')).toBe('R')
    expect(rowState(entry({ path: 'a.ts', indexState: 'A' }), 'staged')).toBe('A')
  })

  it('never shows the clean marker as a letter', () => {
    // A row only exists because something changed on the side it is shown for, so `.` would be a
    // badge with nothing to say.
    expect(rowState(entry({ path: 'x.ts', indexState: 'M' }), 'unstaged')).not.toBe('.')
  })

  it('names the previous path for a rename and nothing for anything else', () => {
    expect(renameNote(entry({ path: 'new.ts', kind: 'renamed', indexState: 'R', origPath: 'old.ts' }))).toBe('old.ts')
    expect(renameNote(entry({ path: 'x.ts' }))).toBeNull()
  })

  it('shortens a deep path for display without losing which file it is', () => {
    expect(shortPath('app/components/workbench/changes.ts')).toBe('workbench/changes.ts')
    expect(shortPath('README.md')).toBe('README.md')
    expect(shortPath('a/b/c.ts')).toBe('b/c.ts')
  })
})

describe('the branch line', () => {
  function branch(partial: Partial<GitBranch>): GitBranch {
    return { name: 'main', detached: false, upstream: null, ahead: 0, behind: 0, ...partial }
  }

  it('says nothing about divergence when there is no upstream to diverge from', () => {
    // Not "0 ahead, 0 behind": with nothing to compare against, a zero would claim the branch is in
    // sync with something that does not exist.
    expect(aheadBehindLabel(branch({}))).toBeNull()
  })

  it('says up to date when an upstream exists and the counts are zero', () => {
    expect(aheadBehindLabel(branch({ upstream: 'origin/main' }))).toBe('Up to date with origin/main')
  })

  it('names each direction that has a count', () => {
    expect(aheadBehindLabel(branch({ upstream: 'origin/main', ahead: 2 }))).toBe('2 ahead')
    expect(aheadBehindLabel(branch({ upstream: 'origin/main', behind: 1 }))).toBe('1 behind')
    expect(aheadBehindLabel(branch({ upstream: 'origin/main', ahead: 2, behind: 1 }))).toBe('2 ahead, 1 behind')
  })

  it('uses the singular for one commit', () => {
    expect(aheadBehindLabel(branch({ upstream: 'origin/main', ahead: 1 }))).toBe('1 ahead')
  })
})

describe('failure copy', () => {
  it('reads a missing repository as a state rather than an error', () => {
    // The one code that is not a failure: a workspace without a repository is an ordinary thing to
    // open, so the panel says so plainly and offers no retry.
    expect(isNotARepository('GIT_NOT_REPO')).toBe(true)
    expect(gitErrorMessage('GIT_NOT_REPO')).toMatch(/not a git repository/i)
    expect(gitErrorMessage('GIT_NOT_REPO')).not.toMatch(/error|failed|problem/i)
  })

  it('has its own sentence for a missing binary, which the panel cannot fix', () => {
    expect(isNotARepository('GIT_NOT_INSTALLED')).toBe(false)
    expect(gitErrorMessage('GIT_NOT_INSTALLED')).toMatch(/git is not installed/i)
  })

  it('names each remaining code differently', () => {
    const texts = ['GIT_FAILED', 'GIT_INVALID_INPUT', 'BRANCH_NOT_FOUND', 'GIT_DIFF_TOO_LARGE'].map(gitErrorMessage)
    expect(new Set(texts).size).toBe(4)
    for (const text of texts) expect(text.length).toBeGreaterThan(0)
  })

  it('still has something to say for a code this build has never seen', () => {
    // Forward-compatible like every other failure reader here: a newer main naming a new failure must
    // not leave the panel with a blank where its explanation belongs.
    expect(gitErrorMessage('SOMETHING_NEW')).toBeTruthy()
    expect(isNotARepository('SOMETHING_NEW')).toBe(false)
  })
})

describe('what a discard did', () => {
  it('reports only what happened', () => {
    expect(discardSummary({ discarded: ['a.ts'], failed: [] })).toMatch(/1 file/)
    expect(discardSummary({ discarded: [], failed: [{ path: 'u.ts', code: 'UNTRACKED' }] })).toMatch(/could not/)
    expect(discardSummary({ discarded: ['a.ts'], failed: [{ path: 'u.ts', code: 'UNTRACKED' }] })).toMatch(/1 file/)
  })

  it('counts in the plural when it should', () => {
    const summary = discardSummary({ discarded: ['a.ts', 'b.ts'], failed: [] })
    expect(summary).toMatch(/2 files/)
  })
})
