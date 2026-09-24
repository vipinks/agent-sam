import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { agentSystemPrompt } from '@/conveyor/protocol/context'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The resize primitive, stood in for.
 *
 * The real one is what the workbench keys its groups through, and it is kept out of this file for one
 * reason that is jsdom's and not the app's: its separator takes the caret on a pointerdown, and a real
 * browser follows that with the click's own focus while jsdom does not — so the composer would never
 * receive a keystroke here, in a pane a user types into without thinking about it.
 *
 * Nothing about the claim being tested goes with it. The key is the workbench's, on the element the
 * workbench creates, and React replaces that element's whole subtree whatever it renders; the two
 * markers keep the structure queryable — `data-group` with the group's id, `data-panel` with the
 * panel's — which is how the remount is observed and how the sibling suites find the panes.
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

/**
 * A pending decision, across a window-state swap.
 *
 * The workbench keys both of its resize groups on the window state, because the resize library takes
 * a declared layout once and owns it from then on — so a maximize or a restore arrives as a new group,
 * and the panes under it remount. That is a deliberate cost, and it is paid in the one place this file
 * is about: a consent pause is a decision the user has been asked for and has not answered yet.
 *
 * The defect this suite pins was exactly there. The pane held the pauses in its own `useState`, so the
 * remount emptied them while the transcript — which the session provider owns, above the keyed group —
 * still carried the call as `awaiting`. What the user saw was the worst version of it: a card rendered
 * with live-looking Approve and Deny buttons that did nothing at all when clicked, because the decision
 * that makes a click do anything had just been thrown away by a maximize. A card that failed to render
 * would have been a bug; a card that renders and lies is a trap.
 *
 * So the claims here are about the rendered pane after the swap, for both directions and for a swap
 * that happens while the decision is already pending: the card is still there, its buttons still
 * dispatch the decision they name, an approval resumes the run with the turn's own plan, calls and
 * history, and a denial ends the turn without asking the model anything.
 *
 * The workbench is rendered whole rather than the pane in isolation, because the remount is the
 * mechanism: a standalone pane has no key above it and cannot fail this way. The resize primitive is
 * the real one — the keyed element is the workbench's, and React remounts its subtree whatever that
 * element renders.
 */

const ROOT = 'C:/w'
const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333'

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
  // Deleted rather than redefined, so jsdom's own accessor is what any later reader sees.
  delete proto.offsetWidth
  delete proto.offsetHeight
})

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'an existing conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/**
 * The whole workbench, over a folder, with the window in the given state.
 *
 * The launch state is main's answer, so a test that starts maximized says so with `isMaximized` rather
 * than by driving an event: that is the real route into the state, and the same one the app takes.
 */
function stubWorkbench(windowed = true): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => !windowed,
    chatWithTools: () => undefined,
    resume: () => undefined,
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/**
 * The chat column's own node, which is how a remount is observed rather than assumed.
 *
 * The group is keyed, so a state swap does not re-render this element — it replaces it. Node identity
 * is therefore the claim: the same query, a different node, and the card inside it still decidable.
 */
function chatColumn(container: HTMLElement): HTMLElement {
  const column = container.querySelector<HTMLElement>('[data-panel]#chat')
  if (!column) throw new Error('the workbench rendered no chat column')
  return column
}

/** Push a window-state change, as main's own maximize/unmaximize listeners do. */
async function swapWindowState(container: HTMLElement, stub: BridgeStub, maximized: boolean): Promise<void> {
  const before = chatColumn(container)
  act(() => stub.emit('conveyor:event:window:onMaximizeChange', maximized))
  // Waited on rather than assumed: the push is applied on the next render, and the node it leaves
  // behind is the evidence that the pane under the keyed group was replaced. Everything after this
  // therefore runs against the pane the swap built, which is what a user's click does too.
  await waitFor(() => expect(chatColumn(container)).not.toBe(before))
}

/** Every stream the pane has started, in order, with the member and input each carried. */
function starts(stub: BridgeStub): Array<{ member: string; input: Record<string, unknown> }> {
  return stub.calls
    .filter((call) => call.channel === 'conveyor:stream:start')
    .map((call) => {
      const envelope = call.args[0] as { input?: Record<string, unknown> }
      return { member: call.method, input: envelope.input ?? {} }
    })
}

/** Send one message from the composer and return the channel that run's chunks arrive on. */
async function startRun(stub: BridgeStub, text = 'refactor the parser'): Promise<string> {
  const field = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
  // Clicked before typed: the resize library focuses one of its separators as it mounts, and keystrokes
  // enter through whatever holds the caret. This is the click a user makes to get the caret anyway.
  await userEvent.click(field)
  await userEvent.type(field, `${text}{Enter}`)
  await waitFor(() => {
    if (starts(stub).length === 0) throw new Error('the composer sent nothing')
  })
  return `conveyor:stream:${starts(stub)[0]?.member}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** One call as the model sent it, which is how the pause and the resume both carry it. */
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** The plan the turn declared, with one step still to do. */
const PLAN = [
  { id: 'read', text: 'Read the parser', status: 'done' as const },
  { id: 'edit', text: 'Change the precedence table', status: 'pending' as const },
]

/** A tool a running MCP server offers, under the identity this app gives it. */
const MCP_TOOL = 'mcp:playwright:browser_navigate'

/** What main hands over with that pause: the server, its standing, and a preview with its secret out. */
const MCP_CONSENT = {
  serverId: 'playwright',
  toolName: 'browser_navigate',
  scope: 'project',
  trust: 'matched',
  argsPreview: '{"url": "https://example.com", "token": "[REDACTED]"}',
}

/**
 * A pause as main sends one.
 *
 * The history is the provider-shaped one main was holding, standing instruction and all, because that
 * is what a resumed run is handed back: a stub that sent an empty list would test the queue and not
 * the echo.
 */
function pause(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'awaiting_approval',
    tool: 'write_file',
    args: { path: 'a.ts' },
    messages: [
      { role: 'system', content: agentSystemPrompt(process.platform) },
      { role: 'user', content: 'refactor the parser' },
    ],
    steps: 1,
    plan: PLAN,
    ...overrides,
  }
}

/** Drive a run to the point where it is waiting on the user, and return the channel it arrived on. */
async function pendingApproval(stub: BridgeStub): Promise<string> {
  const channel = await startRun(stub)
  chunk(stub, channel, { type: 'plan', plan: PLAN })
  chunk(stub, channel, {
    type: 'tool_call_start',
    callId: 'c1',
    tool: 'write_file',
    args: { path: 'a.ts' },
  })
  chunk(stub, channel, {
    type: 'tool_call_start',
    callId: 'c2',
    tool: 'run_command',
    args: { command: 'npm test' },
  })
  chunk(
    stub,
    channel,
    pause({
      callId: 'c1',
      calls: [
        call('c1', 'write_file', { path: 'a.ts', content: 'next\n' }),
        call('c2', 'run_command', { command: 'npm test' }),
      ],
    })
  )

  expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
  return channel
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

/**
 * The same pause, for a tool a running MCP server offers.
 *
 * A second builder rather than a parameter, because the difference is the whole point: this pause carries
 * the consent block, and everything this file asserts about the ordinary one has to keep holding for it.
 */
async function pendingMcpApproval(stub: BridgeStub): Promise<string> {
  const channel = await startRun(stub)
  chunk(stub, channel, { type: 'plan', plan: PLAN })
  chunk(stub, channel, {
    type: 'tool_call_start',
    callId: 'c1',
    tool: MCP_TOOL,
    args: { url: 'https://example.com', token: 's3cret-token' },
  })
  chunk(
    stub,
    channel,
    pause({
      callId: 'c1',
      tool: MCP_TOOL,
      args: { url: 'https://example.com', token: 's3cret-token' },
      calls: [call('c1', MCP_TOOL, { url: 'https://example.com', token: 's3cret-token' })],
      mcp: MCP_CONSENT,
    })
  )

  expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
  return channel
}

describe('a pending decision across a window-state swap', () => {
  it('stays decidable when the window is maximized', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    await pendingApproval(stub)
    await swapWindowState(container, stub, true)

    // The swap really did remount the pane: a node that re-rendered would be the same node.
    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByText('Waiting its turn — nothing here runs until the decision above is made.')).toBeTruthy()

    await userEvent.click(approve)

    // The click is what was broken: the decision the card names is the decision that goes out, and the
    // run resumes rather than the card sitting there having done nothing.
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resume = starts(stub)[1]
    expect(resume.member.startsWith('agent.resume#')).toBe(true)
    expect(resume.input.decision).toBe('approved')
    expect((resume.input.calls as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['c1', 'c2'])
  })

  it('stays decidable when the window is restored', async () => {
    // The other direction. The window is maximized first, with the pane still empty, so that the card
    // is already standing when the restore remounts it — which is the order the failure was reported in.
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    await swapWindowState(container, stub, true)
    await pendingApproval(stub)
    await swapWindowState(container, stub, false)

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(starts(stub).length).toBe(2))
    expect(starts(stub)[1].member.startsWith('agent.resume#')).toBe(true)
    expect(starts(stub)[1].input.decision).toBe('approved')
  })

  it('resumes with the paused turn’s own plan, calls and history after a swap', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    await pendingApproval(stub)
    // Two swaps in a row, so the decision outlives more than the one remount the fault was reported as.
    await swapWindowState(container, stub, true)
    await swapWindowState(container, stub, false)

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resume = starts(stub)[1].input
    // A resumed turn is the same turn: what the loop handed over is what it is given back, so the run
    // continues the plan it paused on rather than restarting one it cannot see.
    expect(resume.plan).toEqual(PLAN)
    expect(resume.steps).toBe(1)
    expect(resume.continuations).toBe(0)
    const echoed = resume.messages as Array<{ role: string; content: string }>
    expect(echoed.filter((message) => message.role === 'system').length).toBe(1)
    expect(echoed.at(-1)?.content).toBe('refactor the parser')
  })

  it('keeps an MCP consent card decidable, with the server it names still on it', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    await pendingMcpApproval(stub)
    // Two swaps, the same as the pause above: the consent block is new state on the step, and state on
    // a step is exactly what a remount is capable of losing.
    await swapWindowState(container, stub, true)
    await swapWindowState(container, stub, false)

    expect(screen.getByText('playwright')).toBeTruthy()
    expect(screen.getByText('project scope')).toBeTruthy()
    expect(screen.getByText('trusted')).toBeTruthy()

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resume = starts(stub)[1]
    expect(resume.member.startsWith('agent.resume#')).toBe(true)
    expect(resume.input.decision).toBe('approved')
    // The call goes back exactly as the pause handed it over, Sam identity and all: the renderer is not
    // the side that knows how a name is spelled on the wire.
    const echoed = resume.input.calls as Array<{ id: string; function: { name: string } }>
    expect(echoed.map((entry) => entry.id)).toEqual(['c1'])
    expect(echoed[0].function.name).toBe(MCP_TOOL)
  })

  it('ends the turn on a denial after a swap, and asks the model nothing', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()

    await pendingApproval(stub)
    await swapWindowState(container, stub, true)

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    // A denial is a decision about the run, not a message to the model: nothing was started, and the
    // card stops offering answers it has already been given.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull())
    expect(starts(stub).length).toBe(1)
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    // The call behind the decided one was never put to the user, and says so rather than waiting.
    expect(screen.getByText('Not decided — the turn was ended before this was answered.')).toBeTruthy()
    // And the composer is the user's again, which is the difference between an ended turn and a
    // conversation still blocked on a question nobody can answer.
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).not.toBe('Waiting for your approval…')
    expect(container.querySelector('[data-panel]#chat')).toBeTruthy()
  })
})
