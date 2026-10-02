/**
 * Mammoth's html, made fit to draw.
 *
 * This is the one place in the app where a *string of markup* from a file's own bytes reaches the DOM,
 * and it exists because the alternative is worse: a Word document is user data like any other, and
 * rendering it means rendering its structure. What makes that safe is not the parser — mammoth escapes
 * the text it emits and produces a small set of its own elements, and neither property is something this
 * app can check — but the pass below, which walks the parsed tree and keeps only what is on a list.
 *
 * The parse is inert. `DOMParser` builds a document that is not in this window's tree: no script runs,
 * no image is fetched, and nothing is laid out. Only after the tree has been pruned is its markup read
 * back out, and the string that comes out can only describe nodes that survived.
 *
 * Three lists, and each is a decision rather than a default:
 *
 * - Elements dropped with their contents. These are the ones whose *inside* is the danger, or whose
 *   content is not text to be read: a script, a stylesheet, a frame, a plugin, a form control, and the
 *   two foreign-content roots that are the classic way around a naive element filter.
 * - Elements allowed through. Word's own vocabulary — paragraphs, headings, lists, tables, emphasis,
 *   links and figures — which is what a reader of a document expects to see.
 * - Attributes kept, per element and by name. Everything else goes, which is what removes every `on*`
 *   handler and every `style` without either having to be enumerated.
 *
 * An element that is neither allowed nor dropped is *unwrapped*: its children stay, its tag does not.
 * That is the friendly half of the rule — a `<section>` around three paragraphs costs the reader
 * nothing — and it is safe because the children have been through this same pass.
 *
 * Deliberately not a third-party sanitizer: `DOMPurify` is the right answer for a general HTML sink and
 * it is a dependency this phase did not name. The list here is short because the input is narrow, and
 * the tests that pin it are in `testing/docx-viewer.test.tsx`.
 */

/** Elements that go, contents and all. */
const DROPPED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'iframe',
  'frame',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'template',
  'noscript',
  'audio',
  'video',
  'source',
  'svg',
  'math',
])

/** Elements kept. Everything a Word document says about itself, and nothing that can act. */
const ALLOWED: ReadonlySet<string> = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'small',
  'span',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
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
  'caption',
  'a',
  'img',
  'figure',
  'figcaption',
])

/**
 * The attributes kept, and only these.
 *
 * `href` and `src` are the two that carry a destination, so they are also the two that are filtered by
 * value below: a `javascript:` url is a script that never looks like one.
 */
const ATTRIBUTES_BY_ELEMENT: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
}

/**
 * Where a link may point.
 *
 * The schemes a person can read in a status bar and then choose to follow. A `javascript:` url is a
 * script that does not look like one, so it is not among them, and anything else — a `file:` url, a
 * protocol handler — is a destination this app has no business putting one click away.
 */
const SAFE_LINK = /^(https?:|mailto:|#)/i

/**
 * Where an image may come from: the document's own bytes, and nowhere else.
 *
 * `data:image/` is how a docx's figures arrive — mammoth inlines them — and the only kind of data url
 * allowed besides: a `data:text/html` url is a document, and handing one to this window would be
 * handing it a second page. A remote address is refused for a different reason: an image url is a
 * request, so a document carrying one would tell a stranger's server that this file had been opened,
 * and when. A linked image therefore draws as its alt text — visible, and silent.
 */
const SAFE_IMAGE = /^data:image\//i

function attributeSurvives(element: Element, name: string): boolean {
  const allowed = ATTRIBUTES_BY_ELEMENT[element.tagName.toLowerCase()]
  if (allowed === undefined || !allowed.includes(name)) return false

  if (name === 'href') return SAFE_LINK.test(element.getAttribute(name) ?? '')
  if (name === 'src') return SAFE_IMAGE.test(element.getAttribute(name) ?? '')

  return true
}

/** Walk a subtree and leave only what the lists above allow. */
function prune(container: Element): void {
  for (const node of Array.from(container.childNodes)) {
    // Comments carry no reading and no rendering, and a conditional comment is a way to smuggle markup
    // past a filter that only looks at elements.
    if (node.nodeType === 8) {
      node.remove()
      continue
    }

    if (node.nodeType !== 1) continue

    const element = node as Element
    const tag = element.tagName.toLowerCase()

    if (DROPPED.has(tag)) {
      element.remove()
      continue
    }

    prune(element)

    if (!ALLOWED.has(tag)) {
      // The tag goes, the children stay — and they have already been through this pass, so what is
      // promoted is exactly what a parent of this element would have kept anyway.
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      if (!attributeSurvives(element, attribute.name.toLowerCase())) element.removeAttribute(attribute.name)
    }
  }
}

/**
 * The html a document viewer may draw, as a string.
 *
 * The parse is of a detached document, which is what makes the pruning meaningful: the tree is walked
 * before anything is in this window, so a script that survives the walk has still never run.
 */
export function sanitizeDocumentHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  prune(parsed.body)

  return parsed.body.innerHTML
}
