import { z } from 'zod'

/**
 * The shape of a custom model provider, and the rules that decide whether one may exist.
 *
 * A custom provider is a server the user runs or subscribes to that speaks the OpenAI
 * `chat/completions` dialect: a base URL, a name to show in Settings, an optional key, and the models
 * it offers. Shared, because two processes need to agree on it — main validates a descriptor before a
 * turn runs against it, and the renderer has to describe one the same way — and kept free of module
 * imports so it never drags main-only code into the renderer bundle.
 */

/** The wire dialects this build can speak. One member: everything reachable here is OpenAI-compatible. */
export const CUSTOM_PROVIDER_DIALECTS = ['openai'] as const

export const customProviderDialectSchema = z.enum(CUSTOM_PROVIDER_DIALECTS)
export type CustomProviderDialect = z.infer<typeof customProviderDialectSchema>

/**
 * A provider as a turn runs it: what to call, with what credential, in which dialect, offering which
 * models.
 *
 * `apiKey` may be empty, and for a custom provider that is the ordinary case rather than an unfinished
 * form — a server on the user's own machine (Ollama, LM Studio, llama.cpp) usually wants no
 * credential at all, and demanding one would make the feature unusable for the setup it exists for.
 */
export const customProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  dialect: customProviderDialectSchema,
  /** The model ids this provider offers, as its catalogue listed them. */
  models: z.array(z.string()),
})

export type CustomProvider = z.infer<typeof customProviderSchema>

/** What the user typed, before the name is checked against what exists and an id is assigned. */
export interface ProviderDraft {
  name: string
  baseUrl: string
  apiKey: string
}

/** Why a draft cannot become a provider. Codes, so a caller never has to read a sentence to branch. */
export type ProviderDraftRejection = 'NAME_REQUIRED' | 'NAME_TAKEN' | 'BASE_URL_INVALID'

export type ProviderDraftCheck = { ok: true; draft: ProviderDraft } | { ok: false; code: ProviderDraftRejection }

/**
 * Decide whether a draft could become a provider, and hand back the version worth storing.
 *
 * The names already in use are passed in rather than read: the rule is about this draft and that list,
 * and a function that reached for the list itself could answer two callers looking at different states
 * with the same verdict. Comparison ignores case and surrounding space, because those are the two ways
 * a user retypes a name they already used — and neither is a second provider.
 *
 * The base URL comes back normalised: trimmed, with any trailing slash removed. Everything joins paths
 * onto it (`/chat/completions`, `/models`), and a stored trailing slash would make those joins produce
 * a double slash that some servers route and some do not.
 */
export function validateProviderDraft(draft: ProviderDraft, taken: readonly string[]): ProviderDraftCheck {
  const name = draft.name.trim()
  if (!name) return { ok: false, code: 'NAME_REQUIRED' }

  const wanted = name.toLowerCase()
  if (taken.some((other) => other.trim().toLowerCase() === wanted)) return { ok: false, code: 'NAME_TAKEN' }

  const baseUrl = normalizeBaseUrl(draft.baseUrl)
  if (!baseUrl) return { ok: false, code: 'BASE_URL_INVALID' }

  return { ok: true, draft: { name, baseUrl, apiKey: draft.apiKey.trim() } }
}

/** The base URL as it is stored, or null when it is not an http(s) address this build can call. */
export function normalizeBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    // Not a URL at all — 'localhost:1234' parses as a scheme-less string, and a user typing that means
    // it, so it is refused rather than guessed at.
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  return trimmed
}

/**
 * An id for a provider, derived from its name so it reads like the provider it belongs to, and free of
 * collisions with the ids already in use.
 *
 * Derived rather than random because the id appears in saved model choices and in the store's keys,
 * where `local-llama` is worth reading and `1f3c…` is not. Stability is the whole point: the same name
 * against the same ids yields the same id, so a form can compute the id it is about to create and use
 * it before the store has answered — which matters because a store action cannot return a value.
 */
export function newProviderId(name: string, existing: readonly string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug || 'custom-provider'

  if (!existing.includes(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existing.includes(candidate)) return candidate
  }
}

/** A provider to add: its id already assigned, in the OpenAI dialect every custom provider speaks. */
export interface NewCustomProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models?: string[]
}

/**
 * The list with one more provider on the end.
 *
 * Creation order is the list's order, so the end is where a new provider goes: Settings then reads in
 * the order the user built it, and nothing has to be sorted to say which was added first. A fresh array
 * rather than a push, because this is what a store action assigns — a reducer that mutated the list it
 * was handed would be a second place the order comes from.
 */
export function appendCustom(current: readonly CustomProvider[], draft: NewCustomProvider): CustomProvider[] {
  return [
    ...current,
    {
      id: draft.id,
      name: draft.name,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      dialect: 'openai',
      models: draft.models ? [...draft.models] : [],
    },
  ]
}

/** The catalogue endpoint for a provider's base URL. */
export function modelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl) ?? baseUrl}/models`
}

/** The streaming chat endpoint for a provider's base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl) ?? baseUrl}/chat/completions`
}
