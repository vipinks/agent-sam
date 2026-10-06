/**
 * The engine picker and the engine consent bridge, as wiring: what the chat header offers beside the
 * Buddy picker, what locks when a conversation starts, what an active engine does to the model picker,
 * and where a `session/request_permission` that arrived from an engine is answered.
 *
 * The rules behind the picker are the protocol module's and are `tests/engines/engine-spawn-test.ts`'s
 * — which engine ids exist, what a row says when a probe found nothing, and why an unknown id is refused
 * by code. What only a rendered pane can show is the composition, which is the whole of this file: that
 * the control sits in the header beside the Buddy picker, that it is live only while there is no
 * conversation to fix an engine on, that a conversation running an engine takes the model picker away
 * rather than letting a send leave under a promise the engine cannot keep, and that an engine's consent
 * question reaches the shield card and the answer reaches main.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the picker looks right beside the Buddy
 * Select in either theme; that is Boss's eyes on the running app.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ENGINE_LOCK_CAPTION, ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { AGENT_SAM_ENGINE_NAME, ENGINE_NOT_INSTALLED_NOTE, type EngineRow } from '@/conveyor/protocol/engine'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import type { PendingEngineConsent } from '@/conveyor/protocol/engine'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const CODEX = 'codex'

/** The providers and models the model dropdown beside the picker draws from. */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

const DEFAULT_MODELS = {
  deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
  openai: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
}

/** The Sam default first, then the engine this machine has not got. */
const NOT_INSTALLED_ROWS: EngineRow[] = [
  { id: null, name: AGENT_SAM_ENGINE_NAME, installed: true, version: null, note: null },
  { id: CODEX, name: 'Codex', installed: false, version: null, note: ENGINE_NOT_INSTALLED_NOTE },
]

/** The same list after a probe found the binary, which is what makes the row selectable. */
const INSTALLED_ROWS: EngineRow[] = [
  NOT_INSTALLED_ROWS[0],
  { id: CODEX, name: 'Codex', installed: true, version: '0.154.0', note: null },
]

/** A conversation that runs the Sam loop: no engine key, exactly as every record written before it. */
const SAM_SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'the first conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
}

/** The same conversation, created under an engine. */
const ENGINE_SESSION: ChatSession = { ...SAM_SESSION, engineId: CODEX }

/** One consent question, as main would publish it while the engine waits for an answer. */
const PENDING_CONSENT: PendingEngineConsent = {
  requestId: '900',
  engineId: CODEX,
  engineName: 'Codex',
  toolCallId: 'call-1',
  title: 'Write notes.md',
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ],
}

interface ScreenFixture {
  stub: BridgeStub
}

/**
 * Main, as the stores and the two reads this screen draws from.
 *
 * The engine list is stubbed per case, because the picker's whole job is to say what a probe found:
 * a suite that always answered "installed" could not see the row that has to say it is not.
 */
function stubScreen(
  options: { rows?: EngineRow[]; session?: ChatSession | null; consent?: PendingEngineConsent | null } = {}
): ScreenFixture {
  const chat = {
    sessions: options.session ? [options.session] : [],
    activeSessionId: options.session ? options.session.id : null,
  }

  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
  })
  // The two engine rails are seeds rather than stubbed calls, because that is what they are in the app: rows
  // main published after probing, and a question main is holding. What these cases drive is the same mirror
  // every window reads, not a second path written for the suite.
  // A store is read on mount by every suite that renders the pane, so the stub seeds it here as well.
  stubStore(stub, 'engine-status', { rows: options.rows ?? NOT_INSTALLED_ROWS })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', { custom: [], disabledIds: [] })
  stubStore(stub, 'engine-consent', { pending: options.consent ?? null })

  setActiveStub(stub)
  return { stub }
}

function Screen(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

const renderScreen = () => render(<Screen />)

/** The two pickers, by the labels a reader is told. */
const buddyTrigger = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Buddy' })
const engineTrigger = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Engine' })
const modelTrigger = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Provider and model' })

/** Open a Select from the keyboard, the one path Radix routes without consulting the pointer. */
async function open(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/** Whether a control is disabled, as Radix states it. */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('data-disabled') !== null
}

/** One recorded bridge call's payload, as main receives it. */
function payloadOf(stub: BridgeStub, module: string, method: string): Record<string, unknown> {
  const call = stub.callsTo(module).find((entry) => entry.method === method)
  if (!call) throw new Error(`no ${module}.${method} call was made`)
  return (call.args[0] ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeProviderId: 'deepseek',
    activeModel: 'deepseek-chat',
    selectedFile: null,
    selectedChange: null,
  })
  queryClient.clear()
})

describe('the engine picker in the chat header', () => {
  it('is drawn in the header, beside the Buddy picker', async () => {
    stubScreen()
    renderScreen()

    const buddy = await buddyTrigger()
    const engine = await engineTrigger()
    const header = buddy.closest('header')

    expect(header).not.toBeNull()
    expect(header?.contains(engine)).toBe(true)
    // After the Buddy picker in document order: the two sit in one cluster, and the engine is the
    // second of them rather than a control that arrived somewhere else in the row.
    expect(buddy.compareDocumentPosition(engine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers Agent Sam first, and says an engine is not installed rather than offering it', async () => {
    stubScreen()
    renderScreen()

    await open(await engineTrigger())
    const options = screen.getAllByRole('option')

    expect(options.map((option) => option.textContent)).toEqual([
      AGENT_SAM_ENGINE_NAME,
      `Codex · ${ENGINE_NOT_INSTALLED_NOTE}`,
    ])
    expect(isDisabled(options[1])).toBe(true)
    expect(isDisabled(options[0])).toBe(false)
  })

  it('offers the engine once the probe found it, and taking it is what the trigger then shows', async () => {
    stubScreen({ rows: INSTALLED_ROWS })
    renderScreen()

    const trigger = await engineTrigger()
    expect(trigger.textContent).toContain(AGENT_SAM_ENGINE_NAME)

    await open(trigger)
    const codex = screen.getAllByRole('option').find((option) => option.textContent?.startsWith('Codex'))
    expect(codex).toBeDefined()
    expect(isDisabled(codex as HTMLElement)).toBe(false)

    await userEvent.click(codex as HTMLElement)
    await waitFor(() => expect(trigger.textContent).toContain('Codex'))
  })
})

describe('what the choice locks', () => {
  it('is live while home, and locked — with the reason said out loud — once a conversation exists', async () => {
    stubScreen()
    const first = renderScreen()
    const home = await engineTrigger()
    expect(isDisabled(home)).toBe(false)
    first.unmount()

    stubScreen({ session: SAM_SESSION })
    renderScreen()
    const locked = await engineTrigger()

    expect(isDisabled(locked)).toBe(true)
    // The caption rather than a bare refusal: a control that will not move must say why, and the words
    // are the pane's own printed constant, not a second sentence written here.
    expect(locked.getAttribute('title')).toBe(ENGINE_LOCK_CAPTION)
  })

  it('shows the conversation\u2019s own engine once one is running, and never the Sam default for it', async () => {
    stubScreen({ session: ENGINE_SESSION })
    renderScreen()

    const trigger = await engineTrigger()
    expect(trigger.textContent).toContain('Codex')
    expect(trigger.textContent).not.toContain(AGENT_SAM_ENGINE_NAME)
  })

  it('shows the Sam default for a conversation that named no engine', async () => {
    stubScreen({ session: SAM_SESSION })
    renderScreen()

    await waitFor(async () => expect((await engineTrigger()).textContent).toContain(AGENT_SAM_ENGINE_NAME))
  })
})

describe('what an active engine does to the model picker', () => {
  it('leaves it live for a conversation running the Sam loop', async () => {
    stubScreen({ session: SAM_SESSION })
    renderScreen()

    const model = await modelTrigger()
    expect(isDisabled(model)).toBe(false)
  })

  it('renders it disabled while an engine owns the conversation, and says which engine does', async () => {
    stubScreen({ session: ENGINE_SESSION })
    renderScreen()

    const model = await modelTrigger()

    expect(isDisabled(model)).toBe(true)
    // A disabled control is not a pointer target, so the reason travels in the native title rather than
    // in a tooltip that would never mount.
    expect(model.getAttribute('title')).toContain('Codex')
  })
})

describe('the engine consent bridge', () => {
  it('puts the engine\u2019s question on the shield, and the card says where it came from', async () => {
    stubScreen({ session: SAM_SESSION, consent: PENDING_CONSENT })
    renderScreen()

    const card = await screen.findByText(PENDING_CONSENT.title)
    expect(card).toBeDefined()
    // The marker the shield reads: the engine's own name is on the card, and a card that showed neither
    // would be a question with no author. The exact word rather than a pattern, because the summary line
    // above the block names the engine too and a pattern would match both.
    expect(await screen.findByText('Codex')).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Deny' })).toBeDefined()
  })

  it('answers Approve with the option that allows, and returns it to the engine', async () => {
    const { stub } = stubScreen({ session: SAM_SESSION, consent: PENDING_CONSENT })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(stub.methodsOn('engine')).toContain('answerConsent'))
    expect(payloadOf(stub, 'engine', 'answerConsent')).toEqual({
      requestId: PENDING_CONSENT.requestId,
      optionId: 'allow-once',
    })
  })

  it('answers Deny with the option that refuses, on the same route', async () => {
    const { stub } = stubScreen({ session: SAM_SESSION, consent: PENDING_CONSENT })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(stub.methodsOn('engine')).toContain('answerConsent'))
    expect(payloadOf(stub, 'engine', 'answerConsent')).toEqual({
      requestId: PENDING_CONSENT.requestId,
      optionId: 'reject-once',
    })
  })
})
