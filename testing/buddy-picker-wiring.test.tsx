import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { BUDDY_LOCK_CAPTION, ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { HOME_STARTERS } from '@/app/components/workbench/home'
import {
  BUILTIN_BUDDIES,
  REMOVED_BUDDY_LABEL,
  AGENT_SAM_BUDDY_NAME,
  type BuddyRecord,
} from '@/conveyor/protocol/buddies'
import type { BuddiesState } from '@/conveyor/stores/buddies'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Buddy Select, as wiring: what the header offers, what it locks, and what the choice seeds.
 *
 * The rules behind it are the protocol module's and are `tests/buddies/buddies-list-test.ts`'s — which
 * rows a list holds, which id calls itself what, and what a record seeds. What only a rendered pane can
 * show is the composition, and that is the whole of this file: that the Select sits beside the Chat
 * title and offers the enabled rows with Agent Sam fixed first, that its value is the home choice before a
 * conversation exists and that conversation's own frozen Buddy after, that the home starters follow the
 * choice, and that the first send is where the choice reaches a record.
 *
 * The seeding itself was built and reviewed in the turn before this one, so these cases are what keeps
 * it wired rather than what decides it: a request that quietly stops carrying the Buddy would fail here.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the Select looks right beside the model
 * dropdown; that is Boss's eyes on the running app.
 */

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** The app's own three, in the order the module declares them. */
const BUILTINS = BUILTIN_BUDDIES
/** One of them, used for the starter swap: the first built-in is the one that declares three. */
const WRITER = BUILTIN_BUDDIES[0]
/** A built-in switched off in the cases below: it must be listed in Settings and not offered here. */
const SWITCHED_OFF = 'analyst'

/**
 * A custom record that declares every optional field, and pins a pair that is *not* the window's own.
 *
 * Deliberately not `deepseek/deepseek-chat`: that is what the workbench store holds, so a seed that
 * never arrived would leave the created row looking seeded and the case below would pass for the wrong
 * reason.
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
  autoApprove: true,
  starters: ['Cut a release', 'Write the changelog'],
  builtin: false,
}

/** A second custom record, so the order after the built-ins has something to be wrong about. */
const REVIEWER: BuddyRecord = {
  id: 'pair-reviewer',
  name: 'Pair Reviewer',
  glyph: 'P',
  description: 'Reads the diff before you do.',
  rolePrompt: 'Read the diff and say what would break.',
  skillIds: [],
  mcpIds: [],
  starters: [],
  builtin: false,
}

/** An empty store: the built-ins are not in it, which is the point of their being pure data. */
const NO_CUSTOM: BuddiesState = { custom: [], disabledIds: [] }

/** The providers and models the model dropdown beside the Select draws from. */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
]

const DEFAULT_MODELS = {
  deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
  openai: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
}

/** A conversation already created as the Captain, as its record is published on startup. */
const OPEN_SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'the release',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
  buddyId: CAPTAIN.id,
  rolePrompt: CAPTAIN.rolePrompt,
  mcpSubset: CAPTAIN.mcpIds,
  activeSkillIds: CAPTAIN.skillIds,
}

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

interface PickerFixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  actions: RecordedAction[]
}

/**
 * Main, as the four stores this screen reads: it applies every action it is sent and broadcasts the
 * result, so a conversation the send creates is one the mirror then holds — which is what makes the
 * Buddy a sent conversation runs as readable off the screen rather than only off the wire.
 */
function stubScreen(
  options: {
    buddies?: BuddiesState
    sessions?: ChatSession[]
    activeSessionId?: string | null
  } = {}
): PickerFixture {
  const chat: { sessions: ChatSession[]; activeSessionId: string | null } = {
    sessions: options.sessions ?? [],
    activeSessionId: options.activeSessionId ?? null,
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

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  // The user's own Buddies, which the picker's rows and the seed both read.
  stubStore(stub, 'buddies', options.buddies ?? NO_CUSTOM)

  const actions: RecordedAction[] = []
  const procedures = stub.bridge.invoke

  // Wrapped *after* `stubStore`, so its own state answer still stands: a wrapper that swallowed the
  // `__get__` read would leave the mirror with no state at all. Actions arrive as invokes on the store
  // channel with the action's name as the method.
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

/** What main's reducer does with one action, narrowed to the three writes this screen makes. */
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

/** The pane under a provider that stays mounted, which is what the workbench renders. */
function Screen({ paneKey = 'pane' }: { paneKey?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel key={paneKey} />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

function renderScreen(paneKey = 'pane') {
  return render(<Screen paneKey={paneKey} />)
}

/** The header's Buddy Select. */
const buddyTrigger = (): Promise<HTMLElement> => screen.findByRole('combobox', { name: 'Buddy' })

/**
 * Open the Select from the keyboard, as the model picker's own suite does.
 *
 * Radix's trigger opens on a click only when the event's `pointerType` is `mouse`, and jsdom's pointer
 * events carry no such type. Enter is a path a keyboard user takes anyway, and the one Radix routes
 * without consulting the pointer at all.
 */
async function openBuddyPicker(): Promise<HTMLElement> {
  const trigger = await buddyTrigger()
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
  return trigger
}

/** Every option the open Select offers, in the order it offers them. */
const options = (): string[] => screen.getAllByRole('option').map((option) => option.textContent ?? '')

/** Choose one option by its label. The list is open, so it is read from there. */
async function pick(label: string): Promise<void> {
  const option = screen.getAllByRole('option').find((candidate) => (candidate.textContent ?? '') === label)
  if (!option) throw new Error(`no option named ${label} — the Select offered ${options().join(', ')}`)
  await userEvent.click(option)
}

/**
 * Whether a control is disabled, as Radix states it: the attribute its styles key off, and the one a
 * screen reader is told.
 */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('data-disabled') !== null
}

/** The payload of the one conversation the send created. */
function createdSession(actions: RecordedAction[]): Record<string, unknown> {
  const action = actions.find((entry) => entry.method === 'addSession')
  if (!action) throw new Error('the send created no conversation')
  return (action.payload as { payload: Record<string, unknown> }).payload
}

/** The composer, as the field a starter fills. */
const composer = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

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

describe('the Buddy Select on the home screen', () => {
  it('is enabled, and shows the Agent Sam default', async () => {
    stubScreen()
    renderScreen()

    const trigger = await buddyTrigger()

    expect(isDisabled(trigger)).toBe(false)
    expect(trigger.textContent).toContain('Agent Sam')
  })

  it('offers Agent Sam first, then the enabled built-ins and customs, and none of the switched-off', async () => {
    stubScreen({ buddies: { custom: [CAPTAIN, REVIEWER], disabledIds: [SWITCHED_OFF] } })
    renderScreen()
    await openBuddyPicker()

    expect(options()).toEqual([
      AGENT_SAM_BUDDY_NAME,
      ...BUILTINS.filter((buddy) => buddy.id !== SWITCHED_OFF).map((buddy) => buddy.name),
      CAPTAIN.name,
      REVIEWER.name,
    ])
  })

  it('swaps the home starters for the chosen Buddy’s, and back for Agent Sam', async () => {
    const { stub } = stubScreen()
    renderScreen()

    await openBuddyPicker()
    await pick(WRITER.name)

    for (const starter of WRITER.starters) {
      expect(screen.getByRole('button', { name: starter })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: HOME_STARTERS[0] })).toBeNull()

    // Still a sentence to start from rather than a send: the swap changes which words are offered.
    await userEvent.click(screen.getByRole('button', { name: WRITER.starters[0] }))
    expect(composer().value).toBe(WRITER.starters[0])
    expect(stub.methodsOn('agent')).not.toContain('chatWithTools')

    await openBuddyPicker()
    await pick(AGENT_SAM_BUDDY_NAME)

    expect(screen.getByRole('button', { name: HOME_STARTERS[0] })).toBeTruthy()
    expect(screen.queryByRole('button', { name: WRITER.starters[0] })).toBeNull()
  })

  it('keeps the choice across a keyed remount of the pane', async () => {
    stubScreen()
    const { rerender } = renderScreen()

    await openBuddyPicker()
    await pick(WRITER.name)

    // The workbench keys the resize group the chat pane lives in on the window state, under a provider
    // that stays mounted — so a maximize replaces the pane and nothing above it. That is the swap.
    rerender(<Screen paneKey="after a maximize" />)

    expect((await buddyTrigger()).textContent).toContain(WRITER.name)
  })
})

describe('the first send, with a Buddy chosen on home', () => {
  it('seeds the conversation with its snapshots and the defaults the record declares', async () => {
    const { actions } = stubScreen({ buddies: { custom: [CAPTAIN], disabledIds: [] } })
    renderScreen()

    await openBuddyPicker()
    await pick(CAPTAIN.name)
    await userEvent.type(await screen.findByLabelText('Message'), 'cut the release{Enter}')

    await waitFor(() => expect(actions.some((action) => action.method === 'addSession')).toBe(true))
    const created = createdSession(actions)

    // The identity, and the two snapshots taken at creation rather than read again later.
    expect(created.buddyId).toBe(CAPTAIN.id)
    expect(created.rolePrompt).toBe(CAPTAIN.rolePrompt)
    expect(created.mcpSubset).toEqual(CAPTAIN.mcpIds)
    // The skills the conversation starts running, and the pair the record pinned — which is not the
    // window's own pair, so this is the seed and not the fallback.
    expect(created.activeSkillIds).toEqual(CAPTAIN.skillIds)
    expect(created.providerId).toBe(CAPTAIN.providerId)
    expect(created.model).toBe(CAPTAIN.model)

    // And the declared consent, written onto the transcript the conversation now runs under: what is
    // read off the pane's own header toggle, which is where the seed lands.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    )
  })

  it('seeds nothing at all when the send is the Agent Sam default', async () => {
    const { actions } = stubScreen()
    renderScreen()

    await userEvent.type(await screen.findByLabelText('Message'), 'hello{Enter}')

    await waitFor(() => expect(actions.some((action) => action.method === 'addSession')).toBe(true))
    const created = createdSession(actions)

    // Absent rather than written with a default: a conversation created as nobody is byte-identical to
    // one created before Buddies existed.
    expect('buddyId' in created).toBe(false)
    expect('rolePrompt' in created).toBe(false)
    expect('mcpSubset' in created).toBe(false)
    expect('activeSkillIds' in created).toBe(false)
    expect(created.providerId).toBe('deepseek')
    expect(created.model).toBe('deepseek-chat')

    // And nothing was switched on behind the user: the consent chip starts off and stays off.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' })).toBeTruthy())
    expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('the Buddy Select in an open conversation', () => {
  it('shows that conversation’s Buddy, locked and explained, while the controls beside it stay live', async () => {
    stubScreen({
      buddies: { custom: [CAPTAIN], disabledIds: [] },
      sessions: [OPEN_SESSION],
      activeSessionId: SESSION_ID,
    })
    renderScreen()

    const trigger = await buddyTrigger()

    expect(trigger.textContent).toContain(CAPTAIN.name)
    expect(isDisabled(trigger)).toBe(true)
    // The rule, in one sentence: the identity is fixed and the two controls beside it are not — which is
    // what makes a locked control read as deliberate rather than broken.
    expect(trigger.getAttribute('title')).toBe(BUDDY_LOCK_CAPTION)

    const model = screen.getByRole('combobox', { name: 'Provider and model' })
    expect(isDisabled(model)).toBe(false)

    const shield = screen.getByRole('switch', { name: 'Auto-approve tool actions' })
    await userEvent.click(shield)
    await waitFor(() => expect(shield.getAttribute('aria-checked')).toBe('true'))
  })

  it('names a conversation whose custom Buddy was deleted as the Removed Buddy', async () => {
    stubScreen({
      sessions: [{ ...OPEN_SESSION, buddyId: 'gone-buddy' }],
      activeSessionId: SESSION_ID,
    })
    renderScreen()

    const trigger = await buddyTrigger()

    // Not the default and not the raw id: the conversation still runs as the role that record seeded it
    // with, so the only honest label is that the Buddy is gone.
    expect(trigger.textContent).toContain(REMOVED_BUDDY_LABEL)
    expect(isDisabled(trigger)).toBe(true)
  })
})
