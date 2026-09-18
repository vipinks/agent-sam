import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { titleFromMessage, UNTITLED } from '@/app/components/workbench/session-rules'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The permanent regression test for Bug B.
 *
 * Sends a message in a session whose title is still the default and asserts the store is told the
 * derived title. This is the second half of the Phase 7 defect: `maybeTitle` existed and was never
 * called, and `ensureSession` returned early on any existing id, so naming only ever happened for a
 * brand-new session — never for one that already existed, which is every session after a restart.
 *
 * The assertion is on the store call, not on rendered text: the title lives in main, and whether the
 * renderer asked for the right change is exactly what was broken.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** Record every store action the panel dispatches. */
function stubWithRecordingStore(sessions: Array<{ id: string; title: string }>, activeSessionId: string | null) {
  const actions: Array<{ method: string; payload: unknown }> = []
  const stub = createBridgeStub({
    loadTranscript: () => null,
    chatWithTools: () => undefined,
  })

  const state = {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })),
    activeSessionId,
  }
  stubStore(stub, CHAT_SESSIONS_STORE_ID, state)

  // Store actions arrive as invokes on the store channel with the action name as the method, which
  // is how `getActions` dispatches them — recording those is what makes the title observable.
  //
  // The state read (`__get__`) is still answered: a naive record-everything wrapper returned
  // `undefined` for it, which left the mirror without state, made the panel throw, and let the
  // "does not rename" case pass because nothing worked at all rather than because nothing renamed.
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return state
      actions.push({ method, payload: args[0] })
      return undefined
    }
    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  return { stub, actions }
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('first-send title wiring (Bug B)', () => {
  it('tells the store the derived title when the active session is untitled', async () => {
    // The state after a restart: a session exists and is active, with the default title.
    const { actions } = stubWithRecordingStore([{ id: SESSION_ID, title: UNTITLED }], SESSION_ID)
    renderChat()

    const composer = await screen.findByLabelText('Message')
    await userEvent.type(composer, 'make a fibonacci script')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      const titled = actions.find((a) => a.method === 'touchSession')
      expect(titled, `touchSession was never called; recorded: ${JSON.stringify(actions)}`).toBeTruthy()
    })

    const titled = actions.find((a) => a.method === 'touchSession')
    // Store actions arrive wrapped: `getActions` dispatches `{ payload }`, which is what the store
    // runtime unwraps before calling the action. Asserted in that shape because that is the wire.
    expect(titled?.payload).toEqual({
      payload: { id: SESSION_ID, title: titleFromMessage('make a fibonacci script') },
    })
  })

  it('clips a long first message before telling the store', async () => {
    const { actions } = stubWithRecordingStore([{ id: SESSION_ID, title: UNTITLED }], SESSION_ID)
    renderChat()

    const composer = await screen.findByLabelText('Message')
    await userEvent.type(composer, 'x'.repeat(120))
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      expect(actions.some((a) => a.method === 'touchSession')).toBe(true)
    })

    const payload = (actions.find((a) => a.method === 'touchSession')?.payload as { payload: { title: string } })
      .payload
    expect(payload.title.length).toBeLessThanOrEqual(48)
    expect(payload.title.endsWith('…')).toBe(true)
  })

  it('does not rename a session that already has a name', async () => {
    const { actions } = stubWithRecordingStore([{ id: SESSION_ID, title: 'An existing name' }], SESSION_ID)
    renderChat()

    const composer = await screen.findByLabelText('Message')
    await userEvent.type(composer, 'a follow-up message')
    await userEvent.keyboard('{Enter}')

    // Give any title write a chance to happen before asserting it did not.
    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toBeTruthy()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(actions.some((a) => a.method === 'touchSession')).toBe(false)
  })
})
