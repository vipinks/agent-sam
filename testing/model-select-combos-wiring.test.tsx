import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { Combo } from '@/conveyor/protocol/combos'
import {
  CHAT_SESSIONS_STORE_ID,
  createBridgeStub,
  setActiveStub,
  stubCombos,
  stubStore,
  type BridgeStub,
} from './bridge-stub'

/**
 * The model picker's combo half, as wiring: what it offers, what a pick writes, and what a send
 * carries.
 *
 * The combo is appended after every plain group as one Select group of its own, and the value the
 * control holds is `combo::<id>` while the payload still names the combo's head pair. Both halves are
 * asserted because both are load-bearing: the marker is what the picker reads back, and the pair is
 * what the session record, the stale guard and every existing suite already know how to carry.
 */

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

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

const DEFAULT_MODELS = {
  deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
  openai: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
}

const COMBOS: Combo[] = [
  {
    id: 'fast',
    name: 'Fast answers',
    members: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
    enabled: true,
  },
  {
    id: 'two',
    name: 'Two deep',
    members: [
      { providerId: 'deepseek', modelId: 'deepseek-chat' },
      { providerId: 'openai', modelId: 'gpt-4o-mini' },
    ],
    enabled: true,
  },
  {
    id: 'off',
    name: 'Off combo',
    members: [{ providerId: 'openai', modelId: 'gpt-4o-mini' }],
    enabled: false,
  },
]

function stubChat(sent: unknown[] = []): BridgeStub {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek', 'openai'],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
    chatWithTools: (input) => void sent.push(input),
    // The module read the reconcile effect makes: the same list the store seed carries.
    list: () => COMBOS,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubCombos(stub, COMBOS)
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

async function openPicker(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('combobox', { name: /^Provider and model/ })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
  return trigger
}

function options(): HTMLElement[] {
  return screen.getAllByRole('option')
}

function optionTexts(): string[] {
  return options().map((option) => option.textContent ?? '')
}

async function pick(text: string): Promise<void> {
  // Substring rather than equality: a combo row is the glyph, its name and its count, and the DOM's
  // textContent between two spans carries no separator the test should have to know about.
  const option = options().find((candidate) => (candidate.textContent ?? '').includes(text))
  if (!option) throw new Error(`no option matching ${text} — the picker offered ${optionTexts().join(', ')}`)
  await userEvent.click(option)
}

function storedMarker(): { comboId?: string; providerId?: string; model?: string } | null {
  const raw = localStorage.getItem('sam-ai-chat-target')
  return raw === null ? null : (JSON.parse(raw) as { comboId?: string; providerId?: string; model?: string })
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ activeProviderId: 'deepseek', activeModel: 'deepseek-chat', activeComboId: null })
  vi.spyOn(toast, 'error').mockImplementation(() => '')
})

describe('the model picker with combos', () => {
  it('offers enabled combos after the plain groups, one Combos group, with the Layers glyph and a count', async () => {
    stubChat()
    renderChat()
    await openPicker()

    const texts = optionTexts()
    const comboIndex = texts.findIndex((text) => text.includes('Fast answers'))
    expect(comboIndex).toBeGreaterThan(texts.findIndex((text) => text.includes('deepseek-chat')))

    // One group labelled Combos, and a row that names the combo, its count, and draws the glyph the
    // feature is drawn with — the mark is what tells a combo row apart from a model row.
    expect(screen.getByText('Combos')).toBeTruthy()
    const comboRow = options().find((option) => option.textContent?.includes('Fast answers'))
    expect(comboRow).toBeTruthy()
    expect(comboRow?.textContent).toContain('1 model')
    expect(comboRow?.querySelector('svg.lucide-layers')).not.toBeNull()

    // A disabled combo is not offered at all.
    expect(texts.some((text) => text.includes('Off combo'))).toBe(false)
  })

  it('picking a combo writes the marker and the head pair, and the send carries comboId', async () => {
    const sent: unknown[] = []
    stubChat(sent)
    renderChat()
    await openPicker()
    await pick('Fast answers')

    expect(useWorkbenchStore.getState().activeComboId).toBe('fast')
    expect(useWorkbenchStore.getState().activeProviderId).toBe('deepseek')
    expect(useWorkbenchStore.getState().activeModel).toBe('deepseek-chat')
    // The persisted marker is the combo and its head, so the next launch restores the same choice.
    expect(storedMarker()).toEqual({ comboId: 'fast', providerId: 'deepseek', model: 'deepseek-chat' })
    // The trigger names the combo, not its head pair, for a screen reader as well as for the eye.
    expect(screen.getByRole('combobox', { name: 'Provider and model: Fast answers' })).toBeTruthy()

    await userEvent.type(await screen.findByLabelText('Message'), 'hello{Enter}')
    await waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]).toMatchObject({
      comboId: 'fast',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('finds a combo by name, and the row the filter kept is the one that sets comboId', async () => {
    stubChat()
    renderChat()
    await openPicker()

    const box = await screen.findByLabelText('Filter models')
    await userEvent.type(box, 'Fast')
    await waitFor(() => expect(options()).toHaveLength(1))
    expect(options()[0].textContent).toContain('Fast answers')

    await userEvent.click(options()[0])
    expect(useWorkbenchStore.getState().activeComboId).toBe('fast')
    expect(storedMarker()).toEqual({ comboId: 'fast', providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('picking a plain model clears the combo', async () => {
    stubChat()
    renderChat()
    await openPicker()
    await pick('Fast answers')
    expect(useWorkbenchStore.getState().activeComboId).toBe('fast')

    await openPicker()
    await pick('deepseek-chat')
    expect(useWorkbenchStore.getState().activeComboId).toBeNull()
    expect(storedMarker()).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('the trigger shows the combo name rather than its head model', async () => {
    stubChat()
    renderChat()
    await openPicker()
    await pick('Fast answers')

    const trigger = await screen.findByRole('combobox', { name: 'Provider and model: Fast answers' })
    expect(trigger.textContent).toContain('Fast answers')
    expect(trigger.textContent).not.toContain('deepseek-chat')
  })

  it('refuses a send whose combo is gone, with a sentence, and keeps the draft', async () => {
    const sent: unknown[] = []
    stubChat(sent)
    renderChat()

    // Let the mirror's list answer, then put back a combo it does not carry: the reconcile has already
    // run, so this reaches the guard itself rather than the startup repair that precedes it.
    await openPicker()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    useWorkbenchStore.setState({ activeComboId: 'gone' })

    const composer = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await userEvent.type(composer, 'keep this draft{Enter}')

    expect(sent).toHaveLength(0)
    expect(composer.value).toBe('keep this draft')
    expect(toast.error).toHaveBeenCalledWith(
      'That combo is no longer available',
      expect.objectContaining({ description: expect.stringContaining('target') })
    )
  })
})
