import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, query } from '../init'
import { MAX_FILE_BYTES } from './workspace'
import {
  assembleMemorySection,
  buildIndex,
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
 * and main turns that into `%APPDATA%\era\memory\<project-key>\` — where the project key is a sha256
 * hash of the resolved root, never a raw path segment. Every page write is a temp-then-rename so a
 * reader sees the old bytes or the new ones, never a half-written page, mirroring `saveTranscriptFile`.
 */

/** The `%APPDATA%` folder this app owns, the same one the user's skills and MCP settings live under. */
const MEMORY_ROOT_FOLDER = 'era'
const MEMORY_FOLDER = 'memory'

/** A project key is a sha256 hex digest: 64 lowercase hex chars, never a path segment a caller shaped. */
export const PROJECT_KEY_PATTERN = /^[0-9a-f]{64}$/

/** Hash a resolved workspace root into a project key. */
export function projectKeyFor(rootPath: string): string {
  return createHash('sha256').update(resolve(rootPath)).digest('hex')
}

/** The memory subtree for one workspace: `%APPDATA%\era\memory\<project-key>`. */
export function memoryRoot(appDataPath: string, rootPath: string): string {
  const key = projectKeyFor(rootPath)
  // Shape-checked before it is joined, the way a session id is before it becomes a filename: the key is
  // the one segment that names a directory, and a segment that is not sha256 hex must never be joined.
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new ConveyorError('MEMORY_IO_ERROR', 'The project key did not form a safe path segment.')
  }
  return join(appDataPath, MEMORY_ROOT_FOLDER, MEMORY_FOLDER, key)
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

/** The newest mtime of the four page files, or zero while none exist. */
async function readTreeMtime(root: string): Promise<number> {
  let max = 0
  for (const page of MEMORY_PAGES) {
    try {
      max = Math.max(max, (await stat(pageFilePath(root, page))).mtimeMs)
    } catch {
      // Absent page contributes nothing to the tree.
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
export async function listMemoryPages(appDataPath: string, rootPath: string): Promise<MemoryPageSummary[]> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string,
  rootPath: string,
  page: MemoryPageId
): Promise<{ content: string; revisions: number } | null> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string,
  rootPath: string,
  page: MemoryPageId,
  content: string
): Promise<MemoryPageSummary> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string,
  rootPath: string,
  page: MemoryPageId
): Promise<{ content: string; revisions: number }> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string,
  rootPath: string,
  term: string
): Promise<MemorySearchResult[]> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string,
  rootPath: string,
  markdown: string,
  homeDir: string,
  force = false
): Promise<MemoryPageSummary[]> {
  const root = memoryRoot(appDataPath, rootPath)
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
    await writeMemoryPage(appDataPath, rootPath, page, fanned[page] ?? '')
  }
  return listMemoryPages(appDataPath, rootPath)
}

/**
 * Rebuild the inverted index from the subtree, skipping it when the tree mtime is unchanged.
 *
 * Called at startup and defensively; every mutation already rebuilds the index as part of its write.
 * The skip is the whole point of persisting the index: a launch over an untouched tree reads the index
 * off disk instead of re-tokenising every page.
 */
export async function ensureMemoryIndex(appDataPath: string, rootPath: string): Promise<{ rebuilt: boolean }> {
  const root = memoryRoot(appDataPath, rootPath)
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
  appDataPath: string
): Promise<{ content: string } | null> {
  if (!workspaceRoot) return null

  const root = memoryRoot(appDataPath, workspaceRoot)
  const handoff = (await readPageSafe(root, 'handoff')) ?? ''
  const decisions = (await readPageSafe(root, 'decisions')) ?? ''
  const quirks = (await readPageSafe(root, 'quirks')) ?? ''
  const { vetoes, decisions: recent } = splitDecisions(decisions)

  return assembleMemorySection({ handoff, vetoes, decisions: recent, quirks })
}

/** Installed by the router, after the store exists: mirrors the four page summaries to every window. */
let memoryPagesSink: ((pages: MemoryPageSummary[]) => void) | null = null

/** Install the sink, or clear it with null. Called once, by the router, after the stores exist. */
export function setMemoryPagesSink(next: ((pages: MemoryPageSummary[]) => void) | null): void {
  memoryPagesSink = next
}

/** Seed the store for the folder open at launch, so the panel has a durable view before it is opened. */
export async function refreshMemoryPagesForRoot(rootPath: string | null): Promise<void> {
  if (!rootPath) return
  await ensureMemoryIndex(app.getPath('appData'), rootPath)
  memoryPagesSink?.(await listMemoryPages(app.getPath('appData'), rootPath))
}

export const memoryModule = defineModule({
  /** The four page summaries, for the panel's tab row. The store mirror is refreshed as a side effect. */
  listPages: query(z.object({ rootPath: z.string().min(1) }), async ({ input }) => {
    const pages = await listMemoryPages(app.getPath('appData'), input.rootPath)
    memoryPagesSink?.(pages)
    return pages
  }),

  /** One page's current text, or null while it has never been written. */
  readPage: query(z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema }), async ({ input }) =>
    readMemoryPage(app.getPath('appData'), input.rootPath, input.page)
  ),

  /** Search the pages for a term. A query, because the panel wants it keyed per term while the user types. */
  search: query(z.object({ rootPath: z.string().min(1), term: z.string().min(2) }), async ({ input }) =>
    searchMemoryPages(app.getPath('appData'), input.rootPath, input.term)
  ),

  /** Write a page: create it, or supersede it and retain the prior revision. */
  writePage: command(
    z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema, content: z.string() }),
    async ({ input }) => {
      const summary = await writeMemoryPage(app.getPath('appData'), input.rootPath, input.page, input.content)
      memoryPagesSink?.(await listMemoryPages(app.getPath('appData'), input.rootPath))
      return summary
    }
  ),

  /** Supersede an existing page explicitly. An absent page is refused, unlike `writePage`. */
  supersedePage: command(
    z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema, content: z.string() }),
    async ({ input }) => {
      const prior = await readMemoryPage(app.getPath('appData'), input.rootPath, input.page)
      if (prior === null) {
        throw new ConveyorError('MEMORY_NOT_FOUND', 'There is no page to supersede yet.')
      }
      const summary = await writeMemoryPage(app.getPath('appData'), input.rootPath, input.page, input.content)
      memoryPagesSink?.(await listMemoryPages(app.getPath('appData'), input.rootPath))
      return summary
    }
  ),

  /** Revert a page to its prior revision. `MEMORY_NOT_FOUND` when there is none. */
  restorePage: command(z.object({ rootPath: z.string().min(1), page: memoryPageIdSchema }), async ({ input }) => {
    const result = await restoreMemoryPage(app.getPath('appData'), input.rootPath, input.page)
    memoryPagesSink?.(await listMemoryPages(app.getPath('appData'), input.rootPath))
    return result
  }),

  /** Import a pasted handoff. `force` is only set after a conflict has been shown to the user. */
  importHandoff: command(
    z.object({ rootPath: z.string().min(1), markdown: z.string(), force: z.boolean().optional() }),
    async ({ input }) => {
      const pages = await importMemoryHandoff(
        app.getPath('appData'),
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
