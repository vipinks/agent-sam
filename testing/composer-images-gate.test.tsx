import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The capability gate, from the composer's side.
 *
 * A provider nothing has been said about is a provider the composer may not attach an image for, and this
 * file is the other half of `composer-images.test.tsx`: the same three gestures, against a record that
 * carries no `supportsImages` at all. Absence and `false` are the same answer — the pure rule's own case,
 * tested directly in `image-attachments-capture-test.ts` — and what is left here is that all three
 * capture paths consult it, say the same sentence, and add nothing.
 *
 * Its own file because the store mirror is fetched once and caches: a suite that seeded a capable provider
 * and then an incapable one would be reading whichever arrived first, and the gate's two answers would be
 * one test file's ordering rather than two states.
 *
 * Seeded with no key rather than with `false`, deliberately: that is the state every existing install is
 * in, and it is the state the default has to be right about.
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

/** The provider record as an install that has never been asked about images has it: no key at all. */
const PROVIDER_WITH_NO_OPINION = { providers: {}, customProviders: [] }

function stubBridge(): BridgeStub {
  const stub = createBridgeStub({
    save: () => ({ id: 'stored-1', name: 'shot.png', mimeType: 'image/png', size: 64 }),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  stubStore(stub, 'provider-config', PROVIDER_WITH_NO_OPINION)
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

async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

function draftChips(): string[] {
  return [...document.querySelectorAll('[data-slot="attachment-chip"]')].map((chip) => chip.textContent ?? '')
}

function imageFile(name: string): File {
  return new File([new Uint8Array(64)], name, { type: 'image/png' })
}

/** The one sentence every refused path has to produce, which names where the capability is turned on. */
const REFUSAL = /not set up to take images/i

beforeEach(() => {
  useWorkbenchStore.setState({ selectedFile: null })
})

describe('a provider that has not been marked image-capable', () => {
  it('refuses a pasted image, saying so once and adding no chip', async () => {
    const stub = stubBridge()
    renderChat()

    const area = await composer()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { files: [imageFile('shot.png')] } })
    fireEvent(area, event)

    // The notice is the composer's own sentence — nothing was rejected by a rule, the provider simply has
    // no permission — and it points at the setting that would change the answer.
    const notice = await screen.findByText(REFUSAL)
    expect(notice.textContent).toContain('Settings')
    expect(draftChips()).toEqual([])
    // Refused before the rule about the file was worth asking, so nothing was read and nothing was stored.
    expect(stub.methodsOn('attachments')).toEqual([])
    // Still prevented: the paste was an image, and letting it through would have pasted its name.
    expect(event.defaultPrevented).toBe(true)
  })

  it('refuses a dropped image, adding no chip', async () => {
    const stub = stubBridge()
    renderChat()

    fireEvent.drop(await composer(), { dataTransfer: { files: [imageFile('dropped.png')] } })

    await screen.findByText(REFUSAL)
    expect(draftChips()).toEqual([])
    expect(stub.methodsOn('attachments')).toEqual([])
  })

  it('refuses what the picker was given, adding no chip', async () => {
    const stub = stubBridge()
    renderChat()

    const input = await screen.findByLabelText('Choose images to attach')
    Object.defineProperty(input, 'files', { configurable: true, value: [imageFile('picked.png')] })
    fireEvent.change(input)

    await screen.findByText(REFUSAL)
    expect(draftChips()).toEqual([])
    expect(stub.methodsOn('attachments')).toEqual([])
  })

  it('dispatches the turn with no references when a message carries no image', async () => {
    const stub = stubBridge()
    renderChat()

    // The gate is about images only. A message of words still sends, which is what keeps a provider that
    // cannot see from being a provider that cannot be talked to.
    await userEvent.type(await composer(), 'just words{Enter}')

    await waitFor(() => expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(true))
    expect(stub.methodsOn('attachments')).toEqual([])
    expect(document.querySelectorAll('[data-slot="attachment-ref-chip"]').length).toBe(0)
  })
})
