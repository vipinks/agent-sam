/**
 * A line-level diff, for showing a `write_file` before it is allowed to happen.
 *
 * The consent card used to name the file and nothing else, so the one action that changes the user's
 * files was approved without ever being read. This computes what the write would do to the file that
 * is there now.
 *
 * Deliberately dependency-free and pure: no `fs` (the baseline arrives as a string, read by the
 * caller in main), no external diff package (the LCS below is small and fully testable, which a
 * dependency would not make it). It also has to be importable from `conveyor/protocol`, so nothing
 * main-only may creep in.
 *
 * The result is structured rather than a unified-diff string, so the card colours a line by what it
 * *is* instead of by re-parsing a prefix. The computation and the disk read still happen in main;
 * the renderer only ever receives this finished result.
 */

/** One line of the diff, in the order it should be read. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
}

export interface FileDiff {
  lines: DiffLine[]
  /** The real number of added lines, whether or not all of them fit under the cap. */
  added: number
  /** The real number of removed lines, likewise. */
  removed: number
  /** True when the change is larger than the cap, so the card can say so rather than under-report. */
  truncated: boolean
}

/**
 * Lines beyond this are not shipped to the renderer.
 *
 * A generated file can be enormous, and the approval card is a decision surface, not a viewer. The
 * true counts are still reported, so a truncated view is never mistaken for a complete one.
 */
export const MAX_DIFF_LINES = 400

/**
 * Beyond this many lines on either side, the LCS table stops being worth its memory and time, and a
 * coarse diff is produced instead: every old line removed, then every new line added. The verdict
 * ("this replaces everything") is right even when the alignment is not, and the card says truncated.
 */
const MAX_LCS_LINES = 2000

/** Shown in place of a line's text when it is too long to be worth shipping whole. */
const MAX_LINE_LENGTH = 500

/**
 * Split a file into lines, treating a single trailing newline as a terminator rather than as an
 * empty last line.
 *
 * This is what keeps a write that only re-adds the final newline from presenting itself as a
 * whole-file change — a rewrite of text the agent just read back must compare equal to itself.
 */
function toLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line))
}

/** The length of the longest common subsequence of two line arrays, as a traceback table. */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  return table
}

/** Walk the table back into a readable sequence of context, removals, and additions. */
function trace(table: Uint32Array, a: string[], b: string[]): DiffLine[] {
  const width = b.length + 1
  const lines: DiffLine[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i] })
      i += 1
      j += 1
      continue
    }
    // Follow whichever side the table says gives the longer common subsequence, so removals and
    // additions group the way a person reading a diff expects.
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      lines.push({ kind: 'removed', text: a[i] })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j] })
      j += 1
    }
  }

  for (; i < a.length; i += 1) lines.push({ kind: 'removed', text: a[i] })
  for (; j < b.length; j += 1) lines.push({ kind: 'added', text: b[j] })

  return lines
}

/**
 * Diff the file that is on disk against the content about to be written.
 *
 * `before` is the current file contents, or null when nothing is there — a missing file is an empty
 * one for this purpose, so a new file comes out as pure additions rather than as a failure.
 */
export function computeFileDiff(before: string | null, after: string): FileDiff {
  const oldLines = toLines(before ?? '')
  const newLines = toLines(after)

  const changed: DiffLine[] =
    oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES
      ? [
          ...oldLines.map((text): DiffLine => ({ kind: 'removed', text })),
          ...newLines.map((text): DiffLine => ({ kind: 'added', text })),
        ]
      : trace(lcsTable(oldLines, newLines), oldLines, newLines)

  // The counts describe the change, not the excerpt: a card that says "3 additions" for a 2000-line
  // file would be a lie told by the cap.
  let added = 0
  let removed = 0
  for (const line of changed) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }

  // A write that changes nothing carries no context worth showing: the card's job is to show what
  // is being asked for, and "this is the file you already have" is not that.
  if (added === 0 && removed === 0) return { lines: [], added, removed, truncated: false }

  return {
    lines: changed.slice(0, MAX_DIFF_LINES),
    added,
    removed,
    truncated: changed.length > MAX_DIFF_LINES,
  }
}
