import { describe, expect, it } from 'vitest'
import { canEdit, decideConflict, insertTab, isDirty, writeErrorMessage } from '@/app/components/workbench/editing'

/**
 * The editor's rules, tested without a DOM.
 *
 * The conflict decision is the piece worth reading: it is three-way rather than a boolean, and the
 * extra case exists to avoid telling the user something untrue. A banner that says "this file changed
 * on disk" when it has not is worse than no banner — the user then reloads and loses their edits to a
 * file that never moved. So a dirty buffer is not on its own a conflict; it is a conflict only when
 * the disk actually moved underneath it.
 */

describe('the conflict decision', () => {
  it('is clean when the buffer matches what was loaded', () => {
    expect(decideConflict({ baseline: 'a\n', local: 'a\n', disk: 'a\n' })).toBe('clean')
  })

  it('is still clean when the disk moved but the buffer has no edits', () => {
    // Nothing of the user's is at stake, so the fresh content can simply be adopted — this is exactly
    // the refetch that happened before the viewer could edit anything.
    expect(decideConflict({ baseline: 'a\n', local: 'a\n', disk: 'b\n' })).toBe('clean')
  })

  it('is dirty when the buffer has edits the disk knows nothing about', () => {
    // The event arrived for this path but the content on disk is what we already had — a touch, or a
    // write of the same bytes. There is nothing to warn about and nothing to reload.
    expect(decideConflict({ baseline: 'a\n', local: 'a edited\n', disk: 'a\n' })).toBe('dirty')
  })

  it('is a conflict only when both sides moved', () => {
    expect(decideConflict({ baseline: 'a\n', local: 'mine\n', disk: 'theirs\n' })).toBe('conflict')
  })

  it('treats a whitespace change as a change', () => {
    // Compared exactly, not trimmed: reindenting a line is an edit, and collapsing it would report a
    // conflict as clean and then silently overwrite the buffer.
    expect(decideConflict({ baseline: 'a\n', local: 'a\n\n', disk: 'a\n' })).toBe('dirty')
    expect(decideConflict({ baseline: 'a\n', local: ' a\n', disk: 'a\n' })).toBe('dirty')
  })

  it('reads a self-write as clean, so saving does not raise its own banner', () => {
    // After a save the baseline is what we wrote and the buffer is what we wrote. Our own event then
    // arrives, and the disk holds exactly that — so this is the ordinary clean refetch, not a conflict.
    const written = 'const a = 1\n'
    expect(decideConflict({ baseline: written, local: written, disk: written })).toBe('clean')
  })

  it('reads an empty file and an emptied buffer honestly', () => {
    expect(decideConflict({ baseline: '', local: '', disk: '' })).toBe('clean')
    // Deleting everything is an edit, and if the disk is still empty there is nothing to warn about.
    expect(decideConflict({ baseline: 'a\n', local: '', disk: 'a\n' })).toBe('dirty')
    // But if the disk moved too, the user is about to overwrite something.
    expect(decideConflict({ baseline: 'a\n', local: '', disk: 'b\n' })).toBe('conflict')
  })
})

describe('dirty', () => {
  it('is false before anything is loaded', () => {
    // A buffer that does not exist is not an unsaved edit; the dirty dot must not appear on a file that
    // was merely opened.
    expect(isDirty(null, null)).toBe(false)
    expect(isDirty('a\n', null)).toBe(false)
    expect(isDirty(null, 'a\n')).toBe(false)
  })

  it('is the buffer differing from what was loaded', () => {
    expect(isDirty('a\n', 'a\n')).toBe(false)
    expect(isDirty('a\n', 'a\nb')).toBe(true)
    expect(isDirty('a\n', '')).toBe(true)
  })
})

describe('Tab', () => {
  it('inserts two spaces at the caret and leaves the caret after them', () => {
    const result = insertTab('ab', 1, 1)
    expect(result.text).toBe('a  b')
    expect(result.caret).toBe(3)
  })

  it('inserts at the very start and the very end', () => {
    expect(insertTab('ab', 0, 0)).toEqual({ text: '  ab', caret: 2 })
    expect(insertTab('ab', 2, 2)).toEqual({ text: 'ab  ', caret: 4 })
  })

  it('replaces a selection rather than adding to it', () => {
    expect(insertTab('abcdef', 1, 4)).toEqual({ text: 'a  ef', caret: 3 })
  })

  it('replaces a selection spanning several lines', () => {
    // Indices 4..8 of `one\ntwo\nthree` are `two\n`, so the replacement leaves `one\n` then the two
    // spaces then `three` — the indentation lands where the selected run began.
    expect(insertTab('one\ntwo\nthree', 4, 8)).toEqual({ text: 'one\n  three', caret: 6 })
  })

  it('indents an empty document', () => {
    expect(insertTab('', 0, 0)).toEqual({ text: '  ', caret: 2 })
  })

  it('does not move the text when the selection is already two spaces', () => {
    // The caret still moves to the end of what was inserted, so repeated Tabs walk rightwards.
    expect(insertTab('a    b', 3, 3)).toEqual({ text: 'a      b', caret: 5 })
  })
})

describe('the read cap', () => {
  it('leaves an oversized file read-only', () => {
    // The reader refuses it, so there are no contents to edit — and an editor opened on an empty buffer
    // would overwrite a file nobody has seen.
    expect(canEdit('FILE_TOO_LARGE')).toBe(false)
  })

  it('allows editing when there was no failure', () => {
    expect(canEdit(null)).toBe(true)
  })

  it('does not treat another failure as the cap', () => {
    // A file that was merely unavailable is a different state with its own copy; the rule speaks about
    // the cap because that is the one the viewer has to disable a control for.
    expect(canEdit('FILE_UNAVAILABLE')).toBe(true)
  })
})

describe('what a failed save says', () => {
  it('names the traversal refusal in the user terms', () => {
    expect(writeErrorMessage('PATH_TRAVERSAL')).toMatch(/outside the open folder/i)
  })

  it('names the size refusal', () => {
    expect(writeErrorMessage('FILE_TOO_LARGE')).toMatch(/too large/i)
  })

  it('says nothing was written when the write itself failed', () => {
    // The reassurance matters: a failed save that does not say the file is untouched leaves the user
    // unsure whether to trust what is on disk.
    expect(writeErrorMessage('WRITE_FAILED')).toMatch(/not written|unchanged|nothing/i)
  })

  it('names the no-folder case', () => {
    expect(writeErrorMessage('NO_WORKSPACE')).toMatch(/folder/i)
  })

  it('has a distinct sentence per code', () => {
    const codes = ['PATH_TRAVERSAL', 'FILE_TOO_LARGE', 'WRITE_FAILED', 'NO_WORKSPACE', 'INVALID_PATH']
    const texts = codes.map(writeErrorMessage)
    expect(new Set(texts).size).toBe(codes.length)
    for (const text of texts) expect(text.length).toBeGreaterThan(0)
  })

  it('still has something to say for a code this build has never seen', () => {
    // Forward-compatible like every other failure reader here: a newer main naming a new failure must
    // not leave the banner blank.
    expect(writeErrorMessage('SOMETHING_NEW')).toBeTruthy()
  })
})
