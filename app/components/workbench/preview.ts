/**
 * The viewer's preview rules: which paths it may render as markdown.
 *
 * Pure and renderer-only, kept out of the component for the reason `editing.ts`, `gutter.ts` and
 * `image.ts` are: it is a decision a test should be able to make by calling a function rather than by
 * rendering a pane and looking for a button. Nothing here touches a disk, a process, or electron — and
 * nothing here reads a file, because a preview is a way of *drawing* content that has already been
 * read, never a new way of reading it.
 *
 * The list is an extension list rather than a media-type probe, and deliberately so: an extension is
 * the only thing the renderer can know about a path before it has the bytes, and the answer has to be
 * available in the same render as the path, so that the toggle appears with the file rather than a
 * moment after it.
 */

import { extensionOf } from './highlight'

/**
 * The extensions this pane will render as markdown.
 *
 * `md` and `markdown` are the two the chat's own export writes and the two a reader means by
 * "markdown". `mdx` is deliberately absent: the chat renders markdown with `react-markdown`, whose
 * pipeline here carries `remark-parse` and `remark-rehype` and no MDX extension — there is no
 * `remark-mdx` or `@mdx-js/mdx` in the dependency tree, so JSX and `{expressions}` in such a file would
 * not be compiled. A preview that showed them as literal text under a markdown toggle would be a
 * promise the renderer cannot keep, so the extension waits until the chat can render one.
 */
const PREVIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown'])

/**
 * Whether a path is one the viewer can preview as rendered markdown.
 *
 * The extension comes from `extensionOf`, so the answer is read from the last segment in either slash
 * and from a folded extension — the same reading the highlighter makes of the same path, rather than a
 * second opinion about where an extension lives.
 *
 * An image answers `false`, and that is not a claim that an image has no preview: the pane previews one
 * through its image branch, from a media type main decided. This rule decides the *markdown* preview
 * only, so "previewable" here means "renderable as markdown", and a path it refuses keeps the viewer
 * exactly as it was.
 */
export function previewablePath(path: string): boolean {
  return PREVIEWABLE_EXTENSIONS.has(extensionOf(path))
}
