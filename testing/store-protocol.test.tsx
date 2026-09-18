import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * Pins the store protocol the whole DOM suite depends on.
 *
 * `stubStore` answers a specific channel (`conveyor:store:<id>`) under a reserved method (`__get__`),
 * and those names are internal to conveyor. The rest of the suite is built on them: rename one and
 * the stub silently stops feeding state, and the wiring tests fail as a confusing "element not found"
 * rather than naming the cause. Asserting the contract here is what turns that into a clear failure.
 */
describe('store protocol', () => {
  it('measures the channel and method the store hooks actually use', () => {
    const stub = createBridgeStub()
    setActiveStub(stub)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatSessionsProvider>
          <SessionListPanel onCreate={() => {}} onOpen={() => {}} onDelete={() => {}} error={null} />
        </ChatSessionsProvider>
      </QueryClientProvider>
    )

    const storeCalls = stub.calls.filter((c) => c.channel.startsWith('conveyor:store:'))

    expect(storeCalls.length, 'the store hooks should have called the bridge').toBeGreaterThan(0)
    expect(storeCalls[0].channel).toBe(`conveyor:store:${CHAT_SESSIONS_STORE_ID}`)
    expect(storeCalls[0].method).toBe('__get__')
  })

  it('feeds the session store state the list then renders', async () => {
    const stub = createBridgeStub()
    stubStore(stub, CHAT_SESSIONS_STORE_ID, {
      sessions: [
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          title: 'seeded through the store channel',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          providerId: 'deepseek',
          model: 'deepseek-chat',
        },
      ],
      activeSessionId: null,
    })
    setActiveStub(stub)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatSessionsProvider>
          <SessionListPanel onCreate={() => {}} onOpen={() => {}} onDelete={() => {}} error={null} />
        </ChatSessionsProvider>
      </QueryClientProvider>
    )

    // The seeded row reaching the screen is what proves the channel and payload shape are right.
    await waitFor(() => {
      expect(view.container.textContent ?? '').toContain('seeded through the store channel')
    })
  })
})
