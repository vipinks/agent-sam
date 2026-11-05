/**
 * The rules a fetched web page is held to: the bounds, the content-type classifier, and the
 * readable-text extractor.
 *
 * Pure, dependency-free, and shared rather than main-only for the reason the terminal protocol is:
 * `conveyor/modules/web-fetch.ts` owns the network and the Node stream, so the rules that decide what
 * a page is allowed to cost — and what of it the model is shown — have to be statable without
 * touching either. That is also why there is no DOMParser here: it does not exist in the main process,
 * and the renderer's `document-html.ts` is renderer-bound. The extractor is a hand-rolled single-pass
 * scanner instead, which is all a text extraction needs.
 *
 * ## Why a fetch tool and not a search tool
 *
 * Search needs an external service reachable over HTTP — in practice SearXNG, which on Windows means
 * Docker Desktop or WSL2. That cannot be a DEFAULT capability of a desktop app that has to work on a
 * fresh install with no provider, no key and no container runtime: a tool that is dead until the user
 * installs a second system is not a built-in. `web_fetch` is in-process, needs no provider, no key and
 * no spawn, and it inherits the consent gate every acting tool already has — the user sees the URL
 * before the request goes out, and can refuse it.
 *
 * ## What this slice deliberately does not do
 *
 * No SSRF/private-IP filter: for v1, per-call human approval is the control, and localhost stays
 * fetchable because local development servers are a real use. A loopback/link-local/metadata blocklist
 * is parked as slice-2 hardening (an auto-approve session has no gate at all); UTF-8 is the only
 * decoding accepted, so a Latin-1 page decodes as mojibake, non-fatally. Also absent by decision:
 * caching, cookies/auth, methods other than GET, robots.txt, and any document extraction (PDF, Office).
 */

/**
 * How many raw bytes may be read off the wire for one page.
 *
 * Twice `MAX_FILE_BYTES` (`workspace.ts:37`) because HTML carries markup around the text: a 1 MB page
 * of prose is a very long document, and the budget buys room for the tags. Enforced while streaming,
 * never trusted from `Content-Length` alone — a header is a claim, and a chunked response may carry
 * none at all.
 */
export const WEB_FETCH_MAX_RAW_BYTES = 2 * 1024 * 1024

/**
 * How much extracted text is handed to the model.
 *
 * Equal to `MAX_TOOL_OUTPUT` (`agent.ts:141`) on purpose: the cut is made here, with its own honest
 * marker, so the generic cap never applies a second, unmarked one on top of it.
 */
export const WEB_FETCH_MAX_TEXT_CHARS = 20_000

/**
 * How long one page fetch may take.
 *
 * `MODEL_LIST_TIMEOUT_MS` (`provider.ts:19`) times three: a remote TLS page is not a local JSON
 * endpoint. Still far below `RUN_COMMAND_TIMEOUT_MS` (`agent.ts:151`) — a fetch is one request, not a
 * build.
 */
export const WEB_FETCH_TIMEOUT_MS = 15_000

/**
 * How many redirect hops one fetch may follow.
 *
 * No repo precedent, so the number is a judgement stated here: enough for the ordinary
 * http→https and canonical-host hops a real link makes, few enough that a chain cannot be walked
 * indefinitely. Every hop is re-resolved and re-checked for http(s); the sixth fails.
 */
export const WEB_FETCH_MAX_REDIRECTS = 5

/** What to do with a response body, decided from its `Content-Type` alone. */
export type WebFetchBodyKind = 'extract' | 'verbatim' | 'unsupported'

/**
 * Read a `Content-Type` header as one of three kinds of body.
 *
 * Absent means extract: a page a server declined to label is still most likely HTML, and the
 * extractor is idempotent on plain text — so defaulting to it cannot corrupt a text body, it can only
 * leave one as it was. Text formats are passed through verbatim; everything else (images, PDFs,
 * archives, binaries) is refused with a code rather than decoded into noise.
 */
export function classifyWebFetchContentType(contentType: string | null): WebFetchBodyKind {
  // PLACEHOLDER (turn 17, commit 1): the declaration seam only. The classifier lands with the handler.
  void contentType
  return 'extract'
}

/**
 * Turn a page's markup into the readable text a model should see.
 *
 * One pass over the source: tags are dropped, chrome is dropped with its contents, headings keep their
 * level as `#` markers, list items become `- ` lines, and `pre`/`code` keep their whitespace verbatim.
 * Text outside those isn't rewritten beyond whitespace collapsing; entities are decoded from a small
 * named table plus numeric escapes. Idempotent on plain text, which is why an absent content-type can
 * default to extraction with no sniffing heuristic.
 */
export function extractReadableText(html: string): string {
  // PLACEHOLDER (turn 17, commit 1): a pass-through, so the suite is red at its assertions rather than
  // at the bundle.
  return html
}
