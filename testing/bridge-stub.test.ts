import { describe, expect, it, vi } from 'vitest'
import { appClient, channelFor, createBridgeStub, setActiveStub } from './bridge-stub'

/**
 * Verifies the bridge stub itself before anything is built on it.
 *
 * A wiring test is only as good as its stub: if the stub does not speak conveyor's protocol, every
 * test above it is testing the stub. This checks the contract empirically rather than by reading
 * minified library code — a query resolves with a value, a command resolves, an event subscribes on
 * the channel main would emit on, and an unknown member fails loudly.
 */
describe('bridge stub', () => {
  it('drives a query through conveyor’s own client', async () => {
    const stub = createBridgeStub({ loadTranscript: () => ({ version: 1, turns: [], interrupted: false }) })
    setActiveStub(stub)

    // The client reads window.conveyor when it is constructed, so the stub is installed first.
    const client = appClient()

    const result = await client.sessions.loadTranscript({ id: 'aaaaaaaa-1111-4111-8111-111111111111' })

    expect(result).toEqual({ version: 1, turns: [], interrupted: false })
    // The call reached the bridge with the input the schema declares.
    expect(stub.callsTo('sessions').map((c) => c.method)).toEqual(['loadTranscript'])
    expect(stub.calls[0].channel).toBe(channelFor('sessions'))
    expect(stub.calls[0].args[0]).toEqual({ id: 'aaaaaaaa-1111-4111-8111-111111111111' })
  })

  it('resolves a command and records it', async () => {
    const stub = createBridgeStub({ saveTranscript: () => undefined })
    setActiveStub(stub)

    await appClient().sessions.saveTranscript({
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      snapshot: { version: 1, turns: [], interrupted: false },
    })

    expect(stub.methodsOn('sessions')).toEqual(['saveTranscript'])
  })

  it('subscribes events on the channel main emits on', () => {
    const stub = createBridgeStub()
    setActiveStub(stub)

    const received: unknown[] = []
    const client = appClient()
    client.window.onFocusChange.subscribe((payload) => received.push(payload))

    stub.emit(channelFor('window'), true)

    // If the channel were wrong this would stay empty, and every event-driven test would be vacuous.
    expect(received).toEqual([true])
  })

  it('opens a stream on the stream-start channel, with the member in the payload', async () => {
    let seenInput: unknown
    const stub = createBridgeStub({
      chatWithTools: (input) => {
        seenInput = input
        return undefined
      },
    })
    setActiveStub(stub)

    // Opening the iterator is what sends the stream start; the chunks themselves arrive by
    // subscription, so this asserts the request side only.
    const iterable = appClient().agent.chatWithTools({ messages: [] } as never) as unknown as AsyncIterable<unknown>
    iterable[Symbol.asyncIterator]()
    await Promise.resolve()

    const start = stub.calls.find((c) => c.channel === 'conveyor:stream:start')
    // Pinned because the stub routes by this shape: `<module>.<method>#<id>` is the stream id carried
    // in the payload, never the channel. Treating it as the channel is what left the chat panel's
    // send unrouted and rejecting, and a conveyor upgrade that changes this must fail here, naming
    // the cause, rather than as an unhandled rejection somewhere else.
    expect(start, 'a stream start must reach the bridge').toBeTruthy()
    const envelope = start?.args[0] as { module: string; method: string; streamId: string; input: unknown }
    expect(envelope.module).toBe('agent')
    expect(envelope.method).toBe('chatWithTools')
    expect(envelope.streamId).toMatch(/^agent\.chatWithTools#/)
    // The handler is reached with the call's own input, so a test that stubs a stream is driving it.
    expect(seenInput).toEqual({ messages: [] })
  })

  it('fails loudly for a member with no stub', async () => {
    const stub = createBridgeStub()
    setActiveStub(stub)

    const client = appClient()
    // Better a clear failure than a silently undefined result that a test then asserts against.
    await expect(client.sessions.deleteTranscript({ id: 'aaaaaaaa-1111-4111-8111-111111111111' })).rejects.toThrow(
      /no stub for/
    )
  })

  it('exposes the members the wiring tests will need', () => {
    const stub = createBridgeStub()
    const manifest = stub.bridge.manifest()
    for (const member of ['saveTranscript', 'loadTranscript', 'deleteTranscript']) {
      expect(manifest.sessions[member], member).toBeDefined()
    }
    expect(vi.isMockFunction(vi.fn())).toBe(true)
  })
})
