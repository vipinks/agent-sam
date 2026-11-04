import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { memoryEpisodeRowSchema, type MemoryEpisodeRow } from '../protocol/episodes'
import { memoryPageIdSchema, type MemoryPageSummary } from '../protocol/memory'

/**
 * The memory panel's durable view state: the four canonical pages and what the disk knows about each —
 * whether it exists and how many prior revisions it retains — plus the captured episodes the brief
 * previews and the setting that decides whether capture runs at all.
 *
 * Main owns the disk, so main owns this mirror: it writes the page list through `setMemoryPagesSink`
 * after every mutation and on the folder open at launch, the episode rows through
 * `setMemoryEpisodesSink` at the same two moments, and every window mirrors the same view. Nothing
 * here is a source of truth — an entry that disagrees with the disk is simply stale until the next
 * write or refresh replaces it. The panel's ephemeral state (which page is open, the search term, the
 * edit buffer) stays in the component; this holds only the view that outlives a dock.
 *
 * `episodesEnabled` is the exception, and deliberately: it is a setting rather than a mirror of the
 * disk. Main reads it through `setEpisodesEnabledSource` at every save, so the switch a user flips
 * governs the next capture without a second IPC payload crossing the boundary.
 *
 * Pure (no electron, no react) because both processes import it: main registers it as the source of
 * truth, and the renderer mirrors it through `useConveyorStore`.
 */

export interface MemoryState {
  /** The four canonical pages, in fixed order, with existence and revision counts. */
  pages: MemoryPageSummary[]
  /** The captured episodes the panel previews, newest first by the brief's own rule. */
  episodes: MemoryEpisodeRow[]
  /**
   * Whether completed turns are captured into episodes. On by default: capture is local, append-only,
   * sanitized and bounded, and never edits a canonical page — the honest tradeoff is that a project's
   * questions reach the provider inside the brief, which the ruling accepted.
   */
  episodesEnabled: boolean
}

export const memoryStore = defineStore('memory', {
  state: { pages: [], episodes: [], episodesEnabled: true } as MemoryState,

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
    setEpisodes: z.object({ episodes: z.array(memoryEpisodeRowSchema) }),
    setEpisodesEnabled: z.object({ enabled: z.boolean() }),
  },

  actions: {
    setPages: (state, { pages }) => {
      state.pages = pages
    },
    setEpisodes: (state, { episodes }) => {
      state.episodes = episodes
    },
    setEpisodesEnabled: (state, { enabled }) => {
      state.episodesEnabled = enabled
    },
  },

  persist: true,
})
