import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { appendCustom, newProviderId, validateProviderDraft, type CustomProvider } from '../protocol/custom-provider'

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
  /**
   * Providers the user added, in the order they added them.
   *
   * Beside the predefined ones rather than among them: `providers` above is keyed by id and holds only
   * what the user chose for a provider that ships with the app, while this is the list of providers
   * that exist because someone typed a base URL. A `Record` would lose the creation order the list UI
   * reads in, and an array cannot collide with a predefined id.
   *
   * `apiKey` is part of the descriptor and is always empty *here*: this state is mirrored to every
   * window, so a credential written into it would be a credential in the renderer. The key a turn runs
   * with is resolved in main and handed to the loop there, which is also the only place it is used.
   */
  customProviders: CustomProvider[]
}

const modelSchema = z.object({ id: z.string(), name: z.string().optional() })

export const providerConfigStore = defineStore('provider-config', {
  state: { providers: {}, customProviders: [] } as ProviderConfigState,

  // Payloads cross the trust boundary, so every action's argument type comes from its schema. The
  // custom-provider payloads carry no key: a descriptor's credential never crosses this boundary in
  // either direction, and the schema is the gate rather than a convention.
  schemas: {
    toggleModel: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
    setFetchedModels: z.object({ providerId: z.string().min(1), models: z.array(modelSchema) }),
    setEnabledModels: z.object({ providerId: z.string().min(1), modelIds: z.array(z.string()) }),
    addCustomProvider: z.object({ name: z.string().min(1), baseUrl: z.string().min(1) }),
    removeCustomProvider: z.object({ id: z.string().min(1) }),
    setCustomProviderModels: z.object({ id: z.string().min(1), models: z.array(z.string().min(1)) }),
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

    /**
     * Add a provider the user typed a base URL for.
     *
     * The rules live in `protocol/custom-provider` and are applied here rather than trusted from the
     * form, because this is the side that owns the list the name has to be unique against. A draft the
     * rules refuse changes nothing: an action cannot return an error, so the two outcomes are "the list
     * grew" and "the list is what it was", and the renderer validates the same draft before sending it
     * so a refusal is explainable there.
     *
     * The payload carries no key, which is why the descriptor is built with an empty one: what a turn
     * runs with is resolved in main from the credentials settings owns, and this slice is mirrored to
     * every window.
     */
    addCustomProvider: (state, { name, baseUrl }) => {
      const check = validateProviderDraft(
        { name, baseUrl, apiKey: '' },
        state.customProviders.map((p) => p.name)
      )
      if (!check.ok) return

      const id = newProviderId(
        check.draft.name,
        state.customProviders.map((p) => p.id)
      )
      state.customProviders = appendCustom(state.customProviders, {
        id,
        name: check.draft.name,
        baseUrl: check.draft.baseUrl,
        apiKey: check.draft.apiKey,
      })
    },

    /**
     * Remove a provider by id. Removing one that is not there is not an error: the list the caller
     * asked for is the list it has.
     */
    removeCustomProvider: (state, { id }) => {
      state.customProviders = state.customProviders.filter((p) => p.id !== id)
    },

    /**
     * Replace one provider's catalogue by id.
     *
     * Replaced rather than merged, because a catalogue is what the provider says it offers: a model no
     * longer listed is no longer offered, and keeping it would leave the dropdown pointing at something
     * that cannot answer.
     */
    setCustomProviderModels: (state, { id, models }) => {
      state.customProviders = state.customProviders.map((p) => (p.id === id ? { ...p, models: [...models] } : p))
    },
  },

  persist: true,
})
