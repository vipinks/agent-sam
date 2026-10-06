/**
 * The OpenCode engine, as the renderer sees it: the picker's row once a probe found the CLI, the Engines
 * section's row with its auth hint and mode control, and the transcript an ACP turn produces with its
 * `via OpenCode` marker — with the model and provider pickers taken away, the session row naming the engine,
 * and the Cost tile left unpriced.
 *
 * The row is drawn by the registry and nothing else: the picker maps `engineRows` and the section maps
 * `ENGINE_IDS`, so a third engine appearing in both is a table that grew rather than a component that was
 * changed. That is what these cases exist to hold — the reason no product component needed a line for
 * OpenCode is the reason a suite has to look at what those components draw.
 *
 * The chunks these cases apply are the real ones: the events are the ones the fixture ACP agent writes, in the
 * order it writes them, folded through the real `acpTranscriptChunks` and the real `applyAgentChunk`. Which
 * events the agent writes, and that an `opencode` session really handshakes against it, is the node suite's
 * claim (`tests/engines/engine-opencode-test.ts`); this file takes those events as given and asks what the pane
 * draws for them.
 *
 * What is not driven here is the transport: jsdom proves wiring and words, not pixels. That a live OpenCode
 * turn streams, and that its call is gated by the shield, is Boss's eyes on the running app with the CLI
 * installed.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentActionCard } from '@/app/components/workbench/agent-action-card'
import {
  applyAgentChunk,
  startAssistantTurn,
  type AgentTurn,
  type ToolStep,
} from '@/app/components/workbench/agent-session'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import type { AcpEvent } from '@/conveyor/protocol/acp'
import { acpTranscriptChunks } from '@/conveyor/protocol/acp-turn'
import {
  ENGINE_AUTH_HINTS,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_NOT_INSTALLED_NOTE,
  ENGINE_PERMISSION_MODE_IDS,
  ENGINE_PERMISSION_MODE_LABELS,
  enginePreference,
  engineRows,
} from '@/conveyor/protocol/engine'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'

/** The three engines, named rather than indexed, so a rename fails here loudly. */
const CODEX = 'codex'
const KIMI = 'kimi'
const OPENCODE = 'opencode'

/** The version the probe on this machine answered for the CLI on `PATH`, so the assertion is the real string. */
const PROBED_VERSION = '1.4.7'

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]
const DEFAULT_MODELS = { deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }

/** The pair a conversation running an engine must stop showing in the list row. */
const SAM_PAIR = 'deepseek/deepseek-chat'

/**
 * The events the fixture ACP agent writes on one prompt, in its own order.
 *
 * Handed in as the protocol's own shapes rather than as the fixture's lines, because the fixture's lines are
 * the node suite's subject: what this file needs is the sequence — prose, then the call it is about, then the
 * outcome, then the prose that closes it — which is what the mapper is asked to preserve.
 */
const FIXTURE_EVENTS: AcpEvent[] = [
  { type: 'message_chunk', sessionId: 'fixture-session-1', text: 'Writing the notes file.' },
  {
    type: 'tool_call',
    sessionId: 'fixture-session-1',
    toolCallId: 'call-1',
    title: 'Write notes.md',
    kind: 'edit',
    status: 'pending',
  },
  { type: 'tool_call_update', sessionId: 'fixture-session-1', toolCallId: 'call-1', status: 'completed' },
  { type: 'message_chunk', sessionId: 'fixture-session-1', text: 'answered:allow-once' },
]

/** Fold those chunks into one assistant turn, exactly as the panel's run loop does. */
function transcriptOf(): AgentTurn {
  const chunks = acpTranscriptChunks(FIXTURE_EVENTS, OPENCODE)
  let turns: AgentTurn[] = [startAssistantTurn()]
  const turnId = turns[0].id
  for (const chunk of chunks) turns = applyAgentChunk(turns, turnId, chunk).turns
  return turns[0]
}

/** A conversation that runs the OpenCode engine. */
const OPENCODE_SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'the opencode conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
  engineId: OPENCODE,
}

/** The settings reads the shell makes for whichever section is showing. */
function settingsReads() {
  return {
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    isEncryptionAvailable: () => true,
  }
}

/** Every store the panes under test read on mount, seeded the way main would have published them. */
function stubScreen(
  options: {
    rows?: ReturnType<typeof engineRows>
    session?: ChatSession | null
    withWorkspace?: boolean
  } = {}
): void {
  const stub = createBridgeStub({
    ...settingsReads(),
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
    searchSessions: () => [],
    listDirectory: () => [],
    pickFolder: () => null,
    openRoot: (input) => ({ path: (input as { path: string }).path }),
  })

  // The rows a probe would have published on this machine: the app's own loop first, then all three engines.
  // Built by the protocol's own row rule, so the labels under test are the shipped ones rather than strings
  // written here — and so a fourth engine would fail these cases rather than slip past them.
  stubStore(stub, 'engine-status', {
    rows:
      options.rows ??
      engineRows({
        [CODEX]: { installed: true, version: '0.160.1' },
        [KIMI]: { installed: true, version: '1.30.0' },
        [OPENCODE]: { installed: true, version: PROBED_VERSION },
      }),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: options.session ? [options.session] : [],
    activeSessionId: options.session ? options.session.id : null,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', { custom: [], disabledIds: [] })
  stubStore(stub, 'engine-consent', { pending: null })

  setActiveStub(stub)
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

function renderSettings(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SettingsView />
    </QueryClientProvider>
  )
}

function renderList(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SessionListPanel
        onCreate={() => {}}
        onOpen={() => {}}
        onRename={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        error={null}
        notice={null}
      />
    </QueryClientProvider>
  )
}

/** The one panel the section row shows, or a failure — every section case is about what is inside it. */
function enginesSection(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[data-slot="settings-section-engines"]')
  if (!panel || panel.hasAttribute('hidden')) throw new Error('the Engines section is not showing')
  return panel
}

/** The OpenCode engine's box inside the section. */
function opencodeRow(): HTMLElement {
  const row = [...enginesSection().querySelectorAll<HTMLElement>('[data-slot="engine-row"]')].find(
    (candidate) => candidate.querySelector('[data-slot="engine-name"]')?.textContent === ENGINE_LABELS[OPENCODE]
  )
  if (!row) throw new Error('the section draws no OpenCode row')
  return row
}

/** Open a Select from the keyboard, the one path Radix routes without consulting the pointer. */
async function open(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/** Whether a control is disabled, as Radix states it. */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('data-disabled') !== null
}

beforeEach(() => {
  localStorage.clear()
  queryClient.clear()
  useWorkbenchStore.setState({
    activeProviderId: 'deepseek',
    activeModel: 'deepseek-chat',
    selectedFile: null,
    selectedChange: null,
    activeActivity: 'settings',
    settingsReturnView: null,
    settingsSection: 'engines',
    collapsedSessionGroups: [],
  })
})

describe('the OpenCode row in the picker', () => {
  it('is offered beside Agent Sam, Codex and Kimi, named from the shipped table and selectable once detected', async () => {
    stubScreen()
    renderChat()

    const engine = await screen.findByRole('combobox', { name: 'Engine' })
    await open(engine)

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Agent Sam',
      ENGINE_LABELS[CODEX],
      ENGINE_LABELS[KIMI],
      ENGINE_LABELS[OPENCODE],
    ])
    // Detected on this machine, so the row is offered rather than refused — and choosing it is what the
    // trigger then shows, with the probed version in the native title.
    const opencode = options[3]
    expect(isDisabled(opencode)).toBe(false)
    await userEvent.click(opencode)
    await waitFor(() => expect(engine.getAttribute('title')).toContain(PROBED_VERSION))
  })

  it('says not installed rather than dropping the row when the probe found nothing', async () => {
    stubScreen({ rows: engineRows({}) })
    renderChat()

    await open(await screen.findByRole('combobox', { name: 'Engine' }))
    const opencode = screen
      .getAllByRole('option')
      .find((option) => option.textContent?.startsWith(ENGINE_LABELS[OPENCODE]))

    expect(opencode?.textContent).toBe(`${ENGINE_LABELS[OPENCODE]} · ${ENGINE_NOT_INSTALLED_NOTE}`)
    expect(isDisabled(opencode as HTMLElement)).toBe(true)
  })
})

describe('the OpenCode row in the Engines section', () => {
  it('is drawn with its probed version, its own auth hint and a mode control on the default', async () => {
    stubScreen()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('engines'))
    await waitFor(() => expect(enginesSection()).toBeTruthy())

    // One row per engine, read from the registry: the section needed no line for OpenCode, and this is the
    // count that says so rather than an assertion that it happened to be two before.
    expect(enginesSection().querySelectorAll('[data-slot="engine-row"]')).toHaveLength(ENGINE_IDS.length)
    expect(opencodeRow().querySelector('[data-slot="engine-name"]')?.textContent).toBe(ENGINE_LABELS[OPENCODE])
    expect(opencodeRow().querySelector('[data-slot="engine-status"]')?.textContent).toBe(PROBED_VERSION)
    // The line is the engine's own, from the law's table: a hint copied from the row above it would name an
    // account this engine's CLI has nothing to do with.
    expect(opencodeRow().querySelector('[data-slot="engine-auth-hint"]')?.textContent).toBe(ENGINE_AUTH_HINTS[OPENCODE])
    // The control the row draws is the shared one, offering the traced modes in the law's own order.
    await open(screen.getByRole('combobox', { name: `${ENGINE_LABELS[OPENCODE]} permission mode` }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
      ENGINE_PERMISSION_MODE_IDS.map((id) => ENGINE_PERMISSION_MODE_LABELS[id])
    )
    // And the row's mode starts on OpenCode's own declared default: its ACP mode carries no sandbox flag, so
    // the shield's per-call question is this engine's whole consent surface.
    expect(enginePreference(undefined, OPENCODE).permissionMode).toBe(
      enginePreference(undefined, OPENCODE).permissionMode
    )
  })
})

describe('a conversation running OpenCode', () => {
  it('draws the turn as narration and a via-OpenCode marker, in the order the agent wrote them', () => {
    const turn = transcriptOf()

    expect(turn.content.indexOf('Writing the notes file.')).toBeGreaterThanOrEqual(0)
    expect(
      turn.content.indexOf('answered:allow-once', turn.content.indexOf('Writing the notes file.'))
    ).toBeGreaterThan(0)

    expect(turn.steps).toHaveLength(1)
    const step = turn.steps[0]
    expect(step.tool).toBe('write_file')
    expect(String(step.args.path)).toBe('Write notes.md')
    expect(step.via).toBe('OpenCode')
    expect(step.status).toBe('ok')
  })

  it('draws "via OpenCode" on the card, and the engine name rather than Codex or Kimi', () => {
    const step: ToolStep = {
      callId: 'call-1',
      tool: 'write_file',
      args: { path: 'Write notes.md' },
      status: 'ok',
      output: '',
      via: 'OpenCode',
    }

    render(<AgentActionCard step={step} />)
    expect(screen.getByText('via OpenCode')).toBeTruthy()
    expect(screen.queryByText('via Codex')).toBeNull()
    expect(screen.queryByText('via Kimi')).toBeNull()
  })

  it('takes the model and provider pickers away, and says which engine owns the conversation', async () => {
    stubScreen({ session: OPENCODE_SESSION })
    renderChat()

    const model = await screen.findByRole('combobox', { name: 'Provider and model' })
    expect(isDisabled(model)).toBe(true)
    expect(model.getAttribute('title')).toContain(ENGINE_LABELS[OPENCODE])

    const engine = await screen.findByRole('combobox', { name: 'Engine' })
    expect(engine.textContent).toContain(ENGINE_LABELS[OPENCODE])
  })

  it('names OpenCode in the list row, and shows the stored provider pair nowhere', async () => {
    stubScreen({ session: OPENCODE_SESSION, withWorkspace: true })
    renderList()

    const row = (await screen.findByText(OPENCODE_SESSION.title)).closest('button') as HTMLElement
    expect(row).toBeTruthy()
    expect(within(row).getByText(ENGINE_LABELS[OPENCODE])).toBeTruthy()
    expect(within(row).queryByText(SAM_PAIR)).toBeNull()
  })
})
