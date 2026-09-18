import { ConveyorError } from 'electron-conveyor/main'

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

  return parseModels(providerId, payload)
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
