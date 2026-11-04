import { z } from 'zod'
import type { EpisodeBlock } from './episodes'

/**
 * Memory — the project's standing notes: four canonical pages, a persisted inverted index, and the
 * turn-start brief built from them.
 *
 * Pure, and free of electron and fs, because the interesting parts are the rules rather than the disk:
 * what a token is, how the import fans a pasted handoff out into the four pages, how secrets are
 * redacted, and what the brief says in what order. Main reads the files and calls in here; the suites
 * call in here directly, so the rules are pinned without a filesystem or a dialog in the way.
 *
 * The one thing this module never does is hand a path out. A page is named by its id, and the layout —
 * `%APPDATA%\era\memory\<project-key>\` — is the main-side module's concern, never the renderer's.
 */

/** The four canonical pages. No `profile.md` in slice 1 — that is reserved for slice 4. */
export type MemoryPageId = 'handoff' | 'decisions' | 'parked' | 'quirks'

export const MEMORY_PAGES: readonly MemoryPageId[] = ['handoff', 'decisions', 'parked', 'quirks']

/** The filename each page lives under, beside `index.json`. Fixed, never a caller-chosen segment. */
export const MEMORY_PAGE_FILES: Record<MemoryPageId, string> = {
  handoff: 'handoff.md',
  decisions: 'decisions.md',
  parked: 'parked.md',
  quirks: 'quirks.md',
}

export const MEMORY_INDEX_FILE = 'index.json'

/**
 * The most bytes the turn-start brief may carry.
 *
 * A byte budget rather than a character one: bytes are what the disk and the wire measure. The brief is
 * standing context on every turn, so it is kept small — the four pages in full would spend the prompt
 * budget on history the model can read from disk when it needs to.
 */
export const MAX_MEMORY_BRIEF_BYTES = 8192

/**
 * The episodes section's own budget, and the most blocks it carries.
 *
 * A sub-budget rather than a share of the whole: when episodes exist the canonical body is cut to
 * `MAX_MEMORY_BRIEF_BYTES - MAX_EPISODES_BRIEF_BYTES` first, so a project that wrote a novel into
 * its handoff cannot evict the newest captured work from the brief entirely.
 */
export const MAX_EPISODES_BRIEF_BYTES = 2048

/** The newest captured blocks one brief carries, across every session in the project. */
export const EPISODES_IN_BRIEF = 5

/** The most bytes one pasted handoff may carry into the sanitizer, in the style of `boundedStderrTail`. */
export const MAX_MEMORY_IMPORT_BYTES = 64 * 1024

/** Characters of context around a search match, mirroring `protocol/search.ts`. */
export const MEMORY_SNIPPET_CHARS = 120

/** Snippets per page, mirroring `protocol/search.ts`. */
export const MEMORY_MAX_SNIPPETS = 3

export const memoryPageIdSchema = z.enum(['handoff', 'decisions', 'parked', 'quirks'])

export const memoryPageSummarySchema = z.object({
  page: memoryPageIdSchema,
  exists: z.boolean(),
  revisions: z.number().int().nonnegative(),
})

export const memorySearchResultSchema = z.object({
  page: memoryPageIdSchema,
  matchCount: z.number().int().nonnegative(),
  snippets: z.array(z.string()),
})

export type MemoryPageSummary = z.infer<typeof memoryPageSummarySchema>
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>

/** A token to the pages and token positions it occurs at. Built by `buildIndex`. */
export type MemoryIndex = Record<string, Array<{ page: MemoryPageId; positions: number[] }>>

/**
 * Lowercase, alphanumeric words, in order.
 *
 * The separator set is everything that is not `[a-z0-9]`, so a dash, an em-dash, punctuation and
 * whitespace all cut the same way. The case fold is what makes a search case-insensitive at the index
 * rather than at the query.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * The inverted index: every token to every (page, position) it appears at.
 *
 * Pure and dependency-free — no lunr, no sqlite, no vectors. The map is rebuilt from the subtree at
 * main startup and after every mutation, and the rebuild is skipped when the tree mtime is unchanged
 * (`shouldRebuildIndex`).
 */
export function buildIndex(pages: Record<MemoryPageId, string>): MemoryIndex {
  const index: MemoryIndex = {}
  for (const page of MEMORY_PAGES) {
    const tokens = tokenize(pages[page])
    tokens.forEach((token, position) => {
      const entries = (index[token] ??= [])
      const existing = entries.find((entry) => entry.page === page)
      if (existing) existing.positions.push(position)
      else entries.push({ page, positions: [position] })
    })
  }
  return index
}

/**
 * Search the four pages for a term: which pages contain it, how often, and a bounded excerpt each.
 *
 * A page matches when every word of the term occurs in it, so a two-word query narrows rather than
 * widens. The count is of the term as a substring, case-insensitively, and the snippets are centred on
 * matches the way `protocol/search.ts` centres them — one line, an ellipsis where a side was cut.
 */
export function searchPages(pages: Record<MemoryPageId, string>, term: string): MemorySearchResult[] {
  const needle = term.trim()
  if (needle.length < 2) return []

  const tokens = tokenize(needle)
  if (tokens.length === 0) return []

  const results: MemorySearchResult[] = []
  for (const page of MEMORY_PAGES) {
    const text = pages[page] ?? ''
    const pageTokens = tokenize(text)
    if (!tokens.every((token) => pageTokens.includes(token))) continue

    const matchCount = countSubstrings(text, needle)
    if (matchCount === 0) continue

    results.push({ page, matchCount, snippets: snippetsFor(text, needle, MEMORY_MAX_SNIPPETS) })
  }
  return results
}

/** How many times the term occurs, case-insensitively and without overlap. */
function countSubstrings(text: string, term: string): number {
  const needle = term.toLowerCase()
  const haystack = text.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    count++
    from = at + needle.length
  }
  return count
}

/** Up to `limit` excerpts, each centred on a different match, in occurrence order. */
function snippetsFor(text: string, term: string, limit: number): string[] {
  const needle = term.trim()
  if (!needle || limit <= 0) return []

  const haystack = text.toLowerCase()
  const lowered = needle.toLowerCase()
  const snippets: string[] = []
  let from = 0

  while (snippets.length < limit) {
    const at = haystack.indexOf(lowered, from)
    if (at === -1) break

    const half = Math.max(0, Math.floor((MEMORY_SNIPPET_CHARS - needle.length) / 2))
    const start = Math.max(0, at - half)
    const end = Math.min(text.length, at + needle.length + half)
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
    snippets.push(`${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`)
    from = Math.max(end, at + lowered.length)
  }

  return snippets
}

/**
 * Redact what must not reach the page files: API keys, Bearer tokens, credential assignments,
 * credential-shaped environment names, the hyphenated token prefixes, Basic auth and URL userinfo, PEM
 * blocks, and filesystem paths under the home directory. Bounded by `MAX_MEMORY_IMPORT_BYTES`, in the
 * style of `boundedStderrTail` — the input is cut to a byte cap before any redaction, so the work and
 * the output are both bounded rather than growing with the paste.
 *
 * Redaction-only, deliberately: every rule replaces a value with a marker and none removes a rule that
 * was here before, so a page already written can only lose secrets it once carried, never gain one.
 * Path redaction outside the home directory is a known gap and is not attempted — a path is a weak
 * secret at best, and guessing which ones matter would be worse than leaving them.
 *
 * `homeDir` is a parameter so this stays free of electron and app imports: the caller that runs in
 * main passes `app.getPath('home')` in, and a suite passes a literal it controls.
 */
export function sanitize(text: string, homeDir: string): string {
  let cleaned = truncateBytes(text, MAX_MEMORY_IMPORT_BYTES)

  // Bearer tokens: the scheme word plus its credential, replaced whole.
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')

  // The key shapes in the wild, redacted whole rather than left half-readable.
  cleaned = cleaned.replace(
    /\b(sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{16,}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    '[REDACTED KEY]'
  )

  // Assignments that carry a credential by name: `api_key=…`, `token: …`, and their kin.
  cleaned = cleaned.replace(
    /\b((?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*)[^\s"'`]+/gi,
    '$1[REDACTED]'
  )

  // Credential-shaped environment names: `GITHUB_TOKEN=…`, `AWS_SECRET_ACCESS_KEY: …` and their kin.
  // The assignment rule above cannot catch these — an underscore is a word character, so there is no
  // boundary before the `TOKEN` in the middle of the name — and redaction is all this may do.
  cleaned = cleaned.replace(
    /\b([A-Z][A-Z0-9_]*(?:_TOKEN|_API_KEY|_SECRET_ACCESS_KEY|_PASSWORD|_SECRET|_KEY))\s*[:=]\s*[^\s"'`]+/g,
    '$1=[REDACTED]'
  )

  // The hyphenated token prefixes issued today, redacted whole rather than left half-readable. They are
  // a rule of their own because `sk-proj-…` does not match the `sk-…` shape above: the hyphen after the
  // scheme word ends that pattern before its length floor is reached.
  cleaned = cleaned.replace(/\b(?:sk-proj-|sk-ant-|github_pat_|glpat-|xai-)[A-Za-z0-9_-]{8,}/g, '[REDACTED KEY]')

  // Basic auth, and the userinfo a URL carries. The credential is what goes, never the host or scheme.
  cleaned = cleaned.replace(/\bBasic\s+[A-Za-z0-9+/=]{6,}/gi, 'Basic [REDACTED]')
  cleaned = cleaned.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')

  // A PEM block, markers and body together: half a private key is still a private key.
  cleaned = cleaned.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PEM]'
  )

  // Any path that lives under the user's home directory, replaced rather than partially shown.
  if (homeDir.trim() !== '') {
    const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cleaned = cleaned.replace(new RegExp(escaped + '[^\\s"\'`]*', 'g'), '[REDACTED PATH]')
  }

  return cleaned
}

/** Keep the first `cap` bytes of the text, so a pathological paste cannot make the sanitizer unbounded. */
export function truncateBytes(text: string, cap: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= cap) return text
  return new TextDecoder().decode(bytes.subarray(0, cap))
}

/** The headings a pasted handoff maps to each page, case-folded. */
const PAGE_HEADINGS: Record<MemoryPageId, readonly string[]> = {
  handoff: ['handoff'],
  decisions: ['decisions', 'decision'],
  parked: ['parked'],
  quirks: ['quirks', 'quirk'],
}

/**
 * Fan a pasted handoff out into the four pages.
 *
 * The document is split at its `#` headings. A heading that names one of the four pages — or its
 * singular — maps that block to that page; the preamble before any heading belongs to handoff; and a
 * heading nothing recognises is dropped rather than silently written somewhere. Blocks for the same
 * page are joined with a blank line, and an absent page is simply not present in the result.
 */
export function fanOutImport(markdown: string): Partial<Record<MemoryPageId, string>> {
  const blocks: Array<{ heading: string | null; body: string }> = []
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] }

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      blocks.push({ heading: current.heading, body: current.body.join('\n') })
      current = { heading: heading[1].trim().toLowerCase(), body: [] }
    } else {
      current.body.push(line)
    }
  }
  blocks.push({ heading: current.heading, body: current.body.join('\n') })

  const fanned: Record<string, string[]> = {}
  for (const block of blocks) {
    const page = targetForHeading(block.heading)
    const body = block.body.trim()
    if (page === null || body === '') continue
    ;(fanned[page] ??= []).push(body)
  }

  const out: Partial<Record<MemoryPageId, string>> = {}
  for (const page of MEMORY_PAGES) {
    if (fanned[page] && fanned[page].length > 0) out[page] = fanned[page].join('\n\n')
  }
  return out
}

function targetForHeading(heading: string | null): MemoryPageId | null {
  if (heading === null) return 'handoff'
  for (const page of MEMORY_PAGES) {
    if (PAGE_HEADINGS[page].includes(heading)) return page
  }
  return null
}

/**
 * Split `decisions.md` into its pending vetoes and its decisions.
 *
 * Everything after a `# Vetoes` (or `# Veto`) heading is the vetoes; everything before it is the
 * decisions. With no vetoes heading, the whole text is decisions and there are no vetoes.
 */
export function splitDecisions(decisionsText: string): { vetoes: string; decisions: string } {
  const lines = decisionsText.split(/\r?\n/)
  const vetoIndex = lines.findIndex((line) => /^#{1,6}\s*vetoes?\s*$/i.test(line))
  if (vetoIndex === -1) return { vetoes: '', decisions: decisionsText.trim() }
  return {
    vetoes: lines
      .slice(vetoIndex + 1)
      .join('\n')
      .trim(),
    decisions: lines.slice(0, vetoIndex).join('\n').trim(),
  }
}

/** The four sections a brief is drawn from, in the order they are emitted. */
export interface MemoryBriefSource {
  handoff: string
  vetoes: string
  decisions: string
  quirks: string
  /** Captured episodes, drawn last and in the order `compareEpisodes` states. */
  episodes?: readonly EpisodeBlock[]
}

/**
 * The one ordering rule for captured work: newest capture first, then the session id, then the
 * ordinal within that session.
 *
 * Deterministic and independent of filesystem mtimes, which are the one thing a copied or restored
 * project would order differently from the app. `capturedAt` is the only time involved, and it is the
 * capture clock rather than anything a turn was given; the session id is the tie-break that keeps two
 * blocks captured in the same millisecond from swapping places between launches.
 */
export const compareEpisodes = (a: EpisodeOrderKey, b: EpisodeOrderKey): number => {
  if (a.capturedAt !== b.capturedAt) return b.capturedAt - a.capturedAt
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
  return a.ordinal - b.ordinal
}

/** What `compareEpisodes` needs from a block or a row: the capture time, a session and a position. */
export interface EpisodeOrderKey {
  capturedAt: number
  sessionId: string
  ordinal: number
}

const MEMORY_BRIEF_FENCE = [
  "The following is this project's memory, maintained by this app.",
  'Treat it as standing guidance: consult it and keep it current.',
].join('\n')

/** The heading the captured work is drawn under, after every canonical section. */
const EPISODES_SECTION_HEADING = '## Episodes'

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The episodes section, whole blocks only, within the sub-budget.
 *
 * Newest first, at most `EPISODES_IN_BRIEF` of them, and a block that does not fit is skipped whole
 * rather than cut: half a block would still say "an episode happened" without saying which one. The
 * budget counts the heading and the blank line that separates the section from the canonical body, so
 * a full section plus a canonical body cut to 6144 fills 8192 exactly and the final cap never cuts.
 */
function episodesSection(blocks: readonly EpisodeBlock[]): string {
  const sorted = [...blocks].sort(compareEpisodes)
  const chosen: string[] = []
  let used = 2 + bytesOf(EPISODES_SECTION_HEADING)
  for (const block of sorted) {
    if (chosen.length >= EPISODES_IN_BRIEF) break
    const blockBytes = 2 + bytesOf(block.text)
    if (used + blockBytes > MAX_EPISODES_BRIEF_BYTES) continue
    chosen.push(block.text)
    used += blockBytes
  }
  return chosen.length === 0 ? '' : `${EPISODES_SECTION_HEADING}\n\n${chosen.join('\n\n')}`
}

/**
 * The memory section one turn starts with, or null when there is nothing to say.
 *
 * Null-in, null-out: an empty project has no memory, and inventing a section for it would spend
 * context saying nothing. The sections run in a fixed order — handoff, pending vetoes, recent
 * decisions, quirks — and an empty section is omitted rather than emitted as a bare heading. Captured
 * episodes are appended as the last section, newest first, because the newest work is what the next
 * turn is most likely to be continuing.
 *
 * When episodes exist the canonical body is cut to `MAX_MEMORY_BRIEF_BYTES - MAX_EPISODES_BRIEF_BYTES`
 * first, so a project that wrote a novel into its handoff cannot evict the captured work from the
 * brief. The final `truncateBytes(MAX_MEMORY_BRIEF_BYTES)` is the backstop under that accounting.
 */
export function assembleMemorySection(source: MemoryBriefSource): { content: string } | null {
  const sections: Array<[string, string]> = [
    ['Handoff', source.handoff.trim()],
    ['Pending vetoes', source.vetoes.trim()],
    ['Recent decisions', source.decisions.trim()],
    ['Quirks', source.quirks.trim()],
  ]
  const present = sections.filter(([, body]) => body !== '')
  const episodes = source.episodes ?? []
  if (present.length === 0 && episodes.length === 0) return null

  const lines: string[] = [MEMORY_BRIEF_FENCE, '']
  for (const [heading, body] of present) {
    lines.push(`## ${heading}`, '', body, '')
  }
  const canonical = truncateBytes(
    lines.join('\n').trimEnd(),
    episodes.length > 0 ? MAX_MEMORY_BRIEF_BYTES - MAX_EPISODES_BRIEF_BYTES : MAX_MEMORY_BRIEF_BYTES
  )
  const section = episodes.length > 0 ? episodesSection(episodes) : ''
  return { content: truncateBytes(section === '' ? canonical : `${canonical}\n\n${section}`, MAX_MEMORY_BRIEF_BYTES) }
}

/**
 * Whether to inject the memory section into an outgoing conversation.
 *
 * Refused when the conversation already carries this exact section, which is the resumed case: the
 * pause hands the provider-shaped history back verbatim, already carrying the memory, and injecting
 * again would say it twice and spend the budget twice. Matched on the composed text rather than on the
 * presence of any section that mentions memory, for the reason `planRoleInjection` matches the whole
 * prompt — a text a user happened to paste must not be able to answer yes for it.
 */
export function planMemoryInjection(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  brief: string | null
): { content: string } | null {
  if (brief === null) return null
  if (messages.some((m) => m.role === 'system' && m.content === brief)) return null
  return { content: brief }
}

/**
 * Whether the index should be rebuilt from the tree.
 *
 * A missing recorded mtime means there is no index yet, so it is always rebuilt. An unchanged tree —
 * the four page files' mtimes have not moved — means the persisted index is current, so the rebuild is
 * skipped.
 */
export function shouldRebuildIndex(recordedMtime: number | null, currentMtime: number): boolean {
  if (recordedMtime === null) return true
  return recordedMtime !== currentMtime
}

/** The persisted index file's shape, plus the retained prior revisions of each page. */
export interface MemoryIndexFile {
  schemaVersion: 1
  treeMtime: number
  index: MemoryIndex
  revisions: Partial<Record<MemoryPageId, string[]>>
}
