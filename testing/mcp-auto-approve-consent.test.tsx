import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel, autoApproveHelperText } from '@/app/components/workbench/chat-panel'
import { agentSystemPrompt } from '@/conveyor/protocol/context'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * What a call that skipped the pause leaves behind, and what the shield says about itself.
 *
 * `mcp-auto-approve-gate-test.ts` owns the decision — which call needs a pause and which does not — and
 * the settings suite owns the flag's own screen. What only a rendered pane can show is the *record*: a
 * server call that ran without anyone being asked must not look like a server call whose question
 * vanished. The card says why nobody was asked, on the calls nobody was asked about, and draws nothing
 * at all on the calls that were.
 *
 * The chunks come from where main sends them, so the marker is asserted on the path it actually takes:
 * `tool_call_start` carries it, the reducer keeps it, the card renders it. A test that set the field on
 * a step directly would pass while the reducer dropped it over the IPC boundary.
 *
 * The shield's own copy is here too, because the exception it names is the half of this feature that
 * lives in the other control: the session's Auto-approve covers built-in tools, and a user reading its
 * helper text has to learn that a server is not covered by it.
 *
 * The harness is `mcp-consent-card.test.tsx`'s, deliberately and without changes to `bridge-stub.ts`
 * beyond the manifest entry this feature's settings suite needed.
 */

const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'

/** Two servers' tools, as main names them. */
const FLAGGED_TOOL = 'mcp:playwright:browser_navigate'
const UNFLAGGED_TOOL = 'mcp:filesystem:read_file'

/** What the pause carries about the server behind a call: the same view the consent card draws. */
const CONSENT = {
  serverId: 'filesystem',
  toolName: 'read_file',
  scope: 'project',
  trust: 'matched',
  argsPreview: '{"path": "docs/readme.md"}',
}

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

async function startRun(stub: BridgeStub): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), 'do the thing{Enter}')
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** One call as the model sent it, which is how a pause carries it. */
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/**
 * The card a call is drawn on, found by the call it names.
 *
 * The card is content now rather than a section: it no longer folds, so there is no header button to
 * click and no `closest('button')` to reach. Its body — whether the flag let a call through — is on
 * screen for as long as the run's row is open.
 */
function cardFor(tool: string): HTMLElement {
  const found = screen.getByText(tool, { exact: false })
  const card = found.closest<HTMLElement>('[data-slot="agent-action-card"]')
  if (!card) throw new Error(`no card for ${tool}`)
  return card
}

/** The marker line as the card draws it, or null when the card draws nothing. */
function marker(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="mcp-auto-approved"]')
}

describe('a server call that ran without asking', () => {
  it('executes with no decision created, and its card says which flag let it through', async () => {
    const { stub } = renderChat()
    const channel = await startRun(stub)

    // The announcement main sends for a call whose server is flagged: the same chunk as ever, with the
    // marker on it. Nothing is awaiting, so the pane is never asked anything.
    chunk(stub, channel, {
      type: 'tool_call_start',
      callId: 'c1',
      tool: FLAGGED_TOOL,
      args: { url: 'https://example.com' },
      autoApproved: 'autoApprove',
    })
    chunk(stub, channel, { type: 'tool_result', callId: 'c1', tool: FLAGGED_TOOL, ok: true, output: 'ok' })

    await waitFor(() => expect(screen.getByText(FLAGGED_TOOL)).toBeTruthy())

    // No decision, and no buttons offering one: the call ran, so there was never a question. This is the
    // claim the flag makes — skipping the pause is skipping *this*, not merely hiding it.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(stub.calls.some((entry) => String(entry.method).startsWith('agent.resume'))).toBe(false)

    // A call's card no longer folds behind a header of its own, so the row is now the only control
    // between the reader and the marker: it is opened, and the card inside it is asserted.
    await userEvent.click(screen.getByRole('button', { name: /View Steps/ }))
    expect(cardFor(FLAGGED_TOOL)).toBeTruthy()
    expect(marker()?.textContent).toMatch(/Ran without asking/)
    // And it names the flag in words, rather than only saying that nobody was asked.
    expect(marker()?.textContent).toMatch(/autoApprove/)
  })

  it('draws no marker on an unflagged server call that was approved', async () => {
    const { stub } = renderChat()

    // The session's shield on, which is the state that must not reach an unflagged server: this control is
    // the whole reason the exception exists, and the case it could break is exactly this one.
    const toggle = await screen.findByRole('switch', { name: 'Auto-approve tool actions' })
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))

    const channel = await startRun(stub)

    // The always-ask rule, unchanged: a pause on a running server's tool, which is what the user sees.
    chunk(stub, channel, {
      type: 'awaiting_approval',
      callId: 'c1',
      tool: UNFLAGGED_TOOL,
      args: { path: 'docs/readme.md' },
      messages: [
        { role: 'system', content: agentSystemPrompt(process.platform) },
        { role: 'user', content: 'do the thing' },
      ],
      steps: 1,
      plan: [],
      mcp: CONSENT,
      calls: [call('c1', UNFLAGGED_TOOL, { path: 'docs/readme.md' })],
    })

    // The question is really asked, and it is answerable.
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(stub.calls.some((entry) => String(entry.method).startsWith('agent.resume'))).toBe(true))

    chunk(stub, channel, { type: 'tool_result', callId: 'c1', tool: UNFLAGGED_TOOL, ok: true, output: 'contents' })

    // A card for a running server's tool names the tool and the server, which is how this one is found.
    await userEvent.click(await screen.findByText('read_file on filesystem'))
    // Nothing: a call that was put to the user carries no marker, because the flag had nothing to do with
    // it. A card that drew the line anyway would be telling the user nobody asked when somebody did.
    expect(marker()).toBeNull()
  })
})

describe('the shield’s own copy', () => {
  it('names the per-server exception in the tooltip the pane renders', async () => {
    renderChat()

    const toggle = await screen.findByRole('switch', { name: 'Auto-approve tool actions' })
    // The control is the session's, and its helper text is what says how far the setting reaches. A user
    // reading it must learn the exception here, because the server's own control lives in Settings and
    // nothing on this screen points at it.
    await userEvent.hover(toggle)

    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 4000 })
    expect(tooltip.textContent).toMatch(/MCP servers ask unless their own auto-approve is on/)
    // Both positions say it, which is what keeps the off state from reading as \"nothing ever runs
    // without asking\": the sentence is the same one `autoApproveHelperText` builds for both.
    expect(autoApproveHelperText(false)).toMatch(/MCP servers ask unless their own auto-approve is on/)
    expect(autoApproveHelperText(true)).toMatch(/MCP servers ask unless their own auto-approve is on/)
    expect(autoApproveHelperText(false)).toMatch(/Each write and command waits for your approval/)
    expect(autoApproveHelperText(true)).toMatch(/Writes and commands run without asking/)
  })
})
