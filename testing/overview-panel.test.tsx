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
import { DEFAULT_COMPACT_PERCENT, type ContextSnapshot, type ModelWindows } from '@/conveyor/protocol/context-window'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Overview resident: the rail slot it takes, the four tiles it draws from a session's own numbers,
 * and the context card it draws beneath them.
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

/**
 * One conversation, as the store holds it. `usage` is absent for one nothing has measured, and
 * `contextSnapshot` for one whose requests have never been measured; the model is the one the window is
 * resolved for, and a test that wants no window at all runs a model nothing has declared or tabled.
 */
function session(
  usage?: typeof MEASURED,
  contextSnapshot?: ContextSnapshot,
  model = 'deepseek-chat'
): ChatSessionsState['sessions'][number] {
  return {
    id: SESSION_ID,
    title: 'what did this cost',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerId: 'deepseek',
    model,
    ...(usage !== undefined ? { usage } : {}),
    ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
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

/** One provider's slice of the config store, as this suite seeds it and the workbench's stub takes it. */
type StubbedProvider = { enabledModels: string[]; fetchedModels: Array<{ id: string }> } & Record<string, unknown>

/** The whole workbench over a folder, with a session list, some prices and a saved transcript. */
function stubWorkbench(options: {
  sessions: ChatSessionsState
  providers?: Record<string, StubbedProvider>
  transcript?: TranscriptSnapshot | null
  /** The compact point the preferences store holds, for a test about what a changed percent moves. */
  compactPoint?: number
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
  // The compact-point preference the card's tick and its status are measured against, seeded rather
  // than left to the mirror's own default: a test that changes it is a claim about the card reading the
  // store rather than about the store's own launch value.
  stubStore(stub, 'context-preferences', { compactPoint: options.compactPoint ?? DEFAULT_COMPACT_PERCENT })
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

/**
 * A snapshot whose categories are each a different size, so every row's own string is checkable.
 *
 * The categories add up to `used` by construction: the rows the card draws are the parts beside that
 * total, and a total disagreeing with its parts would be the one number on the card a reader could not
 * add up themselves.
 */
const SNAPSHOT: ContextSnapshot = {
  tools: 10_000,
  systemPrompt: 5_000,
  projectInstructions: 0,
  skills: 2_500,
  messages: 20_000,
  other: 1_500,
  used: 39_000,
  at: 1_700_000_000_000,
}

/**
 * A conversation that has spent a given total, the whole of it in one category.
 *
 * One category carries the total so the fixture is a partition of `used` at every boundary the tests
 * below pass — including zero, which a fixture shrinking a fixed category would draw as a negative
 * count.
 */
function spent(used: number): ContextSnapshot {
  return {
    tools: 0,
    systemPrompt: 0,
    projectInstructions: 0,
    skills: 0,
    messages: used,
    other: 0,
    used,
    at: SNAPSHOT.at,
  }
}

/**
 * The window `deepseek-chat` is declared at in these tests.
 *
 * Declared rather than taken from the shipped table (64 000), because a card reading the declaration is
 * the claim: 39 000 tokens is 39 percent of 100 000, and of the table's number it would be 61 percent.
 */
const DECLARED: ModelWindows = { 'deepseek-chat': { contextWindow: 100_000 } }

/** A provider record whose one model has fetched nothing, enabled nothing, and declared a window. */
function declared(): Record<string, StubbedProvider> {
  return { deepseek: { enabledModels: [], fetchedModels: [], modelWindows: DECLARED } }
}

/** The card, by the slot it carries, once the resident is docked. */
async function cardFor(container: HTMLElement): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-slot="overview-context-card"]')
    if (!found) throw new Error('the context card is not in the docked panel')
    return found
  })
}

/** One of the card's own parts, by the slot it carries. */
function field(card: HTMLElement, slot: string): HTMLElement {
  const found = card.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
  if (!found) throw new Error(`no ${slot} in the card`)
  return found
}

/** Whether the first slot's element comes before the second's in the document. */
function precedes(container: HTMLElement, first: string, second: string): boolean {
  const a = container.querySelector(first)
  const b = container.querySelector(second)
  if (!a || !b) throw new Error(`missing ${a ? second : first}`)
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/**
 * The card, as the resident draws it beneath the tiles.
 *
 * The strings themselves are `tests/llm/context-card-test.ts`'s, and are asserted whole there; what can
 * only be seen from a rendered workbench is that the panel draws them from the right state — the
 * snapshot off the mirrored session record, the window resolved for that conversation's model off the
 * provider record, and the percent off the preferences store — and that they land in the card's own
 * places rather than in the tiles'.
 */
describe('the context card beneath the tiles', () => {
  it('draws the figure, the bar and the rows from a seeded snapshot and window', async () => {
    stubWorkbench({
      sessions: { sessions: [session(undefined, SNAPSHOT)], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    // Beneath the tiles, which is the placement the phase asked for: the card belongs to the resident's
    // body, after the four numbers it elaborates rather than instead of them.
    expect(precedes(container, '[data-slot="overview-tiles"]', '[data-slot="overview-context-card"]')).toBe(true)

    expect(field(card, 'context-figure').textContent).toBe('39k / 100k')
    expect(field(card, 'context-used').textContent).toBe('39k')

    // The rows are the snapshot's own parts, and the free space is what is left of the window.
    expect(field(card, 'context-category-tools').textContent).toContain('10k')
    expect(field(card, 'context-category-messages').textContent).toContain('20k')
    expect(field(card, 'context-free').textContent).toContain('61k')

    // The estimate is stated as the rule it is, under the card, rather than left to be trusted. Read
    // case-insensitively because the three clauses are the claim, not the sentence's capitalisation.
    expect(field(card, 'context-footnote').textContent?.toLowerCase()).toContain('four characters per token')
    expect(field(card, 'context-footnote').textContent?.toLowerCase()).toContain(
      'cumulative session usage is not counted'
    )
  })

  it('draws a healthy pill, the used badge riding the fill, and the tick where the store puts it', async () => {
    // A percent other than the launch default, so the tick's position is a claim about the card reading
    // the preferences store rather than about the store's own first value.
    stubWorkbench({
      sessions: { sessions: [session(undefined, SNAPSHOT)], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
      compactPoint: 60,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    expect(field(card, 'context-pill').textContent).toBe('Healthy')
    // Green from the theme's own success token, and a caption that says what the pill is not: nothing
    // here compacts, and a coloured pill with no words would read as a feature that acts on its own.
    expect(field(card, 'context-pill').className).toContain('text-success')
    expect(field(card, 'context-caption').textContent).toContain('does not compact yet')

    expect(field(card, 'context-fill').style.width).toBe('39%')
    expect(field(card, 'context-used-badge').textContent).toBe('39%')
    expect(field(card, 'context-tick').style.left).toBe('60%')

    // Below the point: the remainder counts towards it.
    expect(field(card, 'context-remainder').textContent).toContain('To compact point')
    expect(field(card, 'context-remainder').textContent).toContain('21k tokens')
  })

  it('says the conversation is past its compact point, in amber, at the point exactly', async () => {
    stubWorkbench({
      sessions: { sessions: [session(undefined, spent(70_000))], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    // At the point rather than a token past it: the setting is a share that is reached, and the wording
    // flips there — with the amount over stated as zero rather than as a negative number.
    expect(field(card, 'context-pill').textContent).toBe('Past compact point')
    expect(field(card, 'context-pill').className).toContain('text-brand')
    expect(field(card, 'context-remainder').textContent).toContain('Past compact point')
    expect(field(card, 'context-remainder').textContent).toContain('0 tokens over')
    expect(field(card, 'context-fill').style.width).toBe('70%')
  })

  it('says the estimate is over the window, in red, with the fill stopped at the bar', async () => {
    stubWorkbench({
      sessions: { sessions: [session(undefined, spent(150_000))], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    expect(field(card, 'context-pill').textContent).toBe('Over window estimate')
    expect(field(card, 'context-pill').className).toContain('text-destructive')
    // The badge states the whole truth and the bar stops at its own end: a fill reading 100 percent for
    // a conversation over its window would deny the one thing the red pill exists to say.
    expect(field(card, 'context-used-badge').textContent).toBe('150%')
    expect(field(card, 'context-fill').style.width).toBe('100%')
    expect(field(card, 'context-figure').textContent).toBe('150k / 100k')
  })

  it('draws one sentence and no figures at all before anything has been measured', async () => {
    // A conversation whose requests have never been measured: the card is in the panel, and it states
    // what it is waiting for rather than drawing noughts. A figure of zero would be the app claiming a
    // measurement it does not have.
    stubWorkbench({
      sessions: { sessions: [session()], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    expect(field(card, 'context-empty').textContent).toBe(
      'Send a message to see what this conversation is about to spend.'
    )
    for (const slot of ['context-figure', 'context-used', 'context-used-badge', 'context-fill']) {
      expect(card.querySelector(`[data-slot="${slot}"]`)).toBeNull()
    }
    expect(/\d/.test(card.textContent ?? '')).toBe(false)
  })

  it('keeps the used tokens and dashes every share when no window resolves', async () => {
    // A model nobody has declared a window for and the shipped table has never heard of, which is the
    // ordinary state of a gateway's own model names. The measurement stands; the shares of a window
    // nobody supplied cannot be stated, so they are dashes and the card says where to declare one.
    stubWorkbench({
      sessions: { sessions: [session(undefined, SNAPSHOT, 'house-model')], activeSessionId: SESSION_ID },
      providers: declared(),
      transcript: null,
    })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    const card = await cardFor(container)

    expect(field(card, 'context-figure').textContent).toBe(`39k / ${EM_DASH}`)
    expect(field(card, 'context-used').textContent).toBe('39k')
    expect(field(card, 'context-used-badge').textContent).toBe(EM_DASH)
    expect(field(card, 'context-remainder').textContent).toContain(EM_DASH)
    expect(field(card, 'context-free').textContent).toContain(EM_DASH)
    expect(card.querySelector('[data-slot="context-tick"]')).toBeNull()
    expect(field(card, 'context-pill').textContent).toBe('Window unknown')
    // A dash with no way out of it is a dead end, so the card names the surface the window is declared on.
    expect(field(card, 'context-pointed').textContent).toContain('Settings')
  })

  it('draws no card at all on home, where one sentence already covers the area', async () => {
    // The launch state. The panel draws a single sentence and no tiles, and the card is not drawn beside
    // it: a second empty-state sentence, or a card of noughts, would be two answers to one question.
    stubWorkbench({ sessions: { sessions: [], activeSessionId: null }, transcript: null })
    const { container } = await mountWorkbench()

    await dockOverview(container)
    expect(await screen.findByText('Open a conversation to see what it has spent.')).toBeTruthy()
    expect(container.querySelector('[data-slot="overview-context-card"]')).toBeNull()
    expect(container.querySelector('[data-slot="overview-tiles"]')).toBeNull()
  })
})
