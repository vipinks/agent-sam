/**
 * The composer chip's thumbnail: the object URL it hands the browser, and how long that URL lives.
 *
 * Two things are pinned here that the other suites only assert in passing. The first is that the picture
 * and the bytes are the same fact: the chip draws the URL it made from the draft's own bytes, so a chip
 * that drew a URL built from nothing — or from the wrong bytes — fails here rather than in a screenshot.
 * The second is the URL's lifetime. A draft re-render is the ordinary case (every keystroke in the
 * composer is one), and a thumbnail revoked on the render that produced it, or re-made by every render,
 * is a chip the user watches flicker or break while typing.
 *
 * What this file can prove is wiring and class presence, never pixels. `URL.createObjectURL` is stubbed
 * here — jsdom defines it and throws when it is called — so a `src` below is the string a browser would
 * be handed rather than a decoded image, and a size class is the class rather than a rendered box.
 * Whether the URL then *loads* is the renderer's policy question rather than a wiring one, and it is
 * answered by loading one under the app's own `img-src` in a real Electron renderer, not by jsdom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The object-URL API, which jsdom does not implement.
 *
 * Each call hands out its own URL and every URL handed out is recorded, so a revoke below can be matched
 * to the chip that made it — and counted, which is the half of this the existing suites leave open: a URL
 * revoked twice is a URL revoked once and a second call nobody can explain.
 */
let objectUrlSequence = 0
const createdObjectUrls: string[] = []
const createObjectURL = vi.fn(() => {
  objectUrlSequence += 1
  const url = `blob:test/${objectUrlSequence}`
  createdObjectUrls.push(url)
  return url
})
const revokeObjectURL = vi.fn()

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
})

afterAll(() => {
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  createdObjectUrls.length = 0
  // The code viewer's open file lives in the workbench store, which outlives a test.
  useWorkbenchStore.setState({ selectedFile: null })
})

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'an existing conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

const IMAGE_CAPABLE_PROVIDER = {
  providers: { deepseek: { enabledModels: [], fetchedModels: [], supportsImages: true } },
  customProviders: [],
}

/** One image, as a paste, a drop or a picker would hand it over. */
function imageFile(name: string, bytes = 64, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

function stubBridge(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  let saved = 0
  const stub = createBridgeStub({
    save: (input) => {
      const request = input as { name: string; mimeType: string; bytes: Uint8Array }
      saved += 1
      return { id: `stored-${saved}`, name: request.name, mimeType: request.mimeType, size: request.bytes.byteLength }
    },
    readDataUrl: (input) => `data:image/png;base64,${(input as { id: string }).id}`,
    ...overrides,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  stubStore(stub, 'provider-config', IMAGE_CAPABLE_PROVIDER)
  setActiveStub(stub)
  return stub
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The composer, once React has mounted it. */
async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

/** The draft chips the composer is holding, in the order it attached them. */
function draftChips(): HTMLElement[] {
  return [...document.querySelectorAll('[data-slot="attachment-chip"]')] as HTMLElement[]
}

/** The picture drawn inside each of those chips, in the same order. */
function chipThumbnails(): HTMLImageElement[] {
  return [...document.querySelectorAll('[data-slot="attachment-chip"] img')] as HTMLImageElement[]
}

/** A URL JavaScript actually handed to the DOM, which is the only place a revoke can be counted. */
function revokesOf(url: string): string[] {
  return revokeObjectURL.mock.calls.map(([revoked]) => revoked as string).filter((revoked) => revoked === url)
}

describe('the composer chip’s thumbnail', () => {
  it('draws the URL it made from the draft’s bytes, and keeps it through a draft re-render', async () => {
    stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('shot.png')] } })
    await waitFor(() => expect(chipThumbnails().length).toBe(1))

    // The bytes are the chip's own, and so is the media type: one Blob per chip, built from the draft's
    // array and the type the file arrived with.
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const [blob] = createObjectURL.mock.calls[0] as unknown as [Blob]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(64)

    const url = createdObjectUrls[0]
    const image = chipThumbnails()[0]
    expect(image.src).toBe(url)
    // A chip-scale preview, which is the size the design names rather than an icon-sized glyph.
    expect(image.className).toContain('h-6')
    expect(image.className).toContain('w-6')
    expect(image.className).toContain('object-cover')

    // The draft re-render: the message the image will go with, typed one keystroke at a time. Each of
    // those is a render of the pane and of every chip in its row, and the URL has to outlive all of them.
    const area = await composer()
    await userEvent.type(area, 'look at this')
    await waitFor(() => expect(area.value).toBe('look at this'))
    expect(draftChips().length).toBe(1)

    // The same URL, on the same element: not re-made (a second create would be a second Blob and a second
    // URL to revoke), and not released (a revoke here is exactly the broken-image glyph the user reports).
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(chipThumbnails().length).toBe(1)
    expect(chipThumbnails()[0]).toBe(image)
    expect(chipThumbnails()[0].src).toBe(url)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a removed chip’s URL exactly once, and leaves the others alone', async () => {
    stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('keep.png'), imageFile('drop.png')] } })
    await waitFor(() => expect(chipThumbnails().length).toBe(2))
    expect(createObjectURL).toHaveBeenCalledTimes(2)

    const [keptUrl, droppedUrl] = createdObjectUrls
    await userEvent.click(screen.getByLabelText('Remove drop.png'))

    await waitFor(() => expect(chipThumbnails().length).toBe(1))
    // Released, and released once: the URL holds the bytes alive until it is handed back, and a second
    // revoke of the same URL is a call that says the chip's own bookkeeping is wrong.
    expect(revokesOf(droppedUrl)).toHaveLength(1)
    expect(revokesOf(keptUrl)).toEqual([])
    // And the chip that stayed is still drawing its own picture.
    expect(chipThumbnails()[0].src).toBe(keptUrl)
  })
})
