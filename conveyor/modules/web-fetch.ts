import { ConveyorError } from 'electron-conveyor/main'
import type { FetchLike } from './llm-engine'
import type { WebFetchBodyKind } from '../protocol/web'

/**
 * The `web_fetch` handler: one GET, bounded on every axis, returned as one fenced tool result.
 *
 * The whole `ToolOutcome.output` is composed here rather than in the loop or the renderer, so the
 * model's history and the card on screen are handed identical bytes. The body is framed with a
 * declaration that it is untrusted data and URL-named markers, and the marker sentinel is neutralized
 * inside the page so a page cannot close its own fence early.
 *
 * Failures are thrown as `ConveyorError` and captured unchanged by the loop's tool dispatch; the codes
 * are the branch, never the message. All four conditions are authored here, once:
 * `WEB_FETCH_FAILED`, `WEB_FETCH_TIMEOUT`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_UNSUPPORTED_TYPE`.
 */

/** What one call to `web_fetch` may be told. */
export interface WebFetchOptions {
  /** The run's own signal; the request's deadline is composed with it. */
  signal: AbortSignal
  /** Injected so the fetch can be driven from a test; the module members leave it unset. */
  fetchImpl?: FetchLike
  /** Overridden only by a test that must not wait out the real deadline. */
  timeoutMs?: number
}

/** A successful fetch, structurally an `ok` tool outcome. */
export interface WebFetchOutcome {
  ok: true
  output: string
}

/** The body treatment this fetch decided on. Unused by the declaration seam, filled in commit 2. */
export type WebFetchKind = WebFetchBodyKind

/**
 * Fetch one page and return it as a bounded, framed tool result.
 *
 * PLACEHOLDER (turn 17, commit 1): the declaration seam only, so the suite bundles and the red state is
 * at assertion level. Commit 2 fills the request, the bounds, the classifier and the fence.
 */
export async function fetchWebPage(rawUrl: string, options: WebFetchOptions): Promise<WebFetchOutcome> {
  options.signal.throwIfAborted()
  throw new ConveyorError('WEB_FETCH_FAILED', `Fetching ${rawUrl} is not available in this build yet.`)
}
