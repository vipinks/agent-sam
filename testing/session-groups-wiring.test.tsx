import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { ExplorerPanel } from '@/app/components/workbench/explorer-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { UNTITLED } from '@/conveyor/protocol/session-title'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The conversation list, arranged by the project each conversation belongs to.
 *
 * `session-project-test.ts` owns the ordering rule and `session-project-wiring.test.tsx` owns what a
 * click does to the folder. What only a rendered panel can show is the arrangement itself: that the
 * groups are drawn in the order the rule decided, that a header counts its own rows, that collapsing
 * one hides exactly its rows and survives a restart, and that a search reaches a row inside a group
 * the user had put away.
 *
 * Every assertion is on what the user would see or on what the store was told — the group headers in
 * order, the rows under each one, the record left in the settings slice, the action on the wire —
 * because the failure this guards against is a list that renders plausibly while grouping nothing.
 *
 * Rendered under the app's own session provider, over a stubbed transport whose store applies the
 * actions it receives and broadcasts the result, the way main does: that is what makes "the new row
 * lands in the current group" an assertion about the list rather than about a stub's bookkeeping.
 */

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'
const THIRD = 'cccccccc-3333-4333-8333-333333333333'
const FOURTH = 'dddddddd-4444-4444-8444-444444444444'
const FIFTH = 'eeeeeeee-5555-4555-8555-555555555555'

/** The folder the window is showing, and the two other projects its conversations name. */
const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'

/** The record the settings slice writes, read as the renderer holds it. */
const STORED_KEY = 'sam-ai-layout-preferences'

/** The collapse keys as they were persisted, or an empty list when nothing was written. */
function storedCollapsedGroups(): string[] {
  const record = JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}') as { collapsedSessionGroups?: unknown }
  return Array.isArray(record.collapsedSessionGroups) ? (record.collapsedSessionGroups as string[]) : []
}

/** One conversation, as the store holds it. A session with no project has no `lastRoot` key. */
interface SessionRow {
  id: string
  title: string
  lastRoot?: string
  updatedAt?: number
}

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

interface GroupsStub {
  stub: BridgeStub
  actions: RecordedAction[]
  /** The workspace store's state, as the actions applied to it leave it. */
  workspace: { rootPath: string | null; recentRoots: string[] }
}

/**
 * A running app's transport, with both stores this panel reads.
 *
 * The workspace store is answered the way main answers it — the action applied, the new state
 * returned, the change broadcast on the store's channel — so the explorer's label is an honest
 * assertion rather than a value this test wrote into a component.
 *
 * The session store is answered the same way, which is the half this file needs: a created
 * conversation is appended and broadcast, so the row it produces is rendered by the list under test
 * instead of being asserted only on the wire.
 */
function stubGroups(options: {
  sessions: SessionRow[]
  activeSessionId?: string | null
  /** The folder the window opens with. Defaults to `ROOT`. */
  rootPath?: string | null
}): GroupsStub {
  const workspace: GroupsStub['workspace'] = {
    rootPath: options.rootPath === undefined ? ROOT : options.rootPath,
    recentRoots: [ROOT, NOTES, ARCHIVE],
  }

  const state = {
    sessions: options.sessions.map((session, index) => ({
      id: session.id,
      title: session.title,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: session.updatedAt ?? 1_700_000_000_000 + index,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      ...(session.lastRoot === undefined ? {} : { lastRoot: session.lastRoot }),
    })),
    activeSessionId: options.activeSessionId ?? null,
  }

  const stub = createBridgeStub({
    listDirectory: () => [],
    pickFolder: () => null,
    openRoot: (input) => ({ path: (input as { path: string }).path }),
    // The repository panels share the stub, so their reads answer too rather than throwing.
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    // The session layer: a transcript that has never been saved, and the scan behind a search.
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    searchSessions: () => [],
    // The agent and the settings the composer reads.
    chatWithTools: () => undefined,
    resume: () => undefined,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, state)
  stubStore(stub, 'workspace', workspace)

  // Wrapped *after* `stubStore`, so its own answer is still what an unseeded read gets. The session
  // actions are applied as main applies them, because the row a new conversation produces is half of
  // what this file is asserting.
  const actions: RecordedAction[] = []
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return { ...state }
      actions.push({ method, payload: args[0] })

      const input = (args[0] as { payload?: Record<string, unknown> } | undefined)?.payload
      if (method === 'addSession' && input) {
        const now = 1_700_000_500_000
        state.sessions = [
          ...state.sessions,
          {
            id: input.id as string,
            title: input.title as string,
            createdAt: now,
            updatedAt: now,
            providerId: input.providerId as string,
            model: input.model as string,
            ...(input.lastRoot === undefined ? {} : { lastRoot: input.lastRoot as string }),
          },
        ].sort((a, b) => b.updatedAt - a.updatedAt)
        stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...state })
      }
      if (method === 'setActive' && input) {
        state.activeSessionId = input.id as string
        stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...state })
      }

      return { ...state }
    }

    if (channel === 'conveyor:store:workspace') {
      if (method === '__get__') return workspace
      actions.push({ method, payload: args[0] })
      if (method === 'setRootPath') {
        workspace.rootPath = (args[0] as { payload: string | null }).payload
        // Main broadcasts the new state; every panel reading it is answered from here.
        stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })
      }
      return { ...workspace }
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  return { stub, actions, workspace }
}

/** The conversation list as the workbench wires it: the panel reports intent, the layer acts on it. */
function Rail({ notice = null }: { notice?: string | null }) {
  const sessions = useChatSessionsContext()
  return (
    <SessionListPanel
      onCreate={() => void sessions.createSession()}
      onOpen={(id) => void sessions.openSession(id)}
      onRename={() => {}}
      onExport={() => {}}
      onDelete={() => {}}
      error={null}
      notice={notice}
    />
  )
}

function harness(node: React.ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>{node}</ChatSessionsProvider>
    </QueryClientProvider>
  )
}

function renderHarness(node: React.ReactNode) {
  return render(harness(node))
}

/** The group headers, in the order they are drawn. */
function headers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('section[aria-label] > button[aria-expanded]')]
}

/** What each header states to everything that is not a pointer: the project, and how many rows. */
function headerLabels(container: HTMLElement): string[] {
  return headers(container).map((header) => header.getAttribute('aria-label') ?? '')
}

/** One project's group, found by the label its header carries. */
function group(label: string): HTMLElement {
  return screen.getByRole('region', { name: label })
}

/** The header of one project's group. */
function header(container: HTMLElement, label: string): HTMLElement {
  const found = headers(container).find((candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith(label))
  if (!found) throw new Error(`no group header for ${label}`)
  return found
}

/** Collapse one project's group from its own header. */
async function collapse(container: HTMLElement, label: string): Promise<void> {
  await userEvent.click(header(container, label))
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
    collapsedSessionGroups: [],
  })
  queryClient.clear()
})

/**
 * Three projects and one conversation from before sessions had them: the current folder with two
 * rows, another with the newest row in the list, an older one, and the unstamped one with the
 * newest timestamp of all — so that "last" can only be the grouping rule's doing, never recency's.
 */
function fourGroups(): SessionRow[] {
  return [
    { id: FIRST, title: 'parser work', lastRoot: ROOT, updatedAt: 100 },
    { id: SECOND, title: 'parser follow-up', lastRoot: ROOT, updatedAt: 90 },
    { id: THIRD, title: 'notes work', lastRoot: NOTES, updatedAt: 400 },
    { id: FOURTH, title: 'archive work', lastRoot: ARCHIVE, updatedAt: 50 },
    { id: FIFTH, title: 'before projects existed', updatedAt: 500 },
  ]
}

describe('the conversation list, grouped by project', () => {
  it('draws a group per project, the open one first, each header counting its own rows', async () => {
    const { stub } = stubGroups({ sessions: fourGroups(), activeSessionId: FIRST })
    const { container } = renderHarness(<Rail />)

    await screen.findByText('parser work')

    // The open project leads, because it is the one being worked in and the one a new conversation
    // will belong to; then the others by how recently they were used; then the ones with no project.
    expect(headerLabels(container)).toEqual([
      'sam-ai, 2 conversations',
      'notes, 1 conversation',
      'archive, 1 conversation',
      'No project yet, 1 conversation',
    ])

    // Every group is open to start with, and each row is drawn inside its own project's group.
    for (const node of headers(container)) expect(node.getAttribute('aria-expanded')).toBe('true')
    expect(within(group('sam-ai')).getByText('parser work')).toBeTruthy()
    expect(within(group('sam-ai')).getByText('parser follow-up')).toBeTruthy()
    expect(within(group('notes')).getByText('notes work')).toBeTruthy()
    expect(within(group('archive')).getByText('archive work')).toBeTruthy()
    expect(within(group('No project yet')).getByText('before projects existed')).toBeTruthy()

    // The count is the group's own rows, not the list's: one project's two rows are not the four
    // conversations on screen.
    expect(within(group('sam-ai')).queryByText('notes work')).toBeNull()
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
  })

  it('keeps a collapsed group collapsed across a re-render and a rehydrate', async () => {
    stubGroups({ sessions: fourGroups() })
    const view = renderHarness(<Rail />)
    await screen.findByText('notes work')

    await collapse(view.container, 'notes')

    // Collapsed means the rows are gone and the header says so, and the choice is written to the
    // record the layout already lives in — beside the sets and the drawer flag, not a second key.
    expect(within(group('notes')).queryByText('notes work')).toBeNull()
    expect(header(view.container, 'notes').getAttribute('aria-expanded')).toBe('false')
    expect(storedCollapsedGroups()).toEqual([NOTES])

    // A re-render of the panel, with a prop the panel renders, must not reopen it.
    view.rerender(harness(<Rail notice="a selection did not happen" />))
    expect(screen.getByText('a selection did not happen')).toBeTruthy()
    expect(header(view.container, 'notes').getAttribute('aria-expanded')).toBe('false')
    expect(within(group('notes')).queryByText('notes work')).toBeNull()

    // And a restart reads it back: the settings slice is read when its module is evaluated, so a
    // fresh module graph is the only way to reach that, and it is how a launch reaches it.
    view.unmount()
    vi.resetModules()
    const freshClient = await import('@/conveyor/client')
    const { SessionListPanel: FreshPanel } = await import('@/app/components/workbench/session-list-panel')
    const { useWorkbenchStore: freshStore } = await import('@/app/components/workbench/store')
    const { ChatSessionsProvider: FreshProvider } = await import('@/app/components/workbench/chat-sessions-context')

    expect(freshStore.getState().collapsedSessionGroups, 'the record read at store creation').toEqual([NOTES])

    const { container } = render(
      <QueryClientProvider client={freshClient.queryClient}>
        <FreshProvider>
          <FreshPanel
            onCreate={() => {}}
            onOpen={() => {}}
            onRename={() => {}}
            onExport={() => {}}
            onDelete={() => {}}
            error={null}
            notice={null}
          />
        </FreshProvider>
      </QueryClientProvider>
    )

    // The fresh mirror answers its own first read, so the groups appear a tick after the render.
    await waitFor(() => expect(header(container, 'notes')).toBeTruthy())
    expect(header(container, 'notes').getAttribute('aria-expanded'), 'still collapsed after a restart').toBe('false')
    expect(within(group('notes')).queryByText('notes work')).toBeNull()
    // The projects that were open are still open: one group's choice is that group's alone.
    expect(header(container, 'sam-ai').getAttribute('aria-expanded')).toBe('true')
  })

  it('reaches a row inside a collapsed group, and puts it away again when the search is cleared', async () => {
    stubGroups({ sessions: fourGroups() })
    const { container } = renderHarness(<Rail />)
    await screen.findByText('notes work')

    await collapse(container, 'notes')
    expect(within(group('notes')).queryByText('notes work')).toBeNull()

    // A search is a question about every conversation, so a group the user put away is not a group
    // the search may skip: the matching row comes back under its own header.
    const input = screen.getByLabelText('Search conversations')
    await userEvent.click(input)
    await userEvent.type(input, 'notes')

    expect(await within(group('notes')).findByText('notes work')).toBeTruthy()

    // Clearing the field restores the grouped view, collapse and all — the search suspended the
    // collapse, it did not undo it.
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(within(group('notes')).queryByText('notes work')).toBeNull())
    expect(header(container, 'notes').getAttribute('aria-expanded')).toBe('false')
    expect(storedCollapsedGroups()).toEqual([NOTES])
    expect(headerLabels(container)[0]).toBe('sam-ai, 2 conversations')
  })

  it('moves the folder when a row in another group is opened, and reorders around it', async () => {
    const { workspace } = stubGroups({ sessions: fourGroups() })
    const { container } = renderHarness(
      <>
        <Rail />
        <ExplorerPanel />
      </>
    )

    await userEvent.click(await screen.findByText('notes work'))

    // Turn A's behaviour, unchanged by the arrangement: the folder moves to the conversation's own
    // project before the transcript is read, and the explorer is showing it.
    await waitFor(() => expect(workspace.rootPath).toBe(NOTES))
    expect(await screen.findByText(NOTES)).toBeTruthy()

    // And the group that just became the open one leads the list, which is the rule the arrangement
    // is built on rather than a second ordering kept in step with it.
    await waitFor(() => expect(headerLabels(container)[0]).toBe('notes, 1 conversation'))
  })

  it('draws the conversations with no project last, and opens them without moving the folder', async () => {
    const { stub, actions, workspace } = stubGroups({ sessions: fourGroups() })
    const { container } = renderHarness(
      <>
        <Rail />
        <ExplorerPanel />
      </>
    )

    await screen.findByText('before projects existed')

    // Last despite being the most recently touched row in the list: these are conversations from
    // before a session recorded where it ran, and they belong at the foot rather than at the top.
    expect(headerLabels(container).at(-1)).toBe('No project yet, 1 conversation')
    expect(header(container, 'No project yet').getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(screen.getByText('before projects existed'))

    // The row opens, and nothing moves: no project means no folder to open, and nothing to report
    // about one — the silent case the absent field exists for.
    await waitFor(() => expect(actions.some((action) => action.method === 'setActive')).toBe(true))
    expect(workspace.rootPath).toBe(ROOT)
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
    expect(screen.queryByText(/still running/i)).toBeNull()
    expect(screen.queryByText(/could not be opened/i)).toBeNull()
    expect(screen.getByText(ROOT)).toBeTruthy()
  })

  it('creates the new conversation in the open folder, so its row lands in that group', async () => {
    const { actions } = stubGroups({ sessions: fourGroups() })
    const { container } = renderHarness(<Rail />)
    await screen.findByText('parser work')

    await userEvent.click(screen.getByLabelText('New chat'))

    // Created in the folder the user is working in, in one write: the row's project is written with
    // the row, so there is no window in which it belongs to nowhere.
    await waitFor(() => {
      const added = actions.find((action) => action.method === 'addSession')
      expect(added?.payload).toEqual({
        payload: {
          id: expect.any(String),
          title: UNTITLED,
          providerId: 'deepseek',
          model: 'deepseek-chat',
          lastRoot: ROOT,
        },
      })
    })

    // And the row it made is drawn inside the open project's group — not in the group for the
    // conversations that have no project.
    await waitFor(() => expect(within(group('sam-ai')).getByText(UNTITLED)).toBeTruthy())
    expect(headerLabels(container)[0]).toBe('sam-ai, 3 conversations')
    expect(within(group('sam-ai')).getByText('parser work')).toBeTruthy()
    // Nothing new appeared at the foot: the row was created in the open project, so the list of
    // conversations with no project still holds only the one from before.
    expect(headerLabels(container).at(-1)).toBe('No project yet, 1 conversation')
  })

  it('gives a conversation created with no folder open no project at all', async () => {
    const { actions } = stubGroups({ sessions: fourGroups(), rootPath: null })
    renderHarness(<Rail />)
    await screen.findByText('parser work')

    await userEvent.click(screen.getByLabelText('New chat'))

    // No folder open is not a project: the key is absent rather than empty, because an empty path
    // would read as a folder nobody can open.
    await waitFor(() => {
      const added = actions.find((action) => action.method === 'addSession')
      expect(added?.payload).toEqual({
        payload: {
          id: expect.any(String),
          title: UNTITLED,
          providerId: 'deepseek',
          model: 'deepseek-chat',
        },
      })
    })
    await waitFor(() => expect(within(group('No project yet')).getByText(UNTITLED)).toBeTruthy())
  })

  it('keeps the title, the age and the provider and model line on every row', async () => {
    stubGroups({ sessions: [{ id: FIRST, title: 'parser work', lastRoot: ROOT, updatedAt: 1_700_000_000_000 }] })
    renderHarness(<Rail />)

    const row = (await screen.findByText('parser work')).closest('button') as HTMLElement

    // The row is unchanged by the grouping: what the conversation is called, how long ago it was
    // used, and which provider and model it is on.
    expect(within(row).getByText('parser work')).toBeTruthy()
    expect(within(row).getByText('deepseek/deepseek-chat')).toBeTruthy()
    expect(within(row).getByTitle('deepseek · deepseek-chat')).toBeTruthy()
    // The age line, which is the part of the row a grouping mistake would be tempted to drop: the
    // age leads it, the provider and model trail it, and the separator is the row's own. What the age
    // itself says is `relative-time.ts`'s business and is not re-asserted here.
    const meta = within(row).getByText('deepseek/deepseek-chat').closest('p') as HTMLElement
    expect(meta.textContent).toMatch(/\S·deepseek\/deepseek-chat$/)
    expect(within(group('sam-ai')).getByText('parser work')).toBeTruthy()
  })
})
