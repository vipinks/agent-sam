import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkspaceChangeInvalidation } from '@/app/components/workbench/use-workspace-changes'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The viewer with an image open.
 *
 * Which names are images, how big one may be, and what the bytes come back as are decided in main and
 * tested there against real files (`tests/workspace/image-read-test.ts`). What only a DOM test can see
 * is what the pane does with that result: the bytes become one `img` and nothing else, the three parts
 * that belong to a text file — the field, the gutter behind it and the tokens behind that — are absent
 * rather than empty, and a failed image read lands on the state the pane already had for a file it
 * cannot open.
 *
 * The svg case carries the security half, asserted where it can actually fail. Main refuses to send
 * markup — the svg travels base64 in a data URL — and the renderer must never take those bytes and hand
 * them to the DOM as a document. An `img` cannot run what it shows; `dangerouslySetInnerHTML` can, and
 * the assertion that no `svg` or `script` element exists is what keeps the two from being confused.
 *
 * Mounted with the workspace-change subscription, because that lives at the workbench rather than in
 * the viewer: rendering the viewer alone would leave the refetch case with no listener at all.
 */

const ROOT = 'C:/w'
const PNG_PATH = 'C:/w/logo.png'
const SVG_PATH = 'C:/w/icon.svg'
const DISK_MTIME = 1_700_000_000_000

/** A png data URL, and the byte count main would report for the file behind it. */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
const PNG_BYTES = 2048

/**
 * An svg carrying both a script and an inline handler, base64 encoded.
 *
 * The markup is spelled out below and the fixture is asserted to decode back to it, so this is
 * genuinely the dangerous document rather than a string that merely looks like a data URL.
 */
const SVG_MARKUP = '<svg onload="alert(1)"><script>alert(1)</script></svg>'
const SVG_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+'

/** An image read, as main shapes it: a kind the text result does not carry, and no text content. */
function imageResult(options: { path: string; mime: string; dataUrl: string; bytes: number }) {
  return {
    kind: 'image',
    mime: options.mime,
    dataUrl: options.dataUrl,
    bytes: options.bytes,
    path: options.path,
    baselineMtime: DISK_MTIME,
  }
}

const pngResult = { path: PNG_PATH, mime: 'image/png', dataUrl: PNG_DATA_URL, bytes: PNG_BYTES }

function stubViewer(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => imageResult(pngResult),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT })
  setActiveStub(stub)
  return stub
}

function ViewerUnderChangeSubscription() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  useWorkspaceChangeInvalidation(selectedFile)
  return <CodeViewer />
}

function renderViewer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ViewerUnderChangeSubscription />
    </QueryClientProvider>
  )
}

/** The image, once the read has landed. */
async function openImage(container: HTMLElement, alt: string): Promise<HTMLImageElement> {
  return waitFor(() => {
    const found = container.querySelector('img')
    if (found === null) throw new Error(`the image has not rendered yet (expected alt ${alt})`)
    return found
  })
}

/** How many times the read path has been asked for the open file. */
function reads(stub: BridgeStub): number {
  return stub.callsTo('workspace').filter((call) => call.method === 'readFile').length
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

describe('an image in the viewer', () => {
  it('is one img of the read bytes, and none of the text pane’s parts', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: PNG_PATH })
    const { container } = renderViewer()

    const image = await openImage(container, 'logo.png')

    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(image.getAttribute('src')).toBe(PNG_DATA_URL)
    // The file name, so the image is announced as the file it is.
    expect(image.getAttribute('alt')).toBe('logo.png')

    // The three things a text file gets, and an image does not: the field it would be typed into, the
    // numbers beside it, and the tokens behind it.
    expect(container.querySelectorAll('textarea, input')).toHaveLength(0)
    expect(container.querySelector('[data-slot="code-gutter"]')).toBeNull()
    expect(container.querySelector('[data-slot="code-backdrop"]')).toBeNull()
    // Not even a read view: there is no text to render, so nothing renders text.
    expect(container.querySelector('code')).toBeNull()

    // And no edit toggle — not even the disabled `read-only` fallback, which would be a claim about a
    // file the viewer could not edit rather than about one an editor has nothing to hold.
    expect(screen.queryByLabelText('Edit this file')).toBeNull()
    expect(screen.queryByLabelText('Save file')).toBeNull()
    expect(screen.queryByText('read-only')).toBeNull()
  })

  it('is captioned with its media type and its size in bytes', async () => {
    stubViewer()
    useWorkbenchStore.setState({ selectedFile: PNG_PATH })
    const { container } = renderViewer()
    await openImage(container, 'logo.png')

    // The caption is the viewer's only statement about what it is showing, so it names the type main
    // decided on and the size main measured — not the data URL's length, which is a third larger.
    expect(screen.getByText('image/png · 2.0 KB')).toBeTruthy()
  })

  it('keeps an svg out of the document, as a source an img cannot execute', async () => {
    // The fixture is the dangerous document, not merely a data-url-shaped string.
    expect(atob(SVG_DATA_URL.split(',')[1])).toBe(SVG_MARKUP)

    stubViewer({
      readFile: () =>
        imageResult({ path: SVG_PATH, mime: 'image/svg+xml', dataUrl: SVG_DATA_URL, bytes: SVG_MARKUP.length }),
    })
    useWorkbenchStore.setState({ selectedFile: SVG_PATH })
    const { container } = renderViewer()

    const image = await openImage(container, 'icon.svg')

    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(image.getAttribute('src')).toBe(SVG_DATA_URL)
    // The assertion the whole branch exists for: the svg is a source for an image decoder, so the
    // script in it never becomes an element. Asserted on the file's *own* markup rather than on "no svg
    // anywhere", because the chrome around it is drawn with svg icons of its own — and scoped to the
    // image's own region, because the panel's controls are drawn with one that carries a `<rect>` too.
    // The `<rect>` that matters is the fixture's, so finding one in the region the file is drawn in
    // would mean the document had been parsed.
    const region = container.querySelector<HTMLElement>('[data-slot="image"]')
    expect(region, 'the image region').not.toBeNull()
    expect(region?.querySelector('rect')).toBeNull()
    expect(region?.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('alert(1)')
    expect(container.textContent).not.toContain('alert(1)')
  })

  it('shows the existing not-found state when the image is gone', async () => {
    stubViewer({
      readFile: () => {
        throw new ConveyorError('FILE_UNAVAILABLE', 'This file could not be read.')
      },
    })
    useWorkbenchStore.setState({ selectedFile: PNG_PATH })
    const { container } = renderViewer()

    // A deleted image is the code the pane has always branched on, so it says exactly what it says for
    // a text file that went away — nothing new was invented for images here.
    expect(await screen.findByText('This file could not be opened')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports an image over the cap as too large, by code, and shows no img', async () => {
    stubViewer({
      readFile: () => {
        throw new ConveyorError('IMAGE_TOO_LARGE', 'logo.png is 3.0 MB — the viewer caps images at 2 MB.')
      },
    })
    useWorkbenchStore.setState({ selectedFile: PNG_PATH })
    const { container } = renderViewer()

    // Branched on the code: the wording is the renderer's, and main's is free to change.
    expect(await screen.findByText(/caps images at 2 MB/i)).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    // Still an image as far as the pane is concerned, so the editor stays away: the cap is why there are
    // no bytes, and an editor over an unread picture would overwrite something nobody has seen. The
    // refusal is visible rather than the toggle merely missing.
    expect(screen.queryByLabelText('Edit this file')).toBeNull()
    expect(screen.getByText('read-only')).toBeTruthy()
  })
})

describe('a change on disk', () => {
  it('refetches an image exactly as it refetches text', async () => {
    const stub = stubViewer()
    useWorkbenchStore.setState({ selectedFile: PNG_PATH })
    const view = renderViewer()
    await openImage(view.container, 'logo.png')

    const before = reads(stub)
    // What main broadcasts after the file is written, and the read it triggers. The invalidation is
    // keyed by path and knows nothing about kinds, which is the property under test.
    stub.emit('conveyor:event:workspace:onChanged', { kind: 'written', path: PNG_PATH })
    // The burst is coalesced, so give the window a chance to close before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200))

    await waitFor(() => expect(reads(stub)).toBeGreaterThan(before))
    expect(await openImage(view.container, 'logo.png')).toBeTruthy()
  })
})
