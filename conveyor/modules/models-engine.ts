import { ConveyorError } from 'electron-conveyor/main'
import type { CatalogueRates, RateDeclaration } from '../protocol/session-usage'

/**
 * Model listing plumbing: where each provider's catalogue lives, and how to read it back.
 *
 * Pure on purpose — no electron, no fs, `fetch` injected — so the parsing for every provider shape
 * can be exercised against a mocked response, including the Anthropic path, which never touches the
 * network at all.
 */

export interface ModelOption {
  id: string
  /** Human-readable label when the API offers one; the UI falls back to the id. */
  name?: string
  /**
   * What this model's provider published for it, when its catalogue did.
   *
   * The fetched row carries the price so the array-shaped `fetchModels` contract can stay compatible
   * with Settings, while the provider store lifts it into its own map keyed by id. It is not a user
   * declaration and is never merged into one.
   */
  rates?: RateDeclaration
}

/** A provider's models, plus any prices its own catalogue published for them. */
export interface ModelCatalogue {
  models: ModelOption[]
  /** Published in the same dollars-per-million fields a user declaration uses. */
  rates: CatalogueRates
}

/** OpenAI-compatible `/v1/models` endpoints. */
const MODELS_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  // OpenCode Zen is an AI gateway; its catalogue lives under the same prefix as its chat route.
  opencode: 'https://opencode.ai/zen/v1/models',
  openai: 'https://api.openai.com/v1/models',
}

const ANTHROPIC_CURATED_NOTE = 'anthropic'

/**
 * Anthropic is served from a curated list rather than a live call. Their `GET /v1/models` endpoint
 * does exist and answers the same `{ data: [{ id, display_name }] }` shape this parser already
 * handles, so switching to it later is a URL plus two headers rather than a rewrite. The curated
 * list is what this build ships, and it has the side benefit of working before a key is saved.
 */
export const ANTHROPIC_CURATED_MODELS: ModelOption[] = [
  { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
  { id: 'claude-3-opus-latest', name: 'Claude 3 Opus' },
]

/** A `fetch`-shaped function, so the catalogue can be read from a test without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Read a provider's catalogue. Anthropic short-circuits to the curated list; everything else is a
 * GET against its `/v1/models`.
 */
export async function fetchModels(
  providerId: string,
  apiKey: string | null,
  fetchImpl: FetchLike = (url, init) => fetch(url, init)
): Promise<ModelOption[]> {
  if (providerId === ANTHROPIC_CURATED_NOTE) return ANTHROPIC_CURATED_MODELS.map((m) => ({ ...m }))

  const url = MODELS_URLS[providerId]
  if (!url) throw new ConveyorError('UNKNOWN_PROVIDER', `No model catalogue for '${providerId}'.`)

  if (!apiKey) {
    throw new ConveyorError('NO_API_KEY', `No API key is saved for ${providerId}. Add one to fetch its models.`)
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConveyorError('NETWORK_ERROR', `Could not reach ${hostOf(url)}. ${reason}`)
  }

  if (!response.ok) {
    // Only the status is used to branch; the body is detail for the operator.
    const detail = await readSafely(response)
    const suffix = detail.trim() ? ` ${detail.trim().slice(0, 300)}` : ''
    if (response.status === 401 || response.status === 403) {
      throw new ConveyorError('AUTH_FAILED', `The provider rejected this API key.${suffix}`)
    }
    if (response.status === 429) {
      throw new ConveyorError('RATE_LIMITED', `The provider is rate limiting this key.${suffix}`)
    }
    throw new ConveyorError('PROVIDER_ERROR', `The provider refused the request (${response.status}).${suffix}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ConveyorError('PROVIDER_ERROR', `${hostOf(url)} returned a catalogue this app could not read.`)
  }

  return modelsWithCatalogue(parseCatalogue(providerId, payload))
}

/**
 * Attach each catalogue price to its model row.
 *
 * `fetchModels` keeps returning the array Settings already expects; the price rides the row that owns
 * it, and the store lifts the rows into its separate `catalogueRates` map. The map stays the source of
 * truth for pricing; this is only how it crosses the command boundary without changing its shape.
 */
function modelsWithCatalogue(catalogue: ModelCatalogue): ModelOption[] {
  return catalogue.models.map((model) => {
    const rates = catalogue.rates[model.id]
    return rates === undefined ? model : { ...model, rates }
  })
}

/**
 * The models and the prices from one catalogue response.
 *
 * Kept beside `parseModels` because a caller needs both halves from the same response: parsing twice
 * would let a refresh pair one payload's ids with another payload's prices.
 */
export function parseCatalogue(providerId: string, payload: unknown): ModelCatalogue {
  return {
    models: parseModels(providerId, payload),
    rates: parseCatalogueRates(providerId, payload),
  }
}

/**
 * Read the prices an OpenRouter `/models` response publishes, keyed by model id.
 *
 * OpenRouter quotes dollars per token as strings; this app's rate declarations quote dollars per million,
 * so each side is converted once here. A row missing a side is still stored with the sides it has: the
 * pricing rule must see that the catalogue spoke about the model and left a side unpriced, rather than
 * seeing no entry at all and filling the gap from the shipped table.
 */
export function parseCatalogueRates(providerId: string, payload: unknown): CatalogueRates {
  if (providerId !== 'openrouter') return {}

  const rates: CatalogueRates = {}
  for (const row of extractRows(payload)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    if (typeof record.id !== 'string') continue

    const pricing = record.pricing as Record<string, unknown> | undefined
    if (!pricing || typeof pricing !== 'object') continue

    const inputRate = pricePerMillion(pricing.prompt)
    const cacheHitRate = pricePerMillion(pricing.input_cache_read)
    const outputRate = pricePerMillion(pricing.completion)
    if (inputRate === undefined && cacheHitRate === undefined && outputRate === undefined) continue

    rates[record.id] = {
      ...(inputRate !== undefined ? { inputRate } : {}),
      ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
      ...(outputRate !== undefined ? { outputRate } : {}),
    }
  }
  return rates
}

/**
 * One published price as dollars per million, or undefined when it is not a usable number.
 *
 * The rounding keeps the conversion back to micros in `declaredRates` exact for the decimal strings a
 * catalogue publishes; without it a value like `0.00003` can arrive as `30.000000000000004`.
 */
function pricePerMillion(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(raw) || raw < 0) return undefined
  return Math.round(raw * 1_000_000 * 1_000_000) / 1_000_000
}

/**
 * Pull model ids out of a catalogue response.
 *
 * OpenAI answers `{ data: [{ id, ... }] }`. Anthropic answers `{ data: [{ id, display_name }] }`
 * too, so both share one branch; `{ models: [...] }` and a bare array are accepted as well because
 * gateways vary and a wrong guess here is a silent empty list.
 */
export function parseModels(providerId: string, payload: unknown): ModelOption[] {
  const rows = extractRows(payload)

  const models: ModelOption[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      models.push({ id: row })
      continue
    }
    if (!row || typeof row !== 'object') continue

    const record = row as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : null
    if (!id) continue

    // `display_name` is Anthropic's label; OpenRouter uses `name`.
    const label =
      typeof record.display_name === 'string'
        ? record.display_name
        : typeof record.name === 'string'
          ? record.name
          : undefined

    models.push(label && label !== id ? { id, name: label } : { id })
  }

  // Deduplicate by id, then sort so the list reads the same way twice.
  const seen = new Set<string>()
  const unique = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
  unique.sort((a, b) => a.id.localeCompare(b.id))

  if (unique.length === 0 && providerId !== 'anthropic') {
    throw new ConveyorError('PROVIDER_ERROR', 'The provider returned no models in a shape this app recognises.')
  }
  return unique
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.data)) return record.data
    if (Array.isArray(record.models)) return record.models
  }
  return []
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the provider'
  }
}

/** Read an error body without letting a stream failure mask the status already known. */
async function readSafely(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | undefined
      if (error && typeof error.message === 'string') return error.message
      if (typeof parsed.message === 'string') return parsed.message
    } catch {
      // Not JSON — the raw text is still useful as detail.
    }
    return text
  } catch {
    return ''
  }
}
