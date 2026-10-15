import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'

/**
 * The model catalogue each engine's last session advertised, mirrored to every window.
 *
 * Main's state rather than a read the renderer performs, and for the same reason the probed rows next door are:
 * the only way to read an engine's catalogue is to open a session with it, which is a process. A renderer-side
 * read would put that spawn behind whichever window happened to open the control, and a second read would be a
 * second session opened to answer a question the first one already answered.
 *
 * The catalogue is the engine's own advertisement, arriving on the `session/new` that opens a turn — so the entry
 * for an engine is written by the turn that observed it, and an engine whose session has never been opened has
 * no entry. That absence is the honest state: a control offering ids nobody has read would be offering a guess.
 *
 * Deliberately not persisted. It is what the engine said at one moment, and a copy restored from yesterday's file
 * would be a list of models a CLI release may since have retired.
 *
 * The definition is pure (no electron, no react) because both processes import it: main writes the entries, the
 * renderer mirrors them through `useConveyorStore`.
 */

/**
 * What one engine advertised: the ids it offers, and the model its session was already running.
 *
 * `currentModelId` is kept beside the list rather than merged into it, because the two answer different
 * questions: the list is what the engine offers, and the current model is what it is doing now. A session's
 * current model need not appear among the entries it advertises — the Phase 82 probe recorded exactly that for
 * OpenCode — so merging them would put an id in a "chosen from" list that the engine never offered.
 */
export interface EngineModelCatalogue {
  ids: string[]
  currentModelId: string | null
}

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot name
// the state type fails to emit (TS4023).
export interface EngineModelsState {
  /** One entry per engine whose session has been opened, keyed by engine id. Absent means never read. */
  catalogues: Record<string, EngineModelCatalogue>
}

/** The catalogue, as the schema sees it: the ids, and the current model when the session named one. */
const catalogueSchema = z.object({
  ids: z.array(z.string().min(1)),
  currentModelId: z.string().min(1).nullable(),
})

export const engineModelsStore = defineStore('engine-models', {
  state: { catalogues: {} } as EngineModelsState,

  // Payloads cross the trust boundary, so the action's argument type comes from its schema. An engine id is
  // required because a catalogue nobody advertised belongs to no one; the ids array may be empty, because an
  // engine that advertises an empty list has said something this app records rather than something it drops.
  schemas: {
    record: z.object({
      engineId: z.string().min(1),
      catalogue: catalogueSchema,
    }),
  },

  actions: {
    /**
     * Record what one engine's session advertised.
     *
     * One engine at a time, with the others left as they stand: two engines are two advertisements, and a write
     * that replaced the whole map would clear a catalogue the other engine had already answered with.
     */
    record: (state, { engineId, catalogue }) => {
      state.catalogues = { ...state.catalogues, [engineId]: catalogue }
    },
  },
})
