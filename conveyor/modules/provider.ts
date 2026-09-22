import { ConveyorError } from 'electron-conveyor/main'
import { z } from 'zod'
import { defineModule, command } from '../init'
import { modelsUrl, normalizeBaseUrl } from '../protocol/custom-provider'
import { parseModels, type FetchLike } from './models-engine'
import { readApiKey } from './settings'

/**
 * The one thing a custom provider is asked for before anything is sent to it: what models it offers.
 *
 * A provider the user added has no catalogue in this app and no curated list to fall back on — the only
 * source is the server itself, so this is a request against a base URL a user typed rather than a lookup
 * in a table. Two consequences shape the code below: the URL is not known to be good, so every failure
 * has to come back as a code a caller can act on, and a server that accepts the connection and then says
 * nothing is a real case for a machine on the user's own desk, so the request has a deadline.
 */

/** How long a catalogue request is given before the provider is called unreachable. */
export const MODEL_LIST_TIMEOUT_MS = 5000

export interface ListModelsOptions {
  /** Injected so the parsing and the two failure paths can be exercised without a network. */
  fetchImpl?: FetchLike
  /** Overridden only by a test that must not wait out the real deadline. */
  timeoutMs?: number
}

/**
 * Read a provider's catalogue from `baseUrl/models`, as model ids.
 *
 * Failures are codes rather than sentences: `PROVIDER_UNREACHABLE` when no answer came (a refused
 * connection, a DNS failure, or the deadline passing) and `PROVIDER_LIST_FAILED` when an answer came and
 * was unusable. An HTTP failure carries its status beside the code — in the payload, not in the message,
 * because the UI turns a code into words of its own and a status embedded in prose would have to be
 * parsed back out to be shown.
 */
export async function listProviderModels(
  baseUrl: string,
  apiKey: string,
  options: ListModelsOptions = {}
): Promise<string[]> {
  const url = modelsUrl(baseUrl)
  const doFetch: FetchLike = options.fetchImpl ?? ((target, init) => fetch(target, init))

  // The deadline is the request's own, so an unanswered request ends where it is waiting rather than
  // leaving the fetch pending for as long as the app is open.
  const signal = AbortSignal.timeout(options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS)

  const headers: Record<string, string> = { accept: 'application/json' }
  // Only sent when there is a key: a local server that wants no credential may reject a bearer header
  // with nothing in it, and the empty key is the ordinary case here.
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  let response: Response
  try {
    response = await doFetch(url, { method: 'GET', headers, signal })
  } catch {
    // The reason is not repeated: the code says which of the two failures this is, and the endpoint is
    // already known to the caller that passed it.
    throw new ConveyorError(
      'PROVIDER_UNREACHABLE',
      signal.aborted ? 'The provider did not answer in time.' : 'The provider could not be reached.'
    )
  }

  if (!response.ok) {
    throw new ConveyorError('PROVIDER_LIST_FAILED', 'The provider refused to list its models.', {
      status: response.status,
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ConveyorError('PROVIDER_LIST_FAILED', 'The provider returned a catalogue this app could not read.')
  }

  // The same parser the built-in providers go through, so a gateway that answers `{ data: [...] }`,
  // `{ models: [...] }`, or a bare array is read the same way here as there. Its own error is a
  // different fact from ours, so it is translated rather than passed through.
  try {
    return parseModels('custom', payload).map((model) => model.id)
  } catch {
    throw new ConveyorError('PROVIDER_LIST_FAILED', 'The provider returned a catalogue this app could not read.')
  }
}

/** A base URL crossing the IPC boundary has to be one this app can actually call. */
const baseUrlSchema = z
  .string()
  .min(1, 'A base URL is required')
  .refine((value) => normalizeBaseUrl(value) !== null, 'A base URL must be an http(s) address')

export const providerModule = defineModule({
  /**
   * The catalogue of a provider this app has no descriptor for.
   *
   * The URL arrives because only the caller knows which server this is about. The key arrives because
   * the user may be holding it right now — the box in Settings keeps it while they type, and a custom
   * provider is often configured and fetched in one sitting. The id arrives for the case where they are
   * not: a key saved on an earlier run is in main and nowhere else, so without it a provider already set
   * up would have to be given its key again just to be asked what it offers.
   *
   * The id is a fallback rather than a second route. `readApiKey` is consulted only when no key came with
   * the call, so a typed key is never silently replaced by a stored one.
   */
  listModels: command(
    z.object({
      baseUrl: baseUrlSchema,
      apiKey: z.string(),
      providerId: z.string().min(1).optional(),
    }),
    async ({ input }) => {
      const apiKey = input.apiKey || (input.providerId ? ((await readApiKey(input.providerId)) ?? '') : '')
      return listProviderModels(input.baseUrl, apiKey)
    }
  ),
})
