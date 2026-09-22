import { describe, expect, it } from 'vitest'
import * as renderer from 'electron-conveyor/renderer'
import { createBridgeStub, setActiveStub } from './bridge-stub'

/**
 * Pins the event-subscription protocol the stub depends on.
 *
 * The stub now delivers by channel, as main's transport does, so what has to hold is that a
 * subscription reaches the bridge, that a payload emitted on the channel it subscribed to arrives, and
 * that unsubscribing is honoured — otherwise the workspace-change tests could pass while leaking
 * listeners. The channel name itself is still conveyor's business and is taken from the subscription
 * rather than written down here: a stub that hardcoded it would break silently on an upgrade.
 */
describe('event protocol', () => {
  it('subscribes and unsubscribes through the bridge', () => {
    const stub = createBridgeStub()
    const seen: string[] = []
    // Counted through the stub's own subscribe, which the delegating bridge calls into — wrapping
    // `window.conveyor` would be bypassed, since the client captured the delegate at construction.
    setActiveStub(stub)
    const originalSubscribe = stub.bridge.subscribe
    stub.bridge.subscribe = (channel, cb) => {
      seen.push(channel)
      return originalSubscribe(channel, cb)
    }

    type EventMember = { subscribe: (f: (payload: unknown) => void) => () => void }
    const client = renderer.createConveyorClient()
    const received: unknown[] = []
    const unsubscribe = (
      client as unknown as { window: { onFocusChange: EventMember } }
    ).window.onFocusChange.subscribe((payload) => received.push(payload))

    // A subscription reached the bridge, on some channel — the name is conveyor's business.
    expect(seen.length).toBe(1)
    expect(seen[0]).toMatch(/^conveyor:/)

    // Emitted on the channel the subscription asked for: a payload pushed to any other channel
    // reaches this listener not at all, which is what the channel key means.
    stub.emit(seen[0], true)
    expect(received).toEqual([true])

    // Unsubscribing stops delivery: without this a leaked listener would see later events.
    unsubscribe()
    stub.emit(seen[0], false)
    expect(received).toEqual([true])
  })
})
