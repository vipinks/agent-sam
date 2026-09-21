import { describe, expect, it } from 'vitest'
import { gutterText, lineCount } from '@/app/components/workbench/gutter'

/**
 * The line-number gutter's rules, tested without a DOM.
 *
 * The one rule that matters is that the gutter has exactly one number per line of the code beside it.
 * That is not a coincidence to be checked once: the numbers and the code are two elements, and the
 * only thing keeping them in step is that both are laid out as one line box per line. A number too
 * many or too few is a drift the user reads as numbers sliding off their lines, so it is asserted
 * against every shape of buffer that produces lines differently — empty, unterminated, terminated,
 * and CRLF, which is two characters and must still be one break.
 *
 * What a CRLF file means here is worth naming: the buffer is the disk's bytes, so a Windows file
 * arrives as `\r\n`, while the textarea shows its own normalised `\n`. Counting either as two lines
 * would put the gutter permanently one line ahead of a file nobody has edited.
 */

/** The lines a buffer occupies, counted independently of the helper under test. */
function codeLines(buffer: string): number {
  return buffer.split(/\r\n|\r|\n/).length
}

describe('the line count', () => {
  it('is one for an empty buffer, because a caret still has a line to sit on', () => {
    expect(lineCount('')).toBe(1)
  })

  it('is one for a single line with no terminator', () => {
    expect(lineCount('const a = 1')).toBe(1)
  })

  it('counts a trailing newline as opening the next line', () => {
    expect(lineCount('const a = 1\n')).toBe(2)
  })

  it('counts each break between lines', () => {
    expect(lineCount('a\nb\nc')).toBe(3)
  })

  it('counts a CRLF pair once rather than as two breaks', () => {
    expect(lineCount('a\r\nb\r\nc')).toBe(3)
    expect(lineCount('a\r\n')).toBe(2)
    // The same file read from a Unix side of the same repository, byte for byte after normalising.
    expect(lineCount('a\r\nb')).toBe(lineCount('a\nb'))
  })

  it('counts a lone CR as a break, which is what an old file holds', () => {
    expect(lineCount('a\rb')).toBe(2)
  })

  it('agrees with the number of lines the code itself occupies', () => {
    for (const buffer of ['', 'a', 'a\n', 'a\n\n', 'a\r\nb', '<?php\n\n$name = "sam";\nreturn $name;\n']) {
      expect(lineCount(buffer)).toBe(codeLines(buffer))
    }
  })
})

describe('the gutter', () => {
  it('numbers every line, in order, starting at one', () => {
    expect(gutterText('')).toBe('1')
    expect(gutterText('const a = 1')).toBe('1')
    expect(gutterText('const a = 1\n')).toBe('1\n2')
  })

  it('has exactly one number per code line, for every shape of buffer', () => {
    for (const buffer of ['', 'a', 'a\n', 'a\n\n', 'a\r\nb', 'a\rb', 'x\n'.repeat(50)]) {
      expect(gutterText(buffer).split('\n').length).toBe(codeLines(buffer))
      // And the two helpers cannot disagree, because the text is derived from the count.
      expect(gutterText(buffer).split('\n').length).toBe(lineCount(buffer))
    }
  })

  it('numbers a CRLF file the way the editor shows it', () => {
    expect(gutterText('a\r\nb\r\nc')).toBe('1\n2\n3')
  })

  it('never ends with a break, so there is no phantom line under the last number', () => {
    // A trailing newline in the gutter's own text would be a line box with nothing in it, and the
    // numbers would sit one line-height above their lines from the top of that box down.
    for (const buffer of ['a\n', 'a\nb\n', '\n', '']) {
      expect(gutterText(buffer).endsWith('\n')).toBe(false)
    }
  })
})
