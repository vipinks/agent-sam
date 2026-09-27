/**
 * The tiles a transcript draws for the images a turn carried: their footprint, and what sits under them.
 *
 * The wiring is the neighbouring file's business (`transcript-images.test.tsx`: which reference is read,
 * and which sentence a miss or a refusal becomes). What is pinned here is the shape the user actually
 * looks at — a sent message's images are 96px tiles in a wrapping row, each with the name and the size
 * captioned beneath it, and a reference that could not be drawn keeps its wording at the same footprint
 * so a row of tiles never changes size when one of them fails.
 *
 * jsdom lays nothing out, so a `h-24 w-24` here is the class and not a measured box, and the acceptance is
 * the user's eyes on both themes. What this file can do is fail when the classes or the caption structure
 * go away, which is the half of that acceptance a test can hold.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { IMAGE_ATTACH_MISSING_NOTICE, attachmentTooLargeNotice } from '@/conveyor/protocol/image-attachments'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own measurements, so without these
 * every read is 0, no row renders, and the tiles under test are never mounted. The same stubs the
 * neighbouring suite installs, and for the same reason.
 */
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  for (const [property, value] of [
    ['offsetWidth', 900],
    ['offsetHeight', 800],
  ] as const) {
    Object.defineProperty(proto, property, { configurable: true, get: () => value })
  }
})

beforeEach(() => {
  // The code viewer's open file lives in the workbench store, which outlives a test.
  useWorkbenchStore.setState({ selectedFile: null })
})

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** Two references, with two different sizes so the caption is read rather than matched by luck. */
const FIRST_IMAGE = { id: 'ref-a', name: 'shot-a.png', mimeType: 'image/png', size: 64 }
const SECOND_IMAGE = { id: 'ref-b', name: 'shot-b.png', mimeType: 'image/png', size: 128 }

function savedTranscript(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'look at these two', steps: [], imageRefs: [FIRST_IMAGE, SECOND_IMAGE] },
      { id: 'assistant-2', role: 'assistant', content: 'A red box and a blue one.', steps: [] },
    ],
  }
}

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'two screenshots',
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

function stubBridge(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    loadTranscript: () => savedTranscript(),
    // A read that answers, so the two tiles under test are the ones that could be drawn at all. A test
    // wanting a placeholder replaces this handler with a throw.
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

/** The tiles a sent message draws, in the order the turn attached them. */
function tiles(): HTMLElement[] {
  return [...document.querySelectorAll('[data-slot="attachment-ref-chip"]')] as HTMLElement[]
}

/** Wait for the stored conversation to be on screen, which is when its tiles exist. */
async function openTranscript(): Promise<void> {
  await screen.findByText('look at these two')
  await waitFor(() => expect(tiles().length).toBe(2))
}

/** The class list of an element, as the assertion below reads it. */
function classesOf(element: Element | null): string {
  return element instanceof HTMLElement ? element.className : ''
}

describe('the tiles a sent message draws', () => {
  it('draws each image as a 96px tile, with its name and size captioned beneath', async () => {
    stubBridge()
    renderChat()
    await openTranscript()

    const row = document.querySelector('[data-slot="attachment-ref-chip-row"]')
    expect(row).toBeTruthy()
    // A wrapping row rather than a line: four tiles at 96px do not fit beside one narrow message, and the
    // row is what lets them fall onto a second line instead of being clipped.
    expect(classesOf(row)).toContain('flex-wrap')

    for (const [index, tile] of tiles().entries()) {
      const expected = [FIRST_IMAGE, SECOND_IMAGE][index]
      const picture = tile.querySelector('img')
      expect(picture).toBeTruthy()
      // 96px is h-24 w-24 in this app's scale, and `object-cover` is what fills the tile with a screenshot
      // of any shape instead of letter-boxing it.
      expect(classesOf(picture)).toContain('h-24')
      expect(classesOf(picture)).toContain('w-24')
      expect(classesOf(picture)).toContain('object-cover')
      expect((picture as HTMLImageElement).src).toContain(`data:image/png;base64,${expected.id}`)

      // The picture is the tile's first row and the caption its second, which is what `beneath` means.
      expect(tile.firstElementChild).toBe(picture)
      const caption = tile.querySelector('[data-slot="attachment-tile-caption"]')
      expect(caption).toBeTruthy()
      expect(tile.lastElementChild).toBe(caption)
      expect(caption?.textContent).toContain(expected.name)
      expect(caption?.textContent).toContain(`${expected.size} bytes`)
    }
  })

  it('says a reference is gone, at the same tile footprint', async () => {
    stubBridge({
      readDataUrl: () => {
        throw new ConveyorError('IMAGE_ATTACH_NOT_FOUND', 'This image is no longer stored.')
      },
    })
    renderChat()
    await openTranscript()

    for (const [index, tile] of tiles().entries()) {
      const expected = [FIRST_IMAGE, SECOND_IMAGE][index]
      // Nothing to draw, and nothing pretending to be a picture: the tile is the placeholder.
      expect(tile.querySelector('img')).toBeNull()
      const box = tile.firstElementChild
      expect(classesOf(box)).toContain('h-24')
      expect(classesOf(box)).toContain('w-24')
      // The store's own sentence, visible rather than hidden in a tooltip, and the name still there above it.
      expect(tile.textContent).toContain(IMAGE_ATTACH_MISSING_NOTICE)
      expect(tile.textContent).toContain(expected.name)
      expect(tile.querySelector('[data-slot="attachment-tile-caption"]')).toBeTruthy()
    }
    // And the conversation around the tiles is untouched.
    expect(screen.getByText('A red box and a blue one.')).toBeTruthy()
  })

  it('says a reference is over the cap, at the same tile footprint', async () => {
    stubBridge({
      readDataUrl: () => {
        throw new ConveyorError('IMAGE_ATTACH_REFUSED', attachmentTooLargeNotice())
      },
    })
    renderChat()
    await openTranscript()

    for (const tile of tiles()) {
      expect(tile.querySelector('img')).toBeNull()
      expect(classesOf(tile.firstElementChild)).toContain('h-24')
      expect(classesOf(tile.firstElementChild)).toContain('w-24')
      // The cap's own sentence, which is the same one a write would be refused with.
      expect(tile.textContent).toContain('An image can be at most 8 MB.')
      expect(tile.textContent).not.toContain('no longer stored')
    }
  })
})
