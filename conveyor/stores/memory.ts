import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { memoryPageIdSchema, type MemoryPageSummary } from '../protocol/memory'

/**
 * The memory panel's durable view state: the four canonical pages and what the disk knows about each —
 * whether it exists and how many prior revisions it retains.
 *
 * Main owns the disk, so main owns this mirror: it writes it through `setMemoryPagesSink` after every
 * mutation and on the folder open at launch, and every window mirrors the same four summaries. Nothing
 * here is a source of truth — an entry that disagrees with the disk is simply stale until the next
 * write or refresh replaces it. The panel's ephemeral state (which page is open, the search term, the
 * edit buffer) stays in the component; this holds only the view that outlives a dock.
 *
 * Pure (no electron, no react) because both processes import it: main registers it as the source of
 * truth, and the renderer mirrors it through `useConveyorStore`.
 */

export interface MemoryState {
  /** The four canonical pages, in fixed order, with existence and revision counts. */
  pages: MemoryPageSummary[]
}

export const memoryStore = defineStore('memory', {
  state: { pages: [] } as MemoryState,

  schemas: {
    setPages: z.object({
      pages: z.array(
        z.object({
          page: memoryPageIdSchema,
          exists: z.boolean(),
          revisions: z.number().int().nonnegative(),
        })
      ),
    }),
  },

  actions: {
    setPages: (state, { pages }) => {
      state.pages = pages
    },
  },

  persist: true,
})
