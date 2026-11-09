/**
 * Which models a provider offers, by one rule shared by the two surfaces that ask.
 *
 * The chat header's picker and the Buddy editor both have to answer "what can be chosen from this
 * provider", and they used to answer it differently: the picker read the user's switched-on set and
 * fell back to the provider's catalogue, while the editor read `fetchedModels` — the last answer a
 * provider gave the Settings screen, which a custom provider never writes and a fresh install has not
 * written yet. With a custom provider selected the editor's list was therefore empty, and a model that
 * cannot be chosen cannot be pinned.
 *
 * The rule is pure over its four arguments on purpose: both callers already hold the store's mirror and
 * the seeded catalogue, so this reads what they have rather than reaching for a hook or a conveyor
 * module. That is also what keeps it out of the second answer's way — there is no state of its own to
 * disagree with the store.
 *
 * `fetchedModels` is deliberately not read, by either branch. It is a cache of what a provider last
 * answered, never a truth about what may be sent, and the store's own header says as much. Two surfaces
 * resolving the same choice from two different fields is exactly how they drifted apart.
 */

/** The part of a provider's record this rule reads: the ids the user switched on. */
export interface ProviderModelsConfig {
  enabledModels: readonly string[]
}

/** The part of a custom provider's descriptor this rule reads: the catalogue it arrived with. */
export interface ProviderModelsCatalogue {
  id: string
  models: readonly string[]
}

/** One seeded default, as `settings.defaultModels` answers it. Only its id is a choice a Buddy can pin. */
export interface ProviderModelsDefault {
  id: string
}

/**
 * The models a provider offers, in the order they are offered.
 *
 * What the user switched on wins, and wins first on both branches: it is their intent, it is what the
 * editor's switches in Settings mean, and the same enabled set is what the chat dropdown reads. Only
 * when nothing is switched on does the catalogue answer — the descriptor's own list for a provider the
 * user added, the seeded defaults for one that ships — and only then, because a list of everything on
 * offer is the useful fallback rather than a second opinion about what is enabled.
 */
export function resolveProviderModels(
  providerId: string,
  configs: Record<string, ProviderModelsConfig | undefined>,
  customProviders: readonly ProviderModelsCatalogue[],
  defaultModels: Record<string, readonly ProviderModelsDefault[]> | undefined
): string[] {
  const enabled = configs[providerId]?.enabledModels
  if (enabled !== undefined && enabled.length > 0) return [...enabled]

  // A custom provider answers for itself with the catalogue its descriptor carries — the list Settings
  // writes when a fetch comes back. An empty one is still an answer: this provider has offered nothing,
  // and falling through to the seeded defaults would name a model it has never heard of.
  const custom = customProviders.find((provider) => provider.id === providerId)
  if (custom !== undefined) return [...custom.models]

  // A shipped provider has no descriptor to read, so its seeded catalogue answers until a fetch replaces
  // it. This is what makes a fresh install usable: the picker has always offered this, and so must the
  // editor.
  return (defaultModels?.[providerId] ?? []).map((model) => model.id)
}
