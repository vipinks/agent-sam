import { create } from 'zustand'
import { conveyor } from '@/conveyor/client'
import { deriveRunningServers, type McpRunningServer } from '../protocol/mcp-settings'

/**
 * The settings surface's mirror of the MCP reads.
 *
 * Main owns every fact here: the two config files, the trust records, and the running processes. This
 * holds the last answer, so a section can draw a list before it has asked again and can redraw the whole
 * board after an action without every row making its own call. Nothing in it is a source of truth — an
 * entry that disagrees with main is simply stale, and the next refresh replaces it.
 *
 * Refreshed rather than watched. A mutation's answer is what changed, and the row that made it refreshes
 * beside the action that did it; there is no interval and no subscription, because a process list that
 * redraws itself on a timer is a screen that moves while nobody is looking at it. The section also
 * refreshes when it opens, which is the one moment the mirror can be arbitrarily old — the surface is
 * unmounted while it is not on screen.
 *
 * Types come from the client's own members rather than from `modules/mcp.ts`. The renderer imports only
 * `type AppRouter` (see CLAUDE.md), so the shape of a listing is read off the procedure that returns it
 * — where it is declared once, and where a change to it is a change this file cannot miss.
 */
export type McpServerListing = Awaited<ReturnType<typeof conveyor.mcp.listServers>>['user'][number]
export type McpListingError = Awaited<ReturnType<typeof conveyor.mcp.listServers>>['errors'][number]
export type McpRunningTool = Awaited<ReturnType<typeof conveyor.mcp.listRunningTools>>[number]

/** Everything one visit to the settings surface needs, as of the last refresh. */
export interface McpServersState {
  /** True until the first answer arrives. Distinct from an empty list, which is an answer. */
  loading: boolean
  /** Both scopes as main last reported them, or null before the first refresh. */
  listing: {
    user: McpServerListing[]
    project: McpServerListing[]
    /** What either file refused to load. Reported per file and per record, by main. */
    errors: McpListingError[]
  } | null
  /** The servers that are running, derived from the live tool list. */
  running: McpRunningServer[]
  /**
   * Why the last refresh failed, or null.
   *
   * Kept as the raw rejection rather than a sentence: what a failed read means is the section's to say,
   * and the code it branches on travels inside this value.
   */
  error: unknown
  /**
   * Ask main again, for the folder that is open.
   *
   * `rootPath` is passed in rather than read from the workspace store, because a store mirror is a hook
   * and this must stay callable from an action handler and from a suite. A null root means no project
   * scope to read, which main answers with an empty project list rather than a failure.
   */
  refresh: (rootPath: string | null) => Promise<void>
}

/**
 * The two reads as one refresh.
 *
 * Both, always: a server that was just started has to show as running in the same paint that shows it,
 * and a refresh that asked only about the files would leave the running column a step behind every
 * action. `Promise.all` rather than two awaits, so a caller awaiting this gets a settled board.
 *
 * The tools read takes no input — the running set is a fact about this process, not about a folder —
 * which is why it does not travel with the root path.
 */
export const useMcpServersStore = create<McpServersState>((set) => ({
  loading: true,
  listing: null,
  running: [],
  error: null,
  refresh: async (rootPath) => {
    set({ loading: true })
    try {
      const [listing, tools] = await Promise.all([
        conveyor.mcp.listServers({ rootPath }),
        conveyor.mcp.listRunningTools(),
      ])
      set({
        loading: false,
        listing: { user: listing.user, project: listing.project, errors: listing.errors },
        running: deriveRunningServers(tools),
        error: null,
      })
    } catch (error) {
      // The previous answer is kept rather than cleared. A read that failed tells the reader nothing
      // about what is on disk, and throwing away the last good listing would turn one failed call into
      // a screen that claims there are no servers at all.
      set({ loading: false, error })
    }
  },
}))
