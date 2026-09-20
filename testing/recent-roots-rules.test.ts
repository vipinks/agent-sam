import { describe, expect, it } from 'vitest'
import {
  MAX_RECENT_ROOTS,
  WORKSPACE_MISSING,
  forgetRoot,
  rememberRoot,
  sameRoot,
} from '@/conveyor/protocol/recent-roots'
import { rootErrorMessage, rootTail } from '@/app/components/workbench/recent-roots'

/**
 * The recents list's rules, tested without a DOM, a store, or a disk.
 *
 * Order, deduplication and the cap are decisions rather than rendering — and each of them can be
 * wrong while looking right, since a stale order or a duplicated row is still a plausible-looking
 * menu. They live in `conveyor/protocol/recent-roots.ts` so they can be asserted here by calling a
 * function, and so main and the renderer cannot disagree about them: the store reduces with these
 * rules and the menu compares roots with them.
 *
 * The comparison is the one worth reading twice. "The same folder" is spelled the same way twice in
 * practice far less often than it is spelled with different case, so the compare ignores case — and
 * deliberately nothing else, because main resolves a path before it is ever stored.
 */

const SAM = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'

describe('remembering a root', () => {
  it('prepends the newest root', () => {
    expect(rememberRoot([NOTES], SAM)).toEqual([SAM, NOTES])
  })

  it('starts a list from nothing', () => {
    expect(rememberRoot([], SAM)).toEqual([SAM])
  })

  it('moves a root that is already listed to the front instead of listing it twice', () => {
    expect(rememberRoot([SAM, NOTES, ARCHIVE], NOTES)).toEqual([NOTES, SAM, ARCHIVE])
  })

  it('treats a differently-cased spelling as the same root', () => {
    // The case that would otherwise put one folder in the menu twice, and in two different orders
    // depending on which spelling the file dialog last returned.
    expect(rememberRoot([SAM, NOTES], 'c:/WORK/sam-ai')).toEqual(['c:/WORK/sam-ai', NOTES])
  })

  it(`keeps at most ${MAX_RECENT_ROOTS}, dropping the oldest`, () => {
    const full = Array.from({ length: MAX_RECENT_ROOTS }, (_, i) => `C:/work/p${i}`)
    const next = rememberRoot(full, 'C:/work/newest')

    expect(next).toHaveLength(MAX_RECENT_ROOTS)
    expect(next[0]).toBe('C:/work/newest')
    expect(next).not.toContain(`C:/work/p${MAX_RECENT_ROOTS - 1}`)
    expect(next).toContain('C:/work/p0')
  })

  it('does not mutate the list it was given', () => {
    const roots = [SAM, NOTES]
    rememberRoot(roots, ARCHIVE)
    expect(roots).toEqual([SAM, NOTES])
  })
})

describe('forgetting a root', () => {
  it('removes only that entry, keeping the rest in order', () => {
    expect(forgetRoot([SAM, NOTES, ARCHIVE], NOTES)).toEqual([SAM, ARCHIVE])
  })

  it('removes it however it is cased', () => {
    expect(forgetRoot([SAM, NOTES], 'c:/WORK/sam-ai')).toEqual([NOTES])
  })

  it('leaves the list alone when the root is not in it', () => {
    expect(forgetRoot([SAM, NOTES], 'C:/work/elsewhere')).toEqual([SAM, NOTES])
  })
})

describe('comparing roots', () => {
  it('ignores case', () => {
    expect(sameRoot('C:/Work/Sam-AI', 'c:/work/sAM-ai')).toBe(true)
  })

  it('is not fooled by a different folder that shares a prefix', () => {
    expect(sameRoot(SAM, 'C:/work/sam-ai-notes')).toBe(false)
  })

  it('compares the path as stored, which main has already resolved', () => {
    // Stated as a rule rather than left implicit: a trailing separator is a different string, and
    // that is safe only because main resolves every path before the store sees it.
    expect(sameRoot('C:/work/sam-ai', 'C:/work/sam-ai/')).toBe(false)
  })
})

describe('labels', () => {
  it('names a root by its last segment, whichever separator it uses', () => {
    expect(rootTail(SAM)).toBe('sam-ai')
    expect(rootTail('C:\\work\\sam-ai')).toBe('sam-ai')
    expect(rootTail('/home/vipin/proj')).toBe('proj')
  })

  it('ignores a trailing separator', () => {
    expect(rootTail('/home/vipin/proj/')).toBe('proj')
  })

  it('answers with what it was given when there is no segment to name', () => {
    expect(rootTail('')).toBe('')
  })
})

describe('a refused switch', () => {
  it('says the folder is gone when main reports it missing', () => {
    expect(rootErrorMessage(WORKSPACE_MISSING)).toMatch(/no longer there/i)
  })

  it('falls back to a generic sentence for a code it does not know', () => {
    expect(rootErrorMessage('SOMETHING_ELSE')).toMatch(/could not be opened/i)
  })
})
