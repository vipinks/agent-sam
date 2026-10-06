import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { ENGINE_PERMISSION_MODE_IDS, type StoredEnginePreference } from '../protocol/engine'

/**
 * The engine preferences: where each engine's binary is, and what it is allowed to do.
 *
 * A store rather than the renderer-local preferences in `app/components/workbench/store.ts`, and the reason
 * is who reads them. Both values are consumed by *main*: the probe resolves the binary before it starts
 * anything, and the launch arguments are built there, in the process that hands an OS a command line. Main
 * cannot read a renderer's `localStorage`, so these are cross-window state — the renderer mirrors them to
 * draw the section, and the file they persist to is the store's own, so a preference is never written into a
 * session record or a transcript.
 *
 * Both fields are optional per engine on purpose. The state holds what a user has set and nothing else: an
 * engine nobody has touched has no record at all, and readers go through `enginePreference` in
 * `protocol/engine.ts` to get the shipped defaults. That keeps the default in one place — a store that
 * stamped `workspace-write` onto every engine at startup would be a second place the default is stated, and
 * the two would drift the first time it changed.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it, the
 * renderer mirrors it through `useConveyorStore`, and the modes it accepts come from the protocol's own list
 * so the schema and the flag an OS is handed cannot disagree.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot
// name the state type fails to emit (TS4023).
export interface EnginePreferencesState {
  /** One record per engine a user has set something for. Absent means nothing has been set. */
  engines: Record<string, StoredEnginePreference>
}

export const enginePreferencesStore = defineStore('engine-preferences', {
  state: { engines: {} } as EnginePreferencesState,

  // Payloads cross the trust boundary, so each action's argument type comes from its schema — and the mode's
  // schema is a real gate rather than a restatement: a mode no rule offers is refused here, before it is
  // stored, so the flag an OS is handed can only ever be one of the traced three.
  schemas: {
    setPermissionMode: z.object({
      engineId: z.string().min(1),
      mode: z.enum([...ENGINE_PERMISSION_MODE_IDS]),
    }),
    recordBinaryPath: z.object({ engineId: z.string().min(1), path: z.string().min(1) }),
    clearBinaryPath: z.object({ engineId: z.string().min(1) }),
  },

  actions: {
    /**
     * Choose the mode one engine runs under.
     *
     * Read by main when a turn is started, which is what makes the choice reach the arguments rather than
     * only the screen: the section writes it here and nothing else has to be told about it.
     */
    setPermissionMode: (state, { engineId, mode }) => {
      state.engines[engineId] = { ...state.engines[engineId], permissionMode: mode }
    },

    /**
     * Keep the absolute path a probe has already run.
     *
     * Written by main's save, never by the field: the field's value is a draft, and a path is a preference
     * only once something has executed it. Storing a draft would make the next turn run a binary nobody
     * checked — which is the one thing the allowlist exists to prevent.
     */
    recordBinaryPath: (state, { engineId, path }) => {
      state.engines[engineId] = { ...state.engines[engineId], binaryPath: path }
    },

    /**
     * Put the allowlist back in charge of one engine.
     *
     * An absence rather than an empty string, because that is what the resolution reads: a blank path is not
     * a location, and the picker's state after clearing has to be the state of a machine that never set one.
     */
    clearBinaryPath: (state, { engineId }) => {
      state.engines[engineId] = { ...state.engines[engineId], binaryPath: null }
    },
  },

  persist: true,
})
