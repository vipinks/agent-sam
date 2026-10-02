/**
 * The viewer's preview rules: which paths it may render as markdown, and which view such a path opens
 * in.
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

import { previewKind } from '@/conveyor/protocol/preview-kind'
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

/**
 * Whether a path is one of the three kinds the viewer draws through a document surface of its own: a
 * pdf, a modern Word container, and the legacy binary Word one.
 *
 * One question here rather than three, because the panes ask it only to choose a *branch*: which of the
 * three it is stays `previewKind`'s answer, and the surface that mounts the readers asks for it once.
 *
 * The answer is read from the protocol's dispatch rule rather than from a second extension list, for the
 * reason `previewablePath` derives its own from `extensionOf`: a table of document extensions kept here
 * would be a second place the same question is answered, free to disagree with main's.
 */
export function isDocumentPath(path: string): boolean {
  const kind = previewKind(path)

  return kind === 'pdf' || kind === 'docx' || kind === 'doc'
}

/** The two read-only views a file can be drawn in. */
export type ViewMode = 'code' | 'preview'

/**
 * The view a path opens in.
 *
 * Markdown opens rendered: a reader who opened `notes.md` wants the notes, not the asterisks, and the
 * rendering is the whole reason this pane has a second view. Everything else opens in Code, which is
 * where every path has always opened — including an image or a workbook, whose branches draw
 * themselves and ignore the choice entirely, so answering "code" for them changes nothing for them.
 *
 * The answer is derived from `previewablePath` rather than from a second extension list: a path that
 * has no second view cannot default to one, so the two questions have one answer by construction.
 *
 * A default, not a mode. The pane applies it once per opened file and the toggle still moves the view
 * afterwards, which is why nothing here is written anywhere: the next file — and the next launch —
 * starts from this rule again.
 */
export function defaultViewModeForPath(path: string): ViewMode {
  return previewablePath(path) ? 'preview' : 'code'
}
