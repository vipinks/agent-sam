import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { BuddyRecord } from '@/conveyor/protocol/buddies'
import type { BuddiesState } from '@/conveyor/stores/buddies'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * What the first send of a Buddy conversation carries to main.
 *
 * `buddy-picker-wiring.test.tsx` states what the choice does to the *record*: a conversation created as a
 * Buddy is written with that Buddy's role and server list. This file states the other half, which the
 * record cannot show — the turn that same send starts. The two are not the same fact, and the gap between
 * them is a defect class this app has already paid for once: the create writes the record and the record
 * comes back to this window a round trip later, so a turn assembled from what the window shows on the
 * first message of a conversation is a turn assembled from before there was a conversation at all.
 *
 * Phase 84 fixed that for the engine (`27dcbf9`), where the send read the engine off a render value and
 * lost it; the residual it named is these two, which travelled to main by the same route and were never
 * proven. These cases are the proof, and they are deliberately about the payload the real client issues —
 * the stream call main receives — rather than about anything the pane renders.
 *
 * Kept in a file of its own rather than beside the picker's cases, and that is not tidiness: both cases
 * here send, and in this harness a picker opened in a case that follows a send is a picker opened against
 * a store mirror still holding the previous case's conversation, which reads as a conversation already on
 * screen and answers with a locked Select. A case that only sends is immune; a case that has to *choose*
 * before it sends is not, so it goes first in a file where nothing has been sent yet.
 *
 * jsdom proves wiring and payloads, not pixels.
 */

const ROOT = 'C:/work/sam-ai'

/**
 * A custom record that carries a role and a server list, and pins a pair that is not the window's own.
 *
 * Both of those are the point: the role is the string that has to arrive verbatim, and the server list is
 * the one the turn has to be limited to. Neither is `deepseek`/`deepseek-chat`, so a turn that fell back
 * to the window's own values would not look like a pass.
 */
const CAPTAIN: BuddyRecord = {
  id: 'release-captain',
  name: 'Release Captain',
  glyph: 'R',
  description: 'Ships the thing and says what shipped.',
  rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
  skillIds: ['code-review'],
  mcpIds: ['filesystem'],
  providerId: 'openai',
  model: 'gpt-4o-mini',
  autoApprove: false,
  starters: ['Cut a release'],
  builtin: false,
}

/** An empty store: the built-ins are not in it, which is the point of their being pure data. */
const NO_CUSTOM: BuddiesState = { custom: [], disabledIds: [] }

/** The providers the model dropdown beside the Select draws from. */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

const DEFAULT_MODELS = {
  deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
  openai: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
}

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

interface SendFixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  actions: RecordedAction[]
}

/**
 * Main, as the stores this screen reads: it applies every action it is sent and broadcasts the result, so
 * the conversation a send creates is one the mirror then holds.
 */
function stubScreen(options: { buddies?: BuddiesState } = {}): SendFixture {
  const chat: { sessions: ChatSession[]; activeSessionId: string | null } = { sessions: [], activeSessionId: null }

  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', options.buddies ?? NO_CUSTOM)

  const actions: RecordedAction[] = []
  const procedures = stub.bridge.invoke

  // Wrapped *after* `stubStore`, so its own state answer still stands: a wrapper that swallowed the
  // `__get__` read would leave the mirror with no state at all.
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return chat
      const action = args[0] as { payload: Record<string, unknown> }
      actions.push({ method, payload: args[0] })
      applySessionAction(chat, method, action.payload)
      stub.pushToChannel(`${channel}:changed`, { ...chat, sessions: [...chat.sessions] })
      return undefined
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  return { stub, actions }
}

/** What main's reducer does with one action, narrowed to the writes this screen makes. */
function applySessionAction(
  chat: { sessions: ChatSession[]; activeSessionId: string | null },
  method: string,
  payload: Record<string, unknown>
): void {
  if (method === 'addSession') {
    const id = payload.id as string
    if (chat.sessions.some((session) => session.id === id)) return
    chat.sessions = [
      ...chat.sessions,
      {
        id,
        title: payload.title as string,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: payload.providerId as string,
        model: payload.model as string,
        ...(payload.activeSkillIds === undefined ? {} : { activeSkillIds: payload.activeSkillIds as string[] }),
        ...(payload.buddyId === undefined ? {} : { buddyId: payload.buddyId as string }),
        ...(payload.rolePrompt === undefined ? {} : { rolePrompt: payload.rolePrompt as string }),
        ...(payload.mcpSubset === undefined ? {} : { mcpSubset: payload.mcpSubset as string[] }),
      },
    ]
    return
  }

  if (method === 'touchSession') {
    chat.sessions = chat.sessions.map((session) =>
      session.id === payload.id ? ({ ...session, ...payload } as ChatSession) : session
    )
    return
  }

  if (method === 'setActive') chat.activeSessionId = payload.id as string | null
}

function Screen() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

function renderScreen() {
  return render(<Screen />)
}

/**
 * Open the Buddy Select from the keyboard, the one path Radix routes without consulting the pointer.
 *
 * Radix opens its trigger on a click only when the event carries a mouse `pointerType`, and jsdom's
 * pointer events carry none.
 */
async function openBuddyPicker(): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: 'Buddy' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/**
 * The name an option shows, read from the slot that holds it: every option is prefixed with its entry's
 * mark, so a row's own text is the badge's character followed by the name.
 */
const optionName = (option: HTMLElement): string => option.querySelector('[data-slot="buddy-name"]')?.textContent ?? ''

/** Choose one option by its name. The list is open, so it is read from there. */
async function pick(name: string): Promise<void> {
  const option = screen.getAllByRole('option').find((candidate) => optionName(candidate) === name)
  if (!option) throw new Error(`no option named ${name}`)
  await userEvent.click(option)
}

/** The composer, as the field a send is typed into. */
const composer = (): Promise<HTMLTextAreaElement> => screen.findByLabelText('Message') as Promise<HTMLTextAreaElement>

/** The payload of the one conversation a send created. */
function createdSession(actions: RecordedAction[]): Record<string, unknown> {
  const action = actions.find((entry) => entry.method === 'addSession')
  if (!action) throw new Error('the send created no conversation')
  return (action.payload as { payload: Record<string, unknown> }).payload
}

/**
 * The turn the pane asked main to start, as main receives it.
 *
 * Read from the recorded bridge calls rather than from a stub, as the engine suites read theirs: the
 * assertion is about the payload the real client issued, so the shape, the stream channel and the
 * envelope are the shipped ones and only the transport is replaced. `agent.chatWithTools` is the app's own
 * loop, which is the one a conversation that named no engine runs as.
 */
async function chatTurnInput(stub: BridgeStub): Promise<Record<string, unknown>> {
  await waitFor(() => {
    const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (started.length === 0) throw new Error('no stream was started')
  })

  const call = stub.calls.find((entry) => String(entry.method).startsWith('agent.chatWithTools#'))
  if (!call) throw new Error('the chat turn was never started')
  const envelope = call.args[0] as { input?: Record<string, unknown> }
  if (!envelope.input) throw new Error('the stream start carried no input')
  return envelope.input
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

describe('the turn the first send of a Buddy conversation starts', () => {
  it('carries the chosen Buddy’s role verbatim and its server list, on the send that creates the conversation', async () => {
    // The state this is about: no conversation yet, a Buddy chosen while there is none to hold it, and the
    // first message as the send. The record the choice seeds is written by this very send and is back in
    // this window only after a round trip, so a turn assembled from what the window shows was assembled
    // before the create — and on a conversation's first message that means no role and no server list at
    // all, which is how the app's own loop came to answer a Buddy conversation as nobody.
    const { actions, stub } = stubScreen({ buddies: { custom: [CAPTAIN], disabledIds: [] } })
    renderScreen()

    await openBuddyPicker()
    await pick(CAPTAIN.name)
    await userEvent.type(await composer(), 'cut the release{Enter}')

    // The record first, so a failure below cannot be read as a seed that never happened: this half was
    // already stated by the picker's own suite, and it is restated here because the two are one claim.
    await waitFor(() => expect(actions.some((action) => action.method === 'addSession')).toBe(true))
    const created = createdSession(actions)
    expect(created.rolePrompt).toBe(CAPTAIN.rolePrompt)
    expect(created.mcpSubset).toEqual(CAPTAIN.mcpIds)

    const payload = await chatTurnInput(stub)

    // And the turn. Verbatim, because the role reaches a provider as standing context: a turn that
    // re-derived it would be a second source of truth for what the conversation runs as.
    expect(payload.rolePrompt).toBe(CAPTAIN.rolePrompt)
    expect(payload.mcpSubset).toEqual(CAPTAIN.mcpIds)
  })

  it('carries neither a role nor a server list when the creating send is the Agent Sam default', async () => {
    // The paired refusal, and the reason both are asserted on one payload: a fix that simply always sent
    // whatever the window held would put a role on a conversation that named nobody. The Agent Sam default
    // is what every conversation created before Buddies existed runs as, and its request has to stay the
    // request it always was.
    const { actions, stub } = stubScreen()
    renderScreen()

    await userEvent.type(await composer(), 'hello{Enter}')

    // A conversation was created — asserted, not assumed: without it a pane that never sent, or one that
    // re-used a conversation from elsewhere, would pass this case for a reason that is not the claim.
    await waitFor(() => expect(actions.some((action) => action.method === 'addSession')).toBe(true))
    const created = createdSession(actions)
    expect('rolePrompt' in created).toBe(false)
    expect('mcpSubset' in created).toBe(false)

    const payload = await chatTurnInput(stub)

    expect(payload.rolePrompt).toBeUndefined()
    expect(payload.mcpSubset).toBeUndefined()
  })
})
