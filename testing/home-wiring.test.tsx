import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import {
  HOME_HEADLINE,
  HOME_OPEN_FOLDER,
  HOME_RECENT_PROJECTS,
  HOME_STARTERS,
  HOME_SUBLINE,
} from '@/app/components/workbench/home'
import { UNTITLED, titleFromMessage } from '@/app/components/workbench/session-rules'
import { applyThemeVars, clearThemeVars, themeVarsFor } from '@/app/components/workbench/theme-apply'
import { WORKSPACE_MISSING, rememberRoot } from '@/conveyor/protocol/recent-roots'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The home screen, as wiring rather than as rules.
 *
 * What only a rendered screen can show is whether the pieces are actually connected: that a launch
 * with nothing open lands here instead of on an empty transcript, that the New chat control returns
 * here rather than creating a conversation nobody asked for, that the recent projects row reaches the
 * real folder dialog, the real `openRoot` call and the drawer's own session-open action, that a
 * starter fills the composer without sending it, and that the first send is what creates the
 * conversation — with the folder it is created in and the approval mode the chip was left on.
 *
 * Every assertion is on what crossed the bridge or on what a reader can see, never on a private
 * detail: the failure this guards against is a control that renders correctly and calls nothing.
 *
 * Rendered under the app's own `queryClient`, because the conveyor client captures that instance when
 * it is constructed. It is cleared between tests.
 */

const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'
const PICKED = 'C:/work/picked'

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'
const THIRD = 'cccccccc-3333-4333-8333-333333333333'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window makes the virtualizer
 * render no rows at all, which is why this is stated rather than left out. Leaving home is exactly what
 * this suite asserts, and the transcript is where the message it lands on is drawn.
 *
 * Scoped to this file and restored afterwards, so no other suite inherits a fabricated size.
 */
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

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

interface HomeFixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  sessionActions: RecordedAction[]
  /** The transcript files main is holding, by session id. */
  transcripts: Record<string, TranscriptSnapshot>
}

/** A stored conversation, as a session that has been used and left behind. */
function storedTranscript(text: string, autoApprove = false): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'user-1', role: 'user', content: text, steps: [] }],
    autoApprove,
  }
}

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

/**
 * Main, as the two stores this screen reads: it applies every action it is sent and broadcasts the
 * result.
 *
 * Applying the actions is what makes "the screen left home" testable at all — the pane's state is the
 * store's, and a stub that only recorded the action would leave the renderer exactly where it was.
 */
function stubHome(
  options: {
    sessions?: ChatSession[]
    activeSessionId?: string | null
    rootPath?: string | null
    recentRoots?: string[]
    transcripts?: Record<string, TranscriptSnapshot>
    overrides?: Record<string, (input: unknown) => unknown>
  } = {}
): HomeFixture {
  const transcripts: Record<string, TranscriptSnapshot> = { ...options.transcripts }
  const chat: { sessions: ChatSession[]; activeSessionId: string | null } = {
    sessions: options.sessions ?? [],
    activeSessionId: options.activeSessionId ?? null,
  }
  const workspace = {
    rootPath: options.rootPath === undefined ? ROOT : options.rootPath,
    recentRoots: options.recentRoots ?? [ROOT, NOTES, ARCHIVE],
  }

  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    loadTranscript: (input) => transcripts[(input as { id: string }).id] ?? null,
    saveTranscript: (input) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      transcripts[id] = snapshot
      return undefined
    },
    chatWithTools: () => undefined,
    pickFolder: () => PICKED,
    openRoot: (input) => ({ path: (input as { path: string }).path }),
    ...options.overrides,
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', workspace)

  const sessionActions: RecordedAction[] = []
  const procedures = stub.bridge.invoke

  // Wrapped *after* `stubStore`, so its own state answer still stands: a wrapper that swallowed the
  // `__get__` read would leave the mirror with no state at all and let every case below pass for the
  // wrong reason. Actions arrive as invokes on the store channel with the action's name as the method.
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
      // `setRootPath` carries the path itself rather than an object, and main's own reducer is the
      // shape to match here — including remembering the root, which is what makes the row's menu
      // offer the folder that was just opened.
      const action = args[0] as { payload: string | null }
      if (method === 'setRootPath') {
        workspace.rootPath = action.payload
        if (action.payload !== null) workspace.recentRoots = rememberRoot(workspace.recentRoots, action.payload)
      }
      stub.pushToChannel(`${channel}:changed`, { ...workspace })
      return undefined
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)

  // Seeded (above) *and* pushed, because the two cover different tests: the seed answers the initial
  // read, which a store mirror makes only once per store id for the life of the process, and the push
  // is the only route that reaches a mirror an earlier test has already cached. Synchronously, before
  // anything renders, so the first frame is the state this test described rather than the last one's.
  stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...chat, sessions: [...chat.sessions] })
  stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })

  return { stub, sessionActions, transcripts }
}

/** What main does with one session action, which is what the screen then reads back. */
function applySessionAction(
  chat: { sessions: ChatSession[]; activeSessionId: string | null },
  method: string,
  payload: Record<string, unknown>
): void {
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

/** The conversation list, as the workbench wires it: the panel reports the click, the layer decides. */
function SessionRail() {
  const sessions = useChatSessionsContext()
  return (
    <SessionListPanel
      onCreate={() => sessions.goHome()}
      onOpen={(id) => void sessions.openSession(id)}
      onRename={() => {}}
      onExport={() => {}}
      onDelete={() => {}}
      error={null}
      notice={null}
    />
  )
}

function renderScreen(withList = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
        {withList && <SessionRail />}
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The composer, once React has mounted it. */
const composer = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

/**
 * End the run's stream, as main does when the model is done.
 *
 * The channel is read from the recorded start call rather than guessed, and an unstubbed stream stays
 * open — which is deliberate on the stub's side, since most suites only care that a send went out. This
 * one cares that the turn *ended*, because a turn boundary is what schedules the transcript write.
 */
function endStream(stub: BridgeStub): void {
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  stub.emit(`conveyor:stream:${started?.method}`, { type: 'end' })
}

/**
 * The recent projects row, reached through the affordance every state of it draws.
 *
 * The label is not the handle: with no folder on record there is nothing recent, so the row is the
 * affordance alone and the label is not drawn at all.
 */
const recentProjectsRow = (): HTMLElement => {
  const affordance = screen.getByRole('button', { name: HOME_OPEN_FOLDER })
  const row = affordance.parentElement
  if (!row) throw new Error('the open-a-folder affordance has no row')
  return row
}

/** One chip, by the root it stands for — the full path it carries as its title. */
const rootChip = (root: string): HTMLElement => {
  const chip = within(recentProjectsRow())
    .getAllByRole('button')
    .find((button) => button.getAttribute('title') === root)
  if (!chip) throw new Error(`no chip for ${root}`)
  return chip
}

/** The roots the row is offering, in the order it drew them. */
const chipRoots = (): string[] =>
  within(recentProjectsRow())
    .getAllByRole('button')
    .map((button) => button.getAttribute('title'))
    .filter((title): title is string => title !== null)

/** A chip's count: the last thing it draws, muted, after the folder's name. */
const chipCount = (root: string): string => rootChip(root).lastElementChild?.textContent ?? ''

const approvalChip = (): HTMLElement => screen.getByRole('button', { name: 'Approval mode' })

beforeEach(() => {
  // The workbench store outlives a test; clear what a test could otherwise inherit.
  useWorkbenchStore.setState({ selectedFile: null, selectedChange: null })
  queryClient.clear()
})

describe('the home screen at launch', () => {
  it('renders the hero, the composer card, the project row, the recents and the starters', async () => {
    const { stub } = stubHome({
      sessions: [
        row(FIRST, 'Composer card', { lastRoot: ROOT, updatedAt: 3 }),
        row(SECOND, 'Right rail', { lastRoot: NOTES, updatedAt: 2 }),
      ],
    })
    renderScreen()

    // The hero: a headline, and one line under it.
    expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()
    expect(screen.getByText(HOME_SUBLINE)).toBeTruthy()

    // The real composer, as the card: the box, the edge that resizes it, the attach control, the send
    // control, and the model picker above them — the same ones an open conversation offers.
    expect(composer()).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize the composer' })).toBeTruthy()
    expect(screen.getByLabelText('Attach the open file')).toBeTruthy()
    expect(screen.getByLabelText('Send message')).toBeTruthy()
    expect(screen.getByLabelText('Provider and model')).toBeTruthy()

    // The row beneath the card: a chip per folder the app remembers, named for the folder and saying
    // how many conversations were last used in it.
    expect(screen.getByText(HOME_RECENT_PROJECTS)).toBeTruthy()
    expect(chipRoots()).toEqual([ROOT, NOTES, ARCHIVE])
    expect(rootChip(ROOT).textContent).toContain('sam-ai')
    expect(chipCount(ROOT)).toBe('1')
    expect(rootChip(NOTES).textContent).toContain('notes')
    expect(chipCount(ARCHIVE)).toBe('0')

    for (const prompt of HOME_STARTERS) expect(screen.getByRole('button', { name: prompt })).toBeTruthy()

    // Nothing is read for a transcript: home is not a conversation.
    expect(stub.methodsOn('sessions')).not.toContain('loadTranscript')
  })
})

describe('the New chat control', () => {
  it('returns to home without creating a conversation nobody asked for', async () => {
    const { sessionActions } = stubHome({
      sessions: [row(FIRST, 'an existing conversation')],
      activeSessionId: FIRST,
      transcripts: { [FIRST]: storedTranscript('the open conversation') },
    })
    renderScreen(true)

    // The state the control is reached from: a conversation is open, and its transcript is on screen.
    expect(await screen.findByText('the open conversation')).toBeTruthy()
    expect(screen.queryByText(HOME_HEADLINE)).toBeNull()

    await userEvent.click(screen.getByLabelText('New chat'))

    // Home, and nothing created: the control is a way back to the start, not a row nobody typed into.
    expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()
    expect(sessionActions.some((a) => a.method === 'addSession')).toBe(false)
    expect(sessionActions).toContainEqual({ method: 'setActive', payload: { payload: { id: null } } })
  })
})

describe('the recent projects row', () => {
  it('draws one chip per remembered folder, in the store’s order, named for it and carrying its count', async () => {
    stubHome({
      recentRoots: [NOTES, ROOT, ARCHIVE],
      sessions: [
        row(FIRST, 'Composer card', { lastRoot: ROOT, updatedAt: 3 }),
        row(SECOND, 'Right rail', { lastRoot: ROOT, updatedAt: 2 }),
        row(THIRD, 'a conversation that has not run anywhere yet'),
      ],
    })
    renderScreen()

    expect(await screen.findByText(HOME_RECENT_PROJECTS)).toBeTruthy()

    // The store's order, and not an order of the row's own: the folder opened most recently is the
    // first one offered back.
    expect(chipRoots()).toEqual([NOTES, ROOT, ARCHIVE])

    // Named for the folder rather than by its path, and counted: how many conversations were last used
    // in it. Muted, because the count is a detail of the folder rather than the folder itself.
    expect(rootChip(ROOT).textContent).toContain('sam-ai')
    expect(rootChip(ROOT).textContent).not.toContain('C:/work')
    expect(chipCount(ROOT)).toBe('2')
    expect((rootChip(ROOT).lastElementChild as HTMLElement).className).toContain('text-muted-foreground')

    // A folder nothing was ever done in is offered with a zero rather than left out, and a
    // conversation with no project yet belongs to no folder at all.
    expect(chipCount(ARCHIVE)).toBe('0')
    expect(chipCount(NOTES)).toBe('0')

    // Which folder is open is still stated, now by the chip that stands for it.
    expect(rootChip(ROOT).getAttribute('aria-current')).toBe('true')
    expect(rootChip(NOTES).getAttribute('aria-current')).toBeNull()
  })

  it('resumes the folder’s most recent conversation, and asks main for nothing else', async () => {
    const { stub, sessionActions } = stubHome({
      sessions: [
        row(FIRST, 'the older one', { lastRoot: ROOT, updatedAt: 2 }),
        row(SECOND, 'the newer one', { lastRoot: ROOT, updatedAt: 3 }),
      ],
      rootPath: ROOT,
      transcripts: { [SECOND]: storedTranscript('what the newer one turned up') },
    })
    renderScreen()

    await screen.findByText(HOME_RECENT_PROJECTS)
    await userEvent.click(rootChip(ROOT))

    // The drawer's own action, and the most recently touched conversation of that folder: selected,
    // then loaded. Nothing else is asked of main, because the folder it belongs to is already open.
    await waitFor(() =>
      expect(sessionActions).toContainEqual({ method: 'setActive', payload: { payload: { id: SECOND } } })
    )
    expect(stub.callsTo('sessions').find((call) => call.method === 'loadTranscript')?.args[0]).toEqual({ id: SECOND })
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
    expect(stub.methodsOn('workspace')).not.toContain('pickFolder')
    expect(sessionActions.some((action) => action.method === 'addSession')).toBe(false)

    expect(await screen.findByText('what the newer one turned up')).toBeTruthy()
    expect(screen.queryByText(HOME_HEADLINE)).toBeNull()
  })

  it('takes the window to the chip’s folder before the conversation renders', async () => {
    const { stub } = stubHome({
      sessions: [
        row(FIRST, 'the parser work', { lastRoot: ROOT, updatedAt: 2 }),
        row(SECOND, 'the notes work', { lastRoot: NOTES, updatedAt: 3 }),
      ],
      rootPath: ROOT,
      transcripts: { [SECOND]: storedTranscript('what the notes work turned up') },
    })
    renderScreen()

    await screen.findByText(HOME_RECENT_PROJECTS)
    await userEvent.click(rootChip(NOTES))

    // The same `openRoot` the switcher uses. The folder moves first, because the tree, the git reads
    // and the agent's own paths are answered against whatever the workspace store holds.
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openRoot'))
    const openedRoot = stub.callsTo('workspace').find((call) => call.method === 'openRoot')
    const loaded = stub.callsTo('sessions').find((call) => call.method === 'loadTranscript')
    expect(openedRoot?.args[0]).toEqual({ path: NOTES })
    expect(stub.calls.indexOf(openedRoot!)).toBeLessThan(stub.calls.indexOf(loaded!))

    expect(await screen.findByText('what the notes work turned up')).toBeTruthy()
    expect(screen.queryByText(HOME_HEADLINE)).toBeNull()
  })

  it('opens the folder and stays home when the chip has no conversations', async () => {
    const { stub, sessionActions } = stubHome({
      sessions: [row(FIRST, 'the parser work', { lastRoot: ROOT, updatedAt: 3 })],
      rootPath: ROOT,
    })
    renderScreen()

    await screen.findByText(HOME_RECENT_PROJECTS)
    await userEvent.click(rootChip(NOTES))

    // The folder is opened and nothing is opened in it: there is nothing there to resume.
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openRoot'))
    expect(stub.callsTo('workspace').find((call) => call.method === 'openRoot')?.args[0]).toEqual({ path: NOTES })
    expect(stub.methodsOn('sessions')).not.toContain('loadTranscript')
    expect(sessionActions.some((action) => action.method === 'setActive')).toBe(false)

    // Still home, with the composer ready, and the row now saying which folder is open.
    expect(screen.getByText(HOME_HEADLINE)).toBeTruthy()
    await waitFor(() => expect(rootChip(NOTES).getAttribute('aria-current')).toBe('true'))
    await userEvent.type(composer(), 'what is in here?')
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a folder that is gone by its code, switching and opening nothing', async () => {
    const { stub, sessionActions } = stubHome({
      sessions: [row(SECOND, 'the notes work', { lastRoot: NOTES, updatedAt: 3 })],
      rootPath: ROOT,
      overrides: {
        openRoot: () => {
          throw new ConveyorError(WORKSPACE_MISSING, 'C:/work/notes is not a folder that exists.')
        },
      },
    })
    renderScreen()

    await screen.findByText(HOME_RECENT_PROJECTS)
    await userEvent.click(rootChip(NOTES))

    // The wording is the renderer's, chosen by the code — never main's sentence.
    expect(await screen.findByText(/no longer there/i)).toBeTruthy()

    // Refused before either could happen: no conversation opens, and the window stays where it was.
    expect(stub.methodsOn('sessions')).not.toContain('loadTranscript')
    expect(sessionActions.some((action) => action.method === 'setActive')).toBe(false)
    expect(screen.getByText(HOME_HEADLINE)).toBeTruthy()
    expect(rootChip(ROOT).getAttribute('aria-current')).toBe('true')
    expect(rootChip(NOTES).getAttribute('aria-current')).toBeNull()
  })

  it('puts the way to a folder that is not listed at the end of the row', async () => {
    const { stub } = stubHome()
    renderScreen()

    await screen.findByText(HOME_RECENT_PROJECTS)
    const drawn = within(recentProjectsRow()).getAllByRole('button')
    expect(drawn[drawn.length - 1]?.textContent).toContain(HOME_OPEN_FOLDER)

    await userEvent.click(screen.getByRole('button', { name: HOME_OPEN_FOLDER }))

    // The existing picker path, unchanged: the dialog, then the same `openRoot` a chip uses.
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('pickFolder'))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openRoot'))
    expect(stub.callsTo('workspace').find((call) => call.method === 'openRoot')?.args[0]).toEqual({ path: PICKED })
    // And the folder just opened is now the first folder offered back.
    await waitFor(() => expect(chipRoots()[0]).toBe(PICKED))
  })

  it('renders only that way when no folder is on record, and leaves the composer usable', async () => {
    const { stub } = stubHome({ rootPath: null, recentRoots: [] })
    renderScreen()

    // Nothing is recent, so there is no list to head: no label, no chips, and the one way to a folder.
    expect(await screen.findByRole('button', { name: HOME_OPEN_FOLDER })).toBeTruthy()
    expect(screen.queryByText(HOME_RECENT_PROJECTS)).toBeNull()
    expect(chipRoots()).toEqual([])

    // A conversation about nothing in particular is still a conversation: nothing is disabled by the
    // absence of a folder.
    await userEvent.type(composer(), 'what does this app do?')
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: HOME_OPEN_FOLDER }))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('pickFolder'))
    await waitFor(() => expect(chipRoots()).toEqual([PICKED]))
  })

  it('is home’s only list: the Recent work chips and the folder row are gone', async () => {
    stubHome({
      sessions: [
        row(FIRST, 'Composer card', { lastRoot: ROOT, updatedAt: 3 }),
        row(SECOND, 'Right rail', { lastRoot: NOTES, updatedAt: 2 }),
      ],
    })
    renderScreen()

    expect(await screen.findByText(HOME_RECENT_PROJECTS)).toBeTruthy()

    // No row of conversations named by their titles, and no folder trigger standing beside it: the
    // drawer is the one place a conversation is resumed by name.
    expect(screen.queryByText(/Recent work/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Work in a project' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Composer card/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Right rail/ })).toBeNull()
    expect(chipRoots()).toEqual([ROOT, NOTES, ARCHIVE])
  })
})

describe('the starters', () => {
  it('fills the composer without sending anything', async () => {
    const { stub, sessionActions } = stubHome()
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: HOME_STARTERS[0] }))

    expect(composer().value).toBe(HOME_STARTERS[0])
    // Nothing has gone out, and nothing has been created: a starter is a sentence to start from.
    expect(stub.methodsOn('agent')).not.toContain('chatWithTools')
    expect(sessionActions.some((a) => a.method === 'addSession')).toBe(false)
  })
})

describe('the first message', () => {
  it('creates the conversation, in the open folder and under the mode the chip was left on', async () => {
    const { stub, sessionActions, transcripts } = stubHome()
    renderScreen()

    // The chip as it opens, and as the user leaves it.
    expect(approvalChip().textContent).toContain('Manual')
    await userEvent.click(approvalChip())
    expect(approvalChip().textContent).toContain('Auto-approve')

    await userEvent.type(await screen.findByLabelText('Message'), 'make a fibonacci script')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(sessionActions.some((a) => a.method === 'addSession')).toBe(true))
    const created = sessionActions.find((a) => a.method === 'addSession')?.payload as {
      payload: { id: string; title: string; lastRoot?: string }
    }

    // Created with the default title — the row exists before it has a message to be named from — and
    // named by that message in the next write, which is the same pair of writes the composer makes.
    expect(created.payload.title).toBe(UNTITLED)
    expect(created.payload.lastRoot).toBe(ROOT)
    const named = sessionActions.find((a) => a.method === 'touchSession')?.payload as {
      payload: { id: string; title: string }
    }
    expect(named.payload.id).toBe(created.payload.id)
    expect(named.payload.title).toBe(titleFromMessage('make a fibonacci script'))

    // Home is swapped for the transcript of the conversation that now exists.
    await waitFor(() => expect(screen.queryByText(HOME_HEADLINE)).toBeNull())
    expect(await screen.findByText('make a fibonacci script')).toBeTruthy()

    // The mode the chip was left on is the mode the conversation runs under, on screen and on disk.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    )
    // The run's stream, ended the way main ends one: the turn boundary is what schedules the write, so
    // without it the mode never reaches a transcript file.
    await waitFor(() => expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(true))
    endStream(stub)

    await waitFor(() => expect(stub.methodsOn('sessions')).toContain('saveTranscript'), { timeout: 5000 })
    expect(transcripts[created.payload.id]?.autoApprove).toBe(true)
  })
})

describe('home under another theme', () => {
  it('paints itself from the theme’s own tokens, in the dark, and adds no stylesheet', async () => {
    stubHome()
    const sheets = document.querySelectorAll('style').length

    // Ocean at its darkest, applied the way the app applies a theme: the mode on the document, the
    // variables as inline custom properties.
    applyThemeVars(themeVarsFor('ocean', 'dark', 0))
    document.documentElement.classList.add('dark')

    try {
      renderScreen()

      expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()
      expect(document.documentElement.style.getPropertyValue('--background')).toBe(
        themeVarsFor('ocean', 'dark', 0)['background']
      )

      // The two pairs the hero is made of are the theme's own, and they are the pairs the contrast floor
      // is stated over — so legibility here is the theme's, tested where the theme is tested.
      expect(screen.getByText(HOME_HEADLINE).className).toContain('text-foreground')
      expect(screen.getByText(HOME_SUBLINE).className).toContain('text-muted-foreground')

      // Nothing on the screen paints a colour of its own: a literal here would ignore every theme.
      for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
        expect(element.className.toString()).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
        expect(element.getAttribute('style') ?? '').not.toMatch(/color|background/i)
      }

      expect(document.querySelectorAll('style').length).toBe(sheets)
    } finally {
      clearThemeVars()
      document.documentElement.classList.remove('dark')
    }
  })
})
