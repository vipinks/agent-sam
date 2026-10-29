import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { CustomProvider } from '@/conveyor/protocol/custom-provider'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The chat header's picker, as wiring: what it offers and what a pick reaches.
 *
 * The route a custom provider's models are listed by, and the route they are run by, are two different
 * facts and both are here: the picker must offer them after every predefined one — a custom provider
 * that vanished would be one the user added and cannot use — and the pick that follows must put that
 * provider's descriptor on the payload the loop starts with, because a descriptor is what tells main
 * where the turn goes. The engine's side of that is the node suite's; this is the renderer's.
 *
 * A provider with no models is the case with the most ways to be wrong: dropped from the list, offered
 * as a dead option, or offered as a working one that sends nothing. It is asserted as the third thing it
 * would never be: present, and disabled, and saying why.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** A session already named, so the first-send title path adds no store write this suite is not about. */
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

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

const DEFAULT_MODELS = {
  deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
  openai: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
}

/** One provider the user added, with a catalogue. */
const LLAMA: CustomProvider = {
  id: 'local-llama',
  name: 'Local Llama',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  dialect: 'openai',
  models: ['llama-3.1-8b', 'qwen2.5-coder-7b'],
}

/** And one that has never answered for its models, which is a provider the picker still has to name. */
const GATEWAY: CustomProvider = {
  id: 'work-gateway',
  name: 'Work Gateway',
  baseUrl: 'https://gw.example.com/v1',
  apiKey: '',
  dialect: 'openai',
  models: [],
}

const CUSTOM_PROVIDERS = [LLAMA, GATEWAY]

/** Install a bridge whose settings answers are the ones this suite describes. */
function stubChat(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
    chatWithTools: () => undefined,
    ...overrides,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  stubStore(stub, 'provider-config', { providers: {}, customProviders: CUSTOM_PROVIDERS })
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

/**
 * Open the picker, which is one combobox in the header.
 *
 * Opened from the keyboard rather than with a click, deliberately: Radix's trigger opens on a click only
 * when the event's `pointerType` is `mouse`, and jsdom's pointer events carry no such type — the mouse
 * path is taken by the *item* it clicks and not by the trigger, which leaves a click-opened picker
 * dependent on which test in the file ran first. Enter is a path a keyboard user takes anyway, and the
 * one Radix routes without consulting the pointer at all.
 */
async function openPicker(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('combobox', { name: 'Provider and model' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
  return trigger
}

/** Every option the open picker offers, in the order it offers them. */
function options(): HTMLElement[] {
  return screen.getAllByRole('option')
}

function optionTexts(): string[] {
  return options().map((option) => option.textContent ?? '')
}

/**
 * Whether an option is the disabled kind.
 *
 * Radix states it twice and this reads either: `data-disabled` is the attribute its styles key off, and
 * `aria-disabled` is what a screen reader is told.
 */
function isDisabled(option: HTMLElement): boolean {
  return option.hasAttribute('data-disabled') || option.getAttribute('aria-disabled') === 'true'
}

/** Choose one option and let the picker settle. */
async function pick(text: string): Promise<void> {
  const option = options().find((candidate) => (candidate.textContent ?? '') === text)
  if (!option) throw new Error(`no option named ${text} — the picker offered ${optionTexts().join(', ')}`)
  await userEvent.click(option)
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: 'deepseek-chat', selectedFile: null })
  vi.spyOn(toast, 'error').mockImplementation(() => '')
})

describe('the model picker', () => {
  it('lists every custom provider’s models after all the predefined ones, named by their provider', async () => {
    stubChat()
    renderChat()
    await openPicker()

    const texts = optionTexts()
    const firstCustom = texts.findIndex((text) => text.includes(LLAMA.name))
    const lastPredefined = texts.map((text) => /deepseek-chat|gpt-4o-mini/.test(text)).lastIndexOf(true)

    // After all of them, not interleaved: a custom provider is an addition to the list, not a peer of
    // the ones that ship.
    expect(firstCustom).toBeGreaterThan(lastPredefined)
    expect(lastPredefined).toBeGreaterThanOrEqual(0)

    // Each model carries its provider's name, because two providers can offer the same model id and
    // the id alone would not say which one a line belongs to.
    for (const model of LLAMA.models) {
      expect(texts).toContain(`${LLAMA.name} · ${model}`)
    }
  })

  it('shows a custom provider with no models as a disabled hint rather than dropping it', async () => {
    stubChat()
    renderChat()
    await openPicker()

    const hint = options().find((option) => option.textContent?.includes(GATEWAY.name))
    expect(hint, 'the provider with nothing to offer is still listed').toBeTruthy()
    expect(hint?.textContent).toContain('No models yet')
    expect(isDisabled(hint as HTMLElement)).toBe(true)
  })

  it('carries the selected provider’s descriptor into the loop-start payload', async () => {
    const sent: unknown[] = []
    stubChat({ chatWithTools: (input) => void sent.push(input) })
    renderChat()
    await openPicker()

    await pick(`${LLAMA.name} · ${LLAMA.models[0]}`)

    await userEvent.type(await screen.findByLabelText('Message'), 'hello{Enter}')
    await waitFor(() => expect(sent.length).toBe(1))

    const payload = sent[0] as { providerId?: string; model?: string; provider?: unknown }
    expect(payload.providerId).toBe(LLAMA.id)
    expect(payload.model).toBe(LLAMA.models[0])
    // The descriptor as turn A defined it, and with no credential on it: the key is main's to add.
    expect(payload.provider).toEqual({ ...LLAMA, apiKey: '' })
  })

  it('allows a remembered model when the provider config mirror has no record yet', async () => {
    const sent: unknown[] = []
    stubChat({ chatWithTools: (input) => void sent.push(input) })
    renderChat()

    // The catalogue answer is what used to judge this model: it names only the seeded deepseek-chat, so
    // the old validator stopped a model the persisted config had not actually ruled out. Waiting for the
    // picker loads that answer before the remembered pair is restored, which is the post-restart state
    // CHECK 1b describes.
    await openPicker()
    expect(optionTexts()).toContain('deepseek-chat')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: 'deepseek-reasoner' })

    const composer = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await userEvent.type(composer, 'send the remembered model{Enter}')

    await waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0] as { model?: string }).model).toBe('deepseek-reasoner')
    expect(composer.value).toBe('')
  })

  it('allows a remembered model when the provider record has an empty enabled list', async () => {
    const sent: unknown[] = []
    const stub = stubChat({ chatWithTools: (input) => void sent.push(input) })
    stubStore(stub, 'provider-config', {
      providers: { deepseek: { enabledModels: [], fetchedModels: [] } },
      customProviders: [],
    })
    renderChat()

    await openPicker()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: 'deepseek-reasoner' })

    await userEvent.type(await screen.findByLabelText('Message'), 'send the remembered model{Enter}')

    await waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0] as { model?: string }).model).toBe('deepseek-reasoner')
  })

  it('stops a send whose saved model is absent from a non-empty enabled list, and keeps the draft', async () => {
    const sent: unknown[] = []
    const stub = stubChat({ chatWithTools: (input) => void sent.push(input) })
    stubStore(stub, 'provider-config', {
      providers: { deepseek: { enabledModels: ['deepseek-chat'], fetchedModels: [] } },
      customProviders: [],
    })
    renderChat()

    // Opening the picker waits for the catalogue. The reconcile effect has already corrected the launched
    // pair to a live model by then; putting the retired id back afterwards reaches the guard itself, which
    // is the fail-closed half under test rather than the startup repair that precedes it.
    await openPicker()
    expect(optionTexts()).toContain('deepseek-chat')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: 'deepseek-retired' })

    const composer = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await userEvent.type(composer, 'keep this draft{Enter}')

    // The send is refused before the session is touched or the draft is cleared: no provider round-trip,
    // no turn to stop, and the words are still there for the user to send with a live model.
    expect(sent).toHaveLength(0)
    expect(composer.value).toBe('keep this draft')
    expect(toast.error).toHaveBeenCalledWith(
      'That model is no longer available',
      expect.objectContaining({ description: expect.stringContaining('deepseek-retired') })
    )
  })

  it('refuses a send with no selected model and keeps the fresh-install message', async () => {
    const sent: unknown[] = []
    stubChat({ chatWithTools: (input) => void sent.push(input) })
    renderChat()

    await openPicker()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: null })
    expect(useWorkbenchStore.getState().activeModel).toBeNull()

    const composer = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await userEvent.type(composer, 'keep this draft{Enter}')

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Choose a model to send',
        expect.objectContaining({ description: 'Switch a model on in Settings, then send again.' })
      )
    )
    expect(sent).toHaveLength(0)
    expect(composer.value).toBe('keep this draft')
  })

  it('carries no descriptor when the pick is one of the predefined providers', async () => {
    const sent: unknown[] = []
    stubChat({ chatWithTools: (input) => void sent.push(input) })
    renderChat()
    await openPicker()

    await pick('deepseek-chat')

    await userEvent.type(await screen.findByLabelText('Message'), 'hello{Enter}')
    await waitFor(() => expect(sent.length).toBe(1))

    const payload = sent[0] as { providerId?: string; provider?: unknown }
    expect(payload.providerId).toBe('deepseek')
    // Absent rather than an empty descriptor: the built-in table is still what answers for a built-in.
    expect(payload.provider).toBeUndefined()
  })
})
