import { createConveyorClient } from 'electron-conveyor/renderer'
import type { AppRouter } from '@/conveyor/router'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { providerConfigStore } from '@/conveyor/stores/provider-config'

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
  /** Push an event payload, as main would. */
  emit: (channel: string, payload: unknown) => void
  /**
   * Deliver a store change to every subscriber, as main's store broadcast does.
   *
   * conveyor's store mirror caches itself per store id at module scope and fetches state only once,
   * so seeding a *second* test through `invoke` alone has no effect — the mirror already holds the
   * first test's state. This is the route main actually uses to broadcast a change, and the only one
   * that reaches an already-cached mirror.
   */
  pushToSubscribers: (payload: unknown) => void
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
  },
  workspace: {
    listDirectory: 'query',
    readFile: 'query',
    onChanged: 'event',
    pickFolder: 'command',
    writeFile: 'command',
  },
  terminal: { execute: 'stream', shell: 'query' },
  llm: { chat: 'stream' },
  window: { init: 'query', onFocusChange: 'event', onMaximizeChange: 'event' },
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
 * Every subscriber registered, for the lifetime of the test file.
 *
 * Deliberately module-global rather than per-stub. conveyor's store mirror subscribes once, on first
 * use, and caches itself per store id at module scope — so that subscription belongs to whichever
 * stub happened to exist then. A per-stub registry would leave later stubs unable to reach it, which
 * is how a second test ended up seeing the first test's state. It also mirrors reality: the set of
 * listening windows is global, not a property of one bridge object.
 */
const allSubscribers = new Set<(payload: unknown) => void>()

/**
 * Stream subscribers, keyed by the stream channel they registered on.
 *
 * Kept apart from the broadcast registry above because a stream subscriber parses its payload
 * strictly: it reads `msg.type`, and anything that is not a stream envelope becomes an error. A
 * store or event broadcast reaching it therefore crashes its parser — which is exactly what produced
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
      // A stream subscriber is keyed by its channel, because its payload parser is strict and must not
      // receive another channel's traffic. Everything else keeps the tolerant broadcast described in
      // the registry note above: delivery is to every subscriber, because the library's event channel
      // naming is an internal detail and a stub that depended on it would break silently.
      if (channel.startsWith(STREAM_PREFIX)) {
        const set = streamSubscribers.get(channel) ?? new Set()
        set.add(cb)
        streamSubscribers.set(channel, set)
        return () => set.delete(cb)
      }
      allSubscribers.add(cb)
      return () => allSubscribers.delete(cb)
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
      // Delivered to every broadcast subscriber rather than by channel: the library's event channel
      // naming is an internal detail, and a stub that depends on it would break silently on an upgrade.
      for (const cb of allSubscribers) cb(payload)
      // A stream subscriber is reached only on its own channel, for the strict-parser reason above.
      for (const cb of streamSubscribers.get(channel) ?? []) cb(payload)
    },
    pushToSubscribers: (payload) => {
      // A store-changed broadcast belongs to the store mirrors, which are broadcast subscribers. It is
      // deliberately not routed at stream channels: main would never send it there.
      for (const cb of allSubscribers) cb(payload)
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
  // receives it. Deferred a tick, because the subscriber registers after the initial read.
  queueMicrotask(() => stub.pushToSubscribers(state))
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
