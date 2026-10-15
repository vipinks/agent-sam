/**
 * The per-engine model control, as wiring: which engines the chat header draws it for, and what the picker beside
 * it does while an engine owns the conversation.
 *
 * The rule this suite measures was reversed after the phase that landed the control, and the reversal is what the
 * header now shows: the field belongs to an engine that advertises a *catalogue* — a list of models this app can
 * read and offer as a selection — and no engine advertises one. So it is drawn for none of them, at home or inside
 * a conversation, and the absence is asserted rather than left to the render: a tree that drew the field for Codex
 * would collect a word no runner reads while the turn quietly ran the model Codex's own configuration resolves —
 * its default, or the model that configuration names.
 *
 * What did not move is the picker beside it: it stays where it is, and stays refused whenever an engine owns the
 * conversation with the engine named, exactly as it stood before a second control existed. The case below pins that
 * rather than assuming it, because repurposing that picker is the temptation this slot invites.
 *
 * The control's own label is written here as a string rather than imported, deliberately: a name import would make
 * this suite unbuildable on a tree that has no such control, and a red that is a build failure states nothing
 * about the header it is supposed to be measuring.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the row reads well in either theme, and nothing here
 * claims a live Codex ran the model its own configuration resolved — the acceptance for that is a real turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { ENGINE_LABELS, engineRows } from '@/conveyor/protocol/engine'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'
const CODEX = 'codex'
/** The other engine a conversation can be created under. Its model is not this app's to state either. */
const KIMI = 'kimi'

/** The version a probe on this machine answered. */
const PROBED_VERSION = '0.154.0-alpha.6.2'

/**
 * The control's accessible name, stated here rather than imported from the component.
 *
 * A name import would make this suite fail to build on a tree where the control does not exist, and the red this
 * suite has to record is a failed claim about the header. What the reader is told is therefore written out,
 * exactly as the other labelled controls in this pane are asserted against their words.
 */
const ENGINE_MODEL_NAME = 'Engine model'

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]
const DEFAULT_MODELS = { deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }

/** A conversation running the app's own loop: no engine key, exactly as every record written before one. */
const SAM_SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'the first conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
}

/** The same conversation, created under the engine. */
const ENGINE_SESSION: ChatSession = { ...SAM_SESSION, engineId: CODEX }

/** A viewport for the virtualized transcript, which jsdom does not have. */
const VIEWPORT = { width: 900, height: 800 }

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  for (const [property, value] of [
    ['offsetWidth', VIEWPORT.width],
    ['offsetHeight', VIEWPORT.height],
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
 * Main, as this pane reads it: the conversation, the probed rows the header's picker draws, and both run paths
 * stubbed so that which one a send took is asserted rather than assumed.
 */
function stubScreen(session: ChatSession | null): BridgeStub {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    turn: () => undefined,
    chatWithTools: () => undefined,
  })

  stubStore(stub, 'engine-status', {
    rows: engineRows({
      [CODEX]: { installed: true, version: PROBED_VERSION },
      [KIMI]: { installed: true, version: PROBED_VERSION },
    }),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: session ? [session] : [],
    activeSessionId: session ? session.id : null,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', { custom: [], disabledIds: [] })
  stubStore(stub, 'engine-consent', { pending: null })

  setActiveStub(stub)
  return stub
}

function renderChat(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The control this suite is about, looked for by the name a reader is told. */
const engineModelControl = (): HTMLElement | null => screen.queryByRole('combobox', { name: ENGINE_MODEL_NAME })
const samModelPicker = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Provider and model' })
const enginePicker = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Engine' })

/** Whether a control is disabled, as Radix states it. */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('data-disabled') !== null
}

/** Open a Select from the keyboard, the one path Radix routes without consulting the pointer. */
async function open(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

beforeEach(() => {
  localStorage.clear()
  // The model choice is this store's, and the store is module-level: a case that picked one would otherwise
  // decide what the next case's header shows. The slot stays in the tree for the engine that advertises a
  // catalogue later, so the state a case starts from is stated here rather than assumed.
  useWorkbenchStore.setState({
    engineModels: {},
    activeProviderId: 'deepseek',
    activeModel: 'deepseek-chat',
  })
})

describe('the per-engine model control', () => {
  it('draws nothing at home', async () => {
    // First in this file, for the reason this suite's own case was first before the reversal: the state's own
    // case is the one that chooses an engine through the header's picker, and a pane rendered after another
    // pane's conversation would read that conversation's pointer rather than the empty one stubbed here.
    //
    // The state the reversed case began from: no conversation yet, and Codex chosen while there is none to hold
    // it. There is still no catalogue to offer for that engine, so nothing draws — the engine that will answer the
    // first turn runs on the model its own configuration names.
    stubScreen(null)
    const view = renderChat()

    await open(await enginePicker())
    const codex = screen.getAllByRole('option').find((option) => option.textContent?.startsWith(ENGINE_LABELS.codex))
    expect(codex).toBeDefined()
    await userEvent.click(codex as HTMLElement)

    expect(engineModelControl()).toBeNull()
    view.unmount()

    // And the home screen with no engine chosen at all, where the `provider::model` picker is the one model control
    // on the row and stays live.
    stubScreen(null)
    renderChat()

    expect(isDisabled(await samModelPicker())).toBe(false)
    expect(engineModelControl()).toBeNull()
  })

  it('draws nothing for codex, because codex advertises no catalogue', async () => {
    // Codex answers with no list of models this app can read, so the model it runs is the one its own
    // configuration resolves — a choice nobody can be handed as a field. The picker beside it keeps the whole of
    // its behaviour, refused with the engine named, because the engine still runs this conversation.
    stubScreen(ENGINE_SESSION)
    renderChat()

    const sam = await samModelPicker()
    expect(isDisabled(sam)).toBe(true)
    expect(sam.getAttribute('title')).toContain('Codex')

    expect(engineModelControl()).toBeNull()
  })
})
