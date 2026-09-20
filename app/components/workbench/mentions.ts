import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'

/**
 * The composer's mention rules: what the `@` token is, which files a query matches, and what happens
 * to the chip row.
 *
 * Pure and renderer-only, and kept out of the component for the same reason `session-rules.ts` is:
 * filtering, collapsing a duplicate and refusing the twenty-first file are decisions a test should be
 * able to make by calling a function, not by typing into a textarea and inferring what came out.
 *
 * The cap is imported rather than redeclared. `MAX_MENTION_PATHS` is what main enforces on the wire, so
 * a second constant here would be a UI that lets the user build a message the schema then refuses —
 * the renderer refusing at the same number is the point of importing it.
 */

/**
 * How many rows the picker shows for one query.
 *
 * A display budget, not a data one: the walk in main already bounds itself, and this bounds what is
 * put in the DOM. Filtering happens over the whole list, so narrowing the query always finds entries
 * outside the first page.
 */
export const MAX_PICKER_ROWS = 40

/** The `@` token the caret is inside, or null when the caret is in ordinary prose. */
export interface MentionToken {
  /** Index of the `@` itself. */
  start: number
  /** The caret, where the query ends. */
  end: number
  /** What has been typed after the `@`. */
  query: string
}

/**
 * The mention being typed at the caret.
 *
 * Scanned backwards from the caret and abandoned at the first whitespace, which is what makes the
 * token close when the user types past it: the picker follows the cursor rather than latching onto a
 * `@` earlier in the sentence.
 *
 * An `@` that is not at a word boundary is not a token. `me@example.com` is prose about an address,
 * and a popover opening in the middle of it would be a picker the user never asked for.
 */
export function activeMentionToken(text: string, caret: number): MentionToken | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const end = Math.max(0, Math.min(Number.isFinite(caret) ? Math.trunc(caret) : text.length, text.length))

  for (let i = end - 1; i >= 0; i -= 1) {
    const char = text[i]
    if (char === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) return { start: i, end, query: text.slice(i + 1, end) }
      return null
    }
    if (/\s/.test(char)) return null
  }

  return null
}

/** A path's last segment: the chip's label, where the full path would not fit. */
export function mentionTail(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/**
 * The paths a query offers, in the order the picker lists them.
 *
 * Case-insensitive substring matching, because a path the user is half-remembering is the normal case.
 * A file whose own name matches is ranked above one that merely contains the needle in a directory:
 * typing `app` is nearly always about `app.tsx`, not about every file under `src/app/`. Within each
 * group the walk's own order is preserved, so the list never reshuffles without reason.
 */
export function filterMentionPaths(paths: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  const matches = needle === '' ? [...paths] : paths.filter((path) => path.toLowerCase().includes(needle))

  const byName: string[] = []
  const byPath: string[] = []
  for (const path of matches) {
    if (mentionTail(path).toLowerCase().includes(needle)) byName.push(path)
    else byPath.push(path)
  }

  // A trim-only comparison: `needle === ''` matches everything, which is the same order as the walk.
  return [...byName, ...byPath].slice(0, MAX_PICKER_ROWS)
}

/** Why a chip was not added. `duplicate` is a collapse, `full` is the cap. */
export type MentionRefusal = 'duplicate' | 'full'

/**
 * Add one path to the chip row, unless it is already there or the row is full.
 *
 * Both refusals are returned rather than thrown: they are ordinary outcomes of clicking a file that is
 * already attached, and the caller decides what to say. Nothing is mutated — the input is a render of
 * state, and a helper that edited it in place would change a render the caller never asked to change.
 */
export function addMentionPath(
  paths: readonly string[],
  path: string
): { paths: string[]; refused: MentionRefusal | null } {
  if (paths.includes(path)) return { paths: [...paths], refused: 'duplicate' }
  if (paths.length >= MAX_MENTION_PATHS) return { paths: [...paths], refused: 'full' }
  return { paths: [...paths, path], refused: null }
}

/** Drop one path, keeping the order of the rest: the order is the user's and is what the provider reads. */
export function removeMentionPath(paths: readonly string[], path: string): string[] {
  return paths.filter((candidate) => candidate !== path)
}

/**
 * What the transcript says about a file that could not be attached.
 *
 * Branched on the code, never on a sentence: main names the failure with a stable string, and the
 * wording is the renderer's to own — the same rule every other failure in this app follows. The code
 * itself is shown beside the wording, because it is the fact that does not change when the copy does.
 */
export function contextNoticeText(code: string): string {
  switch (code) {
    case 'CONTEXT_FILE_TOO_LARGE':
      return 'is too large to attach'
    case 'CONTEXT_FILE_NOT_FOUND':
      return 'could not be found in the workspace'
    case 'CONTEXT_FILE_REFUSED':
      return 'is outside the workspace, so it was not attached'
    default:
      return 'could not be attached'
  }
}
