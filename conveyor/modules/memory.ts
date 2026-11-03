import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineModule } from '../init'
import type { MemoryPageSummary, MemorySearchResult } from '../protocol/memory'

/**
 * Memory — main-only filesystem access, and the turn-start brief.
 *
 * Slice 1 ships the seams: the project-key layout, the index ensure step, the page writes, the import
 * fan-out, and the brief resolver. Placeholder bodies for the red pins; the product turn fills them in.
 */

export function projectKeyFor(_rootPath: string): string {
  return ''
}

export function memoryRoot(_appDataPath: string, _rootPath: string): string {
  return join(tmpdir(), 'sam-memory-stub')
}

export async function resolveMemoryBrief(
  _workspaceRoot: string | null,
  _appDataPath: string
): Promise<{ content: string } | null> {
  return null
}

export async function ensureMemoryIndex(
  _appDataPath: string,
  _rootPath: string
): Promise<{ rebuilt: boolean }> {
  return { rebuilt: false }
}

export async function writeMemoryPage(
  _appDataPath: string,
  _rootPath: string,
  _page: MemoryPageSummary['page'],
  _content: string
): Promise<MemoryPageSummary> {
  return { page: 'handoff', exists: false, revisions: 0 }
}

export async function readMemoryPage(): Promise<{ content: string; revisions: number } | null> {
  return null
}

export async function restoreMemoryPage(): Promise<{ content: string; revisions: number }> {
  return { content: '', revisions: 0 }
}

export async function importMemoryHandoff(): Promise<MemoryPageSummary[]> {
  return []
}

export async function listMemoryPages(): Promise<MemoryPageSummary[]> {
  return []
}

export async function searchMemoryPages(): Promise<MemorySearchResult[]> {
  return []
}

export const memoryModule = defineModule({})
