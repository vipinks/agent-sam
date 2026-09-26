import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { ATTACHMENT_ACCEPT_ATTRIBUTE } from '@/app/components/workbench/attachments'
import { IMAGE_ATTACHMENT_MIME_TYPES } from '@/conveyor/protocol/image-attachments'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The composer taking images: paste, drop, the picker, the chips, and what a send does with them.
 *
 * Wiring rather than rules. Every sentence asserted below comes from `image-attachments-capture-test.ts`
 * (the shared rules and the gate) and the numbers come from the protocol constants; what is left to check
 * here is whether the three gestures reach those rules at all, whether a chip appears and can be taken off,
 * and whether a send stores the images before it dispatches the turn that names them.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads asserted are the ones
 * main would receive. What this file cannot prove is pixels or IPC: jsdom lays nothing out and clones
 * nothing, so a chip that renders is a chip in the tree rather than a picture the user sees, and the
 * structured clone of a real `Uint8Array` across a real boundary is exercised for the first time by the
 * first paste into the running app.
 */

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 and the virtualizer renders no rows at all. The sent
 * message's reference chips live in that list, so this suite has to state the viewport a browser would
 * have measured. It says nothing about layout: no assertion here depends on a real pixel.
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
 * The object-URL API, which jsdom does not implement.
 *
 * A thumbnail needs a URL for bytes that have no file behind them, and every way a chip goes away has to
 * revoke it. Both halves are stubbed here rather than worked around in the component: a chip that drew
 * nothing because the environment could not make a URL would leave the revocation too — the leak this
 * feature has to not have — untested. Each call gets its own URL so a revoke can be matched to the URL
 * that was handed out.
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

/**
 * A session whose title is already set, so the first-send title path does not add a write.
 *
 * `providerId: 'deepseek'` is what the gate is read against, and `IMAGE_CAPABLE_PROVIDER` below is the
 * matching record: this file is about what an image-capable provider allows, and the file next door
 * (`composer-images-gate.test.tsx`) is about the same composer with the record saying nothing.
 */
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

/** Install a stub that answers an image save with a reference the renderer can carry. */
function stubBridge(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  let saved = 0
  const stub = createBridgeStub({
    save: (input) => {
      const request = input as { name: string; mimeType: string; bytes: Uint8Array }
      saved += 1
      return { id: `stored-${saved}`, name: request.name, mimeType: request.mimeType, size: request.bytes.byteLength }
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

/** The composer's draft chips, in the order they are rendered. */
function draftChips(): string[] {
  return [...document.querySelectorAll('[data-slot="attachment-chip"]')].map((chip) => chip.textContent ?? '')
}

/** The reference chips a sent message draws, in the order they were attached. */
function refChips(): string[] {
  return [...document.querySelectorAll('[data-slot="attachment-ref-chip"]')].map((chip) => chip.textContent ?? '')
}

/** How the picker offers its filter, as the attribute a browser reads. */
function pickerInput(): HTMLInputElement {
  return screen.getByLabelText('Choose images to attach') as HTMLInputElement
}

/** What a save was dispatched with, in the order the saves were dispatched. */
function savedNames(stub: BridgeStub): string[] {
  return stub.callsTo('attachments').map((call) => (call.args[0] as { name: string }).name)
}

describe('the composer taking an image', () => {
  it('takes a pasted image as a chip, and sends nothing', async () => {
    const stub = stubBridge()
    renderChat()

    // The composer stops the paste: an image is not text, and pasting its name into the sentence would be
    // noise the user did not ask for.
    const area = await composer()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { files: [imageFile('shot.png')] } })
    fireEvent(area, event)

    await waitFor(() => expect(draftChips().length).toBe(1))
    expect(draftChips()[0]).toContain('shot.png')
    // The size comes from the bytes, so the chip is showing what it holds rather than what it was told.
    expect(draftChips()[0]).toContain('64 bytes')
    // Nothing crossed the bridge: taking an image is not a send.
    expect(stub.methodsOn('attachments')).toEqual([])
    expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a paste of prose alone', async () => {
    stubBridge()
    renderChat()

    const area = await composer()
    await userEvent.type(area, 'a half-written sentence')
    // A paste carrying no file is the ordinary case and none of this feature's business: it must not be
    // prevented, so the text arrives the way a paste always has.
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { files: [] } })
    fireEvent(area, event)

    expect(draftChips()).toEqual([])
    expect(event.defaultPrevented).toBe(false)
    expect(area.value).toBe('a half-written sentence')
  })

  it('takes a dropped image as a chip', async () => {
    stubBridge()
    renderChat()

    // Dropped on the textarea and handled by the composer around it, which is where a drop lands: the
    // handler is on the box, so an image let go anywhere over the composer is taken.
    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('dropped.png')] } })

    await waitFor(() => expect(draftChips().length).toBe(1))
    expect(draftChips()[0]).toContain('dropped.png')
  })

  it('takes several files of one gesture in the order they arrived', async () => {
    const stub = stubBridge()
    renderChat()

    fireEvent.drop(await composer(), {
      dataTransfer: { files: [imageFile('first.png'), imageFile('second.png'), imageFile('third.png')] },
    })

    await waitFor(() => expect(draftChips().length).toBe(3))
    expect(draftChips()[0]).toContain('first.png')
    expect(draftChips()[1]).toContain('second.png')
    expect(draftChips()[2]).toContain('third.png')
    expect(stub.methodsOn('attachments')).toEqual([])
  })

  it('offers exactly the whitelisted types in the picker', async () => {
    stubBridge()
    renderChat()
    await composer()

    // Built from the whitelist rather than written out, so the dialog and the rule cannot come to offer
    // different types: an `accept` that was narrower would hide an image the composer would have taken,
    // and one that was wider would offer a type that then refuses.
    expect(pickerInput().accept).toBe(ATTACHMENT_ACCEPT_ATTRIBUTE)
    expect(pickerInput().accept.split(',')).toEqual([...IMAGE_ATTACHMENT_MIME_TYPES])
    expect(pickerInput().multiple).toBe(true)
  })

  it('takes what the picker was given and clears the input', async () => {
    stubBridge()
    renderChat()

    const input = await screen.findByLabelText('Choose images to attach')
    const chosen = imageFile('picked.png')
    Object.defineProperty(input, 'files', { configurable: true, value: [chosen] })
    fireEvent.change(input)

    await waitFor(() => expect(draftChips().length).toBe(1))
    expect(draftChips()[0]).toContain('picked.png')
    // Cleared so choosing the same file twice in a row is still a change the input reports; a stale value
    // would make the second pick a no-op the user could not explain.
    expect((input as HTMLInputElement).value).toBe('')
  })
})

describe('what the composer refuses', () => {
  it('refuses a type outside the whitelist, naming the file and the rule', async () => {
    stubBridge()
    renderChat()

    fireEvent.drop(await composer(), {
      dataTransfer: { files: [imageFile('drawing.svg', 32, 'image/svg+xml')] },
    })

    // The sentence is the shared rule's own, and the name is what makes it about the file the user chose.
    const notice = await screen.findByText(/drawing\.svg: /)
    expect(notice.textContent).toContain('image/svg+xml')
    expect(draftChips()).toEqual([])
  })

  it('refuses an image over the shared size limit, naming the file', async () => {
    stubBridge()
    renderChat()

    // One byte over the cap, measured by the same constant the store enforces.
    fireEvent.drop(await composer(), {
      dataTransfer: { files: [imageFile('huge.png', 8 * 1024 * 1024 + 1)] },
    })

    const notice = await screen.findByText(/huge\.png: /)
    expect(notice.textContent).toMatch(/8 MB/)
    expect(draftChips()).toEqual([])
  })

  it('refuses a fifth image, and keeps the four that were taken', async () => {
    stubBridge()
    renderChat()

    const one = imageFile('one.png')
    const two = imageFile('two.png')
    const three = imageFile('three.png')
    const four = imageFile('four.png')
    const five = imageFile('five.png')

    const area = await composer()
    let taken = 0
    for (const file of [one, two, three, four]) {
      fireEvent.drop(area, { dataTransfer: { files: [file] } })
      taken += 1
      // Each drop reads its file, so the count to wait for is this gesture's, not the last one's.
      await waitFor(() => expect(draftChips().length).toBe(taken))
    }

    fireEvent.drop(area, { dataTransfer: { files: [five] } })

    // The fifth is named and the rule is stated, and the four that were taken are still there: a refusal
    // takes nothing away.
    const notice = await screen.findByText(/five\.png: /)
    expect(notice.textContent).toMatch(/at most 4/)
    await waitFor(() => expect(draftChips().length).toBe(4))
    expect(draftChips().some((chip) => chip.includes('five.png'))).toBe(false)
  })

  it('takes the fourth and refuses the fifth of one drop', async () => {
    stubBridge()
    renderChat()

    // One gesture past the cap: the images are taken one at a time against the growing list, so the fourth
    // is taken while the fifth is refused — a batch that passed the list whole would let any number through.
    fireEvent.drop(await composer(), {
      dataTransfer: {
        files: [
          imageFile('a.png'),
          imageFile('b.png'),
          imageFile('c.png'),
          imageFile('d.png'),
          imageFile('e.png'),
          imageFile('f.png'),
        ],
      },
    })

    await waitFor(() => expect(draftChips().length).toBe(4))
    expect(await screen.findByText(/e\.png: /)).toBeTruthy()
  })
})

describe('taking a chip off', () => {
  it('revokes the object URL and drops the image from the draft', async () => {
    const stub = stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('keep.png'), imageFile('drop.png')] } })
    await waitFor(() => expect(draftChips().length).toBe(2))
    // Two thumbnails, so two URLs are out there and each has to come back.
    expect(createObjectURL).toHaveBeenCalledTimes(2)

    await userEvent.click(screen.getByLabelText('Remove drop.png'))

    await waitFor(() => expect(draftChips().length).toBe(1))
    expect(draftChips()[0]).toContain('keep.png')
    // Revoked, not merely unrendered: the URL holds the bytes alive until it is released.
    expect(revokeObjectURL).toHaveBeenCalledWith(createdObjectUrls[1])

    // And gone from the draft, which is what a send proves: only the image left is stored.
    await userEvent.type(await composer(), 'look at this{Enter}')
    await waitFor(() => expect(savedNames(stub)).toEqual(['keep.png']))
  })

  it('revokes every chip’s URL when a send clears the row', async () => {
    stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('one.png'), imageFile('two.png')] } })
    await waitFor(() => expect(draftChips().length).toBe(2))

    await userEvent.type(await composer(), 'both of these{Enter}')

    // The row clears after a successful send, and the chips going away is what releases their URLs.
    await waitFor(() => expect(draftChips()).toEqual([]))
    expect(revokeObjectURL).toHaveBeenCalledWith(createdObjectUrls[0])
    expect(revokeObjectURL).toHaveBeenCalledWith(createdObjectUrls[1])
  })
})

describe('sending with images', () => {
  it('stores each image in attach order, then dispatches the turn', async () => {
    const stub = stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('first.png'), imageFile('second.png')] } })
    await waitFor(() => expect(draftChips().length).toBe(2))

    await userEvent.type(await composer(), 'what is wrong here{Enter}')

    await waitFor(() => expect(savedNames(stub)).toEqual(['first.png', 'second.png']))
    // Each save carries the session the message belongs to, and the bytes themselves.
    const saves = stub.callsTo('attachments')
    expect((saves[0].args[0] as { sessionId: string }).sessionId).toBe(SESSION_ID)
    expect((saves[0].args[0] as { bytes: Uint8Array }).bytes.byteLength).toBe(64)

    // Stored first, dispatched after: the turn names references, so the references have to exist.
    const lastSave = stub.calls.lastIndexOf(saves[saves.length - 1])
    const streamStart = stub.calls.findIndex((call) => call.channel === 'conveyor:stream:start')
    expect(streamStart).toBeGreaterThan(lastSave)

    // And the message the user sees carries the images it sent, in the order they were attached.
    await waitFor(() => expect(refChips().length).toBe(2))
    expect(refChips()[0]).toContain('first.png')
    expect(refChips()[1]).toContain('second.png')
    // A reference, not a thumbnail: the name and the size are what the record holds.
    expect(refChips()[0]).toContain('64 bytes')
    expect(document.querySelectorAll('[data-slot="attachment-ref-chip"] img').length).toBe(0)
  })

  it('sends nothing and keeps the chips when an image cannot be stored', async () => {
    // The refusal main names, checked by code rather than by its sentence.
    const stub = stubBridge({
      save: () => {
        throw new ConveyorError('IMAGE_ATTACH_REFUSED', 'That image could not be stored.')
      },
    })
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('one.png'), imageFile('two.png')] } })
    await waitFor(() => expect(draftChips().length).toBe(2))

    await userEvent.type(await composer(), 'both of these{Enter}')

    // The first save refused, so the second was never attempted: a partial store writes nothing.
    await waitFor(() => expect(stub.callsTo('attachments').length).toBe(1))
    expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(false)
    // The chips remain, and so does the sentence — with the draft the user left, so the send can be tried
    // again rather than retyped.
    expect(draftChips().length).toBe(2)
    expect((await screen.findByText(/could not be stored, so nothing was sent/i)).textContent).toContain(
      'That image could not be stored.'
    )
    expect((await composer()).value).toBe('both of these')
  })

  it('dispatches no save at all for a message carrying no image', async () => {
    const stub = stubBridge()
    renderChat()

    await userEvent.type(await composer(), 'just words{Enter}')
    await waitFor(() => expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(true))

    // No attachment, no write: the store is reached once per image and never once for the absence of one.
    expect(stub.methodsOn('attachments')).toEqual([])
  })
})
