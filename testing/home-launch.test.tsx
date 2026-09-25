import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import {
  HOME_HEADLINE,
  HOME_OPEN_FOLDER,
  HOME_RECENT_PROJECTS,
  HOME_STARTERS,
  HOME_SUBLINE,
} from '@/app/components/workbench/home'
import { UNTITLED, titleFromMessage } from '@/app/components/workbench/session-rules'
import { chatSessionsStore, type ChatSession, type ChatSessionsState } from '@/conveyor/stores/chat-sessions'
import { TRANSCRIPT_VERSION, emptySnapshot, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The home screen a launch shows — the whole workbench, over the state a launch actually starts from.
 *
 * The gap this closes is not in the home screen's own composition: it is the launch. The store's
 * `activeSessionId` is persisted, so the state a launch begins with names whatever conversation was
 * open when the app was last closed, and a pane that reads that pointer as "there is a conversation to
 * open" opens it — leaving the empty transcript pane, or the last conversation, as what a launch
 * renders. The suites that covered home seeded a launch with no pointer at all, which is why they could
 * not see it.
 *
 * So these are launches, mounted whole: the store through the step main runs before any window exists,
 * and `Workbench` rather than the pane in isolation. A launch asserts the six pieces home is made of —
 * the hero, the real composer as a centred card with the approval chip in its footer, the recent
 * projects row, and the starters — and asserts that nothing was read as a transcript.
 * The other three cases are the neighbours of that rule: a conversation that *is* open and has no turns
 * still shows the empty pane, New chat returns here without creating one, and the first message sent
 * from here creates the conversation in the open folder and in the mode the chip was left on.
 *
 * Rendered under the app's own `queryClient`, because the conveyor client captures that instance when
 * it is constructed. It is cleared between tests.
 */

/**
 * The resize primitive, stood in for.
 *
 * The real one takes the caret on a pointerdown as it mounts, and jsdom does not follow that with the
 * click's own focus, so the composer would never receive a keystroke. Nothing about these claims goes
 * with it, and the two markers keep the structure queryable: `data-panel` names the chat column, which
 * is what scopes a home-screen query away from the conversation list standing beside it.
 */
vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-group id={id}>
      {children}
    </div>
  ),
  ResizablePanel: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-panel id={id}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'

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

/** A conversation in the list, as the store holds one. */
function row(id: string, title: string, options: { lastRoot?: string; updatedAt?: number } = {}): ChatSession {
  return {
    id,
    title,
    createdAt: 1_700_000_000_000,
    updatedAt: options.updatedAt ?? 1_700_000_000_000,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(options.lastRoot !== undefined ? { lastRoot: options.lastRoot } : {}),
  }
}

/** A transcript main is holding for a conversation that has been used. */
function storedTranscript(text: string, autoApprove = false): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'user-1', role: 'user', content: text, steps: [] }],
    autoApprove,
  }
}

/**
 * The store as persistence left it after a run that ended with a conversation open.
 *
 * Two conversations in two folders, the older one used in the folder that is open now, because that is
 * what makes the chips and the counts say different things.
 */
function persistedState(): ChatSessionsState {
  return {
    sessions: [
      row(FIRST, 'the parser work', { lastRoot: ROOT, updatedAt: 3 }),
      row(SECOND, 'the notes work', { lastRoot: NOTES, updatedAt: 2 }),
    ],
    activeSessionId: FIRST,
  }
}

/**
 * main, at launch: the step `router.ts` runs as soon as the store is readable, before any window exists.
 *
 * Modelled through the store's own launch rule rather than by writing a cleared pointer here, so a
 * launch's state cannot drift from the state main hands the first window.
 */
function launchState(state: ChatSessionsState): ChatSessionsState {
  chatSessionsStore.actions.landOnHome(state)
  return state
}

interface RecordedAction {
  method: string
  payload: unknown
}

interface Fixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  sessionActions: RecordedAction[]
  /** The transcript files main is holding, by session id. */
  transcripts: Record<string, TranscriptSnapshot>
}

/**
 * The whole workbench over the given state, with main answering every read it makes.
 *
 * Main is modelled as the two stores plus the transcript files, and — as in the pane-level suite — the
 * actions are *applied*, not merely recorded: the pane's state is the store's, so a stub that only
 * recorded the action would leave the renderer exactly where it was and every claim about leaving home
 * would pass for the wrong reason.
 */
function stubWorkbench(
  options: {
    state?: ChatSessionsState
    rootPath?: string | null
    recentRoots?: string[]
    transcripts?: Record<string, TranscriptSnapshot>
  } = {}
): Fixture {
  const transcripts: Record<string, TranscriptSnapshot> = { ...options.transcripts }
  const chat: ChatSessionsState = options.state ?? { sessions: [], activeSessionId: null }
  const workspace = {
    rootPath: options.rootPath === undefined ? ROOT : options.rootPath,
    recentRoots: options.recentRoots ?? [ROOT, NOTES],
  }

  const stub = createBridgeStub({
    isMaximized: () => false,
    chatWithTools: () => undefined,
    resume: () => undefined,
    loadTranscript: (input) => transcripts[(input as { id: string }).id] ?? null,
    saveTranscript: (input) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      transcripts[id] = snapshot
      return undefined
    },
    deleteTranscript: () => undefined,
    emptyTranscript: () => emptySnapshot(),
    transcriptVersion: () => TRANSCRIPT_VERSION,
    searchSessions: () => [],
    exportSession: () => null,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
    listDirectory: () => [],
    listFilesFlat: () => [],
    pickFolder: () => 'C:/work/picked',
    openRoot: (input) => ({ path: (input as { path: string }).path }),
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    shell: () => 'bash',
    listModels: () => [],
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', workspace)

  const sessionActions: RecordedAction[] = []
  const procedures = stub.bridge.invoke

  // Wrapped *after* `stubStore`, so its own state answer still stands: a wrapper that swallowed the
  // `__get__` read would leave the mirror with no state at all and let every case below pass for the
  // wrong reason.
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return chat
      const action = args[0] as { payload: Record<string, unknown> }
      sessionActions.push({ method, payload: args[0] })
      applySessionAction(chat, method, action.payload)
      stub.pushToChannel(`${channel}:changed`, { ...chat, sessions: [...chat.sessions] })
      return undefined
    }

    if (channel === 'conveyor:store:workspace') {
      if (method === '__get__') return workspace
      return procedures(channel, method, ...args)
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)

  // Seeded by `stubStore`, and pushed as well: the seed answers the initial read, which a store mirror
  // makes only once per store id for the life of the process, and the push is the only route that
  // reaches a mirror an earlier test has already cached. Synchronously, before anything renders, so the
  // first frame is the state this test described rather than the last one's.
  stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...chat, sessions: [...chat.sessions] })
  stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })

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
        ...(payload.lastRoot !== undefined ? { lastRoot: payload.lastRoot as string } : {}),
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

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/** The chat column's own node: what scopes a home-screen query away from the conversation list. */
function chatColumn(container: HTMLElement): HTMLElement {
  const column = container.querySelector<HTMLElement>('[data-panel]#chat')
  if (!column) throw new Error('the workbench rendered no chat column')
  return column
}

/**
 * End the run's stream, as main does when the model is done.
 *
 * The channel is read from the recorded start call rather than guessed, and an unstubbed stream stays
 * open — deliberately, since most cases here only care that a send went out. This one cares that the
 * turn *ended*, because a turn boundary is what schedules the transcript write.
 */
function endStream(stub: BridgeStub): void {
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  stub.emit(`conveyor:stream:${started?.method}`, { type: 'end' })
}

beforeEach(() => {
  // The workbench store outlives a test; clear what a test could otherwise inherit.
  useWorkbenchStore.setState({ selectedFile: null, selectedChange: null })
  queryClient.clear()
})

describe('a launch', () => {
  it('lands on home, with the conversations from last time offered back', async () => {
    const { stub } = stubWorkbench({ state: launchState(persistedState()) })
    const { container } = renderWorkbench()
    const chat = chatColumn(container)

    // The hero: the one heading, and the line under it, in the space the transcript would have taken.
    expect(await within(chat).findByText(HOME_HEADLINE)).toBeTruthy()
    expect(within(chat).getByText(HOME_SUBLINE)).toBeTruthy()

    // The composer as the centred card it is on this screen: the real box, the edge that resizes it,
    // the send, and the approval chip in the card's footer rather than in a conversation's header.
    const card = within(chat).getByLabelText('Message').closest('.rounded-xl')
    expect(card, 'the composer was not drawn as a card').toBeTruthy()
    expect(card?.className).toContain('mx-auto')
    expect(card?.className).toContain('max-w-3xl')
    expect(within(chat).getByRole('separator', { name: 'Resize the composer' })).toBeTruthy()
    expect(within(chat).getByLabelText('Send message')).toBeTruthy()

    const chip = within(chat).getByRole('button', { name: 'Approval mode' })
    expect(card?.contains(chip), 'the chip is not in the composer card').toBe(true)
    expect(chip.parentElement?.className).toContain('border-t')
    expect(chip.textContent).toContain('Manual')
    expect(chip.getAttribute('aria-pressed')).toBe('false')

    // The recent projects row beneath the card: a chip per folder the app remembers, named for the
    // folder and saying how many conversations were last used in it, with the way to a folder that is
    // not listed after them.
    expect(within(chat).getByText(HOME_RECENT_PROJECTS)).toBeTruthy()
    const rootChip = (root: string): HTMLElement => {
      const found = within(chat)
        .getAllByRole('button')
        .find((button) => button.getAttribute('title') === root)
      if (!found) throw new Error(`no chip for ${root}`)
      return found
    }
    expect(rootChip(ROOT).textContent).toContain('sam-ai')
    expect(rootChip(ROOT).lastElementChild?.textContent).toBe('1')
    expect(rootChip(NOTES).textContent).toContain('notes')
    expect(within(chat).getByRole('button', { name: HOME_OPEN_FOLDER })).toBeTruthy()

    // And nothing is left of the two surfaces this row replaced: no row of conversations named by
    // their titles, and no folder trigger standing beside it.
    expect(within(chat).queryByText(/Recent work/)).toBeNull()
    expect(within(chat).queryByRole('button', { name: 'Work in a project' })).toBeNull()
    expect(within(chat).queryByRole('button', { name: /the parser work/ })).toBeNull()

    // The three ways in, and the empty pane is not one of them.
    for (const prompt of HOME_STARTERS) expect(within(chat).getByRole('button', { name: prompt })).toBeTruthy()
    expect(screen.queryByText('Start a conversation')).toBeNull()

    // Nothing was read for a transcript: the pointer persistence restored names a conversation to offer
    // back, not one to open.
    expect(stub.methodsOn('sessions')).not.toContain('loadTranscript')
  })
})

describe('a conversation that is open', () => {
  it('shows the empty transcript pane when it has no turns yet', async () => {
    const { stub } = stubWorkbench({
      state: { sessions: [row(FIRST, 'just started', { lastRoot: ROOT })], activeSessionId: FIRST },
    })
    renderWorkbench()

    // Selected, so not home — and empty, so the pane says what it is waiting for rather than showing
    // the home screen, which belongs to a window with nothing open.
    expect(await screen.findByText('Start a conversation')).toBeTruthy()
    expect(screen.queryByText(HOME_HEADLINE)).toBeNull()
    expect(stub.methodsOn('sessions')).toContain('loadTranscript')
  })
})

describe('the New chat control', () => {
  it('returns home from an open conversation without creating one', async () => {
    const { sessionActions } = stubWorkbench({
      state: { sessions: [row(FIRST, 'an open conversation', { lastRoot: ROOT })], activeSessionId: FIRST },
      transcripts: { [FIRST]: storedTranscript('what the parser work turned up') },
    })
    renderWorkbench()

    expect(await screen.findByText('what the parser work turned up')).toBeTruthy()
    expect(screen.queryByText(HOME_HEADLINE)).toBeNull()

    await userEvent.click(screen.getByLabelText('New chat'))

    expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()
    expect(screen.queryByText('Start a conversation')).toBeNull()
    // Home, and nothing created: the control is a way back to the start, not a row nobody typed into.
    expect(sessionActions.some((a) => a.method === 'addSession')).toBe(false)
    expect(sessionActions).toContainEqual({ method: 'setActive', payload: { payload: { id: null } } })
  })
})

describe('the first message from home', () => {
  it('creates the conversation in the open folder, in the mode the chip was left on', async () => {
    const { stub, sessionActions, transcripts } = stubWorkbench({ state: launchState(persistedState()) })
    const { container } = renderWorkbench()

    const chip = await screen.findByRole('button', { name: 'Approval mode' })
    expect(chip.textContent).toContain('Manual')
    await userEvent.click(chip)
    expect(screen.getByRole('button', { name: 'Approval mode' }).textContent).toContain('Auto-approve')

    await userEvent.type(screen.getByLabelText('Message'), 'make a fibonacci script')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(sessionActions.some((a) => a.method === 'addSession')).toBe(true))
    const created = sessionActions.find((a) => a.method === 'addSession')?.payload as {
      payload: { id: string; title: string; lastRoot?: string }
    }
    expect(created.payload.title).toBe(UNTITLED)
    expect(created.payload.lastRoot).toBe(ROOT)

    const named = sessionActions.find((a) => a.method === 'touchSession')?.payload as {
      payload: { id: string; title: string }
    }
    expect(named.payload.id).toBe(created.payload.id)
    expect(named.payload.title).toBe(titleFromMessage('make a fibonacci script'))

    // Home is swapped for the transcript of the conversation that now exists, and the message is in
    // it. Scoped to the conversation because the message is also the name the row now carries.
    await waitFor(() => expect(screen.queryByText(HOME_HEADLINE)).toBeNull())
    const chat = chatColumn(container)
    expect(await within(chat).findByText('make a fibonacci script')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    )

    // The mode the chip was left on is the mode the conversation runs under, on disk as well as on
    // screen: the stream's end is what schedules the transcript write.
    await waitFor(() => expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(true))
    endStream(stub)

    await waitFor(() => expect(stub.methodsOn('sessions')).toContain('saveTranscript'), { timeout: 5000 })
    expect(transcripts[created.payload.id]?.autoApprove).toBe(true)
  })
})
