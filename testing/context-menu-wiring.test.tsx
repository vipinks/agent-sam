import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The three right-click regions, and the one that must keep its own menu.
 *
 * The claim is about dispatch, and only about dispatch: the menu a right-click raises is a native
 * window built in main, so neither its items nor its position can be observed in jsdom — the electron
 * stub has no `Menu`, and there is no menu element in the document to look for. What a rendered pane
 * can show is the half that decided the policy: which element the gesture happened on, whether the
 * chat half was gated on a selection, and whether the two surfaces that must not gain a menu — an
 * explorer row, which draws its own DOM menu, and the guarded editor's textarea — call nothing.
 *
 * The two coordinates are asserted because they are the defect the payload exists to prevent: a
 * context-menu command with no position would make every menu open wherever the platform last put one.
 * They are the event's own `clientX`/`clientY`, in viewport pixels, passed through unchanged.
 *
 * Residual, named rather than claimed: that the native menu appears at those coordinates, that its
 * items are the OS's own roles and that they act on the focused element are main-and-platform
 * behaviour. The pure template is pinned in `tests/ui/context-menu-test.ts`; the menu itself is the
 * witness's, on the running app.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/index.php'
const NOTES_PATH = 'C:/w/notes.txt'
const DISK_MTIME = 1_700_000_000_000

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * The virtualizer measures the scroll element's own `offsetWidth`/`offsetHeight`, both of which jsdom
 * reports as 0 — and a zero-height window renders no rows, so a transcript assertion would be made
 * against an empty list. Scoped to the chat describe and restored there, so the explorer and editor
 * suites do not inherit a fabricated size.
 */
function fakeViewport(): () => void {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  for (const [property, value] of [
    ['offsetWidth', 900],
    ['offsetHeight', 800],
  ] as const) {
    Object.defineProperty(proto, property, { configurable: true, get: () => value })
  }
  return () => {
    delete proto.offsetWidth
    delete proto.offsetHeight
  }
}

/** One open conversation, and the transcript it holds: a question and an answer with text to select. */
const TRANSCRIPT: TranscriptSnapshot = {
  version: TRANSCRIPT_VERSION,
  interrupted: false,
  turns: [
    { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
    { id: 'assistant-2', role: 'assistant', content: 'The parser is now smaller.', steps: [] },
  ],
}

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'a conversation with words in it',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/**
 * A stub for the chat pane: the one run it might open, the transcript it shows, and the context-menu
 * command every dispatch is asserted against.
 *
 * The command handler resolves to nothing rather than refusing: main's answer is not this file's
 * subject, and an unstubbed command would reject as an unhandled error beside a passing assertion.
 */
function stubChat(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    chatWithTools: () => undefined,
    contextMenu: () => undefined,
    loadTranscript: () => TRANSCRIPT,
    ...overrides,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)
  return stub
}

function renderChat(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The calls the pane made to the context-menu command, in order. */
function menuCalls(stub: BridgeStub) {
  return stub.callsTo('web').filter((call) => call.method === 'contextMenu')
}

/** The transcript's scroll container, found by the slot the pane marks it with. */
async function transcript(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-slot="chat-transcript"]')
    if (element === null) throw new Error('the transcript is not on screen')
    return element
  })
}

/** Select an element's contents, the way a drag across the words would. */
function selectContents(element: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()
  expect(selection).not.toBeNull()
  selection?.removeAllRanges()
  selection?.addRange(range)
  expect(selection?.toString().length ?? 0).toBeGreaterThan(0)
}

describe('a right-click in the composer', () => {
  let restoreViewport = (): void => {}

  beforeEach(() => {
    restoreViewport = fakeViewport()
    queryClient.clear()
  })

  afterEach(() => {
    restoreViewport()
  })

  it('asks main for the composer menu at the pointer', async () => {
    const stub = stubChat()
    renderChat()

    const field = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    fireEvent.contextMenu(field, { clientX: 301, clientY: 419 })

    // The editable element itself carries the handler — which is what makes the region a fact rather
    // than a measurement — and the two numbers are the event's own.
    await waitFor(() =>
      expect(menuCalls(stub).map((call) => call.args[0])).toEqual([{ region: 'composer', x: 301, y: 419 }])
    )
  })
})

describe('a right-click on selected chat text', () => {
  let restoreViewport = (): void => {}

  beforeEach(() => {
    restoreViewport = fakeViewport()
    queryClient.clear()
  })

  afterEach(() => {
    restoreViewport()
  })

  it('asks main for the chat menu at the pointer when text is selected', async () => {
    const stub = stubChat()
    renderChat()

    const region = await transcript()
    const answer = await screen.findByText('The parser is now smaller.')
    selectContents(answer)

    fireEvent.contextMenu(region, { clientX: 64, clientY: 128 })

    await waitFor(() =>
      expect(menuCalls(stub).map((call) => call.args[0])).toEqual([{ region: 'chat', x: 64, y: 128 }])
    )
  })

  it('asks for nothing when no text is selected', async () => {
    const stub = stubChat()
    renderChat()

    const region = await transcript()
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(region, { clientX: 10, clientY: 20 })

    // A right-click on prose with nothing selected is a question about nothing: there is no Copy to
    // offer, and no menu is raised. The assertion is that the command was never asked, not that a menu
    // was never drawn — the menu is main's, and this file never sees one.
    expect(menuCalls(stub)).toEqual([])
  })
})

/**
 * The resizable primitive, stood in for exactly as `explorer-context-menu.test.tsx` stands in for it:
 * the workbench's panels are laid out by it, jsdom lays nothing out, and the primitive is not this
 * file's subject.
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

/** The whole workbench over a folder holding one text file, which is what an explorer row needs. */
function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    contextMenu: () => undefined,
    listDirectory: (input) => {
      const path = (input as { path: string }).path
      return path === ROOT ? [{ name: 'notes.txt', path: NOTES_PATH, isDirectory: false }] : []
    },
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    openRoot: () => ROOT,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
  setActiveStub(stub)
  return stub
}

describe('an explorer row keeps its own menu', () => {
  beforeEach(() => {
    localStorage.clear()
    useWorkbenchStore.setState({
      activeActivity: 'files',
      selectedFile: null,
      selectedChange: null,
      commitMessage: '',
      viewerExpanded: false,
      drawerCollapsed: false,
      rightPanel: null,
      editor: { path: null, dirty: false, externalNonce: 0 },
      layoutPreferences: {},
    })
    queryClient.clear()
  })

  it('draws its DOM menu and asks main for no native one', async () => {
    const stub = stubWorkbench()
    render(
      <QueryClientProvider client={queryClient}>
        <Workbench />
      </QueryClientProvider>
    )

    const row = await screen.findByRole('button', { name: 'notes.txt' })
    fireEvent.contextMenu(row, { clientX: 120, clientY: 240 })

    // The row's own menu still opens where the pointer was — the non-clobber proof: the new command is
    // reached only from the two marked regions, and this is a third one that keeps its DOM menu.
    expect(screen.getByRole('menu', { name: 'File actions' })).toBeTruthy()
    expect(menuCalls(stub)).toEqual([])
  })
})

describe('the guarded editor keeps no menu', () => {
  beforeEach(() => {
    localStorage.clear()
    useWorkbenchStore.setState({
      activeActivity: 'files',
      selectedFile: null,
      selectedChange: null,
      editor: { path: null, dirty: false, externalNonce: 0 },
    })
    queryClient.clear()
  })

  it('raises no native menu over its textarea', async () => {
    const stub = createBridgeStub({
      contextMenu: () => undefined,
      readFile: () => ({ path: TEXT_PATH, content: 'just words\n', baselineMtime: DISK_MTIME }),
      listDirectory: () => [],
      status: () => [],
      branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
      log: () => [],
      localBranches: () => ['main'],
      diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    })
    stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
    setActiveStub(stub)

    useWorkbenchStore.setState({ selectedFile: TEXT_PATH })
    render(
      <QueryClientProvider client={queryClient}>
        <CodeViewer />
      </QueryClientProvider>
    )

    await userEvent.click(await screen.findByLabelText('Edit this file'))
    const field = (await screen.findByLabelText('Edit index.php')) as HTMLTextAreaElement

    // The editor is the surface `params.isEditable` could not tell apart from the composer: it is an
    // editable field too, and it keeps the behaviour it had — no menu, because no handler names it.
    fireEvent.contextMenu(field, { clientX: 200, clientY: 300 })
    expect(menuCalls(stub)).toEqual([])
  })
})
