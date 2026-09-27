/**
 * The images a transcript draws, and the ones it says it cannot.
 *
 * Wiring rather than rules: the two sentences a placeholder can show come from
 * `attachments/image-attachments-send-test.ts` and main's own store, and what is left to check here is
 * whether a chip asks for the right bytes, whether a miss becomes a named placeholder rather than an
 * empty box or a crash, and whether a resend or a regenerate still says which images a turn carried.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads asserted below are
 * the ones main would receive. What this file cannot prove is pixels or IPC: jsdom lays nothing out, so
 * a thumbnail here is an `img` with a `src` in the tree rather than a picture the user sees.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own measurements, so without
 * these every read is 0 and no row renders — and the chips under test live in that list.
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

afterAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  delete proto.offsetWidth
  delete proto.offsetHeight
})

/**
 * The object-URL API, which jsdom does not implement and the composer's own draft chips need.
 *
 * The resend below drops a file into the composer, so a draft chip is built before the turn that
 * carries it: without these the drop would throw before the behavior under test was reached.
 */
let objectUrlSequence = 0
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => {
      objectUrlSequence += 1
      return `blob:test/${objectUrlSequence}`
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
})

afterAll(() => {
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

beforeEach(() => {
  // The code viewer's open file lives in the workbench store, which outlives a test.
  useWorkbenchStore.setState({ selectedFile: null })
})

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** Two references, as the store hands them back: an id, a name, a media type and a size. */
const FIRST_IMAGE = { id: 'ref-a', name: 'shot-a.png', mimeType: 'image/png' as const, size: 64 }
const SECOND_IMAGE = { id: 'ref-b', name: 'shot-b.png', mimeType: 'image/png' as const, size: 128 }
const DRAFT_STORED = { id: 'stored-1', name: 'next.png', mimeType: 'image/png' as const, size: 64 }

/** What the open conversation holds: a question with two images, and the reply to it. */
function savedTranscript(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      {
        id: 'user-1',
        role: 'user',
        content: 'look at these two',
        steps: [],
        imageRefs: [FIRST_IMAGE, SECOND_IMAGE],
      },
      { id: 'assistant-2', role: 'assistant', content: 'A red box and a blue one.', steps: [] },
    ],
  }
}

/**
 * The session list as main pushes it: the conversation on screen, and one that is not.
 *
 * The second exists for the laziness the feature promises — its own turns carry images too, and nothing
 * on screen draws them, so nothing may read them.
 */
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
    {
      id: OTHER_ID,
      title: 'a conversation not on screen',
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_001,
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

/** Install a stub answering the store's reads for the transcript above. */
function stubBridge(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    loadTranscript: () => savedTranscript(),
    // The chips' one read, answered for whichever id is asked about. A test that wants a miss or a
    // refusal replaces this one handler.
    readDataUrl: (input) => `data:image/png;base64,${(input as { id: string }).id}`,
    save: (input) => {
      const request = input as { name: string; mimeType: string }
      return { ...DRAFT_STORED, name: request.name, mimeType: request.mimeType }
    },
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

/** The reference chips a sent message draws, in the order the turn attached them. */
function refChips(): HTMLElement[] {
  return [...document.querySelectorAll('[data-slot="attachment-ref-chip"]')] as HTMLElement[]
}

/** The draft chips the composer is holding. */
function draftChips(): string[] {
  return [...document.querySelectorAll('[data-slot="attachment-chip"]')].map((chip) => chip.textContent ?? '')
}

/** The thumbnails drawn inside those chips, as the sources they were given. */
function thumbnails(): string[] {
  return [...document.querySelectorAll('[data-slot="attachment-ref-chip"] img')].map(
    (image) => (image as HTMLImageElement).src
  )
}

/** Every read the chips dispatched, as the pairs they asked for. */
function reads(stub: BridgeStub): Array<{ sessionId: string; id: string }> {
  return stub
    .callsTo('attachments')
    .filter((call) => call.method === 'readDataUrl')
    .map((call) => call.args[0] as { sessionId: string; id: string })
}

/** The messages the last dispatched run carried out of the pane. */
function dispatchedMessages(
  stub: BridgeStub
): Array<{ role: string; content: string; images?: Array<{ id: string }> }> {
  const start = [...stub.calls].reverse().find((call) => call.channel === 'conveyor:stream:start')
  const envelope = start?.args[0] as
    { input?: { messages?: Array<{ role: string; content: string; images?: Array<{ id: string }> }> } } | undefined
  return envelope?.input?.messages ?? []
}

/** The last user turn of that history, which is the turn the images belong to. */
function lastUserTurn(stub: BridgeStub) {
  const user = [...dispatchedMessages(stub)].reverse().find((message) => message.role === 'user')
  if (!user) throw new Error('no user turn was dispatched')
  return user
}

/** One image, as a drop hands it over. */
function imageFile(name: string, bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

/** Wait for the stored conversation to be on screen, which is when its chips exist. */
async function openTranscript(): Promise<void> {
  await screen.findByText('look at these two')
  await waitFor(() => expect(refChips().length).toBe(2))
}

describe('a transcript drawing the images a turn carried', () => {
  it('reads each reference and draws it as a thumbnail', async () => {
    const stub = stubBridge()
    renderChat()
    await openTranscript()

    // One read per reference, each naming the conversation and the id it is about: a chip asks for the
    // bytes behind its own reference and nothing else.
    await waitFor(() => expect(reads(stub).length).toBe(2))
    expect(reads(stub)).toEqual([
      { sessionId: SESSION_ID, id: FIRST_IMAGE.id },
      { sessionId: SESSION_ID, id: SECOND_IMAGE.id },
    ])

    // And the bytes that came back are what the chip draws, in the order the turn attached them.
    await waitFor(() => expect(thumbnails().length).toBe(2))
    expect(thumbnails()[0]).toContain(`data:image/png;base64,${FIRST_IMAGE.id}`)
    expect(thumbnails()[1]).toContain(`data:image/png;base64,${SECOND_IMAGE.id}`)
    // The name is still there beside the picture: a thumbnail of a screenshot is not its filename.
    expect(refChips()[0].textContent).toContain('shot-a.png')
  })

  it('names a reference the store no longer holds, and keeps the message', async () => {
    stubBridge({
      readDataUrl: () => {
        throw new ConveyorError('IMAGE_ATTACH_NOT_FOUND', 'This image is no longer stored.')
      },
    })
    renderChat()
    await openTranscript()

    // A reference whose bytes are gone is neither a crash nor an empty box: the chip still names the image
    // and says it is gone, in the store's own sentence.
    await waitFor(() => expect(refChips()[0].textContent).toContain('This image is no longer stored.'))
    expect(refChips()[0].textContent).toContain('shot-a.png')
    expect(refChips()[1].textContent).toContain('This image is no longer stored.')
    expect(thumbnails()).toEqual([])
    // And the conversation around it is untouched.
    expect(screen.getByText('A red box and a blue one.')).toBeTruthy()
  })

  it('says an image is over the cap rather than drawing it', async () => {
    stubBridge({
      readDataUrl: () => {
        throw new ConveyorError('IMAGE_ATTACH_REFUSED', 'An image can be at most 8 MB. This one is larger.')
      },
    })
    renderChat()
    await openTranscript()

    await waitFor(() => expect(refChips()[0].textContent).toContain('An image can be at most 8 MB.'))
    expect(refChips()[0].textContent).toContain('This one is larger.')
    // A refusal is a different fact from a miss, and is worded as one: nothing here says the image is gone.
    expect(refChips()[0].textContent).not.toContain('no longer stored')
    expect(thumbnails()).toEqual([])
  })

  it('reads only what it draws, and nothing for a conversation that is not open', async () => {
    const stub = stubBridge()
    renderChat()
    await openTranscript()
    await waitFor(() => expect(reads(stub).length).toBe(2))

    // One transcript was read — the one on screen — and every read named it. Nothing is preloaded when a
    // conversation opens, and a chip reads for the reference it is drawing and no other.
    const loads = stub.callsTo('sessions').filter((call) => call.method === 'loadTranscript')
    expect(loads.length).toBe(1)
    expect((loads[0].args[0] as { id: string }).id).toBe(SESSION_ID)
    expect(reads(stub).every((read) => read.sessionId === SESSION_ID)).toBe(true)
  })
})

describe('sending a turn again with its images', () => {
  it('resends the message’s own images and then the draft’s, in that order', async () => {
    const stub = stubBridge()
    renderChat()
    await openTranscript()

    // One image waiting in the composer, arrived the ordinary way.
    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('next.png')] } })
    await waitFor(() => expect(draftChips().length).toBe(1))

    // The edit: the message's own words are replaced and it is sent again.
    await userEvent.click(screen.getByLabelText('Edit message'))
    const editor = screen.getByLabelText('Edit message text')
    await userEvent.clear(editor)
    await userEvent.type(editor, 'look at these two instead')
    await userEvent.click(screen.getByLabelText('Save and resend'))
    // The reply that followed this message goes away with the resend, so the count is confirmed first.
    await userEvent.click(await screen.findByLabelText('Resend'))

    await waitFor(() => expect(dispatchedMessages(stub).length).toBeGreaterThan(0))
    const turn = lastUserTurn(stub)
    expect(turn.content).toBe('look at these two instead')
    // The message keeps the images it was sent with, and takes the one waiting in the draft after them.
    expect((turn.images ?? []).map((image) => image.id)).toEqual([FIRST_IMAGE.id, SECOND_IMAGE.id, DRAFT_STORED.id])
    // The draft's image was stored before it was named, like any other send's.
    const saves = stub.callsTo('attachments').filter((call) => call.method === 'save')
    expect(saves.length).toBe(1)
    expect((saves[0].args[0] as { name: string }).name).toBe('next.png')
  })

  it('regenerates from a history whose image turn still names its images', async () => {
    const stub = stubBridge()
    renderChat()
    await openTranscript()

    await userEvent.click(screen.getByLabelText('Regenerate reply'))

    await waitFor(() => expect(dispatchedMessages(stub).length).toBeGreaterThan(0))
    const turn = lastUserTurn(stub)
    expect(turn.content).toBe('look at these two')
    // The references are still on the turn the rewritten request is built from, which is what lets main
    // resolve them to parts at the request rather than send the question with its pictures missing.
    expect((turn.images ?? []).map((image) => image.id)).toEqual([FIRST_IMAGE.id, SECOND_IMAGE.id])
  })
})
