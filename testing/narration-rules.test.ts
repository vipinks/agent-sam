import { describe, expect, it } from 'vitest'
import { joinNarrationChunk, NARRATION_BREAK } from '@/app/components/workbench/agent-session'

/**
 * The narration join rule, as a rule.
 *
 * A model's prose arrives in fragments, so the renderer stitches chunks into the turn it shows — and
 * that stitching is where the live defect sat: text streamed before a tool call and text streamed
 * after it were concatenated, so multi-step commentary rendered as one run-on paragraph.
 *
 * The rule is about the *seam*, not about chunk boundaries in general. Two fragments of one sentence
 * must still concatenate, because the provider splits them mid-word; only the pieces either side of a
 * card are separate pieces of narration. The separator is a blank line because the bubble renders
 * markdown, where a blank line is what makes two paragraphs rather than one paragraph with a line
 * break inside it.
 */

describe('joinNarrationChunk', () => {
  it('leaves the assembled prose alone when the chunk carries nothing', () => {
    expect(joinNarrationChunk('', '', true)).toBe('')
    expect(joinNarrationChunk('Read the parser.', '', true)).toBe('Read the parser.')
  })

  it('opens the prose with the first chunk, with no break in front of it', () => {
    expect(joinNarrationChunk('', 'Read the parser.', false)).toBe('Read the parser.')
    // A seam with nothing before it would render as an empty paragraph above the answer.
    expect(joinNarrationChunk('', 'Read the parser.', true)).toBe('Read the parser.')
  })

  it('concatenates the fragments of one piece', () => {
    expect(joinNarrationChunk('Read', 'ing now.', false)).toBe('Reading now.')
  })

  it('separates two pieces of narration with a paragraph break', () => {
    expect(joinNarrationChunk('Read the parser.', 'Now the fix.', true)).toBe(
      `Read the parser.${NARRATION_BREAK}Now the fix.`
    )
  })

  it('joins a run of narration with one break per piece', () => {
    let text = joinNarrationChunk('', 'Let me look.', false)
    text = joinNarrationChunk(text, 'Found it.', true)
    text = joinNarrationChunk(text, 'The fix is in.', true)
    expect(text).toBe('Let me look.\n\nFound it.\n\nThe fix is in.')
  })

  it('absorbs trailing whitespace into the break rather than stacking with it', () => {
    // A chunk that ends in the space (or the newline) before a call must not push the break away from
    // its seam, and must not leave two blank lines behind it.
    expect(joinNarrationChunk('Read the parser. ', 'Now the fix.', true)).toBe('Read the parser.\n\nNow the fix.')
    expect(joinNarrationChunk('Read the parser.\n', 'Now the fix.', true)).toBe('Read the parser.\n\nNow the fix.')
    expect(joinNarrationChunk('Read the parser.\n\n', 'Now the fix.', true)).toBe('Read the parser.\n\nNow the fix.')
  })

  it('treats a whitespace-only chunk as spacing, not as a paragraph', () => {
    // The stream's own spacing is not a piece of narration, so it takes no break — in either direction.
    expect(joinNarrationChunk('Read the parser.', '  ', true)).toBe('Read the parser.  ')
    expect(joinNarrationChunk('  ', 'Now the fix.', true)).toBe('  Now the fix.')
  })
})
