import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, query } from '../init'
import {
  EPISODE_PAGE_DIR,
  EPISODE_SESSION_ID_PATTERN,
  MAX_EPISODE_PAGE_BYTES,
  MAX_EPISODES_PER_PAGE,
  episodeRowFromBlock,
  extractEpisode,
  latestEpisodeTurnId,
  parseEpisodeBlocks,
  renderEpisodeBlock,
  type Episode,
  type EpisodeBlock,
  type MemoryEpisodeRow,
} from '../protocol/episodes'
import type { TranscriptSnapshot } from '../protocol/transcript'
import { MAX_FILE_BYTES } from './workspace'
import {
  assembleMemorySection,
  buildIndex,
  compareEpisodes,
  fanOutImport,
  MEMORY_INDEX_FILE,
  MEMORY_PAGE_FILES,
  MEMORY_PAGES,
  memoryPageIdSchema,
  sanitize,
  searchPages,
  shouldRebuildIndex,
  splitDecisions,
  type MemoryIndexFile,
  type MemoryPageId,
  type MemoryPageSummary,
  type MemorySearchResult,
} from '../protocol/memory'

/**
 * Memory — main-only filesystem access, the persisted inverted index, and the turn-start brief.
 *
 * The renderer never sees `fs` or a path: it names a page by id and a folder by its workspace root,
 * and main turns that into `<userData>\memory\<project-key>\` — where the project key is a sha256 hash
 * of the resolved root, never a raw path segment. `userData` already equals `%APPDATA%\era`
 * (`app.setPath('userData', <appData>/era)` in `lib/main/identity.ts`), so the on-disk layout stays the
 * same `%APPDATA%\era\memory\<project-key>\` it always was; the module joins `memory/<key>` onto
 * `userData` instead of `era/memory/<key>` onto `appData`. Every page write is a temp-then-rename so a
 * reader sees the old bytes or the new ones, never a half-written page, mirroring `saveTranscriptFile`.
 */

const MEMORY_FOLDER = 'memory'

/** A project key is a sha256 hex digest: 64 lowercase hex chars, never a path segment a caller shaped. */
export const PROJECT_KEY_PATTERN = /^[0-9a-f]{64}$/

/** Hash a resolved workspace root into a project key. */
export function projectKeyFor(rootPath: string): string {
  return createHash('sha256').update(resolve(rootPath)).digest('hex')
}

/** The memory subtree for one workspace: `<userData>\memory\<project-key>`. */
export function memoryRoot(userDataPath: string, rootPath: string): string {
  const key = projectKeyFor(rootPath)
  // Shape-checked before it is joined, the way a session id is before it becomes a filename: the key is
  // the one segment that names a directory, and a segment that is not sha256 hex must never be joined.
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new ConveyorError('MEMORY_IO_ERROR', 'The project key did not form a safe path segment.')
  }
  return join(userDataPath, MEMORY_FOLDER, key)
}

/** The file one page lives under. The page id is validated before this is called; the name is fixed. */
function pageFilePath(root: string, page: MemoryPageId): string {
  return join(root, MEMORY_PAGE_FILES[page])
}

/**
 * Write a file atomically: a temp sibling, then a rename over the target.
 *
 * Mirrors `saveTranscriptFile` (sessions.ts): the rename is what makes it atomic, and the temp carries
 * the pid so two writers cannot collide on it. A failed write removes its temp rather than leaving a
 * file that would later be mistaken for a page.
 */
async function writeFileAtomic(root: string, target: string, content: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('MEMORY_IO_ERROR', `Could not write memory. ${reason}`)
  }
}

/** Read one page's raw text, or null when it has never been written. */
async function readPageRaw(root: string, page: MemoryPageId): Promise<string | null> {
  const target = pageFilePath(root, page)
  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return null
  }
  if (size > MAX_FILE_BYTES) {
    throw new ConveyorError('MEMORY_IO_ERROR', `${MEMORY_PAGE_FILES[page]} is too large to read.`)
  }
  try {
    return await readFile(target, 'utf8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('MEMORY_IO_ERROR', `Could not read memory. ${reason}`)
  }
}

/**
 * Read a page for a scan or a brief, where one oversized page must not fail the whole read.
 *
 * Absent, oversized and unreadable all collapse to null — the caller treats them as an empty page,
 * which for the brief is exactly the conservative reading: a page this turn cannot read contributes
 * nothing rather than taking the turn down with it.
 */
async function readPageSafe(root: string, page: MemoryPageId): Promise<string | null> {
  try {
    return await readPageRaw(root, page)
  } catch {
    return null
  }
}

/** Every page's current text, absent pages read as empty strings. */
async function readAllPages(root: string): Promise<Record<MemoryPageId, string>> {
  const pages = {} as Record<MemoryPageId, string>
  for (const page of MEMORY_PAGES) {
    pages[page] = (await readPageSafe(root, page)) ?? ''
  }
  return pages
}

/**
 * The newest mtime of the memory tree: the four page files and every episode page, or zero while none
 * exist.
 *
 * The episode pages are part of the tree because a captured turn is memory. A capture deliberately
 * does not rebuild the index inline — that would tokenise four pages on every completed turn — so the
 * moved mtime is what lets the next `ensureMemoryIndex` rebuild once and then settle.
 */
async function readTreeMtime(root: string): Promise<number> {
  let max = 0
  for (const page of MEMORY_PAGES) {
    try {
      max = Math.max(max, (await stat(pageFilePath(root, page))).mtimeMs)
    } catch {
      // Absent page contributes nothing to the tree.
    }
  }

  const dir = episodesDir(root)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return max
  }
  for (const file of files) {
    if (!isEpisodePageFile(file)) continue
    try {
      max = Math.max(max, (await stat(join(dir, file))).mtimeMs)
    } catch {
      // A page that vanished between the readdir and the stat contributes nothing.
    }
  }
  return max
}

/** Read the persisted index file, or null when there is none or it will not parse. */
async function readIndexFile(root: string): Promise<MemoryIndexFile | null> {
  let raw: string
  try {
    raw = await readFile(join(root, MEMORY_INDEX_FILE), 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (parsed as { treeMtime?: unknown }).treeMtime === 'number' &&
    (parsed as { index?: unknown }).index &&
    typeof (parsed as { index?: unknown }).index === 'object' &&
    (parsed as { revisions?: unknown }).revisions &&
    typeof (parsed as { revisions?: unknown }).revisions === 'object'
  ) {
    return parsed as MemoryIndexFile
  }
  return null
}

/** Persist the index and the revision history together, atomically. */
async function writeIndexFile(root: string, file: MemoryIndexFile): Promise<void> {
  await writeFileAtomic(root, join(root, MEMORY_INDEX_FILE), JSON.stringify(file))
}

/** The four page summaries, for the panel's tab row. */
export async function listMemoryPages(userDataPath: string, rootPath: string): Promise<MemoryPageSummary[]> {
  const root = memoryRoot(userDataPath, rootPath)
  const indexFile = await readIndexFile(root)

  const summaries: MemoryPageSummary[] = []
  for (const page of MEMORY_PAGES) {
    let exists = false
    try {
      await stat(pageFilePath(root, page))
      exists = true
    } catch {
      exists = false
    }
    summaries.push({ page, exists, revisions: (indexFile?.revisions?.[page] ?? []).length })
  }
  return summaries
}

/** Read one page's current text and its retained revision count, or null when it has never been written. */
export async function readMemoryPage(
  userDataPath: string,
  rootPath: string,
  page: MemoryPageId
): Promise<{ content: string; revisions: number } | null> {
  const root = memoryRoot(userDataPath, rootPath)
  const content = await readPageRaw(root, page)
  if (content === null) return null
  const indexFile = await readIndexFile(root)
  return { content, revisions: (indexFile?.revisions?.[page] ?? []).length }
}

/**
 * Write a page, creating it or superseding it.
 *
 * On an existing page this *supersedes* rather than overwrites: the prior revision is retained at the
 * head of that page's history, and `restorePage` reverts to it. On an absent page it is the creation,
 * which is the only time a whole-file overwrite happens. The index is rebuilt after the write, since
 * the tree has moved.
 */
export async function writeMemoryPage(
  userDataPath: string,
  rootPath: string,
  page: MemoryPageId,
  content: string
): Promise<MemoryPageSummary> {
  const root = memoryRoot(userDataPath, rootPath)
  const prior = await readPageSafe(root, page)
  const indexFile = (await readIndexFile(root)) ?? { schemaVersion: 1, treeMtime: 0, index: {}, revisions: {} }

  const revisions = { ...(indexFile.revisions ?? {}) }
  if (prior !== null) {
    revisions[page] = [prior, ...(revisions[page] ?? [])]
  }

  await writeFileAtomic(root, pageFilePath(root, page), content)
  await writeIndexFile(root, {
    schemaVersion: 1,
    treeMtime: await readTreeMtime(root),
    index: buildIndex(await readAllPages(root)),
    revisions,
  })

  return { page, exists: true, revisions: (revisions[page] ?? []).length }
}

/**
 * Revert a page to its prior revision, which the revert then consumes.
 *
 * Supersede-not-delete: the write is another supersede — the prior revision becomes current — and the
 * revision being reverted to leaves the history. With no prior revision there is nothing to revert to,
 * which is reported under `MEMORY_NOT_FOUND` so the panel can say "nothing to restore" rather than a
 * write failure.
 */
export async function restoreMemoryPage(
  userDataPath: string,
  rootPath: string,
  page: MemoryPageId
): Promise<{ content: string; revisions: number }> {
  const root = memoryRoot(userDataPath, rootPath)
  const indexFile = await readIndexFile(root)
  const history = indexFile?.revisions?.[page] ?? []
  if (history.length === 0) {
    throw new ConveyorError('MEMORY_NOT_FOUND', 'There is no earlier revision to restore.')
  }

  const [restored, ...rest] = history
  await writeFileAtomic(root, pageFilePath(root, page), restored)
  await writeIndexFile(root, {
    schemaVersion: 1,
    treeMtime: await readTreeMtime(root),
    index: buildIndex(await readAllPages(root)),
    revisions: { ...(indexFile?.revisions ?? {}), [page]: rest },
  })

  return { content: restored, revisions: rest.length }
}

/** Search the four pages, returning page ids with bounded snippets. */
export async function searchMemoryPages(
  userDataPath: string,
  rootPath: string,
  term: string
): Promise<MemorySearchResult[]> {
  const root = memoryRoot(userDataPath, rootPath)
  return searchPages(await readAllPages(root), term)
}

/**
 * Import a pasted handoff: sanitize it, fan it out, and write the sections.
 *
 * The sanitizer runs *before* the fan-out (ruling 5), so a secret in the paste never reaches a page.
 * A section that already exists is never silently overwritten: without `force` the import is refused
 * under `MEMORY_CONFLICT` and nothing is written; with `force` the existing sections are superseded —
 * prior revisions retained, `restorePage` as the undo. A paste with no recognisable section fails
 * under `MEMORY_IMPORT_FAILED`.
 */
export async function importMemoryHandoff(
  userDataPath: string,
  rootPath: string,
  markdown: string,
  homeDir: string,
  force = false
): Promise<MemoryPageSummary[]> {
  const root = memoryRoot(userDataPath, rootPath)
  const fanned = fanOutImport(sanitize(markdown, homeDir))
  const targets = MEMORY_PAGES.filter((page) => typeof fanned[page] === 'string' && (fanned[page] ?? '').trim() !== '')

  if (targets.length === 0) {
    throw new ConveyorError('MEMORY_IMPORT_FAILED', 'The pasted handoff had no sections to import.')
  }

  if (!force) {
    const conflicts: MemoryPageId[] = []
    for (const page of targets) {
      if ((await readPageSafe(root, page)) !== null) conflicts.push(page)
    }
    if (conflicts.length > 0) {
      throw new ConveyorError(
        'MEMORY_CONFLICT',
        'Some of these sections already exist. Choose whether to supersede them.'
      )
    }
  }

  for (const page of targets) {
    await writeMemoryPage(userDataPath, rootPath, page, fanned[page] ?? '')
  }
  return listMemoryPages(userDataPath, rootPath)
}

/**
 * Rebuild the inverted index from the subtree, skipping it when the tree mtime is unchanged.
 *
 * Called at startup and defensively; every mutation already rebuilds the index as part of its write.
 * The skip is the whole point of persisting the index: a launch over an untouched tree reads the index
 * off disk instead of re-tokenising every page.
 */
export async function ensureMemoryIndex(userDataPath: string, rootPath: string): Promise<{ rebuilt: boolean }> {
  const root = memoryRoot(userDataPath, rootPath)
  const currentMtime = await readTreeMtime(root)
  const existing = await readIndexFile(root)

  if (existing !== null && !shouldRebuildIndex(existing.treeMtime, currentMtime)) {
    return { rebuilt: false }
  }

  // An empty tree with no index yet has nothing to index, so nothing is authored — a project that never
  // wrote a memory page keeps no subtree at all until its first write.
  if (existing === null && currentMtime === 0) {
    return { rebuilt: false }
  }

  await writeIndexFile(root, {
    schemaVersion: 1,
    treeMtime: currentMtime,
    index: buildIndex(await readAllPages(root)),
    revisions: existing?.revisions ?? {},
  })
  return { rebuilt: true }
}

/**
 * The turn-start memory brief, or null when the project has none.
 *
 * Read fresh at the turn start, like the project instructions and the skills: the disk is the only copy
 * worth sending. `parked.md` is deliberately not part of the brief — it is what the project set aside,
 * not what it is working from. Null when the workspace is unset or every brief section is empty.
 */
export async function resolveMemoryBrief(
  workspaceRoot: string | null,
  userDataPath: string
): Promise<{ content: string } | null> {
  if (!workspaceRoot) return null

  const root = memoryRoot(userDataPath, workspaceRoot)
  const handoff = (await readPageSafe(root, 'handoff')) ?? ''
  const decisions = (await readPageSafe(root, 'decisions')) ?? ''
  const quirks = (await readPageSafe(root, 'quirks')) ?? ''
  const { vetoes, decisions: recent } = splitDecisions(decisions)

  return assembleMemorySection({
    handoff,
    vetoes,
    decisions: recent,
    quirks,
    episodes: await readAllEpisodeBlocks(root),
  })
}

/** Installed by the router, after the store exists: mirrors the four page summaries to every window. */
let memoryPagesSink: ((pages: MemoryPageSummary[]) => void) | null = null

/** Install the sink, or clear it with null. Called once, by the router, after the stores exist. */
export function setMemoryPagesSink(next: ((pages: MemoryPageSummary[]) => void) | null): void {
  memoryPagesSink = next
}

/** Installed by the router beside the pages sink: mirrors the episode rows to every window. */
let memoryEpisodesSink: ((episodes: MemoryEpisodeRow[]) => void) | null = null

/**
 * Install the episode sink, or clear it with null. Called once, by the router, after the stores exist.
 *
 * A second sink rather than a wider first one, because the two lists have different moments: the page
 * summaries change on a page write, while the episode rows are only refreshed at launch and when the
 * panel asks. A capture deliberately pushes nothing — a store broadcast per completed turn is the IPC
 * chatter the whole transcript design exists to avoid.
 */
export function setMemoryEpisodesSink(next: ((episodes: MemoryEpisodeRow[]) => void) | null): void {
  memoryEpisodesSink = next
}

/**
 * Seed the store for the folder open at launch, so the panel has a durable view before it is opened.
 *
 * The episode rows are seeded beside the page summaries, in the brief's order, so the panel's preview
 * is what the next turn would actually carry.
 */
export async function refreshMemoryPagesForRoot(rootPath: string | null): Promise<void> {
  if (!rootPath) return
  await ensureMemoryIndex(app.getPath('userData'), rootPath)
  memoryPagesSink?.(await listMemoryPages(app.getPath('userData'), rootPath))
  memoryEpisodesSink?.(await listMemoryEpisodes(app.getPath('userData'), rootPath))
}

export const memoryModule = defineModule({
  /** The four page summaries, for the panel's tab row. The store mirrors are refreshed as a side effect. */
  listPages: query(z.object({ rootPath: z.string().min(1) }), async ({ input }) => {
    const pages = await listMemoryPages(app.getPath('userData'), input.rootPath)
    memoryPagesSink?.(pages)
    memoryEpisodesSink?.(await listMemoryEpisodes(app.getPath('userData'), input.rootPath))
    return pages
  }),

  /** One page's current text, or null while it has never been written. */
  readPage: query(z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema }), async ({ input }) =>
    readMemoryPage(app.getPath('userData'), input.rootPath, input.page)
  ),

  /** Search the pages for a term. A query, because the panel wants it keyed per term while the user types. */
  search: query(z.object({ rootPath: z.string().min(1), term: z.string().min(2) }), async ({ input }) =>
    searchMemoryPages(app.getPath('userData'), input.rootPath, input.term)
  ),

  /** Write a page: create it, or supersede it and retain the prior revision. */
  writePage: command(
    z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema, content: z.string() }),
    async ({ input }) => {
      const summary = await writeMemoryPage(app.getPath('userData'), input.rootPath, input.page, input.content)
      memoryPagesSink?.(await listMemoryPages(app.getPath('userData'), input.rootPath))
      return summary
    }
  ),

  /** Supersede an existing page explicitly. An absent page is refused, unlike `writePage`. */
  supersedePage: command(
    z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema, content: z.string() }),
    async ({ input }) => {
      const prior = await readMemoryPage(app.getPath('userData'), input.rootPath, input.page)
      if (prior === null) {
        throw new ConveyorError('MEMORY_NOT_FOUND', 'There is no page to supersede yet.')
      }
      const summary = await writeMemoryPage(app.getPath('userData'), input.rootPath, input.page, input.content)
      memoryPagesSink?.(await listMemoryPages(app.getPath('userData'), input.rootPath))
      return summary
    }
  ),

  /** Revert a page to its prior revision. `MEMORY_NOT_FOUND` when there is none. */
  restorePage: command(z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema }), async ({ input }) => {
    const result = await restoreMemoryPage(app.getPath('userData'), input.rootPath, input.page)
    memoryPagesSink?.(await listMemoryPages(app.getPath('userData'), input.rootPath))
    return result
  }),

  /** Import a pasted handoff. `force` is only set after a conflict has been shown to the user. */
  importHandoff: command(
    z.object({ rootPath: z.string().min(1), markdown: z.string(), force: z.boolean().optional() }),
    async ({ input }) => {
      const pages = await importMemoryHandoff(
        app.getPath('userData'),
        input.rootPath,
        input.markdown,
        app.getPath('home'),
        input.force === true
      )
      memoryPagesSink?.(pages)
      return { pages }
    }
  ),
})

/**
 * Episodes — the captured turns, one page per session, and the fire-and-forget capture behind a
 * transcript save.
 *
 * The capture path needs two things main alone can answer: whether the user left episodic capture on,
 * and which project a conversation belongs to. Both arrive through sources installed by the router,
 * the pattern `setAutoDownloadSource` and `setEnginePreferenceSource` already follow, so this module
 * never reaches for a store it is imported beside.
 *
 * Every write here is a read-modify-write of the whole page — there is one block per turn and forty
 * at most — serialised per page by a promise chain, so two saves of one session that overlap cannot
 * each read the old bytes and write one block. The write itself is the same temp-then-rename the
 * canonical pages use.
 */

/** The directory one project's episode pages live in. */
function episodesDir(root: string): string {
  return join(root, EPISODE_PAGE_DIR)
}

/** Whether a directory entry names one of our episode pages: `<uuid>.md`, and nothing else. */
function isEpisodePageFile(file: string): boolean {
  if (!file.endsWith('.md')) return false
  return EPISODE_SESSION_ID_PATTERN.test(file.slice(0, -'.md'.length))
}

/**
 * One session's episode page. The session id is shape-checked before it becomes a filename, by the
 * same UUID rule the transcript's own input schema enforces — the page lives under the memory root,
 * and a segment that could escape it must never be joined.
 */
function episodePagePath(root: string, sessionId: string): string {
  if (!EPISODE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new ConveyorError('MEMORY_IO_ERROR', 'The session id did not form a safe path segment.')
  }
  return join(episodesDir(root), `${sessionId}.md`)
}

/**
 * One episode page's text, or null while it has never been written.
 *
 * Bounded twice: the file is ours and capped at 128 KB, so anything several times that size is a
 * hand-edited file rather than a page, and refusing to read it is the conservative answer — the next
 * capture logs its code and leaves the bytes alone rather than replacing them with one block.
 */
async function readEpisodePage(target: string): Promise<string | null> {
  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return null
  }
  if (size > MAX_EPISODE_PAGE_BYTES * 4) {
    throw new ConveyorError('MEMORY_IO_ERROR', 'An episode page is too large to read.')
  }
  return readFile(target, 'utf8')
}

const EPISODE_PAGE_HEADER = '# Episodes'

/** The page's whole text: its heading, then whole blocks newest first. */
function renderEpisodePage(blocks: readonly string[]): string {
  return `${EPISODE_PAGE_HEADER}\n\n${blocks.join('\n\n')}\n`
}

function episodePageBytes(blocks: readonly string[]): number {
  return new TextEncoder().encode(renderEpisodePage(blocks)).length
}

/** One page-preserving write: supersede in place, cap by count, then cap by bytes. */
async function writeEpisodePage(root: string, target: string, episode: Episode, homeDir: string): Promise<void> {
  const block = renderEpisodeBlock(episode, homeDir)
  const existing = await readEpisodePage(target)
  const prior = existing === null ? [] : parseEpisodeBlocks(existing, episode.sessionId)

  const same = prior.findIndex((candidate) => candidate.turnId === episode.turnId)
  const blocks =
    same === -1
      ? [block, ...prior.map((candidate) => candidate.text)]
      : prior.map((candidate, index) => (index === same ? block : candidate.text))

  const kept = blocks.slice(0, MAX_EPISODES_PER_PAGE)
  // Over the byte cap the oldest whole blocks go; a page of one block is never reduced further.
  while (kept.length > 1 && episodePageBytes(kept) > MAX_EPISODE_PAGE_BYTES) kept.pop()

  await writeFileAtomic(episodesDir(root), target, renderEpisodePage(kept))
}

/** The in-flight read-modify-write per page, so overlapping saves of one session serialise. */
const episodeWriteChains = new Map<string, Promise<void>>()

/**
 * Append one episode to its session's page, or replace the block a re-save of the same turn wrote.
 *
 * The chain is keyed by the page rather than the session id: a session's page is one file, and that is
 * the thing two writers must not interleave on. A failed write leaves the chain usable — the next call
 * catches its predecessor's rejection rather than inheriting it.
 */
export async function appendEpisodePage(
  userDataPath: string,
  rootPath: string,
  episode: Episode,
  homeDir: string
): Promise<void> {
  const root = memoryRoot(userDataPath, rootPath)
  const target = episodePagePath(root, episode.sessionId)

  const previous = episodeWriteChains.get(target) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeEpisodePage(root, target, episode, homeDir))
  episodeWriteChains.set(target, next)
  try {
    await next
  } finally {
    if (episodeWriteChains.get(target) === next) episodeWriteChains.delete(target)
  }
}

/** Every block on every page in one project, as the brief draws them. */
async function readAllEpisodeBlocks(root: string): Promise<EpisodeBlock[]> {
  const dir = episodesDir(root)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const blocks: EpisodeBlock[] = []
  for (const file of files) {
    if (!isEpisodePageFile(file)) continue
    const sessionId = file.slice(0, -'.md'.length)
    let content: string | null
    try {
      content = await readEpisodePage(join(dir, file))
    } catch {
      // One unreadable page must not take the brief down with it.
      continue
    }
    if (content === null) continue
    blocks.push(...parseEpisodeBlocks(content, sessionId))
  }
  return blocks
}

/**
 * The episode rows the panel draws, newest first by the brief's own rule.
 *
 * Read-only rows rather than pages: an episode is an artifact of a turn, not text a user edits, so
 * there is no write and no revision behind one. A page that cannot be read is skipped for the reason
 * one unreadable canonical page is skipped — the panel is a view, and a missing row is a smaller
 * problem than a panel that fails.
 */
export async function listMemoryEpisodes(userDataPath: string, rootPath: string): Promise<MemoryEpisodeRow[]> {
  const root = memoryRoot(userDataPath, rootPath)
  return (await readAllEpisodeBlocks(root)).map(episodeRowFromBlock).sort(compareEpisodes)
}

/**
 * Remove one session's episode pages, across every project, and report how many were removed.
 *
 * Every project rather than the session's current one: a conversation moved between folders keeps the
 * page it captured under the folder it worked in, and a delete that only looked at the last folder
 * would strand the rest for the startup sweep.
 */
export async function deleteEpisodePagesForSession(userDataPath: string, sessionId: string): Promise<number> {
  if (!EPISODE_SESSION_ID_PATTERN.test(sessionId)) return 0

  const memoryDir = join(userDataPath, MEMORY_FOLDER)
  let keys: string[]
  try {
    keys = await readdir(memoryDir)
  } catch {
    return 0
  }

  let deleted = 0
  for (const key of keys) {
    if (!PROJECT_KEY_PATTERN.test(key)) continue
    try {
      await unlink(join(memoryDir, key, EPISODE_PAGE_DIR, `${sessionId}.md`))
      deleted++
    } catch {
      // Absent is the ordinary case: most projects never captured this session.
    }
  }
  return deleted
}

/**
 * Clear episode pages whose session metadata is gone, and report how many were removed.
 *
 * The startup half of retention, beside the transcript sweep and for the same reason: deleting a
 * session removes its metadata first, so a failed page delete would strand bytes nothing references
 * again. Each file is removed independently — one locked page must not stop the rest of the sweep.
 */
export async function sweepOrphanedEpisodePages(userDataPath: string, liveSessionIds: string[]): Promise<number> {
  const memoryDir = join(userDataPath, MEMORY_FOLDER)
  let keys: string[]
  try {
    keys = await readdir(memoryDir)
  } catch {
    return 0
  }

  const live = new Set(liveSessionIds)
  let deleted = 0
  for (const key of keys) {
    if (!PROJECT_KEY_PATTERN.test(key)) continue
    const dir = join(memoryDir, key, EPISODE_PAGE_DIR)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!isEpisodePageFile(file)) continue
      const id = file.slice(0, -'.md'.length)
      if (live.has(id)) continue
      try {
        await unlink(join(dir, file))
        deleted++
      } catch {
        // Left for the next startup rather than raised: one undeletable page must not block the rest.
      }
    }
  }
  return deleted
}

/** Whether capture is switched on, read through the source the router installs. */
let episodesEnabledSource: (() => boolean) | null = null

/** Install the consent read, or clear it with null. Called once, by the router. */
export function setEpisodesEnabledSource(next: (() => boolean) | null): void {
  episodesEnabledSource = next
}

/** The folder a conversation belongs to, read through the source the router installs. */
let sessionRootSource: ((sessionId: string) => string | null) | null = null

/** Install the project read, or clear it with null. Called once, by the router. */
export function setSessionRootSource(next: ((sessionId: string) => string | null) | null): void {
  sessionRootSource = next
}

/**
 * Capture the completed turn a transcript save just wrote, or do nothing.
 *
 * Fire-and-forget, and quiet by construction: every path that cannot capture — consent off, a
 * conversation with no project, no completed answer — is an ordinary no-op, and a genuine failure is
 * one bounded warning carrying the error's code. Nothing here throws, so nothing can fail the save or
 * the turn it rode in on; nothing here is branched on by a caller, so a store read that fails is
 * reported and otherwise ignored.
 *
 * The turn id comes from the snapshot rather than from the save's own payload: the payload is the
 * transcript's shape and stays exactly as it was, and the last answer on the checked-out trail is the
 * turn a turn-end save is about.
 */
export async function captureEpisode(sessionId: string, snapshot: TranscriptSnapshot): Promise<void> {
  try {
    if (episodesEnabledSource?.() !== true) return
    const rootPath = sessionRootSource?.(sessionId) ?? null
    if (!rootPath) return
    const turnId = latestEpisodeTurnId(snapshot)
    if (turnId === null) return

    const episode = extractEpisode(sessionId, snapshot, turnId, Date.now())
    if (episode === null) return

    await appendEpisodePage(app.getPath('userData'), rootPath, episode, app.getPath('home'))
  } catch (error) {
    const code = error instanceof ConveyorError ? error.code : 'EPISODE_CAPTURE_FAILED'
    console.warn(`[memory] episode capture skipped (${code})`)
  }
}
