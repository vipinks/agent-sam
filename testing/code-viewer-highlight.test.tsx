import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { MAX_HIGHLIGHT_BYTES } from '@/app/components/workbench/highlight'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The viewer's highlighting, as wiring rather than as rules.
 *
 * Which language a path is, and whether it is worth tokenizing, are tested without a DOM in
 * `highlight-rules.test.ts`. What only a DOM test can see is whether the tokens reach the read view:
 * that a real snippet comes back as token spans, that a file past the cap is deliberately left plain
 * and says so, and that the diff stays untokenized. The editor is the third view in that list and no
 * longer belongs to it: it now carries tokens of its own, in a backdrop behind the textarea, which is
 * the subject of `code-viewer-backdrop.test.tsx`. What is left to assert here is the boundary that
 * turn drew — the tokens are the backdrop's, and the field still holds the raw source.
 *
 * The class names are highlight.js's own public API (`hljs-keyword`, `hljs-string`), so asserting on
 * them is asserting on the contract the stylesheet also keys off; a rename there would break the theme
 * too, which is exactly the coupling worth pinning.
 *
 * Rendered under the app's own `queryClient`, because the conveyor client captures that instance at
 * construction. It is cleared between tests.
 */

const ROOT = 'C:/w'
const PHP_PATH = 'C:/w/index.php'
const DIFF_PATH = 'src/app.ts'
const DISK_MTIME = 1_700_000_000_000

/** A small PHP file: well under the synchronous threshold, so it highlights on the first render. */
const PHP_SOURCE = '<?php\n\n$name = "sam";\nreturn $name;\n'

/** A file past the cap: measured in bytes, so ASCII padding is the honest way to build one. */
const OVERSIZED = `<?php\n${'x'.repeat(MAX_HIGHLIGHT_BYTES)}`

/**
 * A file inside the deferred band: over the synchronous threshold and under the cap, so its tokens
 * arrive after the render that asked for them rather than during it.
 *
 * Built from real PHP rather than padding, so the deferred result is a tokenized file and not an empty
 * one — the point of the case is that the *same* content goes from plain to tokenized.
 */
const DEFERRED = `<?php\n${'// a line of source\n'.repeat(6_000)}return 1;\n`

/** The viewer with one file open, and whatever else the case needs. */
function stubViewer(options: { path: string; content: string; diff?: unknown }): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => ({ path: options.path, content: options.content, baselineMtime: DISK_MTIME }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () =>
      options.diff ?? {
        lines: [
          { kind: 'removed', text: 'const a = 1' },
          { kind: 'added', text: 'const a = 2' },
        ],
        added: 1,
        removed: 1,
        truncated: false,
      },
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
  const code = await waitFor(() => {
    const found = container.querySelector('code')
    if (found === null) throw new Error('the read view has not rendered yet')
    return found
  })
  return code
}

/** Every token span highlight.js emitted, whichever kind. */
function tokenSpans(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="hljs-"]')]
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

describe('the read view', () => {
  it('renders a php snippet as token spans, with a keyword and a string among them', async () => {
    stubViewer({ path: PHP_PATH, content: PHP_SOURCE })
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()

    const code = await readView(container)
    // The container carries `hljs`, which is what scopes the theme's token colours to this element.
    expect(code.className).toContain('hljs')

    const keywords = [...container.querySelectorAll<HTMLElement>('.hljs-keyword')]
    expect(keywords.map((el) => el.textContent)).toContain('return')

    const strings = [...container.querySelectorAll<HTMLElement>('.hljs-string')]
    expect(strings.map((el) => el.textContent)).toContain('"sam"')

    // The `<` of `<?php` is escaped rather than injected as markup: the tokens are spans, not HTML.
    expect(code.querySelector('.hljs-meta')?.textContent).toBe('<?php')
    expect(container.querySelector('meta')).toBeNull()
  })

  it('skips a file past the cap, renders it plain, and says why', async () => {
    stubViewer({ path: PHP_PATH, content: OVERSIZED })
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()

    // The note is the whole reason the skip is visible rather than looking like a broken highlighter.
    expect(await screen.findByText(/not highlighted/i)).toBeTruthy()
    expect(screen.getByText(/512 KB/)).toBeTruthy()

    const code = await readView(container)
    // Plain: not one token span, and the source is still readable in full.
    expect(tokenSpans(container)).toHaveLength(0)
    expect(code.textContent?.startsWith('<?php')).toBe(true)
    expect(code.textContent?.length).toBeGreaterThan(MAX_HIGHLIGHT_BYTES)
  })

  it('shows a mid-sized file plain first, then its tokens once they arrive', async () => {
    stubViewer({ path: PHP_PATH, content: DEFERRED })
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()

    // The content really is in the deferred band, so this is the branch under test rather than an
    // accident of how fast the machine is.
    expect(DEFERRED.length).toBeGreaterThan(64 * 1024)
    expect(DEFERRED.length).toBeLessThan(MAX_HIGHLIGHT_BYTES)

    // Plain on the render that asked for it: the pane has painted readable text, and the tokenizing
    // has not run. Nothing is missing from the screen — only its colour.
    const code = await readView(container)
    expect(code.textContent?.startsWith('<?php')).toBe(true)
    expect(tokenSpans(container)).toHaveLength(0)

    // Then the tokens land, without the content having moved underneath the user.
    await waitFor(() => expect(tokenSpans(container).length).toBeGreaterThan(0))
    expect(container.querySelector('.hljs-meta')?.textContent).toBe('<?php')
  })

  it('leaves a language the viewer does not know plain, and does not apologize for it', async () => {
    stubViewer({ path: 'C:/w/notes.rst', content: 'Title\n=====\n' })
    useWorkbenchStore.setState({ selectedFile: 'C:/w/notes.rst' })
    const { container } = renderViewer()

    const code = await readView(container)
    expect(tokenSpans(container)).toHaveLength(0)
    expect(code.textContent).toBe('Title\n=====\n')
    // A file that was never going to be highlighted is not a file that was skipped.
    expect(screen.queryByText(/not highlighted/i)).toBeNull()
  })
})

describe('the views that stay plain', () => {
  it('keeps the editor’s tokens behind the textarea, with the field holding the raw source', async () => {
    stubViewer({ path: PHP_PATH, content: PHP_SOURCE })
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)

    await userEvent.click(await screen.findByLabelText('Edit this file'))
    const area = (await screen.findByLabelText('Edit index.php')) as HTMLTextAreaElement

    // A textarea cannot hold markup, and must not try: the buffer is the raw source, and the only thing
    // the user types into.
    expect(area.value).toBe(PHP_SOURCE)
    expect(container.querySelectorAll('textarea, input')).toHaveLength(1)

    // The tokens exist, and they are not in the field: they are a hidden layer behind it. Without the
    // textarea's own text transparent the layer would be invisible, which the backdrop suite asserts.
    const backdrop = container.querySelector('[data-slot="code-backdrop"]')
    expect(backdrop).not.toBeNull()
    expect(tokenSpans(backdrop as HTMLElement).length).toBeGreaterThan(0)
    expect(area.contains(backdrop)).toBe(false)
  })

  it('keeps the diff’s add and remove colouring, with no syntax tokens in it', async () => {
    stubViewer({ path: DIFF_PATH, content: 'const a = 2\n' })
    useWorkbenchStore.setState({ selectedChange: { path: DIFF_PATH, side: 'unstaged' } })
    const { container } = renderViewer()

    await screen.findByText(/1 added, 1 removed/)

    // The two halves of the requirement, asserted separately: the row is still coloured by what it
    // *is* ...
    const added = screen.getByText(/const a = 2/).closest('div')
    const removed = screen.getByText(/const a = 1/).closest('div')
    expect(added?.className).toMatch(/text-success/)
    expect(removed?.className).toMatch(/text-destructive/)

    // ... and nothing in the diff was tokenized, which is the regression this guards.
    expect(tokenSpans(container)).toHaveLength(0)
  })
})
