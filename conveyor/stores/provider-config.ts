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
  /**
   * Whether this provider's models take images, as the user declared it.
   *
   * Additive and optional, and the optionality is the point: a record written before this key existed
   * carries no opinion rather than a `false` this store would then be claiming the user had chosen. The
   * gate reads absence as "no" — a provider nobody has said anything about is not one to send an image
   * to — but the record stays silent, so a build that reads the store without knowing this key strips it
   * and writes back what it understood rather than inventing a decision.
   *
   * A declaration rather than a discovery: this app does not ask a provider what it accepts, because a
   * wrong answer would be indistinguishable from a right one until an image was refused, and the person
   * who knows is the one who chose the model.
   */
  supportsImages?: boolean
  /**
   * What this provider charges for input, in dollars per million tokens, as the user declared it.
   *
   * Additive and optional like `supportsImages` beside it, and written only when a user has typed a
   * number: absent means nobody has priced this provider, which is not the same as a price of zero. The
   * pricing rules read the three through `declaredRates`, which refuses a declaration short of a side
   * rather than reading the missing side as free.
   *
   * Dollars rather than the micros `RATES` holds, because this is a field a person fills in from a
   * provider's pricing page that quotes `$0.15 / 1M tokens`.
   */
  inputRate?: number
  /**
   * What this provider charges for a prompt token it served from its own cache, in dollars per million.
   *
   * Its own field because it is its own price: every provider that publishes one publishes it below the
   * input rate, and a session on a warm cache is mostly hits — so a declaration without it would leave
   * the Cost tile charging the whole prompt at the miss rate, which is the overstatement the third field
   * exists to stop rather than to permit.
   */
  cacheHitRate?: number
  /** What this provider charges for output, in dollars per million tokens. */
  outputRate?: number
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
    setSupportsImages: z.object({ providerId: z.string().min(1), supported: z.boolean() }),
    // Every side optional and non-negative, because the three are one declaration a user may be halfway
    // through typing: an omitted side means "not declared", which the action writes by leaving the key
    // off rather than by storing a zero this app would then bill at.
    setRates: z.object({
      providerId: z.string().min(1),
      input: z.number().nonnegative().optional(),
      cacheHit: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
    }),
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
     * Record whether this provider's models take images.
     *
     * Written as `true` or as no key at all, never as `false`: clearing the switch puts the record back
     * to saying nothing, which is what a record that predates this setting says — so one rule covers
     * "never chose" and "chose no", and a store read by an older build is not handed a key it would have
     * to understand.
     */
    setSupportsImages: (state, { providerId, supported }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      state.providers[providerId] = supported
        ? { ...current, supportsImages: true }
        : {
            enabledModels: current.enabledModels,
            fetchedModels: current.fetchedModels,
          }
    },

    /**
     * Record what this provider charges, in dollars per million tokens.
     *
     * Written only when set: a side the user left blank takes its key off the record, so "not priced"
     * and "priced at nothing" stay different states. That distinction is the whole point of the action —
     * the Overview draws an em dash for the first and a real `$0.0000` for the second, and a store that
     * turned a blank field into a zero would bill every un-priced provider's tokens at nothing.
     *
     * Both sides travel together in one payload because they are read together: all three arrive from a
     * box that knows every field, and pricing with two of the three is exactly what `declaredRates`
     * refuses.
     */
    setRates: (state, { providerId, input, cacheHit, output }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      state.providers[providerId] = {
        enabledModels: current.enabledModels,
        fetchedModels: current.fetchedModels,
        ...(current.supportsImages === true ? { supportsImages: true } : {}),
        ...(input !== undefined ? { inputRate: input } : {}),
        ...(cacheHit !== undefined ? { cacheHitRate: cacheHit } : {}),
        ...(output !== undefined ? { outputRate: output } : {}),
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
        // Carried across, because this action *replaces* the record rather than merging into it: a
        // refresh is about the catalogue, and a refresh that quietly switched image support off would be
        // a setting the user could watch revert by pressing a button about something else.
        ...(current.supportsImages === true ? { supportsImages: true } : {}),
        // And the declared prices travel with it, for the same reason one field over: pressing Fetch
        // must not silently reprice every session at the shipped table. Copied key by key so an absent
        // side stays absent rather than becoming a zero.
        ...(current.inputRate !== undefined ? { inputRate: current.inputRate } : {}),
        ...(current.cacheHitRate !== undefined ? { cacheHitRate: current.cacheHitRate } : {}),
        ...(current.outputRate !== undefined ? { outputRate: current.outputRate } : {}),
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
