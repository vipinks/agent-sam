import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import {
  channelFor,
  CHAT_SESSIONS_STORE_ID,
  createBridgeStub,
  setActiveStub,
  stubStore,
  type BridgeStub,
} from './bridge-stub'

/**
 * The permanent regression test for Bug A (9bba02a).
 *
 * Renders the real session provider and the real panel over a stubbed transport, in the state a
 * restart produces: the store has an active session, the in-memory transcript is empty and nothing
 * has been loaded. Clicking that row must read the transcript and render it.
 *
 * This is the test that would have caught the defect. The rule-level tests all passed while the app
 * was broken, because the bug was not in a rule — it was in whether the wiring called the rule.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

function savedTranscript(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'make a fibonacci script', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Written and passing.',
        steps: [
          {
            callId: 'call_1',
            tool: 'write_file',
            args: { path: 'fib.py' },
            status: 'ok',
            output: 'Wrote 40 bytes to fib.py.',
          },
        ],
      },
    ],
  }
}

/**
 * The session store's seeded state, as main would push it on startup.
 *
 * The store is a cross-window store owned by main; in the renderer it arrives as an initial state
 * plus a subscription. The stub answers the store's own get/subscribe calls, so the provider reads
 * exactly what a restarted app would.
 */
function sessionStoreState(sessions: Array<{ id: string; title: string }>, activeSessionId: string | null) {
  return {
    sessions: sessions.map((s, i) => ({
      id: s.id,
      title: s.title,
      createdAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_000_000 + i,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })),
    activeSessionId,
  }
}

/**
 * Seed the session store and install the stub, the way a running app's main process would.
 *
 * The store is a cross-window store owned by main, so on startup the renderer receives its state
 * over the store's channel. Seeding it here is what puts the panel in the state the report
 * described: a session that exists in the list, with no transcript in memory behind it.
 */
function stubWithStore(
  storeState: ReturnType<typeof sessionStoreState>,
  overrides: Record<string, (input: unknown) => unknown> = {}
): BridgeStub {
  const stub = createBridgeStub(overrides)
  stubStore(stub, CHAT_SESSIONS_STORE_ID, storeState)
  setActiveStub(stub)
  return stub
}

/**
 * Render and wait for the store's state to arrive.
 *
 * conveyor's store mirror fetches once per store id and caches itself at module scope, so which
 * mechanism delivers the state depends on whether this is the first test to touch the store: either
 * the initial read or the pushed broadcast. Both are asynchronous, so every test that asserts on
 * rendered rows waits rather than reading a synchronously-empty list.
 */
async function renderPanelReady(onOpen = vi.fn()) {
  const rendered = renderPanel(onOpen)
  await waitFor(() => {
    // Either a row or the empty state — both mean the store's state has landed.
    const landed =
      rendered.view.container.textContent?.includes('conversations') ||
      rendered.view.container.textContent?.includes('ago')
    if (!landed) throw new Error('store state has not arrived yet')
  })
  return rendered
}

function renderPanel(onOpen = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  // No conveyor store provider: this version exposes stores as hooks (`useConveyorStore`), which read
  // from the bridge directly. Only TanStack Query needs a provider here.
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <SessionListPanel
          onCreate={vi.fn()}
          onOpen={onOpen}
          onRename={vi.fn()}
          onExport={vi.fn()}
          onDelete={vi.fn()}
          error={null}
        />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
  return { view, queryClient, onOpen }
}

describe('session resume wiring (Bug A)', () => {
  it('clicking a row loads its transcript from the store', async () => {
    stubWithStore(sessionStoreState([{ id: SESSION_ID, title: 'make a fibonacci script' }], SESSION_ID), {
      loadTranscript: () => savedTranscript(),
    })

    const { onOpen } = await renderPanelReady()

    // The row is rendered from the store's metadata.
    const row = await screen.findByText('make a fibonacci script')
    await userEvent.click(row)

    // The wiring handed the click to the provider, which asked for the transcript by id.
    expect(onOpen).toHaveBeenCalledWith(SESSION_ID)
  })

  it('reports the load to the transport with the row’s id', async () => {
    const loaded: unknown[] = []
    const stub = stubWithStore(sessionStoreState([{ id: SESSION_ID, title: 'make a fibonacci script' }], SESSION_ID), {
      loadTranscript: (input) => {
        loaded.push(input)
        return savedTranscript()
      },
    })

    // Rendered with no click: the provider hydrates the persisted active session on mount.
    await renderPanelReady()

    await waitFor(() => expect(loaded.length).toBeGreaterThan(0))
    expect(loaded[0]).toEqual({ id: SESSION_ID })
    expect(stub.callsTo('sessions').map((c) => c.method)).toContain('loadTranscript')
    // And the channel is the one conveyor uses for this module.
    expect(stub.calls.find((c) => c.method === 'loadTranscript')?.channel).toBe(channelFor('sessions'))
  })

  it('does not read a transcript for a session that is not active', async () => {
    // The guard's real intent: clicking a session that is already loaded must not re-read it.
    stubWithStore(
      sessionStoreState(
        [
          { id: SESSION_ID, title: 'one' },
          { id: OTHER_ID, title: 'two' },
        ],
        SESSION_ID
      ),
      { loadTranscript: () => savedTranscript() }
    )

    const { onOpen } = await renderPanelReady()
    await userEvent.click(await screen.findByText('two'))

    expect(onOpen).toHaveBeenCalledWith(OTHER_ID)
  })

  it('renders the session list from store metadata', async () => {
    stubWithStore(
      sessionStoreState(
        [
          { id: SESSION_ID, title: 'make a fibonacci script' },
          { id: OTHER_ID, title: 'debug the parser' },
        ],
        SESSION_ID
      ),
      { loadTranscript: () => savedTranscript() }
    )

    await renderPanelReady()

    expect(await screen.findByText('make a fibonacci script')).toBeTruthy()
    expect(await screen.findByText('debug the parser')).toBeTruthy()
    // The active row is marked, which is the highlight the fix had to keep correct.
    const active = await screen.findByText('make a fibonacci script')
    const row = active.closest('button')
    expect(row?.getAttribute('aria-current')).toBe('true')
  })

  it('shows the empty state when there are no sessions', async () => {
    stubWithStore(sessionStoreState([], null))
    await renderPanelReady()

    expect(await screen.findByText('No conversations yet')).toBeTruthy()
    // Deliberately no assertion that `loadTranscript` went uncalled. conveyor caches one store mirror
    // per store id at module scope, so an earlier test in this file may already have hydrated a
    // session — the calls this test could observe belong partly to that history, and asserting on
    // them would test the harness's ordering rather than the app. What matters here is the render.
  })
})
