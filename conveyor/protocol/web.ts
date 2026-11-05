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

/** The text formats whose bytes are handed over as they arrived, without extraction. */
const VERBATIM_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])

/** The markup types the extractor reads. `xhtml` is html for this purpose. */
const EXTRACT_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/**
 * Read a `Content-Type` header as one of three kinds of body.
 *
 * Absent means extract: a page a server declined to label is still most likely HTML, and the
 * extractor is idempotent on plain text — so defaulting to it cannot corrupt a text body, it can only
 * leave one as it was. Text formats are passed through verbatim; everything else (images, PDFs,
 * archives, binaries) is refused with a code rather than decoded into noise.
 */
export function classifyWebFetchContentType(contentType: string | null): WebFetchBodyKind {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (mime === '') return 'extract'
  if (EXTRACT_TYPES.has(mime)) return 'extract'
  if (VERBATIM_TYPES.has(mime)) return 'verbatim'
  return 'unsupported'
}

/**
 * The named entities a page actually uses, plus the handful of typographic characters this app's
 * prose style carries. A table rather than a library: the full HTML5 set is five megabytes of
 * names for characters a fetched page almost never needs.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  laquo: '\u00ab',
  raquo: '\u00bb',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  middot: '\u00b7',
  bull: '\u2022',
}

/**
 * Private-use markers used inside the single pass, never shown.
 *
 * `VERBATIM_OPEN/CLOSE` fence a `pre`/`code` stretch so the whitespace normalizer cannot reach it;
 * `SEGMENT_OPEN/CLOSE` swap such a stretch for an inline token while the plain text is normalized.
 * Page text carrying these code points is stripped before scanning, so a page cannot forge a fence.
 */
const VERBATIM_OPEN = '\uE000'
const VERBATIM_CLOSE = '\uE001'
const SEGMENT_OPEN = '\uE002'
const SEGMENT_CLOSE = '\uE003'
const INTERNAL_MARKERS = /[\uE000-\uE003]/g

/** Elements whose tags close themselves: no contents to drop, no skip state to enter. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Elements whose contents are raw text rather than markup, so the skip is a literal search. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea'])

/**
 * Elements dropped with everything inside them.
 *
 * The chrome — navigation, banners, footers, forms, embedded objects, media, script and style — is not
 * what the model was asked to read. `head` is here wholesale rather than tag by tag because nothing in
 * it is page text.
 */
const STRIP_TAGS = new Set([
  'head',
  'script',
  'style',
  'title',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'audio',
  'video',
  'button',
  'select',
  'option',
  'textarea',
  'form',
  'input',
  'img',
  'area',
  'source',
  'track',
  'col',
  'param',
  'nav',
  'header',
  'footer',
])

/** Elements that begin and end a line of their own in the extracted text. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'blockquote',
  'figure',
  'figcaption',
  'hr',
  'address',
  'details',
  'summary',
  'fieldset',
  'legend',
])

/** Decode the named and numeric entities this extractor understands. Unknown ones are left alone. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      // A code point that is not a character is left as the entity it was, readable as such.
      if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return whole
      if (value >= 0xd800 && value <= 0xdfff) return whole
      return String.fromCodePoint(value)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** The element name a tag's contents start with, lowercased; empty for anything malformed. */
function tagName(raw: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw)
  return match ? match[1].toLowerCase() : ''
}

/** The index of the `>` that closes a tag, skipping quoted attribute values. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null
  for (let index = from; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

/** Skip the raw text of a script/style/title/textarea, which a tag scanner must not parse. */
function skipRawText(source: string, name: string, from: number): number {
  const closing = new RegExp(`</${name}`, 'gi')
  closing.lastIndex = from
  const match = closing.exec(source)
  if (!match) return source.length
  const end = source.indexOf('>', match.index + match[0].length)
  return end === -1 ? source.length : end + 1
}

/** An anchor's absolute http(s) target, or empty when it is relative or names another scheme. */
function absoluteHref(attrs: string): string {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs)
  const href = decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
  return /^https?:\/\//i.test(href) ? href : ''
}

/**
 * Normalize the text outside `pre`/`code`: collapse runs of spaces and tabs, trim line ends, keep at
 * most one blank line, and drop blank lines at the edges. Newlines that came from the source survive,
 * which is what makes the pass idempotent on text that has already been through it.
 */
function normalizePlainText(text: string): string {
  const lines = text
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))

  const kept: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && kept.length > 0 && kept[kept.length - 1].trim() === '') continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  return kept.join('\n')
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
  const source = html.replace(INTERNAL_MARKERS, '').replace(/\r\n?/g, '\n')

  let out = ''
  let anchorDepth = 0
  let anchorText = ''
  let anchorHref = ''
  let preDepth = 0
  let codeDepth = 0
  let skipTag: string | null = null
  let skipDepth = 0

  const inVerbatim = (): boolean => preDepth > 0 || codeDepth > 0

  /** Append text to the result, or to the open anchor's label while one is being read. */
  const emit = (text: string): void => {
    if (anchorDepth > 0) {
      anchorText += text
      return
    }
    out += text
  }

  const emitText = (raw: string): void => {
    emit(decodeEntities(raw))
  }

  /**
   * Close an anchor: its label, then its target when the label does not already say it.
   *
   * An anchor an `img` or an icon left with no text still names where it goes, which is the only thing
   * it can contribute to readable text.
   */
  const flushAnchor = (): void => {
    const label = anchorText.replace(INTERNAL_MARKERS, '').replace(/\s+/g, ' ').trim()
    const href = anchorHref
    anchorText = ''
    anchorHref = ''
    if (label === '') {
      if (href !== '') out += href
      return
    }
    out += label
    if (href !== '' && label !== href) out += ` (${href})`
  }

  const openTag = (name: string, attrs: string, selfClosing: boolean): void => {
    if (name === 'a' && !selfClosing) {
      if (anchorDepth === 0) {
        anchorText = ''
        anchorHref = absoluteHref(attrs)
      }
      anchorDepth += 1
      return
    }
    if (name === 'br') {
      emit('\n')
      return
    }
    if (name === 'pre') {
      emit('\n')
      if (!inVerbatim()) emit(VERBATIM_OPEN)
      preDepth += 1
      return
    }
    if (name === 'code') {
      if (!inVerbatim()) emit(VERBATIM_OPEN)
      codeDepth += 1
      return
    }
    if (name === 'li') {
      emit('\n- ')
      return
    }
    if (/^h[1-6]$/.test(name)) {
      emit(`\n${'#'.repeat(Math.min(3, Number(name.slice(1))))} `)
      return
    }
    if (BLOCK_TAGS.has(name)) emit('\n')
  }

  const closeTag = (name: string): void => {
    if (name === 'a') {
      if (anchorDepth > 0) {
        anchorDepth -= 1
        if (anchorDepth === 0) flushAnchor()
      }
      return
    }
    if (name === 'pre') {
      if (preDepth === 0) return
      preDepth -= 1
      if (!inVerbatim()) emit(VERBATIM_CLOSE)
      emit('\n')
      return
    }
    if (name === 'code') {
      if (codeDepth === 0) return
      codeDepth -= 1
      if (!inVerbatim()) emit(VERBATIM_CLOSE)
      return
    }
    if (name === 'li') {
      emit('\n')
      return
    }
    if (/^h[1-6]$/.test(name)) {
      emit('\n')
      return
    }
    if (BLOCK_TAGS.has(name)) emit('\n')
  }

  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) {
      if (skipTag === null) emitText(source.slice(index))
      break
    }
    if (open > index && skipTag === null) emitText(source.slice(index, open))

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }

    const marker = source[open + 1] ?? ''
    if (marker === '!' || marker === '?') {
      const end = source.indexOf('>', open + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }

    if (marker === '/') {
      const end = source.indexOf('>', open + 2)
      if (end === -1) {
        index = source.length
        break
      }
      const name = tagName(source.slice(open + 2, end))
      index = end + 1
      if (skipTag !== null) {
        if (name === skipTag) {
          skipDepth -= 1
          if (skipDepth === 0) skipTag = null
        }
        continue
      }
      closeTag(name)
      continue
    }

    if (/[a-zA-Z]/.test(marker)) {
      const end = findTagEnd(source, open + 1)
      if (end === -1) {
        // A tag that never closes is text from here on, which is more honest than dropping the tail.
        if (skipTag === null) emitText(source.slice(open))
        break
      }
      const raw = source.slice(open + 1, end)
      const selfClosing = /\/\s*$/.test(raw)
      const name = tagName(raw)
      index = end + 1

      if (skipTag !== null) {
        if (name === skipTag && !selfClosing && !VOID_TAGS.has(name)) skipDepth += 1
        continue
      }

      if (STRIP_TAGS.has(name) && !selfClosing && !VOID_TAGS.has(name)) {
        if (RAW_TEXT_TAGS.has(name)) {
          index = skipRawText(source, name, index)
        } else {
          skipTag = name
          skipDepth = 1
        }
        continue
      }

      openTag(name, raw, selfClosing)
      continue
    }

    // A `<` that starts no tag is ordinary text.
    if (skipTag === null) emitText('<')
    index = open + 1
  }

  // Swap each verbatim stretch for an inline token, normalize the plain text around it, then put the
  // protected bytes back exactly as they came off the page.
  const segments: string[] = []
  const tokenized = out.replace(/\uE000([\s\S]*?)\uE001/g, (_whole, body: string) => {
    const token = `${SEGMENT_OPEN}${segments.length}${SEGMENT_CLOSE}`
    segments.push(body)
    return token
  })

  return normalizePlainText(tokenized)
    .replace(/\uE002(\d+)\uE003/g, (_whole, id: string) => segments[Number(id)] ?? '')
    .replace(INTERNAL_MARKERS, '')
}
