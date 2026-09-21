import { describe, expect, it } from 'vitest'
import { previewablePath } from '@/app/components/workbench/preview'

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
 * The pane's own wiring — the toggle, what it hides, and that Code is what is shown first — is in
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
