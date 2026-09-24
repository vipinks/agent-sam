import { Eye, TriangleAlert } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { PaneHeader } from './pane-header'
import { formatBytes, imageOf, type ImageRead } from './image'
import { MarkdownContent } from './markdown'
import { previewablePath } from './preview'
import { spreadsheetOf, type SpreadsheetEdit } from './spreadsheet'
import { SpreadsheetView } from './spreadsheet-view'
import { useWorkbenchStore } from './store'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'

/**
 * The right rail's Preview resident, and the rendered surfaces it is made of.
 *
 * The surfaces live here rather than inside the code pane, and this module is the one place each of
 * them is written down: a markdown file rendered, a picture, a workbook's grid. Two panels draw them —
 * this one, which reads the open file and shows whichever of the three it is, and the code pane's own
 * Code | Preview switch, which imports them from here rather than growing a second copy of the same
 * markup. One implementation of a surface, two places that can put it on screen.
 *
 * What makes it a *panel* rather than a second viewer is where its state comes from: `selectedFile`,
 * the same field the code pane reads, so the two residents are two views of one open file rather than
 * two files. Nothing here selects anything, and nothing here writes: a rendered surface is read-only
 * by construction — the way to type is the code pane's editor, and a preview that could also change the
 * file would be a second, differently-shaped editor.
 *
 * The file is read through the same query the code pane makes, so the two residents share one read
 * rather than paying for the same bytes twice: the query key is the path, and the cache answers both.
 */
export function PreviewPanel() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)

  const file = conveyor.workspace.readFile.useQuery({
    input: { path: selectedFile ?? '' },
    enabled: selectedFile !== null,
    retry: false,
  })

  // The three kinds, read the way the code pane reads them: asked at runtime rather than assumed, so
  // whichever shape arrived is the one drawn.
  const image = imageOf(file.data) ? file.data : null
  const spreadsheet = spreadsheetOf(file.data) ? file.data : null
  const content = file.data !== undefined && typeof file.data.content === 'string' ? file.data.content : ''
  const fileName = selectedFile ? (selectedFile.split(/[\\/]/).pop() ?? selectedFile) : ''
  // Whether the open file has a rendered form at all. The extension is the whole of the question, and
  // it is the same question the code pane's switch asks, answered by the same rule.
  const markdown = selectedFile !== null && previewablePath(selectedFile)

  const title = image !== null ? 'Image' : spreadsheet !== null ? 'Spreadsheet' : 'Preview'

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={Eye} title={title}>
        {selectedFile && (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={selectedFile}>
            {fileName}
          </span>
        )}
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      {selectedFile === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Eye className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">Nothing rendered</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              Pick a markdown file, a picture or a workbook in the explorer and its rendered view opens here.
            </p>
          </div>
        </div>
      ) : file.isLoading && file.data === undefined ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">Loading…</div>
      ) : file.error ? (
        <FileError error={file.error} path={selectedFile} />
      ) : image !== null ? (
        <ImageView image={image} alt={fileName} />
      ) : spreadsheet !== null ? (
        /*
          The workbook, drawn read-only: the grid, its tabs and what the file says about itself, with no
          way in. The edit list and the save live in the code pane, where the dirty dot, the Save button
          and the conflict banner are, and a second one here would be a second answer to "is this file
          unsaved". `key` on the path, so opening another workbook remounts the grid onto sheet one of
          the file that is actually open.
        */
        <SpreadsheetView
          key={selectedFile}
          read={spreadsheet}
          editing={false}
          edits={NO_EDITS}
          onEdit={ignoreEdit}
          saveNote={null}
        />
      ) : markdown ? (
        <MarkdownPreview content={content} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Eye className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">Nothing to render</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              This viewer renders markdown, pictures and workbooks. {fileName} is none of them — its source is in
              the Code panel.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The edit list a read-only grid is drawn with, and the callback it will never call.
 *
 * Named rather than written inline at the one call site because the identity matters: the grid memoizes
 * per row off this list, and a fresh empty array on every render of the panel would defeat that. The
 * callback exists only because the grid's own API requires one; nothing here can put the grid into
 * edit mode, so `ignoreEdit` is unreachable rather than merely unused.
 */
const NO_EDITS: SpreadsheetEdit[] = []

function ignoreEdit(): void {}

/**
 * A markdown file, rendered.
 *
 * The file's own characters through the renderer the chat already uses, and nothing else: no gutter and
 * no tokens, because neither describes a rendering — the numbers mark place in the source and the
 * tokens are the source's own colouring, and both belong to the view that shows the source.
 *
 * Nothing is handed to the DOM as markup: this is the same `<MarkdownContent>` the chat has always
 * trusted, and no `dangerouslySetInnerHTML` was added for a file's contents. An empty file has a
 * preview too — nothing to render — and says so, because the chat's renderer answers empty content with
 * "Thinking…", which is a sentence about a stream that has not started, and a file the user opened is
 * not a stream.
 */
export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div data-slot="markdown-preview" className="min-h-0 flex-1 overflow-auto p-4">
      {content.trim() === '' ? (
        <p className="text-[12.5px] text-muted-foreground">This file is empty.</p>
      ) : (
        <MarkdownContent content={content} />
      )}
    </div>
  )
}

/**
 * An image, as a panel shows it.
 *
 * One `img` of the data URL main sent, centered on the pane, with the file's own name as its `alt` so
 * the picture is announced as the file it is rather than as "image". The caption underneath is the
 * panel's one statement about what it is showing: the media type main decided and the size it measured —
 * the caption's wording is this panel's, so one sentence here says it.
 *
 * This element is also the whole of this side's svg story. Main sends an svg base64 inside a data URL —
 * bytes, never markup — and an `img` cannot run what it displays: the source is decoded and painted, so
 * a `script` inside the file has no document to execute in. Every other way of drawing those bytes
 * (inline, or as HTML) would hand them to the DOM as a document, which is the one thing that must not
 * happen; keeping the render to an `img` is what makes the format safe to offer at all.
 */
export function ImageView({ image, alt }: { image: ImageRead; alt: string }) {
  return (
    <div data-slot="image" className="flex min-h-0 flex-1 flex-col">
      {/*
        The image keeps its own aspect ratio inside whatever box the pane gives it (`object-contain`),
        and the scroll container is here rather than on the pane so a picture larger than the pane can
        still be reached instead of being clipped.
      */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={image.dataUrl} alt={alt} className="max-h-full max-w-full object-contain" />
      </div>

      <p
        data-slot="image-caption"
        className="shrink-0 border-t border-border bg-muted px-3 py-1.5 text-center font-mono text-[11px] text-muted-foreground"
      >
        {`${image.mime} · ${formatBytes(image.bytes)}`}
      </p>
    </div>
  )
}

/**
 * What is shown when a read fails. The cases worth their own copy — a file past the cap, an image past
 * its own, a workbook past its own, a locked workbook, a workbook that will not parse — are branched on
 * the error code, never on the message string, which is main's to word.
 *
 * The cases are not refinements of each other: the limits are different numbers, and the way out differs
 * for each — a text file over the cap is a preview the viewer declines, an image over it is one it cannot
 * show, and a locked workbook is neither damaged nor oversized, so telling its reader it "could not be
 * opened" would be a statement about the bytes that happens to be false. A workbook that will not parse
 * is the one place this names a format limit outright, because the honest reason a `.xls` fails here is
 * that this parser reads the modern container and not the binary one.
 *
 * Shared with the code pane, which reaches the same failures for the same files and must word them
 * identically: two sentences for one refusal would be two answers to one question.
 */
export function FileError({ error, path }: { error: unknown; path: string }) {
  const code = error instanceof ConveyorError ? error.code : null
  const encrypted = code === 'SPREADSHEET_ENCRYPTED'
  const tooLarge = code === 'FILE_TOO_LARGE' || code === 'IMAGE_TOO_LARGE' || code === 'SPREADSHEET_TOO_LARGE'
  const name = path.split(/[\\/]/).pop() ?? path

  const title = encrypted
    ? `${name} is password protected`
    : tooLarge
      ? `${name} is too large to preview`
      : 'This file could not be opened'

  const detail = encrypted
    ? 'It can be opened in a spreadsheet program, where it can be unlocked.'
    : code === 'SPREADSHEET_TOO_LARGE'
      ? 'The viewer caps workbooks at 8 MB so a large read never blocks the window.'
      : code === 'SPREADSHEET_PARSE_FAILED'
        ? 'This viewer reads modern .xlsx workbooks; a legacy binary .xls is not one of them.'
        : code === 'IMAGE_TOO_LARGE'
          ? 'The viewer caps images at 2 MB so a large read never blocks the window.'
          : tooLarge
            ? 'The viewer caps files at 1 MB so a large read never blocks the window.'
            : 'It may be binary, moved, or unreadable.'

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/50" />
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}
