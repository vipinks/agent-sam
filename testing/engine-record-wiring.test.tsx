/**
 * The engine a conversation runs as, and the model its turns ran, as what gets *recorded*.
 *
 * Three records answer three different questions and this suite keeps them apart. The transcript file is what
 * a reopened conversation is read from, so the engine a conversation was created as has to be on it from the
 * moment it is created, and the model a turn actually carried has to be on any transcript whose engine ran
 * one. The session record is the small part the list and the header read without opening a file, so it is
 * where the model is kept for the header's control to be put back when a conversation is reopened: the
 * control's own value is renderer-local and forgotten on relaunch, which is the Phase 83a residual this
 * closes, and the record is the only thing that survives one.
 *
 * The last claim is the catalogue's: it is state keyed per engine, written by the turn that observed the
 * advertisement, so one engine's list can never answer another engine's control. The publication is seeded
 * the way main publishes it — through the store the turn's sink dispatches into — rather than by writing a
 * value beside the control, so what is asserted is the keying rather than a copied list.
 *
 * The reds this suite was written against, on the tree at `8d1b8d4`: nothing wrote `engineId` onto a
 * transcript the app created, nothing wrote the model a turn carried onto either record, and nothing hydrated
 * the header's control from a reopened conversation's record — which is why that tree's stored transcripts
 * named no engine at all (the phase's own count was 0 of 62) and every reopened engine conversation showed an
 * empty field where its model should be.
 *
 * jsdom proves wiring and words, not pixels: nothing here claims a live OpenCode, Codex or Kimi ran anything,
 * and nothing here measures a signed-in Kimi surface — an engine that advertises no catalogue draws no
 * control, which is the whole of what this suite says about it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { ENGINE_LABELS, engineRows } from '@/conveyor/protocol/engine'
import type { TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import type { ChatSession, ChatSessionsState } from '@/conveyor/stores/chat-sessions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'dddddddd-7777-4777-8777-777777777777'

/** The three engines, named rather than indexed, so a rename fails here loudly. */
const CODEX = 'codex'
const KIMI = 'kimi'
const OPENCODE = 'opencode'

/** The version a probe on this machine answered. */
const PROBED_VERSION = '1.4.7'

/** The ids `session/new` advertised in the seeded publication: the list the control is drawn from. */
const OFFERED = ['opencode/gemini-3', 'opencode/gpt-5', 'opencode/sonnet-4']

/** The one the case below picks, which is the model its turn then runs. */
const PICKED = 'opencode/sonnet-4'

/**
 * The control's accessible name, stated here rather than imported from the component.
 *
 * A name import would make this suite fail to build on a tree where the control does not exist, and the red
 * this suite has to record is a failed claim about the header. What the reader is told is written out, as the
 * sibling engine-model suites write it out.
 */
const ENGINE_MODEL_NAME = 'Engine model'

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]
const DEFAULT_MODELS = { deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }

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

/** One action dispatched at the chat-sessions store, as main receives it. */
interface RecordedAction {
  method: string
  payload: Record<string, unknown>
}

interface Fixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  sessionActions: RecordedAction[]
  /** The transcript files main is holding, by session id. */
  transcripts: Record<string, TranscriptSnapshot>
}

/** The publication one engine's session advertised, keyed the way the store keys it. */
type Catalogues = Record<string, { ids: string[]; currentModelId: string | null }>

/**
 * Main, as this pane reads it: the conversation (or none, which is home), the probed rows, the catalogue an
 * engine's session advertised, and both run paths stubbed so that which one a send took is asserted rather
 * than assumed.
 *
 * The session actions are *applied* as well as recorded, because the pane's state is the store's: a stub that
 * only recorded an `addSession` would leave the renderer on home while the case below claimed a conversation
 * was created, and every assertion about the record would then be about a row nobody wrote.
 */
function stubScreen(options: { session?: ChatSession | null; catalogues?: Catalogues } = {}): Fixture {
  const chat: ChatSessionsState = {
    sessions: options.session ? [options.session] : [],
    activeSessionId: options.session ? options.session.id : null,
  }
  const transcripts: Record<string, TranscriptSnapshot> = {}
  const sessionActions: RecordedAction[] = []

  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    listFilesFlat: () => [],
    loadTranscript: (input) => transcripts[(input as { id: string }).id] ?? null,
    saveTranscript: (input) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      transcripts[id] = snapshot
      return undefined
    },
    turn: () => undefined,
    chatWithTools: () => undefined,
  })

  stubStore(stub, 'engine-status', {
    rows: engineRows({
      [CODEX]: { installed: true, version: PROBED_VERSION },
      [KIMI]: { installed: true, version: PROBED_VERSION },
      [OPENCODE]: { installed: true, version: PROBED_VERSION },
    }),
  })
  // The advertisement as main publishes it: one entry per engine id, and no entry at all for an engine whose
  // session has not been opened. An empty map is therefore a turn that published nothing.
  stubStore(stub, 'engine-models', { catalogues: options.catalogues ?? {} })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', { custom: [], disabledIds: [] })
  stubStore(stub, 'engine-consent', { pending: null })

  // Wrapped *after* `stubStore`, so its own state answer still stands: a wrapper that swallowed the `__get__`
  // read would leave the mirror with no state and let every case below pass for the wrong reason.
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return chat
      const { payload } = args[0] as { payload: Record<string, unknown> }
      sessionActions.push({ method, payload })
      applySessionAction(chat, method, payload)
      stub.pushToChannel(`${channel}:changed`, { ...chat, sessions: [...chat.sessions] })
      return undefined
    }
    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, {
    ...chat,
    sessions: [...chat.sessions],
  })

  return { stub, sessionActions, transcripts }
}

/** What main does with one session action, which is what the screen then reads back. */
function applySessionAction(chat: ChatSessionsState, method: string, payload: Record<string, unknown>): void {
  const byRecency = (sessions: ChatSession[]): ChatSession[] => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  if (method === 'addSession') {
    const id = payload.id as string
    if (chat.sessions.some((s) => s.id === id)) return
    const now = Date.now()
    chat.sessions = byRecency([
      ...chat.sessions,
      {
        id,
        title: payload.title as string,
        createdAt: now,
        updatedAt: now,
        providerId: payload.providerId as string,
        model: payload.model as string,
        ...(payload.engineId !== undefined ? { engineId: payload.engineId as string } : {}),
      },
    ])
    return
  }

  if (method === 'touchSession') {
    chat.sessions = chat.sessions.map((s) => (s.id === payload.id ? ({ ...s, ...payload } as ChatSession) : s))
    return
  }

  if (method === 'setActive') chat.activeSessionId = payload.id as string | null
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

/** The advertised ids the open list is offering, in the order it offers them. */
const offeredOptions = (): string[] => screen.queryAllByRole('option').map((option) => option.textContent?.trim() ?? '')

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
 * End the run's stream, as main does when the engine is done.
 *
 * The channel is read from the recorded start call rather than guessed. A turn boundary is what schedules the
 * transcript write, so a case about what was recorded has to end the run rather than merely start it.
 */
function endStream(stub: BridgeStub): void {
  const started = stub.calls.find(
    (call) => call.channel === 'conveyor:stream:start' && String(call.method).startsWith('engine.turn#')
  )
  if (!started) throw new Error('no engine turn was started')
  stub.emit(`conveyor:stream:${started.method}`, { type: 'end' })
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

/** The row every stub conversation is built on: the engine is what each case below puts on top of it. */
const SAM_ROW: ChatSession = {
  id: SESSION_ID,
  title: 'a conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
}

describe('the engine and its model, recorded', () => {
  it('writes the created engine and the model a turn carried onto the transcript and the record', async () => {
    // Home, with the engine chosen and a model picked from its own advertised list: the state a first message
    // under an engine is sent from.
    const { stub, sessionActions, transcripts } = stubScreen({
      catalogues: { [OPENCODE]: { ids: [...OFFERED], currentModelId: null } },
    })
    renderChat()

    await open(await enginePicker())
    const engineRow = screen
      .getAllByRole('option')
      .find((option) => option.textContent?.startsWith(ENGINE_LABELS[OPENCODE]))
    expect(engineRow, 'the picker drew no OpenCode row').toBeDefined()
    await userEvent.click(engineRow as HTMLElement)

    const control = await screen.findByRole('combobox', { name: ENGINE_MODEL_NAME })
    await userEvent.click(control)
    await waitFor(() => expect(offeredOptions()).toContain(PICKED))
    await userEvent.click(screen.getByRole('option', { name: PICKED }))

    await userEvent.type(await screen.findByLabelText('Message'), 'run on the model I picked{Enter}')

    // The turn under that engine, ended, which is the boundary the transcript is written at.
    await waitFor(() =>
      expect(
        stub.calls.some(
          (call) => call.channel === 'conveyor:stream:start' && String(call.method).startsWith('engine.turn#')
        )
      ).toBe(true)
    )
    endStream(stub)
    await waitFor(() => expect(stub.methodsOn('sessions')).toContain('saveTranscript'), { timeout: 5000 })

    const created = sessionActions.find((action) => action.method === 'addSession')?.payload
    expect(created, 'the send created no conversation').toBeDefined()
    const id = created?.id as string

    // The record on disk: the engine the conversation was created as, and the model its turn carried.
    expect(transcripts[id]?.engineId).toBe(OPENCODE)
    expect(transcripts[id]?.engineModel).toBe(PICKED)

    // And the session record, which is what a reopened conversation's header reads without a file.
    expect(sessionActions.find((action) => action.method === 'addSession')?.payload.engineId).toBe(OPENCODE)
    expect(
      sessionActions.some((action) => action.method === 'touchSession' && action.payload.engineModel === PICKED)
    ).toBe(true)
  })

  it('hydrates the header control from the record when an engine conversation is reopened', async () => {
    // A conversation whose turns ran a model, reopened: the value is not in the window — nothing survives a
    // relaunch in the workbench store — so it can only come off the record.
    const session: ChatSession = {
      id: SESSION_ID,
      title: 'the opencode conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      engineId: OPENCODE,
      engineModel: PICKED,
    }
    stubScreen({ session, catalogues: { [OPENCODE]: { ids: [...OFFERED], currentModelId: null } } })
    renderChat()

    const control = (await screen.findByRole('combobox', { name: ENGINE_MODEL_NAME })) as HTMLInputElement
    await waitFor(() => expect(control.value).toBe(PICKED))

    // And it is a live value rather than a frozen one: the catalogue its session advertised is still the list
    // the field searches.
    await userEvent.click(control)
    await waitFor(() => expect(offeredOptions()).toContain(PICKED))
  })

  it('offers a published catalogue to its own engine and to no other', async () => {
    // The publication is live: inside the conversation running the engine that advertised it, the control is
    // drawn and its list is that advertisement.
    stubScreen({
      session: { ...SAM_ROW, engineId: OPENCODE },
      catalogues: { [OPENCODE]: { ids: [...OFFERED], currentModelId: null } },
    })
    const view = renderChat()

    const control = (await screen.findByRole('combobox', { name: ENGINE_MODEL_NAME })) as HTMLInputElement
    await userEvent.click(control)
    await waitFor(() => expect(offeredOptions()).toEqual(OFFERED))
    view.unmount()

    // And the same publication, while a Codex conversation is open. Keyed per engine is the whole point: a
    // single latest slot would put this engine's list behind the other engine's control, and the row would
    // offer ids the turn under Codex never reads.
    stubScreen({
      session: { ...SAM_ROW, engineId: CODEX },
      catalogues: { [OPENCODE]: { ids: [...OFFERED], currentModelId: null } },
    })
    renderChat()

    const sam = await samModelPicker()
    expect(isDisabled(sam)).toBe(true)
    expect(sam.getAttribute('title')).toContain('Codex')
    expect(engineModelControl()).toBeNull()
    expect(offeredOptions()).toEqual([])
    for (const id of OFFERED) expect(screen.queryByText(id)).toBeNull()
  })

  it('draws nothing for Kimi after a turn that published no catalogue', async () => {
    // Kimi's installed CLI answers with a session that advertises nothing, and nothing here invents a list for
    // it: the engine that published no catalogue draws no control, which is the same rule that leaves its row
    // out of `ENGINE_MODEL_ENGINES`. The picker beside it keeps its behaviour — refused, with the engine named.
    stubScreen({ session: { ...SAM_ROW, engineId: KIMI } })
    renderChat()

    const sam = await samModelPicker()
    expect(isDisabled(sam)).toBe(true)
    expect(sam.getAttribute('title')).toContain('Kimi')
    expect(engineModelControl()).toBeNull()
    expect(offeredOptions()).toEqual([])
  })
})
