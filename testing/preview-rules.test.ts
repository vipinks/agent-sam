import { describe, expect, it } from 'vitest'
import { defaultViewModeForPath, isDocumentPath, previewablePath } from '@/app/components/workbench/preview'

/**
 * Which paths the viewer may preview as rendered markdown, without a DOM.
 *
 * This is the rule the toggle is gated on, so its boundaries are the whole of the claim: a path the
 * rule accepts gets a Code | Preview switch, and a path it refuses gets today's viewer unchanged.
 *
 * Two of the refusals are the interesting ones and are stated where they can fail.
 *
 * An image is refused. A picture *is* previewed by this pane, but by the image branch, which is a
 * different kind of file and a different branch — so `previewable` here means precisely "as rendered
 * markdown", and an image is not that. Were this rule to accept one, the pane would offer a markdown
 * render of bytes that are not characters.
 *
 * `.mdx` is refused because the chat's renderer does not support it. That renderer is `react-markdown`
 * with `remark-parse` and `remark-rehype` and nothing else wired: there is no `remark-mdx` and no
 * `@mdx-js/mdx` in the dependency tree, so JSX and `{expressions}` in such a file are not compiled —
 * they would arrive at the pane as literal text under a toggle that promised a rendering. Rather than
 * offer a preview of the file's *name*, the extension is left out until the chat can render one.
 *
 * The pane's own wiring — the toggle, what it hides, and which view a path opens in — is in
 * `code-viewer-preview.test.tsx`, because only a rendered pane can fail there.
 */
describe('previewablePath', () => {
  it('accepts the two markdown extensions, whatever case the path arrived in', () => {
    expect(previewablePath('C:/w/notes.md')).toBe(true)
    expect(previewablePath('C:/w/README.markdown')).toBe(true)
    // Windows hands back whatever case the dialog, the user or the shell last spelled, so the
    // comparison is made on a folded extension rather than on the path as written.
    expect(previewablePath('C:/w/NOTES.MD')).toBe(true)
    expect(previewablePath('C:/w/ReadMe.Markdown')).toBe(true)
    expect(previewablePath('C:/w/docs/guide/intro.md')).toBe(true)
    // A backslash path from a Windows root and a forward-slash one describe the same file.
    expect(previewablePath('C:\\w\\docs\\intro.md')).toBe(true)
  })

  it('refuses an image, which this pane previews as bytes rather than as markdown', () => {
    expect(previewablePath('C:/w/logo.png')).toBe(false)
    expect(previewablePath('C:/w/photo.jpg')).toBe(false)
    expect(previewablePath('C:/w/photo.jpeg')).toBe(false)
    expect(previewablePath('C:/w/anim.gif')).toBe(false)
    expect(previewablePath('C:/w/shot.webp')).toBe(false)
    expect(previewablePath('C:/w/icon.svg')).toBe(false)
    expect(previewablePath('C:/w/favicon.ico')).toBe(false)
  })

  it('refuses mdx, which the chat’s renderer has no compiler for', () => {
    // The finding, asserted rather than only commented: react-markdown's pipeline here carries no MDX
    // extension, so JSX and expressions would not be compiled and the toggle would be a promise the
    // renderer cannot keep.
    expect(previewablePath('C:/w/page.mdx')).toBe(false)
  })

  it('refuses every other kind of text, so only markdown gains a toggle', () => {
    expect(previewablePath('C:/w/app.ts')).toBe(false)
    expect(previewablePath('C:/w/index.php')).toBe(false)
    expect(previewablePath('C:/w/notes.txt')).toBe(false)
    expect(previewablePath('C:/w/package.json')).toBe(false)
    expect(previewablePath('C:/w/notes.rst')).toBe(false)
  })

  it('reads the extension from the last segment only', () => {
    // A directory named after an extension is not a file of that type, and a file inside it is still
    // whatever its own name says it is.
    expect(previewablePath('C:/w/docs.md/readme')).toBe(false)
    expect(previewablePath('C:/w/docs.md/readme.txt')).toBe(false)
    expect(previewablePath('C:/w/docs.md/readme.md')).toBe(true)
    // A path with no extension at all, and the empty selection, are neither markdown.
    expect(previewablePath('C:/w/LICENSE')).toBe(false)
    expect(previewablePath('')).toBe(false)
  })

  it('does not mistake a hidden file for a file of that type', () => {
    // `.md` is a file *called* `.md`, the way `.gitignore` is a file called `.gitignore` — a leading
    // dot names the file, it does not introduce an extension.
    expect(previewablePath('C:/w/.md')).toBe(false)
    expect(previewablePath('C:/w/.markdown')).toBe(false)
  })
})

/**
 * Which view a path opens in, as a rule rather than as a rendered pane.
 *
 * This is the decision the pane makes once per opened file, and it is stated here — as a function over a
 * path — so that "markdown opens rendered, everything else opens in Code" is a claim a test can make
 * without a DOM. What only a rendered pane can show is that the pane actually asks this rule; that is in
 * `code-viewer-preview.test.tsx`.
 *
 * The equality with `previewablePath` is the interesting part and is asserted as such: a path with no
 * second view cannot default to one, so the two rules cannot drift into disagreeing about a file.
 */
describe('defaultViewModeForPath', () => {
  it('opens markdown in the preview, whichever spelling of the extension arrived', () => {
    expect(defaultViewModeForPath('C:/w/notes.md')).toBe('preview')
    expect(defaultViewModeForPath('C:/w/README.markdown')).toBe('preview')
    expect(defaultViewModeForPath('C:\\w\\docs\\intro.md')).toBe('preview')
    // The case folding is `previewablePath`'s, asserted here because this rule is what the pane calls.
    expect(defaultViewModeForPath('C:/w/NOTES.MD')).toBe('preview')
  })

  it('opens every other path in Code', () => {
    expect(defaultViewModeForPath('C:/w/app.ts')).toBe('code')
    expect(defaultViewModeForPath('C:/w/index.php')).toBe('code')
    expect(defaultViewModeForPath('C:/w/notes.txt')).toBe('code')
    expect(defaultViewModeForPath('C:/w/package.json')).toBe('code')
    // The kinds this pane draws through branches of their own keep the default that changes nothing for
    // them: an image and a workbook never consult the view, so Code is the honest answer here.
    expect(defaultViewModeForPath('C:/w/logo.png')).toBe('code')
    expect(defaultViewModeForPath('C:/w/report.xlsx')).toBe('code')
    // The exclusions markdown itself carries — `.mdx` and a file merely called `.md` — are exclusions
    // from the default too, or the pane would open a view it cannot offer a toggle for.
    expect(defaultViewModeForPath('C:/w/page.mdx')).toBe('code')
    expect(defaultViewModeForPath('C:/w/.md')).toBe('code')
    expect(defaultViewModeForPath('')).toBe('code')
  })

  it('agrees with previewablePath on every path, so the two cannot disagree', () => {
    // Stated as one rule rather than as a copy of the list above: the default is derived from the toggle's
    // rule, and a path that gains or loses a preview must move both together.
    for (const path of [
      'C:/w/notes.md',
      'C:/w/NOTES.MD',
      'C:/w/README.markdown',
      'C:/w/app.ts',
      'C:/w/logo.png',
      'C:/w/report.xlsx',
      'C:/w/page.mdx',
      'C:/w/.md',
      '',
    ]) {
      expect(defaultViewModeForPath(path)).toBe(previewablePath(path) ? 'preview' : 'code')
    }
  })
})

/**
 * Which paths the pane draws through a document surface of its own.
 *
 * The routing's own question, and the one both panes ask before they choose a branch: a `.pdf`, a
 * `.docx` and a `.doc` are the three kinds Turn 2 wires to the readers and the fallback card, and
 * every other kind has to answer `false` so its branch is left exactly as it was.
 *
 * The refusal of `.doc` is the one worth stating: the legacy container is *routed* — it gets a card
 * rather than a plain "nothing to render" — but it is not drawn, so what it must not do is answer like
 * a document this viewer can read. The predicate answers for the routing, and the card is what tells
 * the difference.
 */
describe('isDocumentPath', () => {
  it('accepts the three document kinds, whichever case the extension arrived in', () => {
    expect(isDocumentPath('C:/w/manual.pdf')).toBe(true)
    expect(isDocumentPath('C:/w/report.docx')).toBe(true)
    expect(isDocumentPath('C:/w/legacy/report.doc')).toBe(true)
    expect(isDocumentPath('C:/w/NOTES.PDF')).toBe(true)
    expect(isDocumentPath('C:\\w\\legacy\\Report.DOC')).toBe(true)
  })

  it('refuses the kinds that keep their own branches', () => {
    expect(isDocumentPath('C:/w/notes.md')).toBe(false)
    expect(isDocumentPath('C:/w/logo.png')).toBe(false)
    expect(isDocumentPath('C:/w/book.xlsx')).toBe(false)
    expect(isDocumentPath('C:/w/app.ts')).toBe(false)
    expect(isDocumentPath('C:/w/archive.zip')).toBe(false)
    // A name with no extension, and a directory that happens to be spelled like one.
    expect(isDocumentPath('C:/w/Makefile')).toBe(false)
    expect(isDocumentPath('C:/reports.pdf/notes.txt')).toBe(false)
    expect(isDocumentPath('')).toBe(false)
  })
})
