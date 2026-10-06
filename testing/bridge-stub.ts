import { createConveyorClient } from 'electron-conveyor/renderer'
import type { AppRouter } from '@/conveyor/router'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { terminalPreferencesStore } from '@/conveyor/stores/terminal-preferences'
import { contextPreferencesStore } from '@/conveyor/stores/context-preferences'
import { buddiesStore } from '@/conveyor/stores/buddies'
import { appearancePreferencesStore } from '@/conveyor/stores/appearance-preferences'
import { updateStatusStore } from '@/conveyor/stores/update-status'
import { updatePreferencesStore } from '@/conveyor/stores/update-preferences'

/**
 * A stubbed `window.conveyor` bridge for wiring tests.
 *
 * The real renderer client is a Proxy over `window.conveyor`, so stubbing the bridge tests the real
 * client rather than a fake of it — the call shape, the channel names and the procedure dispatch all
 * go through conveyor's own code. Only the transport is replaced.
 *
 * Records every call, so a test can assert *that* the wiring asked for the right thing, which is what
 * the Phase 7 defects got wrong and what rule-level tests could not see.
 */

/** One recorded bridge call. */
export interface BridgeCall {
  channel: string
  method: string
  args: unknown[]
}

export interface BridgeStub {
  bridge: {
    invoke: (channel: string, method: string, ...args: unknown[]) => Promise<unknown>
    subscribe: (channel: string, cb: (payload: unknown) => void) => () => void
    manifest: () => Record<string, Record<string, string>>
  }
  /** Every call, in order. */
  calls: BridgeCall[]
  /** The calls made to one module, e.g. `sessions`. */
  callsTo: (module: string) => BridgeCall[]
  /** The methods called on one module, in order. */
  methodsOn: (module: string) => string[]
  /** Replace a handler for one `module.method`. */
  on: (method: string, handler: (input: unknown, channel: string) => unknown) => void
  /**
   * This stub's handlers, by method name (or `module.method`).
   *
   * Exposed so the stable delegate can route stream calls to the same handlers a test registered: a
   * stream start names its member in the payload, so resolving it needs this map on whichever stub is
   * current.
   */
  handlers: Map<string, (input: unknown, channel: string) => unknown>
  /** Push an event payload, as main would — to the subscribers of that channel and no others. */
  emit: (channel: string, payload: unknown) => void
  /**
   * Deliver a store change on the channel main broadcasts it on.
   *
   * conveyor's store mirror caches itself per store id at module scope and fetches state only once,
   * so seeding a *second* test through `invoke` alone has no effect — the mirror already holds the
   * first test's state. This is the route main actually uses to broadcast a change, and the only one
   * that reaches an already-cached mirror.
   */
  pushToChannel: (channel: string, payload: unknown) => void
}

/**
 * The manifest the client bootstraps from.
 *
 * Each entry says what kind a member is, which is how the Proxy knows whether a call returns a value,
 * a stream or an event. `justChecking` is deliberately absent so an unlisted call fails loudly rather
 * than being silently treated as a query.
 */
const MANIFEST: Record<string, Record<string, string>> = {
  sessions: {
    saveTranscript: 'command',
    loadTranscript: 'query',
    deleteTranscript: 'command',
    emptyTranscript: 'query',
    transcriptVersion: 'query',
    searchSessions: 'query',
    exportSession: 'command',
  },
  agent: { chatWithTools: 'stream', resume: 'stream' },
  settings: {
    listProviders: 'query',
    defaultModels: 'query',
    listConfigured: 'query',
    isEncryptionAvailable: 'query',
    saveApiKey: 'command',
    clearApiKey: 'command',
    fetchModels: 'command',
  },
  // The catalogue of a provider the user added. A command, like `settings.fetchModels` above it, so the
  // client dispatches it the way main registered it: a member missing from this map is refused by the
  // client's own manifest check before any handler is reached.
  provider: { listModels: 'command' },
  workspace: {
    listDirectory: 'query',
    readFile: 'query',
    onChanged: 'event',
    pickFolder: 'command',
    // The recents switcher's switch: the folder dialog returns a path, and this opens one the app
    // already knows. Both commands, so the client dispatches them the way main registered them.
    openRoot: 'command',
    writeFile: 'command',
    // The workbook write: a command, like the text one above, so the client dispatches it the way main
    // registered it. Listed even though only the spreadsheet suites stub it, because an unlisted member is
    // dispatched by the client's Proxy as something else rather than failing loudly.
    writeSpreadsheet: 'command',
    // The document read and the shell hand-off the two document viewers are built on. A query and a
    // command, in that order, because that is how main registered them; the read is listed for the
    // reason every read above it is — the client refuses an unlisted member rather than dispatching it,
    // and a viewer whose read never ran would render its loading state forever.
    readDocument: 'query',
    openDocument: 'command',
  },
  terminal: { execute: 'stream', shell: 'query' },
  // The PTY: one shell per folder, owned by main. Its four commands are the pane's whole write side,
  // its two reads are what a pane coming back catches up from, and its two events are how output and
  // an exit arrive. All eight are listed by kind for the reason the entries around them are — the client
  // refuses an unlisted member rather than dispatching it, so a terminal suite cannot reach the pane's
  // own calls without these lines.
  terminalPty: {
    create: 'command',
    write: 'command',
    resize: 'command',
    kill: 'command',
    read: 'query',
    list: 'query',
    data: 'event',
    exit: 'event',
  },
  llm: { chat: 'stream' },
  window: {
    init: 'query',
    isMaximized: 'query',
    onFocusChange: 'event',
    onMaximizeChange: 'event',
    // The titlebar's four view acts. Commands, the kind main registered them as, and listed rather
    // than left out: the client refuses a member that is missing from this map before any handler is
    // reached, so a button whose act is absent here could not dispatch at all.
    zoomIn: 'command',
    zoomOut: 'command',
    resetZoom: 'command',
    toggleFullscreen: 'command',
  },
  // The running app's own version, which `/version` reports. A query, like `sessions.transcriptVersion`
  // above it, and listed for the same reason: the client refuses an unlisted member rather than
  // dispatching it, and a command that reached nothing would render an empty notice rather than fail.
  system: { version: 'query' },
  // The mention picker's only read. Listed so the composer's call is dispatched as the query main
  // registered rather than as an unlisted member, which is what the client's Proxy does with an
  // unknown name.
  mentions: { listFilesFlat: 'query' },
  // The composer's image store: the write a send performs once per attached image, and the delete a
  // conversation's cleanup offers. Listed by kind for the reason the entries around it are — the client
  // refuses an unlisted member rather than dispatching it, so a suite about a send carrying images could
  // not reach the store without this line.
  attachments: { save: 'command', deleteSession: 'command', readDataUrl: 'command' },
  // The skills surface: the two reads the composer and the settings section make, and the four writes
  // phase 43 added. Listed by kind for the same reason as the entries around it — the picker's read runs
  // on mount, and a member missing from this map would be dispatched by the wrong path.
  skills: {
    listSkills: 'query',
    getSkillBody: 'query',
    createSkill: 'command',
    copySkillIntoProject: 'command',
    deleteSkill: 'command',
    setSkillAvailability: 'command',
  },
  // The MCP settings section: both reads it draws a row from, every write a row offers, and the two
  // calls that start and stop a process. Listed by kind, so the client dispatches each the way main
  // registered it — a member missing from this map is refused by the client's own manifest check.
  mcp: {
    listServers: 'query',
    listRunningTools: 'query',
    getServerLogs: 'query',
    addServer: 'command',
    removeServer: 'command',
    setEnabled: 'command',
    // The per-server auto-approve flag's own write. Listed by kind like its siblings, because the
    // client refuses an unlisted member rather than dispatching it — so a suite about that control
    // cannot reach main without this line.
    setAutoApprove: 'command',
    setTrust: 'command',
    setSecret: 'command',
    clearSecret: 'command',
    startServer: 'command',
    stopServer: 'command',
  },
  // The repository view: the reads the changes panel makes, and the commands it offers. Listed by
  // kind, so the client dispatches each the way main registered it.
  git: {
    status: 'query',
    branch: 'query',
    log: 'query',
    localBranches: 'query',
    diff: 'query',
    stage: 'command',
    unstage: 'command',
    commit: 'command',
    discardWorktree: 'command',
    checkoutBranch: 'command',
  },
}

/**
 * The stream-transport constants, taken from conveyor's protocol rather than inferred.
 *
 * `STREAM_START` is its own channel and the member travels inside the payload: the client calls
 * `invoke(STREAM_START, '<module>.<method>#<id>', { module, method, streamId, input })`. The
 * composite string `<module>.<method>#<id>` is a stream id, never a channel — matching it as one was
 * the mistake that left the chat panel's send unrouted.
 */
const STREAM_START = 'conveyor:stream:start'
const STREAM_CANCEL = 'conveyor:stream:cancel'
const STREAM_PREFIX = 'conveyor:stream:'

/**
 * Answer a stream start: run the handler stubbed for that member, or resolve with nothing.
 *
 * The member is read from the stream id — `<module>.<method>#<id>` — and the handler is given the
 * call's own input, which the envelope carries under `input`. Handing over the whole envelope instead
 * would make every stream stub assert against transport metadata it never asked for.
 *
 * An unstubbed stream resolves rather than rejecting: the panel opens one on send, and a test about
 * the title should not have to fake a model reply to get a clean run.
 */
function streamReply(
  handlers: Map<string, (input: unknown, channel: string) => unknown>,
  member: string,
  envelope: unknown
): Promise<unknown> {
  const parsed = /^([^.]+)\.([^#]+)#/.exec(String(member))
  const handler = parsed ? (handlers.get(parsed[2]) ?? handlers.get(`${parsed[1]}.${parsed[2]}`)) : undefined
  if (!handler) return Promise.resolve(undefined)
  const carries = envelope && typeof envelope === 'object' && 'input' in envelope
  return Promise.resolve(handler(carries ? (envelope as { input: unknown }).input : undefined, member))
}

/**
 * The channel conveyor builds for a module id.
 *
 * Only used for assertions about the *invoke* channel, which was confirmed empirically (see the
 * stub's own test). Event subscriptions are not modelled by channel at all — see `subscribe` below.
 */
export function channelFor(moduleId: string): string {
  return `conveyor:${moduleId}`
}

/**
 * Every subscriber registered, for the lifetime of the test file, keyed by the channel it asked for.
 *
 * Deliberately module-global rather than per-stub. conveyor's store mirror subscribes once, on first
 * use, and caches itself per store id at module scope — so that subscription belongs to whichever
 * stub happened to exist then. A per-stub registry would leave later stubs unable to reach it, which
 * is how a second test ended up seeing the first test's state. It also mirrors reality: the set of
 * listening windows is global, not a property of one bridge object.
 *
 * Keyed by channel rather than held as one set, because one set meant one broadcast. The mirror
 * subscribes to `conveyor:store:<id>:changed` and takes whatever arrives as its whole state, so an
 * event pushed to every subscriber landed in it as state — emitting the window's `true` for "maximized"
 * replaced the workspace store with a boolean, and the explorer of a rendered workbench then read
 * `recentRoots` off it. Main addresses each channel separately; so does this now.
 */
const broadcastSubscribers = new Map<string, Set<(payload: unknown) => void>>()

/** The subscriber set for a channel, made on first use. */
function subscribersOn(channel: string): Set<(payload: unknown) => void> {
  const existing = broadcastSubscribers.get(channel)
  if (existing) return existing
  const created = new Set<(payload: unknown) => void>()
  broadcastSubscribers.set(channel, created)
  return created
}

/**
 * Stream subscribers, keyed by the stream channel they registered on.
 *
 * Kept apart from the subscribers above as well as keyed, because a stream subscriber parses its
 * payload strictly: it reads `msg.type`, and anything that is not a stream envelope becomes an error.
 * A store or event payload reaching it therefore crashes its parser — which is exactly what produced
 * `Cannot read properties of undefined (reading 'code')`, since the failure is turned into
 * `ConveyorError.from(msg.error)` with nothing to read. Main never pushes a store payload down a
 * stream channel, so keeping the two apart is the honest simulation.
 */
const streamSubscribers = new Map<string, Set<(payload: unknown) => void>>()

/**
 * The real initial state of each store the app registers, for unseeded reads.
 *
 * Taken from the store definitions themselves rather than written out here, so this cannot drift from
 * them. The store definitions are pure (no electron, no react — they are shared with the renderer),
 * so importing them into a test stub is safe.
 *
 * This matters because the store mirror caches whatever it receives at module scope: answering an
 * unseeded read with `{}` would leave a shapeless state in the cache for the rest of the file, and
 * the panel would throw on `sessions.length`. Returning the genuine empty state is the honest
 * simulation of a store that exists but has nothing in it.
 */
const initialStates = new Map<string, unknown>([
  ['conveyor:store:chat-sessions', structuredClone(chatSessionsStore.initialState)],
  ['conveyor:store:workspace', structuredClone(workspaceStore.initialState)],
  ['conveyor:store:provider-config', structuredClone(providerConfigStore.initialState)],
  // The terminal's two preferences, which the pane reads on every mount and the settings section writes:
  // without a genuine initial state here the mirror would cache `undefined` for this store and the
  // terminal pane would throw on the selector that reads a font size out of it.
  ['conveyor:store:terminal-preferences', structuredClone(terminalPreferencesStore.initialState)],
  // The compact-point preference, which the Context settings section reads on every mount and writes
  // when the percent changes: without a genuine initial state here the mirror would cache `undefined`
  // for this store, and the section would throw on the selector that reads a percent out of it.
  ['conveyor:store:context-preferences', structuredClone(contextPreferencesStore.initialState)],
  // The user's own Buddies, which the session hook reads on every render to resolve one at creation:
  // without a genuine initial state here the mirror would cache `undefined` for this store and the read
  // of the custom list would throw before a single conversation could be created.
  ['conveyor:store:buddies', structuredClone(buddiesStore.initialState)],
  // The chat pane's two display preferences — the side the user's bubbles sit on and the size the message
  // body is painted at. The pane reads both on every render, so without a genuine initial state here the
  // mirror would cache `undefined` for this store and the transcript would throw on the first message it
  // drew.
  ['conveyor:store:appearance-preferences', structuredClone(appearancePreferencesStore.initialState)],
  // The updater's two stores. The status one is read by the workbench's update-ready notice on every
  // mount — every suite that renders the workbench mounts it — and the preference one is read by the
  // Updates settings section. Without a genuine initial state here the mirror would cache `undefined`
  // for either, and the notice would throw on the selector that reads a state out of it.
  ['conveyor:store:update-status', structuredClone(updateStatusStore.initialState)],
  ['conveyor:store:update-preferences', structuredClone(updatePreferencesStore.initialState)],
])

/**
 * Store state, keyed by store id, shared across stubs for the life of the test file.
 *
 * The store mirror fetches its state once and caches itself at module scope, so a fetch started
 * under one test can still be in flight when the next test installs a fresh stub. Keeping the seed
 * here means whichever stub is current can answer it.
 *
 * Storing it per-stub instead was the bug: the late fetch landed on a stub with no store handler and
 * threw an unhandled rejection. The tests still passed, which is exactly why it mattered — an
 * unhandled rejection can mask a real failure, and vitest reports it separately from assertions.
 */
const storeSeeds = new Map<string, unknown>()

/** The stub the app is currently talking to. Swapped per test; the bridge object never changes. */
let current: BridgeStub | null = null

export function createBridgeStub(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const calls: BridgeCall[] = []
  const handlers = new Map<string, (input: unknown, channel: string) => unknown>(Object.entries(overrides))

  const bridge: BridgeStub['bridge'] = {
    invoke: async (channel, method, ...args) => {
      calls.push({ channel, method, args })
      // Stream transport, handled here as well as in the stable delegate. A per-test wrapper is allowed
      // to replace this `invoke` with a recording one, and the chat panel's send reached only that
      // wrapper — so routing that lives *only* in the delegate is routing a wrapper can strand.
      if (channel === STREAM_START) return streamReply(handlers, method, args[0])
      if (channel === STREAM_CANCEL) return undefined
      const handler = handlers.get(method)
      if (handler) return handler(args[0], channel)
      // A store read is answered from the shared seed, so it works on any stub — including one
      // installed after the fetch began, and including the very first fetch that happens before any
      // test has seeded anything.
      //
      // An unseeded store falls back to its real initial state. It must not throw: the app reads stores
      // this suite does not care about (the workspace, the provider config), and a rejection there
      // surfaces as an unhandled error that vitest reports separately from assertions — a passing test
      // file carrying hidden failures.
      if (channel.startsWith('conveyor:store:')) {
        return storeSeeds.get(channel) ?? structuredClone(initialStates.get(channel))
      }
      throw new Error(`no stub for ${channel}.${method}`)
    },
    subscribe: (channel, cb) => {
      // Keyed by the channel, exactly as main's own transport is, and for the reason the registry note
      // gives: one shared set meant one broadcast, and a store mirror takes whatever arrives on its
      // own channel as its whole state.
      if (channel.startsWith(STREAM_PREFIX)) {
        const set = streamSubscribers.get(channel) ?? new Set()
        set.add(cb)
        streamSubscribers.set(channel, set)
        return () => set.delete(cb)
      }
      const set = subscribersOn(channel)
      set.add(cb)
      return () => set.delete(cb)
    },
    manifest: () => MANIFEST,
  }

  const moduleOf = (channel: string) => channel.replace(/^conveyor:/, '')
  // Bound to a local so `methodsOn` below can share it: referencing `this.callsTo` inside an object
  // literal is a runtime error, which is exactly what the first run of the stub test caught.
  const callsTo = (module: string) => calls.filter((c) => moduleOf(c.channel) === module)

  return {
    bridge,
    calls,
    handlers,
    callsTo,
    methodsOn: (module) => callsTo(module).map((c) => c.method),
    on: (method, handler) => {
      handlers.set(method, handler)
    },
    emit: (channel, payload) => {
      // A stream payload goes to its own channel's subscribers and nowhere else. The tolerant broadcast
      // below is right for events, whose channel naming is the library's business — but a stream
      // payload is a chunk, and handing one to a store mirror would replace that store's state with it,
      // leaving the failure to surface later as a component reading a field its store no longer has.
      // Main never sends a chunk to a non-stream subscriber, so this is also the honest simulation.
      if (channel.startsWith(STREAM_PREFIX)) {
        for (const cb of streamSubscribers.get(channel) ?? []) cb(payload)
        return
      }
      // Event payloads included: a payload handed to a channel nobody is listening on reaches nobody,
      // which is what main does, and what a store mirror depends on — it takes whatever arrives on its
      // own channel as its whole state.
      for (const cb of broadcastSubscribers.get(channel) ?? []) cb(payload)
    },
    pushToChannel: (channel, payload) => {
      // A store change, on the channel the mirror subscribed to. Not routed at stream channels: main
      // would never send it there.
      for (const cb of broadcastSubscribers.get(channel) ?? []) cb(payload)
    },
  }
}

/**
 * Seed a cross-window store, as main would.
 *
 * Two mechanisms, because conveyor's store mirror uses both and only one of them can work per test:
 *
 * - `invoke` answers the initial read. The mirror fetches state once, on first use per store id, and
 *   caches itself at module scope (`getMirror` keeps a Map keyed by id) — so this only feeds the
 *   *first* test that touches a given store.
 * - `subscribe` exists so later tests can push state on the store-changed channel, which is how main
 *   broadcasts a change and the only route that works once the mirror is cached. Without it, a second
 *   test seeding different state would silently see the first test's.
 *
 * The channel and method names were recorded from the hooks, not guessed: `conveyor:store:<id>` and
 * `__get__`. `testing/store-protocol.test.tsx` pins them so a conveyor upgrade fails there, naming
 * the cause, rather than as a confusing "element not found" somewhere else.
 */
export function stubStore(stub: BridgeStub, storeId: string, state: unknown): void {
  const channel = `conveyor:store:${storeId}`
  // Registered globally as well as on this stub, so a store read that arrives after this test has
  // finished still finds its state rather than failing as an unknown procedure.
  storeSeeds.set(channel, state)
  const procedures = stub.bridge.invoke

  stub.bridge.invoke = async (c, method, ...args) => {
    if (c === channel) return state
    return procedures(c, method, ...args)
  }

  // Push the same state to anyone already subscribed, so a mirror cached by an earlier test still
  // receives it. Deferred a tick, because the subscriber registers after the initial read. On the
  // channel the mirror subscribed to, and only there: it takes whatever arrives as its whole state.
  queueMicrotask(() => stub.pushToChannel(`conveyor:store:${storeId}:changed`, state))
}

/** The chat session store's id, as `defineStore('chat-sessions', ...)` declares it. */
export const CHAT_SESSIONS_STORE_ID = 'chat-sessions'

/**
 * The single bridge object the app's client is given, installed once.
 *
 * It delegates to whichever stub is current rather than being replaced, because the app's client
 * captures `window.conveyor` when it is constructed — which, since app modules are imported once,
 * happens on the first import. Swapping `window.conveyor` per test therefore had no effect: calls
 * kept arriving at the first test's stub, which is why later tests saw stale state and missing call
 * records. One stable object with an indirection is what makes per-test stubs real.
 */
const bridgeDelegate = {
  invoke: (channel: string, method: string, ...args: unknown[]): Promise<unknown> => {
    if (!current) return Promise.reject(new Error('no bridge stub installed'))
    // A pure forwarder. The stream transport is handled inside the stub's own `invoke`, so a stream
    // start is recorded like every other call and a test that wraps `invoke` still reaches it through
    // the stub's routing. Handling streams here instead would bypass both the record and the wrapper —
    // which is how the branch this replaced came to look correct while never being taken.
    return current.bridge.invoke(channel, method, ...args)
  },
  subscribe: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!current) throw new Error('no bridge stub installed')
    // Routed through the current stub rather than straight into the registry, so a test can wrap the
    // stub's own `subscribe` and observe it. Where the subscriber is filed — broadcast set or stream
    // map — is the stub's decision, since it depends on the channel.
    return current.bridge.subscribe(channel, cb)
  },
  manifest: (): Record<string, Record<string, string>> => (current ? current.bridge.manifest() : MANIFEST),
}

/**
 * Make a stub the one the app talks to, installing the delegating bridge if needed.
 *
 * Safe to call on every test: the delegate is installed once, and only the target changes. That is
 * what lets each test have fresh call records and its own handlers while the client keeps working.
 */
export function setActiveStub(stub: BridgeStub): void {
  current = stub
  const target = window as unknown as { conveyor?: unknown }
  if (target.conveyor !== bridgeDelegate) target.conveyor = bridgeDelegate
}

/** The stub currently in use. */
export function activeStub(): BridgeStub {
  if (!current) throw new Error('no bridge stub installed — is testing/setup-bridge.ts registered?')
  return current
}

/** The typed client over the installed stub — the same object the app's components import. */
export function appClient() {
  return createConveyorClient<AppRouter>()
}
