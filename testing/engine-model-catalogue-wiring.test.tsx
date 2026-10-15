/**
 * The engine model control, as a search over a catalogue: the field OpenCode's own advertisement feeds, the
 * filtering it performs, and the value it hands to the turn.
 *
 * The rule this suite measures is the one this phase reverses: `engineTakesModel` answers true for the engine
 * that *advertises a catalogue* — OpenCode, whose `session/new` answers with `models.availableModels[]` — and the
 * field is therefore drawn for that engine and still for no other. `testing/engine-model-wiring.test.tsx` holds
 * the other half: nothing is drawn for Codex, and nothing at home for an engine that advertises nothing.
 *
 * What the field is, when there is a catalogue: the search *over* it. Typing filters the advertised ids and
 * offers the matches; picking one records it as this engine's model, which is the same store slot the send path
 * reads when it builds a turn — so there is one answer to what a turn was asked to run as, and the third case
 * below is the claim that the answer reaches the turn rather than merely the control.
 *
 * The catalogue is seeded through main's own store, because that is where it comes from: the client reads it off
 * `session/new` during a turn and main publishes it as state, exactly as it publishes what a probe found. jsdom
 * proves wiring and words, not pixels: nothing here says the list reads well in either theme, and nothing here
 * claims a live OpenCode accepted the id — that is the runner's own suite and, ultimately, a real turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { engineRows } from '@/conveyor/protocol/engine'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'ffffffff-6666-4666-8666-666666666666'
/** The engine that advertises a catalogue, and therefore the only one this control is drawn for. */
const OPENCODE = 'opencode'

/** The version a probe on this machine answered. */
const PROBED_VERSION = '1.4.7'

/** The advertised ids, as `session/new` sends them: a sample of the probe's several hundred. */
const OFFERED = ['opencode/gpt-5', 'opencode/sonnet-4', 'opencode/gemini-3']

/** The session's own current model, which the advertised list above deliberately omits. */
const CURRENT = 'opencode/big-pickle'

/** The control's accessible name, stated here rather than imported, for the reason the sibling suite states it. */
const ENGINE_MODEL_NAME = 'Engine model'

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]
const DEFAULT_MODELS = { deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }

/** A conversation running OpenCode, which is the state that draws the control at all. */
const ENGINE_SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'a conversation on opencode',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
  engineId: OPENCODE,
}

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
 * Main, as this pane reads it: the conversation on OpenCode, its probed row, the catalogue its last session
 * advertised, and both run paths stubbed so that which one a send took is asserted rather than assumed.
 */
function stubScreen(): BridgeStub {
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
    rows: engineRows({ [OPENCODE]: { installed: true, version: PROBED_VERSION } }),
  })
  // The advertisement, in the shape the client publishes it: the ids the agent offered, and the model the
  // session is already running — which need not be among them, and is not.
  stubStore(stub, 'engine-models', {
    catalogues: { [OPENCODE]: { ids: [...OFFERED], currentModelId: CURRENT } },
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [ENGINE_SESSION], activeSessionId: SESSION_ID })
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
const engineModelControl = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: ENGINE_MODEL_NAME })

/** The advertised ids the open list is offering, in the order it offers them. */
const offeredOptions = (): string[] => screen.queryAllByRole('option').map((option) => option.textContent?.trim() ?? '')

beforeEach(() => {
  localStorage.clear()
  // The model choice is this store's, and the store is module-level: a case that picked one would otherwise
  // decide what the next case's header shows.
  useWorkbenchStore.setState({
    engineModels: {},
    activeProviderId: 'deepseek',
    activeModel: 'deepseek-chat',
  })
})

describe('the engine model control over a catalogue', () => {
  it('draws for OpenCode as a searchable combobox over the advertised ids', async () => {
    stubScreen()
    renderChat()

    const control = await engineModelControl()
    // A combobox rather than a textbox, because that is what it is: the field is the surface the catalogue is
    // searched by, and the list it opens is the engine's own advertisement.
    expect(control.getAttribute('role')).toBe('combobox')
    expect(control.getAttribute('aria-expanded')).toBe('false')
    expect((control as HTMLInputElement).value).toBe('')

    await userEvent.click(control)
    await waitFor(() => expect(control.getAttribute('aria-expanded')).toBe('true'))
    expect(offeredOptions()).toEqual(OFFERED)
  })

  it('filters the advertised list by what is typed into it', async () => {
    stubScreen()
    renderChat()

    const control = await engineModelControl()
    await userEvent.type(control, 'gemini')

    await waitFor(() => expect(offeredOptions()).toEqual(['opencode/gemini-3']))
    // The ids that do not match are gone rather than merely unhighlighted: the list is the search's answer.
    expect(offeredOptions()).not.toContain('opencode/gpt-5')
  })

  it('picks one and carries it on the next turn, which is what the send path reads', async () => {
    const stub = stubScreen()
    renderChat()

    const control = await engineModelControl()
    await userEvent.click(control)
    await waitFor(() => expect(offeredOptions()).toEqual(OFFERED))

    await userEvent.click(screen.getByRole('option', { name: 'opencode/sonnet-4' }))

    // What the control holds, which is the store slot the send path reads...
    expect(useWorkbenchStore.getState().engineModels[OPENCODE]).toBe('opencode/sonnet-4')

    // ...and then the turn itself, read off the envelope main was handed rather than assumed from the store.
    await userEvent.type(await screen.findByLabelText('Message'), 'run on that model{Enter}')

    await waitFor(() => {
      const turn = stub.calls.find(
        (call) => call.channel === 'conveyor:stream:start' && String(call.method).startsWith('engine.turn#')
      )
      expect(turn).toBeDefined()
      const envelope = turn?.args.find(
        (arg): arg is { input?: { model?: string } } =>
          typeof arg === 'object' && arg !== null && 'input' in (arg as Record<string, unknown>)
      )
      expect(envelope?.input?.model).toBe('opencode/sonnet-4')
    })
  })
})
