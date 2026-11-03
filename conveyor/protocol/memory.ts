import { z } from 'zod'

/**
 * Memory — the project's standing notes, indexed and injected into the turn start.
 *
 * Slice 1 ships the pure rules only: the tokenizer and inverted index, the sanitizer, the import
 * fan-out, and the brief planner. All of it is free of electron and fs so the suites pin it directly
 * and the renderer imports the types and schemas without pulling main in.
 *
 * Placeholder bodies: the red pins import these seams; the product turn fills them in.
 */

export type MemoryPageId = 'handoff' | 'decisions' | 'parked' | 'quirks'

export const MEMORY_PAGES: readonly MemoryPageId[] = ['handoff', 'decisions', 'parked', 'quirks']

export const MEMORY_PAGE_FILES: Record<MemoryPageId, string> = {
  handoff: 'handoff.md',
  decisions: 'decisions.md',
  parked: 'parked.md',
  quirks: 'quirks.md',
}

export const MEMORY_INDEX_FILE = 'index.json'

export const MAX_MEMORY_BRIEF_BYTES = 8192

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

export type MemoryIndex = Record<string, Array<{ page: MemoryPageId; positions: number[] }>>

export function tokenize(_text: string): string[] {
  return []
}

export function buildIndex(_pages: Record<MemoryPageId, string>): MemoryIndex {
  return {}
}

export function searchPages(
  _pages: Record<MemoryPageId, string>,
  _term: string
): MemorySearchResult[] {
  return []
}

export function sanitize(text: string, _homeDir: string): string {
  return text
}

export function fanOutImport(_markdown: string): Partial<Record<MemoryPageId, string>> {
  return {}
}

export interface MemoryBriefSource {
  handoff: string
  vetoes: string
  decisions: string
  quirks: string
}

export function splitDecisions(decisionsText: string): { vetoes: string; decisions: string } {
  return { vetoes: '', decisions: decisionsText }
}

export function assembleMemorySection(_source: MemoryBriefSource): { content: string } | null {
  return null
}

export function planMemoryInjection(
  _messages: ReadonlyArray<{ role: string; content?: unknown }>,
  _brief: string | null
): { content: string } | null {
  return null
}

export function shouldRebuildIndex(_recordedMtime: number | null, _currentMtime: number): boolean {
  return false
}
