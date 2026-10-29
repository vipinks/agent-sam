import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/renderer'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Moving a conversation out of the project it belongs to and into another one.
 *
 * `session-project-test.ts` owns the pure rules — which folders a row is offered, and how a refusal is
 * worded. What only a rendered list can show is the wiring: that the control sits on the row's own
 * action surface beside rename, that picking a folder dispatches the command main owns, that the row
 * then lands under the destination's header, and that a refusal leaves every row exactly where it was.
 *
 * The stub answers a move the way main does — check the folder, write the record, broadcast it — so "the
 * row re-groups" is asserted on the list under test rather than on this file's bookkeeping. Transcripts
 * are absent throughout because a move neither reads nor writes one: a session's transcript lives in one
 * directory for every project (`conveyor/modules/sessions.ts:52`).
 */

const MOVED = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222'
const TITLE = 'the parser drops newlines'
const KEPT = 'the notes work'

const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'
/** A project the list draws a group for, which the recents have never held. */
const DOCS = 'C:/work/docs'

/** One conversation, as the store holds it. A session with no project has no `lastRoot` key. */
interface SessionRow {
  id: string
  title: string
  lastRoot?: string
}

interface MoveRail {
  stub: BridgeStub
  /** The workspace store's state, as the actions applied to it leave it. */
  workspace: { rootPath: string | null; recentRoots: string[] }
  /** The folders a move was actually applied to, in order. */
  applied: string[]
}

/**
 * A running app's transport, with both stores this panel reads.
 *
 * The sessions store is answered the way main answers it, because the row's new group is half of what
 * this file asserts: a store that recorded the call without applying it would let a list that re-groups
 * nothing pass. `refuse` is the other half — a destination the stub rejects with main's own code.
 */
function stubMove(options: {
  sessions: SessionRow[]
  activeSessionId?: string | null
  rootPath?: string | null
  /** A folder the stub refuses every move to, as a folder that is gone. */
  refuse?: string
}): MoveRail {
  const workspace = {
    rootPath: options.rootPath === undefined ? ROOT : options.rootPath,
    recentRoots: [ROOT, NOTES, ARCHIVE],
  }
  const state = {
    sessions: options.sessions.map((session, index) => ({
      id: session.id,
      title: session.title,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      ...(session.lastRoot === undefined ? {} : { lastRoot: session.lastRoot }),
    })),
    activeSessionId: options.activeSessionId === undefined ? MOVED : options.activeSessionId,
  }

  const applied: string[] = []

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
    moveSession: (input) => {
      const { id, destination } = input as { id: string; destination: string }
      // Main checks the folder first and writes nothing when it is gone, which is what the row's own
      // refusal sentence is built from.
      if (options.refuse !== undefined) {
        throw new ConveyorError(WORKSPACE_MISSING, `${options.refuse} is not a folder that exists.`)
      }
      applied.push(destination)
      state.sessions = state.sessions.map((session) =>
        session.id === id ? { ...session, lastRoot: destination, updatedAt: 1_700_000_900_000 } : session
      )
      stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...state })
      return { path: destination }
    },
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

  // The workspace store's own actions, applied and broadcast the way main applies them: the switch that
  // follows a move of the open conversation travels through here.
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return { ...state }
      return { ...state }
    }
    if (channel === 'conveyor:store:workspace') {
      if (method === '__get__') return { ...workspace }
      if (method === 'setRootPath') {
        workspace.rootPath = (args[0] as { payload: string | null }).payload
        stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })
      }
      return { ...workspace }
    }

    return procedures(channel, method, ...args)
  }

  // Pushed as well as seeded: the store mirror fetches its state once and is answered from here
  // afterwards, so a test after the first would otherwise read the state the first one left behind.
  stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...state })
  stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })

  setActiveStub(stub)
  return { stub, workspace, applied }
}

/** The session rail as the workbench wires it: the list reports intent, the layer does the work. */
function Rail() {
  const sessions = useChatSessionsContext()
  return (
    <SessionListPanel
      onCreate={() => {}}
      onOpen={(id) => void sessions.openSession(id)}
      onRename={() => {}}
      onExport={() => {}}
      onMove={(id, destination) => void sessions.moveSession(id, destination)}
      onDelete={(id) => void sessions.deleteSession(id)}
      error={null}
      notice={sessions.notice}
    />
  )
}

function renderRail() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <Rail />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** One project's group, found by the label its header carries. */
function group(label: string): HTMLElement {
  return screen.getByRole('region', { name: label })
}

/** One row's destinations, as its submenu draws them. */
async function openMoveMenu(title: string): Promise<HTMLElement> {
  const trigger = screen.getByLabelText(`Session actions for ${title}`)
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to project' }))
  return screen.findByRole('menu', { name: 'Move to project' })
}

function menuItems(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
}

/** The move calls main received, by the input each carried. */
function moveCalls(stub: BridgeStub): unknown[] {
  return stub
    .callsTo('sessions')
    .filter((call) => call.method === 'moveSession')
    .map((call) => call.args[0])
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
})

describe('session move wiring', () => {
  it('offers a move from the row, and every folder except the row’s own project', async () => {
    stubMove({ sessions: [{ id: MOVED, title: TITLE, lastRoot: ROOT }] })
    renderRail()
    await screen.findByText(TITLE)

    const menu = await openMoveMenu(TITLE)

    // The row already belongs to sam-ai, so sam-ai is not a destination — and the other remembered
    // folders are, named by their last segment the way a group header names a folder.
    expect(menuItems(menu)).toEqual(['notes', 'archive'])
  })

  it('offers a project the list draws as a group even when the recents never held it', async () => {
    // docs has a conversation, so the panel draws its header — while the recents list holds only sam-ai,
    // notes and archive. That is the shape the recents cap leaves behind: a project on screen that the
    // menu did not offer.
    const { stub } = stubMove({
      sessions: [
        { id: MOVED, title: TITLE, lastRoot: ROOT },
        { id: OTHER, title: KEPT, lastRoot: DOCS },
      ],
    })
    renderRail()
    await screen.findByText(TITLE)
    expect(within(group('docs')).getByText(KEPT)).toBeTruthy()

    const menu = await openMoveMenu(TITLE)

    // The open folder first, then the remembered ones in their own order, then the group-only project —
    // one entry for the folder the row already belongs to is still absent.
    expect(menuItems(menu)).toEqual(['notes', 'archive', 'docs'])

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'docs' }))

    // The choice reaches main with the path the group's header stands for, not with its label.
    await waitFor(() => expect(moveCalls(stub)).toContainEqual({ id: MOVED, destination: DOCS }))
  })

  it('sends the move command the row and the folder that was picked', async () => {
    const { stub } = stubMove({ sessions: [{ id: MOVED, title: TITLE, lastRoot: ROOT }] })
    renderRail()
    await screen.findByText(TITLE)

    const menu = await openMoveMenu(TITLE)
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'notes' }))

    // The id and the destination, in one call: a move that reached main with either half missing would
    // move the wrong conversation, or move this one nowhere.
    await waitFor(() => expect(moveCalls(stub)).toContainEqual({ id: MOVED, destination: NOTES }))
  })

  it('lands the row under the destination group, and takes the open conversation with it', async () => {
    const { workspace } = stubMove({ sessions: [{ id: MOVED, title: TITLE, lastRoot: ROOT }] })
    renderRail()
    await screen.findByText(TITLE)

    // It starts under its own project, which is the folder the window is showing.
    expect(within(group('sam-ai')).getByText(TITLE)).toBeTruthy()

    const menu = await openMoveMenu(TITLE)
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'notes' }))

    // The destination group is created by the move — it did not exist a moment ago — the row is inside it,
    // and the group it left is gone rather than left standing empty.
    await waitFor(() => expect(within(group('notes')).getByText(TITLE)).toBeTruthy())
    expect(screen.queryByRole('region', { name: 'sam-ai' })).toBeNull()
    // The row that moved is the open conversation, so the window follows it: its next turn runs where the
    // record now says it belongs, rather than stamping the row back into the folder it left.
    await waitFor(() => expect(workspace.rootPath).toBe(NOTES))
  })

  it('leaves a row that is not the open one without moving the window', async () => {
    // The open conversation is the other row, so moving this one must not take the workspace with it.
    const { workspace } = stubMove({
      sessions: [
        { id: MOVED, title: TITLE, lastRoot: ROOT },
        { id: OTHER, title: KEPT, lastRoot: ROOT },
      ],
      activeSessionId: OTHER,
    })
    renderRail()
    await screen.findByText(TITLE)

    const menu = await openMoveMenu(TITLE)
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'notes' }))

    await waitFor(() => expect(within(group('notes')).getByText(TITLE)).toBeTruthy())
    expect(workspace.rootPath).toBe(ROOT)
  })

  it('refuses a folder that is gone, names it, and moves nothing', async () => {
    const { stub, workspace, applied } = stubMove({
      sessions: [{ id: MOVED, title: TITLE, lastRoot: ROOT }],
      refuse: NOTES,
    })
    renderRail()
    await screen.findByText(TITLE)

    const menu = await openMoveMenu(TITLE)
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'notes' }))

    // Worded from main's code, never from its sentence, and naming the one thing the user can act on: the
    // folder that is no longer there.
    const notice = await screen.findByText(/is no longer there/)
    expect(notice.textContent).toContain(NOTES)
    expect(notice.textContent).toContain(TITLE)

    // The command was asked, and nothing moved: no record written, no row re-grouped, no folder switched.
    expect(moveCalls(stub)).toContainEqual({ id: MOVED, destination: NOTES })
    expect(applied).toEqual([])
    expect(within(group('sam-ai')).getByText(TITLE)).toBeTruthy()
    expect(workspace.rootPath).toBe(ROOT)
  })
})
