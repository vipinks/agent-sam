import { describe, expect, it } from 'vitest'
import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'
import {
  activeMentionToken,
  addMentionPath,
  contextNoticeText,
  filterMentionPaths,
  MAX_PICKER_ROWS,
  mentionTail,
  removeMentionPath,
} from '@/app/components/workbench/mentions'

/**
 * The composer's mention rules, tested without a DOM.
 *
 * Filtering, dedupe and the cap are decisions rather than rendering: which file a query matches, what
 * happens when the user picks the same file twice, and what happens at the twentieth chip. They live
 * in `mentions.ts` precisely so they can be asserted here, directly, instead of through a typed
 * keystroke and an inferred chip.
 */

describe('the @ token', () => {
  it('opens at the very start of a draft', () => {
    expect(activeMentionToken('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })

  it('opens after whitespace and carries the query up to the caret', () => {
    expect(activeMentionToken('look at @src/ap', 15)).toEqual({ start: 8, end: 15, query: 'src/ap' })
  })

  it('reads the caret, not the end of the text', () => {
    // Continued typing after the token must not widen it: the query ends where the cursor is.
    expect(activeMentionToken('@app.tsx tail', 4)).toEqual({ start: 0, end: 4, query: 'app' })
  })

  it('is not an address', () => {
    // A mention starts a word. `me@example.com` is a sentence about an address, not a file pick.
    expect(activeMentionToken('mail me@example.com', 18)).toBeNull()
  })

  it('is closed by the whitespace that follows it', () => {
    // Once the user has typed past the token, the caret is in ordinary prose and there is nothing to
    // pick for — reopening on every later keystroke would be a popover that never goes away.
    expect(activeMentionToken('@src then wrote', 15)).toBeNull()
  })

  it('says nothing for text with no token at all', () => {
    expect(activeMentionToken('just a sentence', 15)).toBeNull()
    expect(activeMentionToken('', 0)).toBeNull()
  })
})

describe('filtering the workspace', () => {
  const files = ['src/app.tsx', 'src/lib/utils.ts', 'docs/app-notes.md', 'README.md']

  it('offers everything for an empty query, bounded by the display budget', () => {
    expect(filterMentionPaths(files, '')).toEqual(files)

    const many = Array.from({ length: MAX_PICKER_ROWS + 10 }, (_, i) => `file-${i}.ts`)
    expect(filterMentionPaths(many, '').length).toBe(MAX_PICKER_ROWS)
  })

  it('matches anywhere in the path, case-insensitively', () => {
    expect(filterMentionPaths(files, 'APP')).toEqual(['src/app.tsx', 'docs/app-notes.md'])
    expect(filterMentionPaths(files, 'utils')).toEqual(['src/lib/utils.ts'])
  })

  it('ranks a file whose own name matches above a path that merely contains it', () => {
    // The needle is in a directory for the first and in the file name for the second. Typing a file's
    // name is the common case, so the file itself has to win even though the walk listed it later.
    expect(filterMentionPaths(['src/app/index.ts', 'docs/app.ts'], 'app')).toEqual(['docs/app.ts', 'src/app/index.ts'])
  })

  it('returns an empty list rather than throwing when nothing matches', () => {
    expect(filterMentionPaths(files, 'nothing-like-this')).toEqual([])
  })

  it('ignores the surrounding whitespace of a query', () => {
    expect(filterMentionPaths(files, ' utils ')).toEqual(['src/lib/utils.ts'])
  })
})

describe('what a chip shows', () => {
  it('is the last segment of either separator style', () => {
    expect(mentionTail('src/app.tsx')).toBe('app.tsx')
    expect(mentionTail('src\\lib\\utils.ts')).toBe('utils.ts')
    expect(mentionTail('README.md')).toBe('README.md')
    expect(mentionTail('src/')).toBe('src')
  })

  it('falls back to the path itself rather than an empty label', () => {
    expect(mentionTail('')).toBe('')
  })
})

describe('adding and removing chips', () => {
  it('appends in the order the user picked', () => {
    expect(addMentionPath([], 'src/app.tsx')).toEqual({ paths: ['src/app.tsx'], refused: null })
    expect(addMentionPath(['a.ts'], 'b.ts')).toEqual({ paths: ['a.ts', 'b.ts'], refused: null })
  })

  it('collapses a duplicate into the one chip that is already there', () => {
    const result = addMentionPath(['src/app.tsx', 'README.md'], 'src/app.tsx')
    expect(result.refused).toBe('duplicate')
    expect(result.paths).toEqual(['src/app.tsx', 'README.md'])
  })

  it('refuses past the cap, leaving the chips that are there alone', () => {
    const full = Array.from({ length: MAX_MENTION_PATHS }, (_, i) => `file-${i}.ts`)
    const result = addMentionPath(full, 'one-too-many.ts')
    expect(result.refused).toBe('full')
    expect(result.paths).toEqual(full)
  })

  it('still accepts the file that fills the last slot', () => {
    const nearly = Array.from({ length: MAX_MENTION_PATHS - 1 }, (_, i) => `file-${i}.ts`)
    const result = addMentionPath(nearly, 'the-last-one.ts')
    expect(result.refused).toBeNull()
    expect(result.paths.length).toBe(MAX_MENTION_PATHS)
  })

  it('removes exactly the chip that was clicked, keeping the rest in order', () => {
    expect(removeMentionPath(['a.ts', 'b.ts', 'c.ts'], 'b.ts')).toEqual(['a.ts', 'c.ts'])
    expect(removeMentionPath(['a.ts'], 'missing.ts')).toEqual(['a.ts'])
  })
})

describe('notice wording', () => {
  it('says something different for each code, in user terms rather than the code itself', () => {
    const texts = (['CONTEXT_FILE_TOO_LARGE', 'CONTEXT_FILE_NOT_FOUND', 'CONTEXT_FILE_REFUSED'] as const).map(
      contextNoticeText
    )
    expect(new Set(texts).size).toBe(3)
    expect(contextNoticeText('CONTEXT_FILE_TOO_LARGE')).toMatch(/too large/)
    expect(contextNoticeText('CONTEXT_FILE_NOT_FOUND')).toMatch(/could not be found/)
    expect(contextNoticeText('CONTEXT_FILE_REFUSED')).toMatch(/outside the workspace/)
  })

  it('has wording for a code this build has never seen', () => {
    // Forward-compatible like every other chunk reader: a newer main naming a new failure must not
    // leave the transcript row with a blank where its explanation belongs.
    expect(contextNoticeText('CONTEXT_FILE_SOMETHING_NEW')).toBeTruthy()
  })
})
