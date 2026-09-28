import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { appendCustom, newProviderId, validateProviderDraft, type CustomProvider } from '../protocol/custom-provider'
import type { ModelWindows } from '../protocol/context-window'
import type { ModelRates } from '../protocol/session-usage'

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
   * What this provider charges for each of its models, as the user declared it, by model id.
   *
   * Additive and optional like `supportsImages` above, and keyed by the model because a price is about
   * the model that was billed: one provider serves a cheap model and a dear one, and a single triple for
   * the provider would have to be wrong about at least one of them. A record that nobody has priced
   * carries no such key, which the pricing rules read as the shipped table pricing every model.
   *
   * Each entry is all-or-nothing at the point it is read — a triple short of a side is not a declaration,
   * and the table prices that model rather than the missing side being read as free — though a row being
   * typed into stores the sides it has, so a person filling three fields in one at a time keeps what they
   * have already typed.
   *
   * Dollars rather than the micros `RATES` holds, because these are fields a person fills in from a
   * provider's pricing page that quotes `$0.15 / 1M tokens`: the one conversion happens in
   * `declaredRates`, which is also what decides whether an entry is whole enough to price with.
   */
  modelRates?: ModelRates
  /**
   * How many tokens each of this provider's models accepts, as the user declared it, by model id.
   *
   * Additive and optional beside `modelRates` above, and keyed by the model for the same reason a price
   * is: one provider serves a small model and a large one, and a single number for the provider would
   * have to be wrong about at least one of them. A record nobody has declared a window for carries no
   * such key, which the window rules read as the shipped table deciding every model.
   *
   * Each entry is one number and is read all-or-nothing: a declaration short of its window is not a
   * declaration, and the table's window is used rather than an absent one being read as zero — a model
   * that accepts no context is not a fact any row can mean. The entry is dropped when the field is
   * blanked, and the map itself is dropped when nothing is left in it, so "nobody declared" and
   * "declared as nothing" cannot be confused.
   *
   * Tokens rather than a share of anything, because that is what a provider publishes: the compact point
   * is the preference that turns one of these into a token count, and it is a percent precisely so one
   * number can govern a 64k model and a 200k one.
   */
  modelWindows?: ModelWindows
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
    // off rather than by storing a zero this app would then bill at. The model id travels with them
    // because the price belongs to the model the row was drawn for.
    setModelRates: z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      input: z.number().nonnegative().optional(),
      cacheHit: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
    }),
    /**
     * A model's window, or the absence of a declaration for it.
     *
     * One optional whole number rather than a triple: an entry is one number, and a row whose field was
     * cleared sends none — which the action writes by taking the key off rather than by storing a zero a
     * reader would take for a model that accepts nothing.
     */
    setModelWindows: z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      window: z.number().int().positive().optional(),
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
            // Carried across, because this branch *rebuilds* the record: switching an unrelated setting
            // off must not be the thing that reprices every model at the shipped table.
            ...(current.modelRates !== undefined ? { modelRates: current.modelRates } : {}),
            // And the declared windows travel with them, for the same reason one key over: a switch about
            // images must not reset what a model's window was said to be.
            ...(current.modelWindows !== undefined ? { modelWindows: current.modelWindows } : {}),
          }
    },

    /**
     * Record what one model charges, in dollars per million tokens.
     *
     * Written only when set: a side the user left blank takes its key off that model's entry, so "not
     * priced" and "priced at nothing" stay different states. That distinction is the whole point of the
     * action — the Overview draws an em dash for the first and a real `$0.0000` for the second, and a
     * store that turned a blank field into a zero would bill every un-priced model's tokens at nothing.
     *
     * All three sides travel together in one payload because they are read together: they arrive from a
     * row that knows its own declaration, and pricing with two of the three is exactly what
     * `declaredRates` refuses. What is stored is what was typed, side by side, so a user filling the
     * three fields in one at a time keeps the sides they have already entered — the refusal happens when
     * the declaration is read, not when a half-typed one is saved.
     *
     * A model with nothing left declared loses its entry, and a map with no entries left loses the key:
     * an empty map would be this record claiming a price it does not have, and an absent map is what a
     * provider nobody has priced carries.
     */
    setModelRates: (state, { providerId, modelId, input, cacheHit, output }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      const declared = {
        ...(input !== undefined ? { inputRate: input } : {}),
        ...(cacheHit !== undefined ? { cacheHitRate: cacheHit } : {}),
        ...(output !== undefined ? { outputRate: output } : {}),
      }
      const modelRates: ModelRates = { ...current.modelRates }
      if (Object.keys(declared).length > 0) modelRates[modelId] = declared
      else delete modelRates[modelId]

      state.providers[providerId] = {
        enabledModels: current.enabledModels,
        fetchedModels: current.fetchedModels,
        ...(current.supportsImages === true ? { supportsImages: true } : {}),
        ...(current.modelWindows !== undefined ? { modelWindows: current.modelWindows } : {}),
        ...(Object.keys(modelRates).length > 0 ? { modelRates } : {}),
      }
    },

    /**
     * Record how many tokens one model accepts, by model id.
     *
     * Written only when set, exactly as a price is: a blank field takes that model's entry off, and a map
     * with nothing left in it loses the key, so "nobody has declared a window" stays distinguishable from
     * "declared as nothing". The entry is one number, so there is no half-typed entry to keep — the
     * refusal a partial price needs has no counterpart here, where the only way to be partial is to be
     * absent.
     */
    setModelWindows: (state, { providerId, modelId, window }) => {
      const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
      const modelWindows: ModelWindows = { ...current.modelWindows }
      if (window !== undefined) modelWindows[modelId] = { contextWindow: window }
      else delete modelWindows[modelId]

      state.providers[providerId] = {
        enabledModels: current.enabledModels,
        fetchedModels: current.fetchedModels,
        ...(current.supportsImages === true ? { supportsImages: true } : {}),
        ...(current.modelRates !== undefined ? { modelRates: current.modelRates } : {}),
        ...(Object.keys(modelWindows).length > 0 ? { modelWindows } : {}),
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
        // And the declared prices travel with it, for the same reason one key over: pressing Fetch must
        // not silently reprice every model at the shipped table. The map goes across whole, so the
        // half-typed row a user is in the middle of keeps its sides too.
        ...(current.modelRates !== undefined ? { modelRates: current.modelRates } : {}),
        // And the declared windows, for the third time and the same reason: what a provider says it
        // offers has no bearing on how much one of its models accepts.
        ...(current.modelWindows !== undefined ? { modelWindows: current.modelWindows } : {}),
      }
    },

    /**
     * Take the retired provider-level rate keys off every record, once, at startup.
     *
     * A key this build no longer knows still arrives in the record, because main's load is one level
     * deep: the persisted state is spread over the initial state, so a `providers` map from the file
     * replaces the empty one wholesale and everything inside a record survives with it. Nothing reads
     * those keys any more, but leaving them would mean the file this app rewrites every time it saves
     * still carried a price for a provider — and the design that moved the price onto the model removed
     * it without migrating a value, so there is nothing to move and the honest end state is a record
     * that never mentioned it.
     *
     * No migration, deliberately: a triple declared for a provider names no model, and guessing which
     * one it meant would bill some model at a price nobody entered for it. The models price from the
     * shipped table until their own rows are filled in.
     *
     * Idempotent, and called once at registration: a record that never had those keys is left exactly
     * as it was, down to the identity of the record it holds.
     */
    dropRetiredRates: (state) => {
      const retired = ['inputRate', 'cacheHitRate', 'outputRate'] as const
      for (const [providerId, record] of Object.entries(state.providers)) {
        const stale = record as unknown as Record<string, unknown>
        if (!retired.some((key) => key in stale)) continue
        const { enabledModels, fetchedModels, supportsImages, modelRates, modelWindows } = record
        state.providers[providerId] = {
          enabledModels,
          fetchedModels,
          ...(supportsImages === true ? { supportsImages: true } : {}),
          ...(modelRates !== undefined ? { modelRates } : {}),
          // A record being normalised for the retired keys keeps everything else it says, this
          // included — the pass is about three keys that are gone, not about the ones that are here.
          ...(modelWindows !== undefined ? { modelWindows } : {}),
        }
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
