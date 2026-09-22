import { describe, expect, it } from 'vitest'
import { truncateFromTurn } from '@/conveyor/protocol/truncate'

/**
 * The cut an edited message makes, as a rule rather than as wiring.
 *
 * Editing a message is not an edit in place: everything after it was an answer to words the user is
 * about to change, so it goes. Two callers depend on the same subtraction agreeing — the dialog that
 * says how many turns will be removed, and the send that removes them — so the rule is tested here on
 * its own, where "strictly before" and "unchanged when the id is unknown" are the whole of the claim.
 */

/** Turns distinguished by id alone; the rule reads nothing else. */
function turns(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }))
}

/** The ids of a result, which is the whole of what a cut decides. */
function ids(value: readonly { id: string }[]): string[] {
  return value.map((turn) => turn.id)
}

describe('truncateFromTurn', () => {
  it('returns the turns strictly before the named one, in order', () => {
    const transcript = turns('user-1', 'assistant-2', 'user-3', 'assistant-4')

    expect(ids(truncateFromTurn(transcript, 'user-3'))).toEqual(['user-1', 'assistant-2'])
  })

  it('excludes the named turn itself', () => {
    const transcript = turns('user-1', 'assistant-2')

    // The edited turn is replaced rather than kept: its replacement is built by the send path, with
    // the words the user has just changed. A cut that left it in would put two messages on screen.
    expect(ids(truncateFromTurn(transcript, 'assistant-2'))).not.toContain('assistant-2')
  })

  it('returns nothing before the first turn', () => {
    expect(truncateFromTurn(turns('user-1', 'assistant-2'), 'user-1')).toEqual([])
  })

  it('returns the turns unchanged when the id is not in them', () => {
    const transcript = turns('user-1', 'assistant-2')

    // A turn that is not there is not a cut. Returning a prefix of the transcript instead would
    // silently discard the conversation on a stale id.
    expect(truncateFromTurn(transcript, 'user-9')).toEqual(transcript)
  })

  it('leaves an empty transcript empty', () => {
    expect(truncateFromTurn([], 'user-1')).toEqual([])
  })

  it('hands back the turns themselves, not copies of them', () => {
    const second = { id: 'assistant-2', content: 'the answer' }
    const transcript = [{ id: 'user-1', content: 'the question' }, second, { id: 'user-3', content: 'again' }]

    // A cut discards turns; it does not rewrite the ones it keeps. Identity is what makes that
    // visible, and it is what lets a caller keep whatever else it knows about a surviving turn.
    expect(truncateFromTurn(transcript, 'user-3')[1]).toBe(second)
  })

  it('does not mutate the transcript it is given', () => {
    const transcript = turns('user-1', 'assistant-2', 'user-3')

    truncateFromTurn(transcript, 'user-3')

    expect(ids(transcript)).toEqual(['user-1', 'assistant-2', 'user-3'])
  })
})
