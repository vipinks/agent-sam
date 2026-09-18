import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'

/**
 * Per-provider model choices: which models a provider offers, and which of those the user has
 * switched on.
 *
 * `fetchedModels` is a cache, not a truth — it is whatever the provider last answered, kept so
 * Settings can render the list before another fetch. `enabledModels` is the user's intent and the
 * only thing the chat dropdown reads from.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers
 * it as the source of truth, and the renderer mirrors it through `useConveyorStore`.
 */
export interface ProviderConfig {
  /** Models the user has switched on, in the order they were enabled. */
  enabledModels: string[]
  /** Last fetched catalogue, cached for display. */
  fetchedModels: Array<{ id: string; name?: string }>
}

// Exported, not just local: the router's inferred type references this store, and a declaration
// that cannot name the state type fails to emit (TS4023).
export interface ProviderConfigState {
  providers: Record<string, ProviderConfig>
}

const modelSchema = z.object({ id: z.string(), name: z.string().optional() })

export const providerConfigStore = defineStore('provider-config', {
  state: { providers: {} } as ProviderConfigState,

  // Payloads cross the trust boundary, so every action's argument type comes from its schema.
  schemas: {
    toggleModel: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
    setFetchedModels: z.object({ providerId: z.string().min(1), models: z.array(modelSchema) }),
    setEnabledModels: z.object({ providerId: z.string().min(1), modelIds: z.array(z.string()) }),
  },

  actions: {
    /** Switch one model on or off. Auto-saved: `persist` writes the whole store on every change. */
    toggleModel: (state, { providerId, modelId }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      const enabled = current.enabledModels.includes(modelId)
      state.providers[providerId] = {
        ...current,
        enabledModels: enabled
          ? current.enabledModels.filter((id) => id !== modelId)
          : [...current.enabledModels, modelId],
      }
    },

    /**
     * Record a fetched catalogue. Enabling is left alone: a refresh must not silently change what
     * the user has switched on, though any enabled id the provider no longer lists is dropped so
     * the chat dropdown cannot offer a model that no longer exists.
     */
    setFetchedModels: (state, { providerId, models }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      const available = new Set(models.map((m) => m.id))
      state.providers[providerId] = {
        fetchedModels: models,
        enabledModels: current.enabledModels.filter((id) => available.has(id)),
      }
    },

    /** Replace the enabled set outright — used when a provider is cleared. */
    setEnabledModels: (state, { providerId, modelIds }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      state.providers[providerId] = { ...current, enabledModels: modelIds }
    },
  },

  persist: true,
})
