import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { ExplorerPanel } from '@/app/components/workbench/explorer-panel'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * What a conversation's project does to the window, as wiring rather than as rules.
 *
 * `session-project-test.ts` owns the decisions — which folder a click opens, when a click is refused,
 * what a turn start records. What only a rendered workbench can show is whether the decisions are
 * reached at all: that a click on a stamped row moves the explorer to that folder, that a folder which
 * is gone leaves the open one alone and says which one it was, that a turn start writes the project
 * down, and that a click during a stream is refused instead of quietly redirecting the workspace.
 *
 * Every assertion is on the effect the user would see — the folder the explorer is showing, the notice
 * on screen, the action the store received — because the failure these guard against is a click that
 * renders correctly and moves nothing.
 *
 * Rendered under the app's own session provider and the real store mirror over a stubbed transport, so
 * the store actions are the ones main would actually receive.
 */

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'

/** The folder the window is showing, and the two a session can claim to belong to. */
const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const GONE = 'C:/work/archive'

/** One conversation, as the store holds it. A session with no project has no `lastRoot` key. */
interface SessionRow {
  id: string
  title: string
  lastRoot?: string
}

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

interface ProjectStub {
  stub: BridgeStub
  actions: RecordedAction[]
  /** The workspace store's state, as the actions applied to it leave it. */
  workspace: { rootPath: string | null; recentRoots: string[] }
}

/**
 * A running app's transport, with both stores a session click touches.
 *
 * The workspace store is answered the way main answers it: the action is applied, the new state is
 * returned, and it is broadcast on the store's changed channel. That is what makes the explorer's
 * label an honest assertion — the panel is reading the same state a second window would have been
 * sent — rather than a value this test wrote into a component.
 *
 * `openRoot` is the workspace module's own command, and the one a stamped switch goes through. A test
 * can replace it to answer the way main does for a folder that is gone.
 */
function stubProject(options: {
  sessions: SessionRow[]
  activeSessionId?: string | null
  /** The folder the window opens with. */
  rootPath?: string | null
  /** How main answers `openRoot`. Defaults to accepting whatever it is handed. */
  openRoot?: (input: unknown) => unknown
  /** How the agent's stream behaves. Defaults to ending immediately. */
  stream?: () => unknown
}): ProjectStub {
  const workspace: ProjectStub['workspace'] = {
    rootPath: options.rootPath === undefined ? ROOT : options.rootPath,
    recentRoots: [ROOT, NOTES, GONE],
  }

  const sessions = options.sessions.map((session, index) => ({
    id: session.id,
    title: session.title,
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(session.lastRoot === undefined ? {} : { lastRoot: session.lastRoot }),
  }))

  const sessionState = { sessions, activeSessionId: options.activeSessionId ?? null }

  const stub = createBridgeStub({
    // The workspace: a listing for the explorer, the dialog a switch can also come from, and the
    // command a session's project is opened through.
    listDirectory: () => [],
    pickFolder: () => null,
    openRoot: options.openRoot ?? ((input) => ({ path: (input as { path: string }).path })),
    // The repository panels share the stub, so their reads answer too rather than throwing.
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    // The session layer: a transcript that has never been saved, and the scan behind a search.
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    searchSessions: () => [],
    // The agent, and the settings the composer reads on mount.
    chatWithTools: options.stream ?? (() => undefined),
    resume: () => undefined,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionState)
  stubStore(stub, 'workspace', workspace)

  // Wrapped *after* `stubStore`, so its own state answer is still what an unseeded read gets: a
  // wrapper that swallowed it would leave the mirror with no state and let every case below pass for
  // the wrong reason.
  const actions: RecordedAction[] = []
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return sessionState
      actions.push({ method, payload: args[0] })
      return sessionState
    }

    if (channel === 'conveyor:store:workspace') {
      if (method === '__get__') return workspace
      actions.push({ method, payload: args[0] })
      if (method === 'setRootPath') {
        workspace.rootPath = (args[0] as { payload: string | null }).payload
        // Main broadcasts the new state; the explorer reads it there.
        stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })
      }
      return { ...workspace }
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  return { stub, actions, workspace }
}

/** The session rail as the workbench wires it: the list reports intent, the layer does the work. */
function SessionRail() {
  const sessions = useChatSessionsContext()
  return (
    <SessionListPanel
      onCreate={() => {}}
      onOpen={(id) => void sessions.openSession(id)}
      onRename={() => {}}
      onExport={() => {}}
      onDelete={() => {}}
      error={null}
      notice={sessions.notice}
    />
  )
}

function renderHarness(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>{node}</ChatSessionsProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
})

describe('a conversation that knows its project', () => {
  it('opens the folder the session belongs to', async () => {
    const { stub, workspace } = stubProject({
      sessions: [{ id: FIRST, title: 'notes work', lastRoot: NOTES }],
    })
    renderHarness(
      <>
        <SessionRail />
        <ExplorerPanel />
      </>
    )

    await userEvent.click(await screen.findByText('notes work'))

    // The folder moved to where the conversation was last used, through the one command that checks a
    // folder is still there before the store is told anything.
    await waitFor(() => expect(workspace.rootPath).toBe(NOTES))
    expect(stub.methodsOn('workspace')).toContain('openRoot')
    // And the explorer is showing it, because it reads the store the way any second window would.
    expect(await screen.findByText(NOTES)).toBeTruthy()
  })

  it('keeps the open folder when the project is gone, and names the one that is', async () => {
    const { actions, workspace } = stubProject({
      sessions: [{ id: FIRST, title: 'archive work', lastRoot: GONE }],
      openRoot: () => {
        throw new ConveyorError(WORKSPACE_MISSING, `${GONE} is not a folder that exists.`)
      },
    })
    renderHarness(
      <>
        <SessionRail />
        <ExplorerPanel />
      </>
    )

    await userEvent.click(await screen.findByText('archive work'))

    // The wording is this side's, chosen by the code — and it names the folder that is gone, which is
    // the one thing the user can act on.
    expect(await screen.findByText((text) => text.includes(GONE) && /no longer there/i.test(text))).toBeTruthy()
    expect(workspace.rootPath).toBe(ROOT)
    expect(screen.getByText(ROOT)).toBeTruthy()
    // The conversation still opens: the notice explains its project, not a click that failed.
    expect(actions.some((action) => action.method === 'setActive')).toBe(true)
  })

  it('records the folder the turn started in', async () => {
    const { actions } = stubProject({
      sessions: [{ id: FIRST, title: 'notes work', lastRoot: NOTES }],
      activeSessionId: FIRST,
      rootPath: ROOT,
    })
    renderHarness(
      <>
        <SessionRail />
        <ChatPanel />
      </>
    )

    // The row is on screen before anything is typed, so the layer is holding the session it has to
    // stamp rather than racing the store's first push.
    await screen.findByText('notes work')
    await userEvent.type(await screen.findByLabelText('Message'), 'tidy the parser{Enter}')

    // The session was last used in the other folder and the turn is running in this one, so the stamp
    // follows the work.
    await waitFor(() => {
      const stamp = actions.find((action) => action.method === 'touchSession')
      expect(stamp?.payload).toEqual({ payload: { id: FIRST, lastRoot: ROOT } })
    })
  })
})

describe('switching conversations while a turn is live', () => {
  it('refuses the click, and changes nothing', async () => {
    const { stub, actions, workspace } = stubProject({
      sessions: [
        { id: FIRST, title: 'notes work', lastRoot: ROOT },
        { id: SECOND, title: 'archive work', lastRoot: NOTES },
      ],
      activeSessionId: FIRST,
      rootPath: ROOT,
      // A run that never ends, which is the state the guard exists for.
      stream: () => new Promise(() => {}),
    })
    renderHarness(
      <>
        <SessionRail />
        <ChatPanel />
      </>
    )

    await screen.findByText('archive work')
    await userEvent.type(await screen.findByLabelText('Message'), 'review the parser{Enter}')

    // Stop in place of Send is the run being live, which is the fact the refusal reads — waited for
    // rather than assumed, because a click before the stream opens is an ordinary switch.
    await screen.findByRole('button', { name: 'Stop' })

    await userEvent.click(screen.getByText('archive work'))

    expect(await screen.findByText(/still running/i)).toBeTruthy()
    // Nothing moved: the other conversation was not made active and no folder was opened, so the
    // running turn's tool paths still point where it started.
    expect(actions.some((action) => action.method === 'setActive')).toBe(false)
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
    expect(workspace.rootPath).toBe(ROOT)
  })
})
