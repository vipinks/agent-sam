/**
 * The line-number gutter's two rules, and nothing else.
 *
 * The numbers are a column beside the code rather than part of it, which makes one thing the whole of
 * its correctness: there must be exactly one number per line of the buffer it sits next to. Everything
 * here is aimed at that — `lineCount` is the only counter, and `gutterText` is derived from it rather
 * than counted again, so the two cannot disagree about a file.
 *
 * The gutter is rendered as one block of newline-separated numbers under `whitespace-pre`, which is
 * what makes the alignment structural rather than tuned: the numbers and the code are laid out by the
 * same line-height over the same number of line boxes, so line N of the numbers is line N of the code
 * without either side measuring the other. A trailing break would be one line box too many, which is
 * why the text is joined rather than terminated.
 *
 * Pure and renderer-only: no DOM, no React, no filesystem — the same split `highlight.ts` and
 * `editing.ts` keep, so the rules are testable without a render and the component holds only the parts
 * a rule cannot express.
 */

// ---------------------------------------------------------------- the count

/**
 * How many lines a buffer occupies: its line breaks plus one.
 *
 * `\r\n` is one break rather than two. The buffer is the disk's bytes, so a Windows file arrives as
 * `\r\n` while the textarea shows its own normalised `\n` — counting the pair twice would put the
 * gutter permanently one line ahead of a file nobody has edited. A lone `\r` is counted as a break of
 * its own, because a file written by an older editor really does use it as one.
 *
 * An empty buffer is one line, not zero: the caret sits somewhere, and the read view of an empty file
 * shows an empty first line.
 */
export function lineCount(buffer: string): number {
  let lines = 1

  for (let i = 0; i < buffer.length; i += 1) {
    const code = buffer.charCodeAt(i)
    if (code === 10) lines += 1
    else if (code === 13) {
      lines += 1
      // The low half of a CRLF pair belongs to the break just counted.
      if (buffer.charCodeAt(i + 1) === 10) i += 1
    }
  }

  return lines
}

// ---------------------------------------------------------------- the column

/**
 * The gutter's text for a buffer: `1` through the line count, one per line.
 *
 * One string of newline-separated numbers rather than an array of elements, because the text is what
 * the layout needs to be the code's own: each break here becomes one line box, exactly as a break in
 * the source does. It also keeps a five-thousand-line file to a single text node.
 */
export function gutterText(buffer: string): string {
  const count = lineCount(buffer)
  const numbers: string[] = new Array(count)
  for (let i = 0; i < count; i += 1) numbers[i] = String(i + 1)
  return numbers.join('\n')
}
