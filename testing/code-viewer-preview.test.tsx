import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The rendered preview for a markdown file, as wiring rather than as rules.
 *
 * Which paths are previewable at all is settled without a DOM in `preview-rules.test.ts`. What only a
 * rendered pane can show is everything the switch does to the pane: that the toggle is offered for a
 * markdown file and absent for every other path, that a markdown file opens in Preview while every other
 * path opens in Code, that Preview replaces the numbered, tokenized read view with a rendering of the
 * same characters, that returning to Code puts both back, that entering edit mode lands in the editor
 * rather than in the preview, and that the renderer the chat already trusts is the only thing that
 * turns those characters into elements.
 *
 * The safety case is asserted last and hardest, because it is the one an inheritance claim could get
 * wrong: the payload is a fixture, and the assertion is made against the *document* — no element may
 * carry an event-handler attribute, and nothing anywhere may carry a `javascript:` URL.
 *
 * The GFM cases sit in the same describe for the same reason the payload does: they are claims about
 * what the *inherited* renderer does. A pipe table, a task list, a strikethrough and an autolink are
 * constructs the preview only gained because the shared renderer gained them, so they are asserted
 * where a change to that renderer would break them.
 */

const ROOT = 'C:/w'
const MD_PATH = 'C:/w/notes.md'
const TEXT_PATH = 'C:/w/index.php'
const TS_PATH = 'C:/w/app.ts'
const DISK_MTIME = 1_700_000_000_000

/** A language the viewer highlights, so "this path opens in Code" is provable from the tokens. */
const TS_SOURCE = ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n')

/**
 * A markdown file with all four of the things the preview has to render: a heading, a list, a fenced
 * block, and a table.
 *
 * The fence is deliberately a language the viewer tokenizes, so "the tokens are gone in Preview" is a
 * claim about tokens that were genuinely there a moment earlier in Code.
 */
const MD_SOURCE = [
  '# Release notes',
  '',
  'A short list:',
  '',
  '- one',
  '- two',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
].join('\n')

/**
 * A piped table: the construct whose support is whatever plugins the renderer carries, and therefore the
 * one that says which renderer a surface got. One header row and one body row of two cells each, so the
 * counts asserted below are this fixture's rather than a count of whatever happened to appear.
 */
const TABLE_SOURCE = ['| Name | Value |', '| --- | --- |', '| alpha | 1 |', ''].join('\n')

/**
 * The document a preview must not run: an inline handler on raw markup, and a script URL on a link.
 *
 * Spelled out as a fixture rather than described, so the assertions below are made about a payload
 * that is genuinely present in the file being rendered.
 */
const PAYLOAD_SOURCE = ['# Pic', '', '<img src=x onerror="alert(1)">', '', '[click](javascript:alert(1))', ''].join(
  '\n'
)

/** A task list: two items, one ticked, as GFM spells one. */
const TASK_SOURCE = ['- [x] shipped', '- [ ] not yet', ''].join('\n')

/** Struck-through words, which GFM writes with tildes and the renderer carries as an element. */
const DEL_SOURCE = ['A line with ~~removed~~ words.', ''].join('\n')

/**
 * A GFM autolink: a bare URL with no angle brackets and no link syntax around it.
 *
 * Deliberately not `<https://…>`, which CommonMark already autolinks without any plugin — such a case
 * would pass before this plugin existed and would therefore gate nothing. The literal form is the one
 * GFM adds, so it is the one that fails without `remark-gfm` and that pins the contract here.
 */
const AUTOLINK_SOURCE = ['See https://example.com/gfm-autolink for the details.', ''].join('\n')

/**
 * The payload once more, where a table cell puts it.
 *
 * The cell is the interesting place for it: a table is the construct this commit gained, so a cell is
 * where a newly-parsed construct could plausibly have become a new way for a file's characters to reach
 * the document. Spelled out rather than derived from `PAYLOAD_SOURCE`, so the assertions below are made
 * about a payload genuinely present in this fixture.
 */
const TABLE_PAYLOAD_SOURCE = ['| Name | Value |', '| --- | --- |', '| <img src=x onerror="alert(1)"> | 1 |', ''].join(
  '\n'
)

/** The viewer with one file open, and no change selected. */
function stubViewer(path: string, content: string): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => ({ path, content, baselineMtime: DISK_MTIME }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)
  return stub
}

function renderViewer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CodeViewer />
    </QueryClientProvider>
  )
}

/** Wait for the read view to be on screen rather than the loading state. */
async function readView(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const code = container.querySelector('code')
    if (code === null) throw new Error('the read view has not rendered yet')
    return code
  })
}

/** The gutter, found by the slot the viewer marks it with. */
function gutterOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="code-gutter"]')
}

/** The preview's own container, found by its slot for the same reason the gutter is. */
function previewOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="markdown-preview"]')
}

/**
 * Wait for the rendered markdown, which is where a markdown path now starts.
 *
 * Distinct from `readView` rather than a looser version of it: a preview of a fenced block contains a
 * `code` element of its own, so "wait for a `code`" would pass on the very view this helper exists to
 * tell apart from the read view.
 */
async function markdownPreview(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const preview = previewOf(container)
    if (preview === null) throw new Error('the preview has not rendered yet')
    return preview
  })
}

/** The toggle's two buttons, asked for by the name a user reads rather than by position. */
function toggle(): { code: HTMLElement; preview: HTMLElement } {
  return {
    code: screen.getByRole('button', { name: 'Code' }),
    preview: screen.getByRole('button', { name: 'Preview' }),
  }
}

/** The read view's token spans, which are the highlight and nothing else. */
function tokenSpans(container: HTMLElement): number {
  return container.querySelectorAll('[class*="hljs-"]').length
}

/** Every event-handler attribute anywhere in the pane, as `element[attribute]` names. */
function handlerAttributes(container: HTMLElement): string[] {
  const found: string[] = []
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith('on')) found.push(`${element.tagName}[${attribute.name}]`)
    }
  }
  return found
}

/** Every attribute value in the pane that carries a script URL. */
function scriptUrls(container: HTMLElement): string[] {
  const found: string[] = []
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes('javascript:')) found.push(`${element.tagName}[${attribute.name}]`)
    }
  }
  return found
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('the toggle', () => {
  it('opens a markdown file in Preview, with the toggle offering Code', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()

    // The path's own default: a reader who opened `notes.md` wants the notes, not the asterisks, and the
    // switch is what offers them the source instead. Nothing of the Code view is behind the rendering —
    // no gutter, no tokens — and the pressed state says which of the two halves is showing.
    const preview = await markdownPreview(container)
    expect(toggle().preview.getAttribute('aria-pressed')).toBe('true')
    expect(toggle().code.getAttribute('aria-pressed')).toBe('false')
    expect(preview.querySelector('h1')?.textContent).toBe('Release notes')
    expect(gutterOf(container)).toBeNull()
    expect(tokenSpans(container)).toBe(0)
    expect(container.querySelector('code.hljs')).toBeNull()

    // And the other half is one click away: Code is still the numbered, tokenized read view.
    await userEvent.click(toggle().code)
    expect(previewOf(container)).toBeNull()
    expect(gutterOf(container)).not.toBeNull()
    expect(tokenSpans(container)).toBeGreaterThan(0)
  })

  it('is absent for a path that is not markdown', async () => {
    stubViewer(TEXT_PATH, '<?php\n\n$name = "sam";\n')
    useWorkbenchStore.setState({ selectedFile: TEXT_PATH })
    const { container } = renderViewer()
    await readView(container)

    // No Code button either: with nothing to switch to, a lone Code button would be a control that
    // does nothing, and the pane would look like it had lost a preview rather than never offered one.
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull()
    expect(previewOf(container)).toBeNull()
  })

  it('opens a TypeScript file in Code, where there is no switch to offer', async () => {
    stubViewer(TS_PATH, TS_SOURCE)
    useWorkbenchStore.setState({ selectedFile: TS_PATH })
    const { container } = renderViewer()
    await readView(container)

    // Non-markdown paths keep the default they have always had: the numbered read view, with the file's
    // characters and their tokens. Only markdown moved.
    expect(gutterOf(container)).not.toBeNull()
    expect(tokenSpans(container)).toBeGreaterThan(0)
    expect(previewOf(container)).toBeNull()
    // And with nothing to switch to, neither half of the switch is offered.
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull()
  })

  it('is absent for an image, which is previewed as bytes rather than as markdown', async () => {
    const stub = createBridgeStub({
      readFile: () => ({
        kind: 'image',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        bytes: 128,
        path: 'C:/w/logo.png',
        baselineMtime: DISK_MTIME,
      }),
      listDirectory: () => [],
      status: () => [],
      branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
      log: () => [],
      localBranches: () => ['main'],
      diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    })
    stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
    setActiveStub(stub)
    useWorkbenchStore.setState({ selectedFile: 'C:/w/logo.png' })
    const { container } = renderViewer()

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull()
  })
})

describe('the preview', () => {
  it('renders a heading and a list from the file, and hides the gutter and the tokens', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    const preview = previewOf(container)
    expect(preview).not.toBeNull()

    // The file's characters, rendered: a heading, the two list items, and the fenced block's code.
    expect(preview?.querySelector('h1')?.textContent).toBe('Release notes')
    const items = [...(preview?.querySelectorAll('li') ?? [])].map((li) => li.textContent)
    expect(items).toEqual(['one', 'two'])
    // The fence's content arrives with the newline the fence itself ended on, exactly as it does in
    // the chat's rendering of the same block — the preview is that renderer, not a parser of its own.
    expect(preview?.querySelector('pre code')?.textContent?.trim()).toBe('const a = 1')

    // Read-only and display-only: the preview is not a second editor.
    expect(container.querySelectorAll('textarea, input')).toHaveLength(0)

    // Line numbers and highlighting belong to Code. In Preview there is neither a gutter nor a token
    // span — the source is rendered, not tokenized, so nothing was painted underneath it either.
    expect(gutterOf(container)).toBeNull()
    expect(tokenSpans(container)).toBe(0)
    expect(container.querySelector('code.hljs')).toBeNull()

    expect(toggle().preview.getAttribute('aria-pressed')).toBe('true')
    expect(toggle().code.getAttribute('aria-pressed')).toBe('false')
  })

  it('returns to Code and back to Preview without leaving anything of the other behind', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    await userEvent.click(toggle().code)

    // Both halves of the Code view are back, and the rendering is gone — the switch is a view, not a
    // one-way door, and neither view leaves anything of the other behind.
    expect(previewOf(container)).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(gutterOf(container)).not.toBeNull()
    expect(tokenSpans(container)).toBeGreaterThan(0)
    // The same characters in both views: the numbers count the file, not the render.
    expect(gutterOf(container)?.textContent?.split('\n')).toHaveLength(MD_SOURCE.split('\n').length)

    // And the way back is the same click in the other direction, which is what makes this a toggle
    // rather than a default with a one-way door out of it.
    await userEvent.click(toggle().preview)
    expect(previewOf(container)?.querySelector('h1')?.textContent).toBe('Release notes')
    expect(gutterOf(container)).toBeNull()
    expect(tokenSpans(container)).toBe(0)
  })

  it('opens the textarea when the user asks to edit, rather than editing inside the preview', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // Opened from the preview it now starts in, the editor is still reached through Code: the view moves
    // before the field arrives, so the pane never tries to type into a rendering.
    await userEvent.click(await screen.findByLabelText('Edit this file'))

    // Edit mode is Code mode: the field is there, and the preview — read-only by construction — is not.
    const area = (await screen.findByLabelText('Edit notes.md')) as HTMLTextAreaElement
    expect(area.value).toBe(MD_SOURCE)
    expect(previewOf(container)).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(gutterOf(container)).not.toBeNull()

    // And with the editor open the choice is not offered at all: Preview would have to leave edit mode
    // to keep its own promise, so it is withdrawn rather than left to answer a click it cannot honour.
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull()
  })

  it('says so when there is nothing to render, rather than borrowing the chat’s thinking state', async () => {
    stubViewer(MD_PATH, '')
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // The chat's renderer answers an empty content with "Thinking…", which is a sentence about a
    // stream. A file the user opened is not a stream, so the viewer answers for itself.
    expect(previewOf(container)?.textContent).toBe('This file is empty.')
    expect(screen.queryByText('Thinking…')).toBeNull()
  })
})

describe('the renderer the preview inherits', () => {
  it('does not hand the file’s markup to the document', async () => {
    stubViewer(MD_PATH, PAYLOAD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // The heading is rendered, so the file genuinely went through the renderer rather than being
    // dropped — the assertions below are about a preview that ran, not about one that did not.
    expect(previewOf(container)?.querySelector('h1')?.textContent).toBe('Pic')

    // The safety claim, made against the document: the chat's renderer takes no raw HTML (there is no
    // `rehype-raw` in its pipeline) and sanitizes URLs, so the payload's handler is not an attribute
    // anywhere and no element carries a script URL. No `dangerouslySetInnerHTML` was added for this —
    // the preview is the same `<Markdown>` the chat has always trusted.
    expect(handlerAttributes(container)).toEqual([])
    expect(scriptUrls(container)).toEqual([])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()

    // The raw markup is not dropped either — it is shown, as the characters the file contains, which is
    // what the chat shows for the same input. Escaped text has no handler to fire; this is the half of
    // the claim the attribute scan above cannot make on its own.
    expect(previewOf(container)?.textContent).toContain('<img src=x onerror="alert(1)">')
    // Asserted on the serialized markup rather than on the attribute text, which appears either way: an
    // element would be written as `<img …`, while escaped characters are written as `&lt;img …`. This is
    // the one assertion that tells the two apart.
    expect(container.innerHTML).not.toContain('<img')
  })

  it('renders a pipe table as a real table, with the fixture’s own rows and cells', async () => {
    stubViewer(MD_PATH, TABLE_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    /*
      This case used to pin the opposite claim, and the history is worth keeping. `remark-gfm` was not in
      the dependency tree, so a pipe table arrived as a paragraph of literal text and the assertion said
      so — deliberately, because the promise this preview makes is "what the chat renders", and a preview
      that quietly supported tables the chat did not would have been a second renderer wearing the first
      one's name.

      The gap has since been closed the way that comment said it should be: one plugin added to the shared
      renderer in `markdown.tsx`, so both surfaces gained GFM together rather than this pane gaining a
      parser of its own. The contract is a real table now, and the counts below are stated rather than
      summed up as "a table element appeared": `TABLE_SOURCE` is one header row and one body row of two
      cells each, and the assertion is made against exactly that.
    */
    const table = previewOf(container)?.querySelector('table')
    expect(table).not.toBeNull()

    expect(table?.querySelectorAll('thead tr')).toHaveLength(1)
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(1)
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((cell) => cell.textContent)).toEqual(['Name', 'Value'])
    expect([...(table?.querySelectorAll('tbody td') ?? [])].map((cell) => cell.textContent)).toEqual(['alpha', '1'])

    // And the pipes are gone from the text: the characters that used to be on screen are markup now,
    // which is the half of the claim the element counts above cannot make on their own.
    expect(table?.textContent).not.toContain('|')
  })

  it('renders a task list as a disabled checkbox per item, because a box here is a reading of one', async () => {
    stubViewer(MD_PATH, TASK_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // A disabled checkbox is the whole of the claim: an item's state is drawn, not offered as a control,
    // so the rendering cannot disagree with the file the user is reading. This pane is read-only by
    // construction, and this assertion is what keeps a ticked box from becoming a toggle.
    const boxes = [...(previewOf(container)?.querySelectorAll('li input[type="checkbox"]') ?? [])] as HTMLInputElement[]
    expect(boxes).toHaveLength(2)
    expect(boxes.map((box) => box.disabled)).toEqual([true, true])
    // And they carry the file's own ticks rather than a default.
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    expect(previewOf(container)?.textContent).toContain('shipped')
  })

  it('renders strikethrough as a del element rather than as its tildes', async () => {
    stubViewer(MD_PATH, DEL_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    expect(previewOf(container)?.querySelector('del')?.textContent).toBe('removed')
    // The markers are gone: this is a rendering of the line, not the line with its syntax still on it.
    expect(previewOf(container)?.textContent).not.toContain('~~')
  })

  it('renders an autolink as an anchor carrying the literal href', async () => {
    stubViewer(MD_PATH, AUTOLINK_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // The URL is both the link and its text, and the href is asserted literally because the inherited
    // sanitizer is what stands between a file's characters and an attribute: a link that survived it is
    // the evidence that the same url transform runs over the constructs GFM newly parses.
    const anchor = previewOf(container)?.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com/gfm-autolink')
    expect(anchor?.textContent).toBe('https://example.com/gfm-autolink')
    // Bare in the source and a link in the render, which is the whole of what GFM's autolink adds.
    expect(previewOf(container)?.textContent).toContain('See https://example.com/gfm-autolink for the details.')
  })

  it('does not run the payload a table cell carries either', async () => {
    stubViewer(MD_PATH, TABLE_PAYLOAD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await markdownPreview(container)

    // The table is real, so the cell genuinely went through the newly-parsed construct rather than being
    // skipped — the assertions below are about a rendering that ran.
    expect(previewOf(container)?.querySelector('table')).not.toBeNull()

    // The same document-wide claims as the fixture above, made again because a cell is a new place for a
    // file's characters to land: no handler attribute anywhere, no `img`, no script.
    expect(handlerAttributes(container)).toEqual([])
    expect(scriptUrls(container)).toEqual([])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()

    // And the markup is inert text inside the cell, on the same element-versus-text distinction the
    // fixture above makes: an element would serialize as `<img`, escaped characters as `&lt;img`.
    expect(previewOf(container)?.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(container.innerHTML).not.toContain('<img')
  })
})
