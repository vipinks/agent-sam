/**
 * The per-engine model control, as wiring: what the chat header offers once an engine is chosen, what it
 * writes, and what the engine turn carries because of it.
 *
 * The lane this suite measures is the whole of the phase, and it is two halves of one fact: the control is
 * drawn *instead of* a promise the engine's own model would not keep, and the value it holds is what reaches
 * main on the turn. So the claims are made against the header and against the transport — a stream start as the
 * real client issues it, read out of the recorded bridge calls — rather than against a prop.
 *
 * Which engines are offered the control is part of the claim rather than an accident of the render: the field
 * belongs to an engine whose turn carries the model, and the case at the end pins that for an engine the field
 * must not be drawn for — one collecting an id no runner reads would be a promise nothing keeps, which is the
 * thing this phase exists to remove.
 *
 * The existing `provider::model` picker is asserted here as well, unchanged, because the temptation this control
 * is measured against is repurposing it: it stays where it is and stays refused whenever an engine owns the
 * conversation, which is what the cases below pin rather than assume.
 *
 * The control's own label is written here as a string rather than imported, deliberately: a name import would
 * make this suite unbuildable on a tree that has no such control, and a red that is a build failure states
 * nothing about the header it is supposed to be measuring.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the control reads well in either theme, or that a
 * live Codex honours the id it was handed — the acceptance for the second is a real turn with a real model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
/** The other engine a conversation can be created under. Its model is not this app's to state. */
const KIMI = 'kimi'

/** The id a user types into the control. Codex publishes no catalogue, so this is a string and nothing more. */
const MODEL = 'gpt-5-codex'

/** The version a probe on this machine answered. */
const PROBED_VERSION = '0.154.0-alpha.6.2'

/**
 * The control's accessible name, stated here rather than imported from the component.
 *
 * A name import would make this suite fail to build on a tree where the control does not exist yet, and the red
 * this suite has to record is a failed claim about the header. What the reader is told is therefore written
 * out, exactly as the other labelled controls in this pane are asserted against their words.
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

/** And under the engine whose turn carries no model id at all. */
const KIMI_SESSION: ChatSession = { ...SAM_SESSION, engineId: KIMI }

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

const engineModelControl = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: ENGINE_MODEL_NAME })
const samModelPicker = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Provider and model' })
const enginePicker = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Engine' })
const composer = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('Message')) as HTMLTextAreaElement

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

/**
 * The turn the pane asked main to start, as main receives it.
 *
 * Read from the recorded bridge calls rather than from a stub: the assertion is about the payload the real
 * client issued, so the schema, the channel and the envelope are the shipped ones and only the transport is
 * replaced.
 */
async function engineTurnInput(stub: BridgeStub): Promise<Record<string, unknown>> {
  await waitFor(() => {
    const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (started.length === 0) throw new Error('no stream was started')
  })

  const call = stub.calls.find((entry) => String(entry.method).startsWith('engine.turn#'))
  if (!call) throw new Error('the engine turn was never started')
  const envelope = call.args[0] as { input?: Record<string, unknown> }
  if (!envelope.input) throw new Error('the stream start carried no input')
  return envelope.input
}

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

describe('the per-engine model control', () => {
  it('carries the model on the turn that creates the conversation, with no blur of its own', async () => {
    // The state Boss's run was in, and the state the two Codex sessions were made in: no conversation yet, the
    // engine chosen while there is none to hold it, the id typed into the control, and the send as the commit.
    //
    // The claim is about the turn the pane starts, not about the control: a send is the one moment both choices
    // have to travel under — the engine the conversation is created as, and the model that engine runs. A pane
    // that read its own conversation back off a render is a pane whose first turn, the very one this send is
    // starting, ran as something else.
    //
    // First in this file, and unmounted at the end: there is no automatic cleanup here, the cases below leave
    // their pane standing, and a second one on screen would make this case's queries ambiguous.
    const stub = stubScreen(null)
    const view = renderChat()

    await open(await enginePicker())
    const codex = screen.getAllByRole('option').find((option) => option.textContent?.startsWith(ENGINE_LABELS.codex))
    expect(codex).toBeDefined()
    await userEvent.click(codex as HTMLElement)

    // Typed and never blurred: nothing about this control commits on focus loss, because the send is the only
    // thing that has to read it.
    await userEvent.type(await engineModelControl(), MODEL)
    expect(useWorkbenchStore.getState().engineModels[CODEX]).toBe(MODEL)

    await userEvent.type(await composer(), 'which model are you{Enter}')

    expect(await engineTurnInput(stub)).toMatchObject({
      engineId: CODEX,
      prompt: 'which model are you',
      model: MODEL,
    })
    // And the engine path, stated the same way the case below states it: the app's own loop — the one that answers
    // under the picker's `provider::model` rather than under the engine — was never asked for this turn.
    expect(stub.calls.some((call) => String(call.method).startsWith('agent.chatWithTools'))).toBe(false)

    view.unmount()
  })

  it('is drawn in the header once an engine is chosen, where the model picker sits, and is live', async () => {
    stubScreen(ENGINE_SESSION)
    renderChat()

    const control = await engineModelControl()
    const sam = await samModelPicker()

    expect(control.closest('header')).not.toBeNull()
    // Immediately before the `provider::model` picker, which is the slot a reader looks in for "the model":
    // the live control is the one belonging to the engine that owns the conversation.
    expect(control.compareDocumentPosition(sam) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(isDisabled(control)).toBe(false)
    expect(control.getAttribute('placeholder')).toBeTruthy()

    // And the promise the engine's own model makes is kept: the picker beside it is refused exactly as it was
    // before this control existed, naming the engine that took the choice over.
    expect(isDisabled(sam)).toBe(true)
    expect(sam.getAttribute('title')).toContain('Codex')
  })

  it('records what is typed into the store, and sends that model with the engine turn', async () => {
    const stub = stubScreen(ENGINE_SESSION)
    renderChat()

    const control = await engineModelControl()
    await userEvent.type(control, MODEL)

    // The store is what the header shows and what a send reads, so the write is asserted before the turn is:
    // a control that carried a model it never recorded would lose the choice on the next render.
    expect(useWorkbenchStore.getState().engineModels[CODEX]).toBe(MODEL)

    await userEvent.type(await composer(), 'hello{Enter}')

    expect(await engineTurnInput(stub)).toMatchObject({ engineId: CODEX, prompt: 'hello', model: MODEL })
    // The engine path, stated: the app's own loop was never asked for.
    expect(stub.calls.some((call) => String(call.method).startsWith('agent.chatWithTools'))).toBe(false)
  })

  it('draws nothing until an engine is chosen, and leaves the Sam-loop picker exactly as it was', async () => {
    // A conversation running the app's own loop: no engine is chosen, so there is no engine model to state and
    // the provider::model picker is the one model control on the row.
    stubScreen(SAM_SESSION)
    const sam = renderChat()
    expect(isDisabled(await samModelPicker())).toBe(false)
    expect(screen.queryByRole('combobox', { name: ENGINE_MODEL_NAME })).toBeNull()
    sam.unmount()

    // And the home screen, where no conversation — and so no engine — exists yet.
    stubScreen(null)
    renderChat()
    expect(isDisabled(await samModelPicker())).toBe(false)
    expect(screen.queryByRole('combobox', { name: ENGINE_MODEL_NAME })).toBeNull()
  })

  it('draws nothing for an engine whose turn carries no model this app can set', async () => {
    // Kimi answers with a model *catalogue* on its ACP session rather than taking an id from a command line, so
    // the model it runs is a selection this app has yet to read rather than a word a user types. A free-text
    // field drawn here would collect an id no runner reads while the turn quietly ran the default — the exact
    // shape of promise this phase removes, which is why the absence is asserted rather than left to the render.
    stubScreen(KIMI_SESSION)
    renderChat()

    const sam = await samModelPicker()
    expect(isDisabled(sam)).toBe(true)
    expect(sam.getAttribute('title')).toContain('Kimi')
    expect(screen.queryByRole('combobox', { name: ENGINE_MODEL_NAME })).toBeNull()
  })
})
