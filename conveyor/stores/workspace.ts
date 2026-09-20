import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { forgetRoot as forgetRecentRoot, rememberRoot as rememberRecentRoot } from '../protocol/recent-roots'

/**
 * The folder the explorer is browsing, and the folders it was browsing recently. It is the single
 * source of truth for "which workspace is open", so main owns it and every window sees the same
 * folder. `persist` survives restarts, which is the whole point: reopening the app lands on the folder
 * you were last working in — and the recents list is what makes the folders *before* that one a click
 * away rather than a walk through the file dialog.
 *
 * Recents live here rather than in a store of their own because they are the same subject as the open
 * root: they are the same folders, and a switch and a remember are one event. Two stores would need a
 * rule for what happens when one changes and the other does not.
 *
 * The definition is pure (no electron, no react) because both processes import it — main registers
 * it as the source of truth, the renderer mirrors it through `useConveyorStore`. The ordering and
 * deduplication rules are not re-implemented here: they are imported from `protocol/recent-roots`,
 * which main and the renderer both read, so the menu and the store cannot disagree about what "the
 * same folder" means.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that
// cannot name the state type fails to emit (TS4023).
export interface WorkspaceState {
  /** The open root, or null when no folder is open. */
  rootPath: string | null
  /**
   * Known roots, most recent first, capped by `MAX_RECENT_ROOTS`.
   *
   * Absolute paths, and resolved by main before they are ever stored — which is what lets the compare
   * be a case-insensitive one and nothing more.
   */
  recentRoots: string[]
}

export const workspaceStore = defineStore('workspace', {
  state: { rootPath: null, recentRoots: [] } as WorkspaceState,

  // Payloads cross the trust boundary, so the action's argument type comes from this schema.
  schemas: {
    setRootPath: z.string().nullable(),
    forgetRoot: z.string().min(1),
  },

  actions: {
    /**
     * Open a folder, and record it as the most recent one.
     *
     * The two are one action because they are one event — the folder the explorer is browsing is by
     * definition the folder that was just opened — and because splitting them would leave a version of
     * the app that opens folders without remembering them, which is the behaviour this replaces.
     *
     * Null (no folder open) clears the root and leaves the list alone: "no folder" is not a folder
     * anyone would want offered back.
     */
    setRootPath: (state, rootPath) => {
      state.rootPath = rootPath
      if (rootPath !== null) state.recentRoots = rememberRecentRoot(state.recentRoots, rootPath)
    },

    /**
     * Drop a folder from the list without switching to it.
     *
     * The open root is deliberately *not* special-cased. Forgetting the folder that is open removes
     * its entry and opens nothing else, which is exactly what the user asked for: the folder stays
     * browsable until they open another one, and it is offered again the moment it is opened.
     */
    forgetRoot: (state, path) => {
      state.recentRoots = forgetRecentRoot(state.recentRoots, path)
    },
  },

  persist: true,
})
