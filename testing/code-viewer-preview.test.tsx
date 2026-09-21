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
 * markdown file and absent for every other path, that Code is what is on screen until the user says
 * otherwise, that Preview replaces the numbered, tokenized read view with a rendering of the same
 * characters, that returning to Code puts both back, that entering edit mode lands in the editor
 * rather than in the preview, and that the renderer the chat already trusts is the only thing that
 * turns those characters into elements.
 *
 * The safety case is asserted last and hardest, because it is the one an inheritance claim could get
 * wrong: the payload is a fixture, and the assertion is made against the *document* — no element may
 * carry an event-handler attribute, and nothing anywhere may carry a `javascript:` URL.
 */

const ROOT = 'C:/w'
const MD_PATH = 'C:/w/notes.md'
const TEXT_PATH = 'C:/w/index.php'
const DISK_MTIME = 1_700_000_000_000

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

/** A piped table, the one construct whose support depends on the renderer's own plugins. */
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
  it('opens a markdown file in Code, and renders the source with its gutter and tokens', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await readView(container)

    // Code is the default, so a markdown file looks exactly as it did before this toggle existed: the
    // numbered read view, with the file's characters and their tokens.
    expect(toggle().code.getAttribute('aria-pressed')).toBe('true')
    expect(toggle().preview.getAttribute('aria-pressed')).toBe('false')
    expect(gutterOf(container)).not.toBeNull()
    expect(tokenSpans(container)).toBeGreaterThan(0)
    // Nothing is being rendered as markdown yet, so no heading element exists.
    expect(container.querySelector('h1')).toBeNull()
    expect(previewOf(container)).toBeNull()
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
    await readView(container)

    await userEvent.click(toggle().preview)

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

  it('puts the gutter and the tokens back when the user switches to Code', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await readView(container)

    await userEvent.click(toggle().preview)
    await userEvent.click(toggle().code)

    // Both halves of the Code view are back, and the rendering is gone — the switch is a view, not a
    // one-way door, and neither view leaves anything of the other behind.
    expect(previewOf(container)).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(gutterOf(container)).not.toBeNull()
    expect(tokenSpans(container)).toBeGreaterThan(0)
    // The same characters in both views: the numbers count the file, not the render.
    expect(gutterOf(container)?.textContent?.split('\n')).toHaveLength(MD_SOURCE.split('\n').length)
  })

  it('opens the textarea when the user asks to edit, rather than editing inside the preview', async () => {
    stubViewer(MD_PATH, MD_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await readView(container)

    await userEvent.click(toggle().preview)
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
    await readView(container)

    await userEvent.click(toggle().preview)

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
    await readView(container)

    await userEvent.click(toggle().preview)

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

  it('renders a pipe table exactly as the chat does: as its text, because neither has a GFM plugin', async () => {
    stubViewer(MD_PATH, TABLE_SOURCE)
    useWorkbenchStore.setState({ selectedFile: MD_PATH })
    const { container } = renderViewer()
    await readView(container)

    await userEvent.click(toggle().preview)

    /*
      `remark-gfm` is not in the dependency tree, so the shared renderer does not turn a pipe table into
      table elements — the rows arrive as a paragraph of literal text, measured directly against
      `react-markdown` before this test was written. Pinned here rather than left to whichever branch
      the assertion happened to take, because the claim this preview makes is "what the chat renders",
      not "a richer rendering than the chat": a preview that quietly supported tables the chat did not
      would be a second renderer wearing the first one's name.

      A failure here means the shared renderer gained GFM support — good news, and the fix is to assert
      the table instead. Closing the gap properly is one dependency added to `markdown.tsx`, so both
      surfaces gain it together, not to this branch.
    */
    expect(previewOf(container)?.querySelector('table')).toBeNull()
    expect(previewOf(container)?.textContent).toContain('| Name | Value |')
    expect(previewOf(container)?.textContent).toContain('alpha')
  })
})
