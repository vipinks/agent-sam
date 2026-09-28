import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT } from '../protocol/context-window'

/**
 * How much of a model's window this app is willing to fill before it calls the conversation compact.
 *
 * A store rather than a renderer-local preference key, for the reason the terminal's two are: the point
 * is read by *main*, which measures a request as it builds it — and main cannot read a window's
 * `localStorage`. One cross-window store is the one shape both processes can hold, and the persisted
 * file is the store's own, so a preference is never written into a session record: a preference is not a
 * fact about a conversation.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it,
 * the renderer mirrors it through `useConveyorStore`, and the bounds come from
 * `protocol/context-window` so the Settings field's rule and this store's gate cannot disagree.
 *
 * No behaviour lives here: this turn stores the preference and nothing acts on it. Compaction is a
 * later turn's subject, and a store that reached for the window on its own would be that turn's
 * decision made early and in the wrong place.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that
// cannot name the state type fails to emit (TS4023).
export interface ContextPreferencesState {
  /** The share of a model's window, as a whole percent, at which a conversation is considered full. */
  compactPoint: number
}

export const contextPreferencesStore = defineStore('context-preferences', {
  state: {
    compactPoint: DEFAULT_COMPACT_PERCENT,
  } as ContextPreferencesState,

  // Payloads cross the trust boundary, so the action's argument type comes from its schema — and the
  // schema is where the bounds are enforced rather than merely restated, so a caller that skipped the
  // field cannot store a percent the field would have refused.
  schemas: {
    setCompactPoint: z.object({
      percent: z.number().int().min(MIN_COMPACT_PERCENT).max(MAX_COMPACT_PERCENT),
    }),
  },

  actions: {
    /**
     * Set the share of the window at which a conversation is considered full.
     *
     * Read by whoever measures a request against a window, which is main — and read as a percent rather
     * than as a token count, because the count depends on the model and the percent does not: one
     * preference has to mean seventy percent of a 64k model and of a 200k one.
     */
    setCompactPoint: (state, { percent }) => {
      state.compactPoint = percent
    },
  },

  persist: true,
})
