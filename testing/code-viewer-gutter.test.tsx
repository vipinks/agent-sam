import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The line-number gutter, as wiring rather than as rules.
 *
 * What a gutter *is* — one number per line, CRLF counted once, no phantom line under the last number —
 * is settled without a DOM in `gutter-rules.test.ts`. What only a rendered viewer can show is the part
 * the rules cannot promise: that the read view puts a gutter beside the code rather than inside it,
 * that the numbers are in the same scroll container as the source so the two cannot drift apart, that
 * the highlighted and plain branches both get one, and that edit mode's gutter follows the textarea's
 * scroll position rather than the buffer's first line.
 *
 * The gutter is located by its slot rather than by its position in the tree, because its position is
 * exactly what some of these cases assert — a query that hardcoded "the second child" would pass while
 * the numbers sat somewhere else entirely.
 */

const ROOT = 'C:/w'
const PHP_PATH = 'C:/w/index.php'
const PLAIN_PATH = 'C:/w/notes.rst'
const DISK_MTIME = 1_700_000_000_000

/**
 * Five line boxes: the four lines of the file plus the empty one its trailing newline opens, which is
 * what the pane shows and therefore what the numbers have to say.
 */
const PHP_SOURCE = '<?php\n\n$name = "sam";\nreturn $name;\n'
/** The same shape in a language the viewer has no grammar for, so the plain branch is what renders. */
const PLAIN_SOURCE = 'Title\n=====\nBody\n'

/** The numbers a buffer of N line boxes is numbered with, independently of the helper under test. */
function numbersUpto(lines: number): string[] {
  return Array.from({ length: lines }, (_, i) => String(i + 1))
}

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
function gutterOf(container: HTMLElement): HTMLElement {
  const gutter = container.querySelector<HTMLElement>('[data-slot="code-gutter"]')
  if (gutter === null) throw new Error('no gutter rendered')
  return gutter
}

/** The numbers the gutter is showing, as the lines they are laid out on. */
function gutterNumbers(container: HTMLElement): string[] {
  return gutterOf(container).textContent?.split('\n') ?? []
}

/** Enter edit mode and hand back the textarea. */
async function startEditing(fileName: string): Promise<HTMLTextAreaElement> {
  await userEvent.click(await screen.findByLabelText('Edit this file'))
  return (await screen.findByLabelText(`Edit ${fileName}`)) as HTMLTextAreaElement
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
  it('numbers every line of a file it does not tokenize', async () => {
    stubViewer(PLAIN_PATH, PLAIN_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PLAIN_PATH })
    const { container } = renderViewer()
    await readView(container)

    // The plain branch: no tokens, and still one number per line box of the fixture.
    expect(container.querySelectorAll('[class*="hljs-"]')).toHaveLength(0)
    expect(gutterNumbers(container)).toEqual(numbersUpto(PLAIN_SOURCE.split('\n').length))
  })

  it('shows the gutter and the token spans together', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)

    // The tokens are what the code carries ...
    expect(container.querySelectorAll('[class*="hljs-"]').length).toBeGreaterThan(0)
    // ... and the numbers are beside them, complete, one per line box of the same fixture.
    expect(gutterNumbers(container)).toEqual(numbersUpto(PHP_SOURCE.split('\n').length))
  })

  it('puts the gutter and the code in one scroll container, so they cannot desync', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    const code = await readView(container)

    const gutter = gutterOf(container)
    // One scroller, two columns: whichever element scrolls the code is the element that holds the
    // numbers, so there is one scroll position rather than two that would have to be kept in step.
    const scroller = gutter.closest('.overflow-auto')
    expect(scroller).not.toBeNull()
    expect(code.closest('.overflow-auto')).toBe(scroller)
    // And neither column wraps: a line of code is one line of numbers.
    expect(gutter.className).toMatch(/\bwhitespace-pre\b/)
  })

  it('keeps the numbers out of the code, and out of the reader’s way', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    const code = await readView(container)
    const gutter = gutterOf(container)

    // Decoration, not content: not inside the code element, hidden from assistive technology, and not
    // selectable, so dragging a selection across the pane copies the file rather than its numbering.
    expect(code.contains(gutter)).toBe(false)
    expect(gutter.getAttribute('aria-hidden')).toBe('true')
    expect(gutter.className).toMatch(/\bselect-none\b/)
    expect(code.textContent).toBe(PHP_SOURCE)
  })
})

describe('edit mode', () => {
  it('gives the textarea a gutter of its own, and grows it as a newline is typed', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    expect(gutterNumbers(container)).toEqual(numbersUpto(PHP_SOURCE.split('\n').length))

    await userEvent.type(area, '\n')
    await waitFor(() => expect(gutterNumbers(container).length).toBe(PHP_SOURCE.split('\n').length + 1))
    // The numbers are the buffer's lines: the textarea is the only thing the user typed into.
    expect(gutterNumbers(container).length).toBe(area.value.split('\n').length)
    expect(container.querySelectorAll('textarea, input')).toHaveLength(1)
    // A second field in all but name would be one the user could type numbers into.
    expect(gutterOf(container).getAttribute('contenteditable')).toBeNull()
  })

  it('stays in step when Tab inserts spaces, which add no line', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    area.setSelectionRange(0, 0)
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(area.value.startsWith('  ')).toBe(true))

    // Indenting changes the text without changing how many lines it has, and the gutter has to say so
    // rather than falling behind the buffer.
    expect(gutterNumbers(container).length).toBe(PHP_SOURCE.split('\n').length)
    expect(gutterNumbers(container).length).toBe(area.value.split('\n').length)
  })

  it('copies the textarea’s scrollTop onto the gutter whenever the textarea scrolls', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')
    const gutter = gutterOf(container)

    // jsdom has no layout, so the scroll position is set by hand and the event is fired: what is under
    // test is the wiring (the handler reads the textarea and writes the gutter), not the browser's
    // scrolling. The gutter's own box is `overflow-hidden`, which is what makes copying the offset the
    // only way it can ever move.
    area.scrollTop = 42
    fireEvent.scroll(area)
    expect(gutter.scrollTop).toBe(42)

    area.scrollTop = 0
    fireEvent.scroll(area)
    expect(gutter.scrollTop).toBe(0)
    expect(gutter.className).toMatch(/\boverflow-hidden\b/)
  })
})
