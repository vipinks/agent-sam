import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { MAX_HIGHLIGHT_BYTES } from '@/app/components/workbench/highlight'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The editor's highlighted backdrop, as wiring rather than as rules.
 *
 * What the backdrop *is* — a pre element rendering the same buffer through the same highlighter and
 * memo the read view uses, or nothing at all for a file past the cap — is decided in `highlight.ts`
 * and asserted there. What only a rendered viewer can show is the arrangement the rules cannot
 * promise: that the textarea is still the only input and the only source of truth, that its own text
 * is transparent while its caret and selection are not, that the tokens sit in a sibling element
 * behind it rather than inside it, that typing moves both, and that a file over the cap gets an opaque
 * field and the note instead of a backdrop.
 *
 * The save case is here rather than in `code-viewer-editing.test.tsx` on purpose: the requirement is
 * that the backdrop is display-only, so the guard is that the payload a save sends — path, content,
 * baseline — is untouched by the layer now sitting under the text.
 *
 * Alignment is deliberately *not* asserted. jsdom has no layout, so it cannot measure whether the
 * backdrop's glyphs sit under the textarea's; the metrics are matched by construction (the same font,
 * size, line-height, padding and wrapping, in the same box) and the pixel check is a live run.
 */

const ROOT = 'C:/w'
const PHP_PATH = 'C:/w/index.php'
const PLAIN_PATH = 'C:/w/notes.rst'
const DISK_MTIME = 1_700_000_000_000

/** A small PHP file: a keyword, a string, and under the synchronous threshold. */
const PHP_SOURCE = '<?php\n\n$name = "sam";\nreturn $name;\n'

/** A file past the cap, measured in bytes: `utf8Bytes` counts this padding one byte each. */
const OVERSIZED = `<?php\n${'x'.repeat(MAX_HIGHLIGHT_BYTES)}`

/** The viewer with one file open, and no change selected. */
function stubViewer(path: string, content: string): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => ({ path, content, baselineMtime: DISK_MTIME }),
    writeFile: () => ({ path, bytes: content.length, mtimeMs: DISK_MTIME + 999 }),
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

/** Enter edit mode and hand back the textarea. */
async function startEditing(fileName: string): Promise<HTMLTextAreaElement> {
  await userEvent.click(await screen.findByLabelText('Edit this file'))
  return (await screen.findByLabelText(`Edit ${fileName}`)) as HTMLTextAreaElement
}

/**
 * The backdrop, found by the slot the viewer marks it with, or null when there is none.
 *
 * Null rather than a throw, because "there is no backdrop" is one of the cases under test — the
 * over-cap file must not have one — and a helper that threw would turn that assertion into an error.
 */
function backdropOf(container: HTMLElement): HTMLPreElement | null {
  return container.querySelector<HTMLPreElement>('[data-slot="code-backdrop"]')
}

/** Every token span highlight.js emitted, whichever kind. */
function tokenSpans(root: HTMLElement | null): HTMLElement[] {
  return root === null ? [] : [...root.querySelectorAll<HTMLElement>('[class*="hljs-"]')]
}

const GUTTER = '[data-slot="code-gutter"]'

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('the editor’s backdrop', () => {
  it('tokenizes the buffer behind the textarea, which keeps holding the raw source', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    // The textarea is still the source of truth: the raw source, and the only field in the pane.
    expect(area.value).toBe(PHP_SOURCE)
    expect(container.querySelectorAll('textarea, input')).toHaveLength(1)

    const backdrop = backdropOf(container)
    expect(backdrop).not.toBeNull()
    if (backdrop === null) return

    // The same characters, through the same highlighter the read view uses: the tokens are the file's.
    expect(backdrop.textContent).toBe(area.value)
    expect(tokenSpans(backdrop).length).toBeGreaterThan(0)
    expect(backdrop.querySelector('.hljs-keyword')?.textContent).toBe('return')
    expect(backdrop.querySelector('.hljs-meta')?.textContent).toBe('<?php')

    // Decoration behind the field rather than a second place the text lives: hidden from assistive
    // technology, and not containing the field.
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.contains(area)).toBe(false)

    // The field's own text is transparent so the backdrop is what the eye reads, and the caret is not
    // — a transparent caret over transparent text would be an editor with no visible cursor.
    expect(area.className).toMatch(/\btext-transparent\b/)
    expect(area.className).toMatch(/\bcaret-\S+/)
  })

  it('updates the backdrop as the user types, from the same buffer the textarea holds', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    await userEvent.type(area, '// note\n')

    // One buffer, rendered twice: the field is what was typed, and the backdrop is the same string.
    await waitFor(() => expect(backdropOf(container)?.textContent).toBe(area.value))
    expect(area.value).toBe(`${PHP_SOURCE}// note\n`)
    // Still the file's tokens, so the backdrop is re-tokenized rather than frozen on the first render.
    expect(tokenSpans(backdropOf(container)).length).toBeGreaterThan(0)
  })

  it('copies the textarea’s scroll offsets onto the backdrop, as it does onto the gutter', async () => {
    stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')
    const backdrop = backdropOf(container)

    // jsdom has no layout, so the offsets are set by hand and the event is fired: what is under test is
    // the wiring. Both axes, because the field wraps off and a long line scrolls sideways.
    area.scrollTop = 42
    area.scrollLeft = 7
    fireEvent.scroll(area)

    expect(backdrop?.scrollTop).toBe(42)
    expect(backdrop?.scrollLeft).toBe(7)
    // The gutter takes the vertical offset from the same handler, which is the "same sync" the two owe.
    expect(container.querySelector<HTMLElement>(GUTTER)?.scrollTop).toBe(42)
    expect(backdrop?.className).toMatch(/\boverflow-hidden\b/)
  })

  it('leaves a file past the cap on an opaque textarea, with the note and no backdrop', async () => {
    stubViewer(PHP_PATH, OVERSIZED)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    // The skip note is the editor's own now, and says why there is no colour.
    expect(await screen.findByText(/not highlighted/i)).toBeTruthy()
    expect(screen.getByText(/512 KB/)).toBeTruthy()

    // Nothing was tokenized for the editor: a monster file pays nothing for a layer that cannot help it.
    expect(backdropOf(container)).toBeNull()
    expect(tokenSpans(container)).toHaveLength(0)
    expect(area.value).toBe(OVERSIZED)

    // Opaque, because with no backdrop a transparent field would be an invisible one.
    expect(area.className).toMatch(/\bbg-background\b/)
    expect(area.className).not.toMatch(/\btext-transparent\b/)
  })

  it('leaves a language the viewer does not know on a plain textarea, and does not apologize', async () => {
    stubViewer(PLAIN_PATH, 'Title\n=====\nBody\n')
    useWorkbenchStore.setState({ selectedFile: PLAIN_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('notes.rst')

    // No grammar means no tokens, so there is nothing for a backdrop to hold, and nothing was skipped.
    expect(backdropOf(container)).toBeNull()
    expect(area.className).toMatch(/\bbg-background\b/)
    expect(screen.queryByText(/not highlighted/i)).toBeNull()
  })
})

describe('the editing the backdrop must not disturb', () => {
  it('still saves the path, the content, and the baseline the buffer was based on', async () => {
    const stub = stubViewer(PHP_PATH, PHP_SOURCE)
    useWorkbenchStore.setState({ selectedFile: PHP_PATH })
    const { container } = renderViewer()
    await readView(container)
    const area = await startEditing('index.php')

    await userEvent.type(area, '// edit\n')
    // The dirty dot is still the buffer's, raised by the same rule as before.
    expect(await screen.findByLabelText('index.php has unsaved changes')).toBeTruthy()

    await userEvent.keyboard('{Control>}s{/Control}')

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeFile')
    // Exactly the payload the command validated before this turn: the backdrop contributes no field,
    // and no part of it is sent.
    expect(written?.args[0]).toEqual({
      path: PHP_PATH,
      content: `${PHP_SOURCE}// edit\n`,
      rootPath: ROOT,
      baselineMtime: DISK_MTIME,
    })

    // Saved is clean: the content is what the buffer holds and the dot goes out.
    await waitFor(() => expect(screen.queryByLabelText('index.php has unsaved changes')).toBeNull())
  })
})
