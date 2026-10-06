import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { engineRows, type EngineRow } from '../protocol/engine'

/**
 * What the last probe found about each engine, mirrored to every window.
 *
 * Main's state rather than a read the renderer performs, because that is what this is: whether a binary is
 * installed is a fact about the machine, discovered once by main through the spawn law, and every window
 * should show the same answer. A renderer-side read would make each window ask separately — several probes
 * for one fact — and would put the spawn behind a control that may never be opened.
 *
 * Deliberately not persisted. It is a fact about this machine's disk at the moment it was read, and a copy
 * restored from yesterday's file would be a picker offering an engine that has since been uninstalled. The
 * initial state is the honest empty answer — every engine drawn as not installed — which is also what the
 * picker shows for the moment before main's first probe lands.
 *
 * The definition is pure (no electron, no react) because both processes import it: main writes the rows, the
 * renderer mirrors them through `useConveyorStore`.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot
// name the state type fails to emit (TS4023).
export interface EngineStatusState {
  /** One row per known engine, the app's own row first. Never empty: the un-probed list is the initial one. */
  rows: EngineRow[]
}

/** The row shape, as the schema sees it: `id` null is the app's own row, which is not an engine. */
const rowSchema = z.object({
  id: z.string().min(1).nullable(),
  name: z.string().min(1),
  installed: z.boolean(),
  version: z.string().nullable(),
  note: z.string().nullable(),
})

export const engineStatusStore = defineStore('engine-status', {
  state: { rows: engineRows({}) } as EngineStatusState,

  // Payloads cross the trust boundary, so the action's argument type comes from its schema: a row without a
  // name could not be drawn, and one without its own `installed` flag could not say whether it may be picked.
  schemas: {
    record: z.object({ rows: z.array(rowSchema).min(1) }),
  },

  actions: {
    /**
     * Record what a probe found.
     *
     * The whole list at once rather than one engine at a time: the rows are read together, and a partial update
     * would leave the picker showing a list that was true at two different moments.
     */
    record: (state, { rows }) => {
      state.rows = rows
    },
  },
})
