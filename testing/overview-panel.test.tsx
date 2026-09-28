import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { chatSessionsStore, type ChatSessionsState } from '@/conveyor/stores/chat-sessions'
import { queryClient } from '@/conveyor/client'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Overview resident: the rail slot it takes, and the four tiles it draws from a session's own
 * numbers.
 *
 * What can only be seen here is the wiring. The rules that turn a usage record, a rates pair and a turn
 * count into four strings are `tests/llm/session-usage-test.ts`'s, and the rate fields' own store
 * behaviour is the provider-config node suite's; this file is about what the resident reads them *from*
 * — the mirrored session store the panel is handed, the per-provider prices sitting beside it, the
 * transcript the count comes out of, and the stream chunk that moves a total.
 *
 * Two claims in particular are only a rendered workbench's to make. The panel reads the *mirror*, so a
 * recorded reply has to move the tiles without a reload — which is asserted by streaming a chunk and
 * watching the numbers change under the rail. And the honesty rule is a claim about words: a session
 * nothing has measured draws an em dash rather than a zero, with the reply count still counting beside
 * it.
 *
 * Residual, named rather than claimed: jsdom lays nothing out and prices nothing, so what is verified
 * here is that the resident draws these strings from this state. That the numbers a live provider
 * reports produce these tiles, and that a provider which reports nothing produces the em dashes, is
 * Boss's session against a real endpoint.
 */

const standIn = vi.hoisted(() => ({ groups: new Set<string>() }))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ id, children }: { id?: string; children?: ReactNode }) => {
    if (id) standIn.groups.add(id)
    return (
      <div data-group id={id}>
        {children}
      </div>
    )
  },
  ResizablePanel: ({ id, defaultSize, children }: { id?: string; defaultSize?: string; children?: ReactNode }) => (
    <div data-panel id={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** The em dash the tiles draw when a number is not there to draw. */
const EM_DASH = '—'

/** What a conversation that was measured spent: the running total the store keeps. */
const MEASURED = { prompt: 940_000, completion: 60_000, cached: 893_000, lastReportedAt: 1_700_000_000_000 }

/** One conversation, as the store holds it. `usage` is absent for one nothing has measured. */
function session(usage?: typeof MEASURED): ChatSessionsState['sessions'][number] {
  return {
    id: SESSION_ID,
    title: 'what did this cost',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(usage !== undefined ? { usage } : {}),
  }
}

/** A transcript with the replies a saved conversation ended with. */
function saved(turns: Array<'user' | 'assistant'>): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: turns.map((role, index) => ({ id: `${role}-${index}`, role, content: `${role} ${index}`, steps: [] })),
  }
}

/** What the store main owns recorded, so a dispatch is assertable rather than merely assumed. */
interface FakeMain {
  state: () => ChatSessionsState
  actions: Array<{ method: string; payload: unknown }>
}

/**
 * The chat-sessions store, main's half.
 *
 * A cross-window store is owned by main: an action travels to the store channel, the real reducer runs
 * there, and the mirror changes only when the result is broadcast. Applying the definition's own
 * reducer and pushing the result down the changed channel is what makes "the tiles move without a
 * reload" a claim about the mirror rather than about a second copy of the state.
 */
function fakeSessions(stub: BridgeStub, initial: ChatSessionsState): FakeMain {
  let state = structuredClone(initial)
  const actions: Array<{ method: string; payload: unknown }> = []
  stubStore(stub, CHAT_SESSIONS_STORE_ID, state)
  const procedures = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      // The state read is still answered: a wrapper that swallowed it would leave the mirror without
      // state, and every assertion below would pass because nothing worked at all.
      if (method === '__get__') return state
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      actions.push({ method, payload })
      const reduce = chatSessionsStore.actions[method as keyof typeof chatSessionsStore.actions] as unknown as (
        draft: ChatSessionsState,
        input: unknown
      ) => void
      const next = structuredClone(state) as ChatSessionsState
      if (reduce) reduce(next, payload)
      state = next
      queueMicrotask(() =>
        stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, structuredClone(state))
      )
      return state
    }
    return procedures(channel, method, ...args)
  }

  return { state: () => state, actions }
}

/** The whole workbench over a folder, with a session list, some prices and a saved transcript. */
function stubWorkbench(options: {
  sessions: ChatSessionsState
  providers?: Record<
    string,
    { enabledModels: string[]; fetchedModels: Array<{ id: string }> } & Record<string, unknown>
  >
  transcript?: TranscriptSnapshot | null
}): { stub: BridgeStub; main: FakeMain } {
  const stub = createBridgeStub({
    isMaximized: () => false,
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
    // The session click asks main to open the folder the conversation was used in; answered with the
    // folder already open, which is the case that changes nothing around the slot.
    openRoot: () => ROOT,
    loadTranscript: () => options.transcript ?? null,
    chatWithTools: () => undefined,
  })

  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: options.providers ?? {}, customProviders: [] })
  const main = fakeSessions(stub, options.sessions)
  setActiveStub(stub)
  return { stub, main }
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/**
 * Install the seeded stores, then mount.
 *
 * The mirror conveyor's client keeps is module-global and built once for the file, and `stubStore`
 * pushes a test's state to it a tick after it is registered. `render()` flushes effects synchronously,
 * so a mount that starts in the same tick as its own seed would read the *previous* test's state — and
 * a previous test's active session id is not a harmless leftover here: the session layer restores it at
 * startup, and the panel would then be showing a conversation this test never seeded. Waiting one tick
 * is what makes "this test's stores, at mount" a true statement rather than a usually-true one.
 */
async function mountWorkbench() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return renderWorkbench()
}

/** The right rail, by the name it states to everything that is not a pointer. */
function rightRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Right rail' })
}

/** One of the right rail's residents, by its label. */
function resident(label: string): HTMLElement {
  return within(rightRail()).getByRole('button', { name: label })
}

/** The docked Overview panel, which is only in the document while the resident is docked. */
function panel(container: HTMLElement): HTMLElement {
  const docked = container.querySelector<HTMLElement>('[data-panel]#code')
  const found = docked?.querySelector<HTMLElement>('[data-slot="overview-panel"]')
  if (!found) throw new Error('the Overview panel is not docked')
  return found
}

/** One tile's value, by the tile it belongs to. */
function tile(container: HTMLElement, id: string): HTMLElement {
  const found = panel(container).querySelector<HTMLElement>(`[data-slot="overview-${id}"]`)
  if (!found) throw new Error(`no ${id} tile in the docked panel`)
  return found
}

/** Dock the resident and wait for the panel to be in the slot. */
async function dockOverview(container: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(resident('Overview'))
  await waitFor(() => expect(panel(container)).toBeTruthy())
  return panel(container)
}

/** The channel main's chunks would arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub, index = 0): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[index]
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

beforeEach(() => {
  standIn.groups.clear()
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
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

describe('the Overview resident and its tiles', () => {
  it('docks between Preview and Tools and reads the session it is about', async () => {
    // A conversation that has been measured, on a model whose prices the user has declared: the numbers
    // below are the declaration's, not the shipped table's — the same session prices at $0.1412 on the
    // table, so the cost asserted here is the override being read at all. Declared for `deepseek-chat`,
    // the model the session runs on, because a price belongs to the model it was entered for.
    stubWorkbench({
      sessions: { sessions: [session(MEASURED)], activeSessionId: SESSION_ID },
      providers: {
        deepseek: {
          enabledModels: ['deepseek-chat'],
          fetchedModels: [],
          modelRates: { 'deepseek-chat': { inputRate: 1, cacheHitRate: 0.5, outputRate: 2 } },
        },
      },
      transcript: saved(['user', 'assistant', 'user', 'assistant']),
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    expect(resident('Overview').getAttribute('aria-pressed')).toBe('true')
    // The glyph it is drawn as, so "the bar-chart resident" is a claim about the icon rather than a
    // claim about a label someone could have written on any button.
    expect(resident('Overview').querySelector('svg.lucide-chart-column')).not.toBeNull()
    // Its place in the registry, read from the rail rather than from the array: the resident sits after
    // the two views of the file and before the tools.
    const labels = [...rightRail().querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(['Code', 'Preview', 'Overview', 'Tools'])

    await waitFor(() => expect(tile(container, 'tokens').textContent).toBe('1M'))
    // 47 000 tokens at $1, 893 000 cache hits at $0.50 and 60 000 out at $2, which is the declaration
    // read as a triple: the same session at the input rate throughout would read $0.98 and at the pair's
    // $1.06, so neither of those is the number above.
    expect(tile(container, 'cost').textContent).toBe('$0.6135')
    expect(tile(container, 'cache').textContent).toBe('95%')
    expect(tile(container, 'turns').textContent).toBe('2')
  })

  it('prices the cache hits a measured session reported, from the shipped DeepSeek table', async () => {
    // No declaration anywhere: `deepseek-chat` prices itself from the table this build ships, at
    // DeepSeek's published rates of $0.27 in, $0.07 cached and $1.10 out per million. The session is the
    // one the override test prices, so what differs is only the rates — 47 000 fresh tokens, 893 000
    // cache hits, 60 000 out — and $0.1412 is that arithmetic rather than the $0.3198 a pair charging
    // every prompt token at $0.27 would have read.
    stubWorkbench({
      sessions: { sessions: [session(MEASURED)], activeSessionId: SESSION_ID },
      providers: { deepseek: { enabledModels: ['deepseek-chat'], fetchedModels: [] } },
      transcript: saved(['user', 'assistant']),
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    await waitFor(() => expect(tile(container, 'cost').textContent).toBe('$0.1412'))
    expect(tile(container, 'cache').textContent).toBe('95%')
    expect(tile(container, 'tokens').textContent).toBe('1M')
  })

  it('draws an em dash for what was not measured, and still counts the replies', async () => {
    // A conversation whose providers have reported nothing — and whose model nobody has priced, so the
    // cost has two reasons to be unknown and one honest way to say it. The count is not a measurement
    // of spend: it is how many replies the transcript holds, and it is the one tile that is always a
    // number.
    stubWorkbench({
      sessions: { sessions: [session()], activeSessionId: SESSION_ID },
      transcript: saved(['user', 'assistant', 'user', 'assistant']),
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    await waitFor(() => expect(tile(container, 'turns').textContent).toBe('2'))
    expect(tile(container, 'tokens').textContent).toBe(EM_DASH)
    expect(tile(container, 'cost').textContent).toBe(EM_DASH)
    expect(tile(container, 'cache').textContent).toBe(EM_DASH)
  })

  it('draws one sentence and no tiles when nothing is open', async () => {
    // The launch state: no conversation, so nothing has been measured and nothing is being read. A row
    // of zeros here would be the app claiming a measurement of a conversation that does not exist.
    stubWorkbench({ sessions: { sessions: [], activeSessionId: null }, transcript: null })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    expect(await screen.findByText('Open a conversation to see what it has spent.')).toBeTruthy()
    expect(container.querySelector('[data-slot="overview-tiles"]')).toBeNull()
  })

  it('records what a streamed reply reported, and the tiles move without a reload', async () => {
    // The live half: the run's own usage chunk reaches the store with the conversation's id and the
    // provider's counters, and the panel — already docked and drawing em dashes — fills in from the
    // mirror. Nothing here remounts the panel, which is the point: the same read updates.
    const { stub, main } = stubWorkbench({
      sessions: { sessions: [session()], activeSessionId: SESSION_ID },
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    await waitFor(() => expect(tile(container, 'tokens').textContent).toBe(EM_DASH))

    await userEvent.type(await screen.findByLabelText('Message'), 'measure this{Enter}')
    const channel = await streamChannel(stub)

    chunk(stub, channel, { type: 'text_delta', text: 'Done.' })
    // The accounting frame: no prose of its own, reported once at the end of the round-trip.
    chunk(stub, channel, { type: 'usage', prompt: 5000, completion: 900, cached: 4000 })
    chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, channel, { type: 'done', reason: 'complete', steps: 1 })
    stub.emit(channel, { type: 'end' })

    await waitFor(() => {
      const recorded = main.actions.find((action) => action.method === 'recordUsage')
      expect(recorded?.payload).toEqual({ id: SESSION_ID, prompt: 5000, completion: 900, cached: 4000 })
    })

    // Priced by the shipped table, since this provider declared nothing: 5 000 prompt — of which 4 000
    // came back from the cache — and 900 completion on `deepseek-chat` is $0.0015, not the $0.0023 the
    // pair would have charged for the cached half at the input rate.
    await waitFor(() => expect(tile(container, 'tokens').textContent).toBe('5.9k'))
    expect(tile(container, 'cost').textContent).toBe('$0.0015')
    expect(tile(container, 'cache').textContent).toBe('80%')
    // One reply, which is the one this run just made.
    expect(tile(container, 'turns').textContent).toBe('1')
  })
})
