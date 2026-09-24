import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { agentSystemPrompt } from '@/conveyor/protocol/context'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The consent card for a running MCP server's tool, as the user meets it.
 *
 * The node suite owns what the loop decides — the identity, the gate, the codes. What only a rendered
 * pane can show is the question itself: which server is asking, what this app knows about it, and what
 * it wants to run. That is the whole of what a user has to decide on, and a card that left any of it out
 * would be asking them to approve something they cannot see.
 *
 * Two claims:
 *
 * - A pause on an MCP tool renders the server's id, its scope and trust state, the tool's name, and the
 *   arguments with the server's own secrets already replaced — because the replacement happened in main,
 *   where the plaintexts are, and what is on screen is what crossed the IPC boundary.
 * - Approving it resumes exactly the call that was asked about, with the queue the pause handed over
 *   still behind it, and only that call: consent is per call here as it is everywhere else.
 */

const SESSION_ID = 'dddddddd-4444-4444-8444-444444444444'

/** The identity main names a server's tool by, and the call the model made for it. */
const TOOL = 'mcp:playwright:browser_navigate'

/**
 * What the pause carries about the server behind the call.
 *
 * The preview is a string because that is what main sends: it redacted against the secrets that server
 * was started with, collapsed it to one line and cut it to length before the chunk existed. The renderer
 * never holds a plaintext, so the card cannot show one.
 */
const CONSENT = {
  serverId: 'playwright',
  toolName: 'browser_navigate',
  scope: 'project',
  trust: 'matched',
  argsPreview: '{"url": "https://example.com", "token": "[REDACTED]"}',
}

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

function renderChat() {
  const stub = createBridgeStub({
    chatWithTools: () => undefined,
    resume: () => undefined,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: 'a conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId: SESSION_ID,
  })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { ...view, stub }
}

/** Send one message from the composer and return the channel the run's chunks arrive on. */
async function startRun(stub: BridgeStub): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), 'navigate to the docs{Enter}')
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
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

/** One call as the model sent it, which is how the pause and the resume both carry it. */
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** A pause on a running server's tool, as main sends one. */
function pause(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'awaiting_approval',
    callId: 'c1',
    tool: TOOL,
    args: { url: 'https://example.com' },
    messages: [
      { role: 'system', content: agentSystemPrompt(process.platform) },
      { role: 'user', content: 'navigate to the docs' },
    ],
    steps: 1,
    plan: [],
    mcp: CONSENT,
    calls: [call('c1', TOOL, { url: 'https://example.com' })],
    ...overrides,
  }
}

describe('the consent card for a running server’s tool', () => {
  it('says which server is asking, what it may run, and with what arguments', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    chunk(stub, channel, pause())

    // The server, in its own right rather than only in the card's title: the user is being asked to
    // trust a process they cannot see, so its id is what the block is labelled with.
    const consentBlock = await screen.findByText(CONSENT.serverId)
    expect(consentBlock).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()

    // What this app knows about that server: the scope it came from and the trust state the config
    // layer compared, both rendered as the config layer's own words.
    expect(screen.getByText('project scope')).toBeTruthy()
    expect(screen.getByText('trusted')).toBeTruthy()
    // And what it wants to run.
    expect(screen.getByText(CONSENT.toolName)).toBeTruthy()
    expect(screen.getByText(`${CONSENT.toolName} on ${CONSENT.serverId}`)).toBeTruthy()

    // The arguments, as the card may show them: the redaction marker is what main put there, and the
    // value it stands for is nowhere in the pane.
    expect(screen.getByText(/\[REDACTED\]/)).toBeTruthy()
    expect(screen.queryByText(/s3cret-token/)).toBeNull()
  })

  it('resumes the call it was asked about, and leaves the rest of the frame queued', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    chunk(
      stub,
      channel,
      pause({
        calls: [call('c1', TOOL, { url: 'https://example.com' }), call('c2', 'mcp:playwright:browser_click', {})],
      })
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    // One decision, one call: the sibling is still waiting its turn, which is what makes consent per
    // call rather than per frame.
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resume = starts(stub)[1]
    expect(resume.member.startsWith('agent.resume#')).toBe(true)
    expect(resume.input.decision).toBe('approved')

    // The queue goes back whole and untouched, head first: the decision answers the head, and the calls
    // behind it are the model's own — read back out of the pause rather than rebuilt here.
    const calls = resume.input.calls as Array<{ id: string; function: { name: string } }>
    expect(calls.map((entry) => entry.id)).toEqual(['c1', 'c2'])
    expect(calls[0].function.name).toBe(TOOL)
    expect(screen.getByText('Waiting its turn — nothing here runs until the decision above is made.')).toBeTruthy()
  })
})
