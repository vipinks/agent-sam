import { createConveyorClient } from 'electron-conveyor/renderer'
import type { AppRouter } from '@/conveyor/router'

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

/** The stub the app is currently talking to. Swapped per test; the bridge object never changes. */
let current: BridgeStub | null = null

export function createBridgeStub(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const calls: BridgeCall[] = []
  const handlers = new Map<string, (input: unknown, channel: string) => unknown>(Object.entries(overrides))

  const bridge: BridgeStub['bridge'] = {
    invoke: async (channel, method, ...args) => {
      calls.push({ channel, method, args })
      const handler = handlers.get(method)
      if (!handler) throw new Error(`no stub for ${channel}.${method}`)
      // Defaults are resolved lazily so a test can install a handler after building the stub.
      return handler(args[0], channel)
    },
    subscribe: (_channel, cb) => {
      // Keyed by nothing: delivery is to every subscriber, because the library's channel naming is an
      // internal detail and a stub that depended on it would break silently. See the module-level
      // registry note above for why this set is global.
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
    callsTo,
    methodsOn: (module) => callsTo(module).map((c) => c.method),
    on: (method, handler) => {
      handlers.set(method, handler)
    },
    emit: (_channel, payload) => {
      // Delivered to every subscriber rather than by channel: the library's event channel naming is
      // an internal detail, and a stub that depends on it would break silently on an upgrade.
      for (const cb of allSubscribers) cb(payload)
    },
    pushToSubscribers: (payload) => {
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
    return current.bridge.invoke(channel, method, ...args)
  },
  subscribe: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!current) throw new Error('no bridge stub installed')
    // Routed through the current stub rather than straight into the registry, so a test can wrap the
    // stub's own `subscribe` and observe it. The registry itself stays global because the library
    // subscribes once and caches its mirror — that subscription must outlive any single stub.
    const unsubscribe = current.bridge.subscribe(channel, cb)
    allSubscribers.add(cb)
    return () => {
      allSubscribers.delete(cb)
      unsubscribe?.()
    }
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
