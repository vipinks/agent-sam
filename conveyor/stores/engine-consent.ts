import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import type { PendingEngineConsent } from '../protocol/engine'

/**
 * The engine question waiting on the user, mirrored to every window.
 *
 * Deliberately not persisted, and it is the second store in this app that is not — the updater's status is
 * the first, and for the same kind of reason. A pending question is a fact about a running process: the engine
 * that asked is mid-turn and holding a promise, and a question restored from disk after a restart would be a
 * card whose buttons answer a process that no longer exists. The transcript's own pause is reconciled away for
 * exactly this reason when a conversation is read back; this store never writes the state that would need it.
 *
 * One question at a time, and a slot rather than a list. An engine asks about one call before it makes it, so
 * a queue would be a queue that cannot fill: a second question can only arrive after the first is answered,
 * because the agent is waiting on that answer to continue. Holding a list would be holding a shape the
 * protocol cannot produce.
 *
 * The definition is pure — no electron, no react — because both processes import it: main registers it and
 * dispatches the questions, the renderer mirrors it through `useConveyorStore`.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot
// name the state type fails to emit (TS4023).
export interface EngineConsentState {
  /** The question on the shield, or null when no engine is asking anything. */
  pending: PendingEngineConsent | null
}

/** The option shape, as the schema sees it: the kinds come from the protocol and are not re-listed here. */
const optionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string(),
  kind: z.string(),
})

export const engineConsentStore = defineStore('engine-consent', {
  state: { pending: null } as EngineConsentState,

  // Payloads cross the trust boundary, so each action's argument type comes from its schema: a question
  // without a request id could not be answered, and one without options could not be put.
  schemas: {
    request: z.object({
      requestId: z.string().min(1),
      engineId: z.string().min(1),
      engineName: z.string().min(1),
      toolCallId: z.string(),
      title: z.string(),
      options: z.array(optionSchema),
    }),
    clear: z.object({ requestId: z.string().min(1) }),
  },

  actions: {
    /**
     * Put one engine's question on the shield.
     *
     * Replaces whatever was there rather than refusing: the agent asking is the only speaker, and its next
     * question cannot arrive before the last one was answered — so a slot that already held something held a
     * question whose answer has been sent, and clearing it is this dispatch's own job.
     */
    request: (state, consent) => {
      state.pending = consent
    },

    /**
     * Take the question off the shield, by the id that put it there.
     *
     * By id rather than unconditionally, because an answer and a question can cross: an engine that was
     * closed while its question was on screen clears the question it asked, and a later question from a new
     * session must not be cleared by that stale removal.
     */
    clear: (state, { requestId }) => {
      if (state.pending !== null && state.pending.requestId !== requestId) return
      state.pending = null
    },
  },
})
