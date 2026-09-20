/**
 * Mentions: which files a message may point at, and how they are described to the model.
 *
 * Pure, and shared rather than main-only, for the same reason the transcript shape is: main does the
 * walking and the reading, but the *rules* — what is skipped, how the cap applies, what a failure is
 * called — are decisions a test should be able to make without a filesystem. So the disk lives in
 * `conveyor/modules/mentions.ts` and everything here is data in, data out.
 *
 * Three rules are load-bearing enough to state up front.
 *
 * The skip list is matched on whole path segments rather than as a substring. `node_modules` is
 * skipped; `src/outbox/app.ts` and `docs/vendors.md` are not, because a rule that matched substrings
 * would quietly hide a real file whose name happened to contain one.
 *
 * The cap applies during the walk, not after it. A walk that collects everything and then slices has
 * already paid the cost it was trying to avoid — reading a directory with half a million files to
 * show two thousand of them — so the caller stops itself at the boundary, and this module owns the
 * boundary rather than the truncation.
 *
 * A file that could not be read is reported, not dropped. The model is told the user pointed at
 * something that could not be included, and which failure it was; a mention that vanished silently
 * would read as an empty file, which is a different and much more misleading thing.
 */

/**
 * Directory names no mention may reach, and no picker may offer.
 *
 * The same spirit as the explorer's hidden entries, but not the same list: `out` and `vendor` are
 * generated or third-party trees that are worth listing in a file tree, and are close to worthless as
 * a mention target — the user wants their own source, not a dependency or a build artefact.
 */
export const SKIP_SEGMENTS = ['node_modules', '.git', 'dist', 'out', 'vendor'] as const

/**
 * How many entries one walk may produce.
 *
 * A bound on the walk, and deliberately a generous one: it exists so a pathological tree cannot turn
 * a mention picker into an unbounded read, not to shape what the picker shows. The picker's own
 * filtering and display budget are the UI's business.
 */
export const MAX_MENTION_ENTRIES = 2000

/**
 * How many mentions one send may carry.
 *
 * Far smaller than the walk cap, because these are different questions: the walk answers "what could
 * be mentioned", and this answers "how much may one message drag into the provider's context". A
 * thousand files at 1 MB each is a request no provider will accept, and the cap is what keeps a
 * message's size a property of the app rather than of what the user happened to click.
 */
export const MAX_MENTION_PATHS = 20

/** Whether one path segment is a directory no mention may reach. Case-insensitive: the filesystems differ. */
export function isSkippedSegment(segment: string): boolean {
  const lowered = segment.toLowerCase()
  return SKIP_SEGMENTS.some((skip) => skip === lowered)
}

/**
 * Whether a path is skipped, on any of its segments.
 *
 * Both separators are honoured, because a path may have been produced on either platform by the time
 * it reaches here and a Windows-style path must not slip through a check written for `/`.
 */
export function isSkippedPath(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment !== '' && isSkippedSegment(segment))
}

/**
 * Directory-entry names in the order a walk should consider them.
 *
 * Case-insensitive, so a capitalised name does not sort above every lowercase one — and with an exact
 * tiebreak, because `Alpha.ts` and `alpha.ts` are two different files that compare equal
 * case-insensitively. Without the tiebreak their relative order would be whatever the directory
 * listing happened to return, and the cap could then keep either one from run to run.
 *
 * Returns a new array; the caller's is left alone.
 */
export function orderDirectoryEntries(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const byName = a.localeCompare(b, undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    // Only reached when the names differ by case alone. Compared exactly so the tie is settled by the
    // names themselves rather than by their position in the listing.
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * The codes a mention can be skipped under.
 *
 * Stable strings rather than wording, so the renderer branches on the code and the message stays
 * free to change: the same rule the rest of the app's failures follow.
 */
export const MENTION_SKIP_CODES = ['CONTEXT_FILE_TOO_LARGE', 'CONTEXT_FILE_NOT_FOUND', 'CONTEXT_FILE_REFUSED'] as const

export type MentionSkipCode = (typeof MENTION_SKIP_CODES)[number]

/**
 * One mention, after the disk has been consulted.
 *
 * `text` is present exactly when `status` is `ok`; the other statuses carry no content because there
 * is none to carry. Modelling it as a union rather than an optional field is what makes "skipped"
 * unable to be confused with "read, and empty".
 */
export type MentionRead =
  { path: string; status: 'ok'; text: string } | { path: string; status: 'too-large' | 'missing' | 'refused' }

/** A skip, as it is reported to the renderer and named to the model. */
export interface MentionNotice {
  path: string
  code: MentionSkipCode
}

/** Which code each failure status is reported under. */
const SKIP_CODE: Record<Exclude<MentionRead['status'], 'ok'>, MentionSkipCode> = {
  'too-large': 'CONTEXT_FILE_TOO_LARGE',
  missing: 'CONTEXT_FILE_NOT_FOUND',
  refused: 'CONTEXT_FILE_REFUSED',
}

/**
 * Whether a value is one of the failure statuses.
 *
 * Taken as `unknown` because these values cross IPC: the type says an entry is a `MentionRead`, and the
 * point of the check is what happens when it is not one anyway. A type guard is what keeps that
 * defensive read honest without writing comparisons the compiler can see are impossible.
 */
function isSkipStatus(value: unknown): value is keyof typeof SKIP_CODE {
  return value === 'too-large' || value === 'missing' || value === 'refused'
}

/** How a skip reads in the section. One line, because the model needs the fact and not a paragraph. */
function skipLine(notice: MentionNotice): string {
  return `- ${notice.path} — not included (${notice.code})`
}

/**
 * The context section for a message's mentions, and the skips to report.
 *
 * Order is the request's, not a sorted one: the user picked these in an order, and a section that
 * reordered them would quietly disagree with the chips they are looking at. Files that read are
 * included as fenced blocks; files that did not are named with their code.
 *
 * Never throws. It is fed by disk reads, and it is the last step before a send, so a surprise here
 * must not be the thing that loses the user's message — a malformed entry is included as best it can
 * be rather than raised. `nullish` guards rather than type assertions, because the values cross IPC.
 */
export function assembleMentionContext(entries: readonly MentionRead[]): {
  section: string
  notices: MentionNotice[]
} {
  const notices: MentionNotice[] = []
  const blocks: string[] = []

  for (const raw of entries) {
    // Widened on purpose. These entries cross IPC, so the declared type is a promise rather than a
    // guarantee; reading them defensively is the difference between a malformed entry producing a
    // degraded section and it producing a failed send.
    const entry: { path?: unknown; status?: unknown; text?: unknown } | null | undefined = raw
    const path = typeof entry?.path === 'string' ? entry.path : ''

    if (entry?.status === 'ok') {
      const text = typeof entry.text === 'string' ? entry.text : ''
      // The path is repeated on the fence's info string so the model can tell one file's content from
      // the next without counting fences, and a fenced block rather than an inline one because these
      // are whole files and would otherwise reflow into the surrounding prose.
      blocks.push(`### ${path}\n\n\`\`\`\n${text}\n\`\`\``)
      continue
    }

    // An entry that is not one of the known failure statuses is reported as refused rather than
    // dropped: it was asked for, and the model should be told it is not here.
    const code = isSkipStatus(entry?.status) ? SKIP_CODE[entry.status] : 'CONTEXT_FILE_REFUSED'
    notices.push({ path, code })
    blocks.push(skipLine({ path, code }))
  }

  if (entries.length === 0) return { section: '', notices }

  // A preamble rather than a bare dump of blocks: the model has to know these arrived because the
  // user attached them, and that they are context for the message rather than the message itself.
  const section = ['The user attached the following files from the workspace to this message.', '', ...blocks].join(
    '\n'
  )

  return { section, notices }
}
