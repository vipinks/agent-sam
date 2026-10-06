import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { DEFAULT_AUTO_DOWNLOAD } from '../protocol/updates'

/**
 * The one auto-update preference a user owns: whether a found update is fetched without being asked.
 *
 * A store rather than a renderer-local key, for the reason the terminal's and the appearance section's are
 * one process over: this is a *preference*, and a preference belongs to the app rather than to one window.
 * The updater runs in main, and main cannot read a window's `localStorage` — so the value has to live where
 * main can read it, be written to the store's own file rather than into a session record, and survive a
 * restart, because an update discovered yesterday and still downloading should not be forgotten overnight.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it, the
 * renderer mirrors it through `useConveyorStore`, and the default comes from `protocol/updates` so the value
 * a fresh install starts from is the same value the module falls back to when nothing has said otherwise.
 *
 * No behaviour lives here. The updater reads this store through a function installed by the router, and a
 * store that reached for the updater itself would put a main-process side effect in a reducer — where the
 * next reader of the state would not see it.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot
// name the state type fails to emit (TS4023).
export interface UpdatePreferencesState {
  /** Whether a found update is downloaded without the user asking. Read by the updater before each check. */
  autoDownload: boolean
}

export const updatePreferencesStore = defineStore('update-preferences', {
  state: {
    autoDownload: DEFAULT_AUTO_DOWNLOAD,
  } as UpdatePreferencesState,

  // Payloads cross the trust boundary, so the action's argument type comes from its schema — and the schema
  // is where a caller that skipped the field is refused rather than merely restated, so the switch cannot
  // be stored as anything but a boolean.
  schemas: {
    setAutoDownload: z.object({ autoDownload: z.boolean() }),
  },

  actions: {
    /**
     * Set whether a found update is fetched without being asked.
     *
     * Read by the updater as it applies its settings before a check, so flipping it off governs the next
     * check rather than the one already in flight: a check is the moment the decision is made, and a
     * download that has started is not something this preference can undo.
     */
    setAutoDownload: (state, { autoDownload }) => {
      state.autoDownload = autoDownload
    },
  },

  persist: true,
})
