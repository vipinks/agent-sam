import type { LanguageFn } from 'highlight.js'
import hljs from 'highlight.js/lib/core'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

/**
 * Turning a file's text into token spans, and deciding whether that is worth doing at all.
 *
 * The dependency is `highlight.js`, and it is the only one this feature adds. The two candidates were
 * measured rather than guessed, each bundled minified with exactly the languages below:
 * `highlight.js` core + 8 grammars is 63,744 B raw / 20,147 B gzip; `prismjs` core + 11 components is
 * 34,420 B raw / 11,444 B gzip. Prism is the smaller bundle and is still not the choice, for three
 * reasons that cost more than 8.7 KB of gzip in a renderer whose bundle is read from local disk and
 * never sent over a network. First, prismjs ships no types, so choosing it would mean adding a second
 * dependency (`@types/prismjs`) or hand-writing declarations for a third party. Second, Prism's
 * language modules register by *mutating* a `window`-scoped global and then reading it back, so their
 * correctness rests on module evaluation order and on a browser global rather than on an import edge —
 * loading it outside a browser needs a faked `window` to work at all, which is a fragility a bundler
 * reorder or a future test environment would expose. Third, Prism builds PHP on `markup`,
 * `markup-templating` and `clike`, so "register only these languages" would really be eleven
 * registrations with three of them hidden glue. highlight.js gives each language a real ESM module with
 * a real import edge, ships its own types, and needs no plugin for any of the eight.
 *
 * One import is per grammar, and `hljs/lib/core` rather than the package entry, because the entry
 * registers ~190 languages and would multiply this cost for grammars nothing here can ask for. What is
 * registered is exactly the map below, and `languageForPath` answers only with names from it — so the
 * two cannot drift, which is the failure that would otherwise surface as a throw the first time a
 * particular file was opened.
 *
 * Everything here is pure and renderer-only: no filesystem, no electron, no React. The highlighter runs
 * on content the renderer already holds — the read came through the conveyor client — and it returns a
 * string of escaped HTML, which is what makes the memo possible and the component trivial.
 */

// ---------------------------------------------------------------- registration

/**
 * The grammars this build carries, keyed by the name `languageForPath` answers with.
 *
 * `xml` is highlight.js's name for the HTML grammar: it is the one that tokenizes HTML, XHTML and SVG
 * alike, so the map sends all of those here rather than carrying three near-identical grammars.
 *
 * `plaintext` is a grammar too, not a magic string. Registering it means a path with no extension takes
 * the same lookup as a path with one, and the fallback cannot be a name that throws if someone ever
 * asks highlight.js to highlight it.
 */
const GRAMMARS: Record<string, LanguageFn> = {
  css,
  javascript,
  json,
  markdown,
  php,
  plaintext,
  python,
  typescript,
  xml,
}

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)

/**
 * The names actually registered, read off the same object that was registered.
 *
 * Exported so the rules suite can assert the extension map names nothing outside it. Deriving the list
 * from `GRAMMARS` rather than writing it out again is the point: a second hand-kept list is a second
 * thing to forget.
 */
export const SYNTAX_LANGUAGES: readonly string[] = Object.keys(GRAMMARS)

/** The fallback, registered above so it is a language like any other. */
export const PLAINTEXT = 'plaintext'

// ---------------------------------------------------------------- sizes

/**
 * Above this, the file is not tokenized at all: it is shown as plain text, with a note saying so.
 *
 * A half-megabyte file is already more than a viewport can usefully show, and tokenizing one costs a
 * visible pause for output nobody reads. This is a deliberate ceiling rather than a budget — the
 * asynchronous path below is what keeps the viewer responsive in the sizes that *are* worth reading.
 */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024

/**
 * Up to here the tokenizing happens inline, during the render that needs it.
 *
 * The threshold exists because the cost is not linear in what the user notices: a few hundred lines
 * tokenize inside a frame and deferring them would only produce a flash of plain text, while a large
 * file costs long enough that doing it inline would drop the interaction that caused the render.
 */
export const SYNC_HIGHLIGHT_BYTES = 64 * 1024

// ---------------------------------------------------------------- the path

/**
 * A path's last segment, so an extension is never read out of a parent directory's name.
 *
 * Split on both separators rather than on whichever one this machine uses: the path was written by
 * whichever OS the app was running on, and a stored path can outlive a change of platform.
 */
function baseName(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? ''
}

/**
 * The extension of a path, lowercased, or `''` when it has none.
 *
 * A leading dot names a hidden file rather than an extension — `.gitignore` is a file called
 * `.gitignore`, not a file of type `gitignore` — which is why the dot has to be past position zero.
 * Case is folded here rather than at each lookup, because a Windows path arrives in whatever case the
 * dialog, the user, or the shell last spelled it in.
 */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Extension to registered language. One extension appears once, and every value is in `GRAMMARS`. */
export const EXTENSION_LANGUAGES: Record<string, string> = {
  php: 'php',
  phtml: 'php',

  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',

  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  json: 'json',

  md: 'markdown',
  markdown: 'markdown',

  css: 'css',

  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  xml: 'xml',

  py: 'python',
  pyw: 'python',
}

/**
 * The language to tokenize a path as, or `PLAINTEXT` when nothing applies.
 *
 * Total by construction: an empty extension, an unknown one and a path with no dot at all all fall to
 * the same answer, so a caller never has to ask whether this can fail.
 */
export function languageForPath(path: string): string {
  return EXTENSION_LANGUAGES[extensionOf(path)] ?? PLAINTEXT
}

// ---------------------------------------------------------------- the decision

/**
 * What the viewer should do with a file: tokenize it now, tokenize it off the current task, or neither.
 *
 * `too-large` carries the byte count and the limit it exceeded rather than a boolean, because the note
 * the viewer shows is worded from this object and a bare `true` would leave it guessing at why.
 */
export type HighlightPlan =
  | { mode: 'plain'; reason: 'plaintext' }
  | { mode: 'plain'; reason: 'too-large'; bytes: number; limit: number }
  | { mode: 'sync'; language: string }
  | { mode: 'async'; language: string }

/**
 * The UTF-8 byte length of a string.
 *
 * Measured rather than read off `.length`, which counts UTF-16 code units: a file of emoji is four
 * bytes per character and would come in at a quarter of its real size, so a cap expressed in bytes
 * would let through exactly the files it exists to stop. Written out rather than taken from
 * `TextEncoder` so the rule is a pure function of its input — no environment to be present or absent,
 * and nothing to mock in a test.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    // A surrogate pair is one character in four bytes; the low half is consumed with the high one.
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * Decide how a file should be highlighted.
 *
 * The order of the two questions matters. A language the viewer does not know is settled first, so an
 * enormous `.zip` is not reported as "too large to highlight" when it was never a candidate. Size is
 * then measured once and drives both the skip and the sync/async split, so the two thresholds can
 * never disagree about the same file.
 */
export function highlightPlan(path: string, content: string): HighlightPlan {
  const language = languageForPath(path)
  if (language === PLAINTEXT) return { mode: 'plain', reason: 'plaintext' }

  const bytes = utf8Bytes(content)
  if (bytes > MAX_HIGHLIGHT_BYTES) return { mode: 'plain', reason: 'too-large', bytes, limit: MAX_HIGHLIGHT_BYTES }

  return bytes > SYNC_HIGHLIGHT_BYTES ? { mode: 'async', language } : { mode: 'sync', language }
}

/**
 * What the viewer says about a file it did not tokenize, or `null` when it has nothing to explain.
 *
 * A file the viewer simply has no grammar for is not an apology: nothing was skipped, there was never
 * anything to do. Only the cap is worth a sentence, because only the cap is a decision the viewer made
 * and a reader might otherwise mistake for a broken highlighter. The limit is named in the units it is
 * expressed in, and derived from the constant rather than typed out, so a change to the cap cannot
 * leave the note describing the old one.
 */
export function skipNote(plan: HighlightPlan): string | null {
  if (plan.mode !== 'plain' || plan.reason !== 'too-large') return null
  return `This file is over ${Math.floor(plan.limit / 1024)} KB, so it is not highlighted — showing plain text.`
}

// ---------------------------------------------------------------- the tokenizing

/** Escapes the five characters that matter for text being placed inside an element. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Tokenize content into escaped HTML.
 *
 * The result is a string of `<span class="hljs-…">` wrappers around escaped source text — highlight.js
 * escapes what it is given and emits nothing else, which is what makes it safe to place in an element
 * as HTML rather than as a React tree of thousands of nodes. The alternative, mapping the token stream
 * to elements in React, would need highlight.js's emitter, which is internal and not part of its public
 * API.
 *
 * A grammar that throws is caught rather than allowed to take the pane down: a file the highlighter
 * cannot handle is still a file the user asked to read, so it degrades to the escaped source. An
 * unregistered language would throw on every render, which is why the failure is contained here and
 * why `languageForPath` only ever answers with a registered name.
 */
export function highlightToHtml(content: string, language: string): string {
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(content)
  }
}

// ---------------------------------------------------------------- the memo

/**
 * How many files' tokenized output are kept.
 *
 * Keyed by path and holding one entry each, so this is also the number of *files* remembered, and a
 * session that opens more than this is doing something other than reading code. Small enough that the
 * retained HTML cannot grow without bound, large enough that the tabs a user actually moves between
 * are all still warm.
 */
export const HIGHLIGHT_CACHE_LIMIT = 16

/** One file's tokenized output, kept only for as long as it describes the content it was made from. */
interface MemoEntry {
  language: string
  content: string
  html: string
}

export interface HighlightMemo {
  /** The tokenized HTML for this path and content, computed only if it is not already known. */
  get: (path: string, content: string, language: string) => string
}

/**
 * Remember tokenized output per path, so returning to a file does not tokenize it again.
 *
 * Both halves of that sentence are load-bearing. Keyed by *path* rather than by content, because a
 * tab switch is the thing being avoided: two files are each remembered under their own name, so moving
 * between them costs nothing, where a content-keyed cache would hold both but would have to hash a
 * half-megabyte string to find either. And the stored content is compared on the way out, because a
 * path is not its contents: an edit, an external write, or a save all change the text under the same
 * name, and serving the old tokens for new code would be the highlighter lying about what is on screen.
 *
 * The compute function is injected rather than called directly so the memo can be exercised without
 * the highlighter — the same seam `createChangeCoalescer` uses for its clock, and for the same reason:
 * the rule is about what gets recomputed, and asserting that needs a compute that can be counted.
 */
export function createHighlightMemo(
  compute: (content: string, language: string) => string,
  limit: number = HIGHLIGHT_CACHE_LIMIT
): HighlightMemo {
  // Insertion order is the recency order: every read moves its entry to the end, so the first key is
  // always the least recently used one and eviction needs no bookkeeping beyond a delete and a set.
  const entries = new Map<string, MemoEntry>()

  return {
    get(path, content, language) {
      const hit = entries.get(path)
      if (hit !== undefined && hit.language === language && hit.content === content) {
        entries.delete(path)
        entries.set(path, hit)
        return hit.html
      }

      const html = compute(content, language)
      entries.delete(path)
      entries.set(path, { language, content, html })

      if (entries.size > limit) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }

      return html
    },
  }
}

/** The memo the viewer uses. One per renderer process, which is one per window. */
export const highlightMemo: HighlightMemo = createHighlightMemo(highlightToHtml)
