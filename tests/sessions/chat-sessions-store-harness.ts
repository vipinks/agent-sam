/**
 * A tiny in-memory harness for the chat-sessions store's actions.
 *
 * The store is a plain definition object, and its actions are pure `(state, payload)` functions.
 * That means the ordering and lifecycle rules can be exercised without electron, without a window,
 * and without the IPC broadcast, by calling the action directly against a state object.
 */
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import type { ChatSessionsState } from '../../conveyor/stores/chat-sessions'

type Actions = typeof chatSessionsStore.actions

/**
 * The store runtime names the initial state `initialState`; the authoring config calls it `state`.
 * Reading it here means the harness starts from exactly what main would start from.
 */
const INITIAL_STATE = (chatSessionsStore as unknown as { initialState: ChatSessionsState }).initialState

export interface StoreHarness {
  state: () => ChatSessionsState
  /** Invoke one action by name, exactly as the store runtime would. */
  run: <K extends keyof Actions>(name: K, payload: Parameters<Actions[K]>[1]) => void
}

export function createStoreHarness(): StoreHarness {
  // Cloned rather than referenced, so a test cannot mutate the store definition's own initial state
  // and leak into the next test.
  const state: ChatSessionsState = structuredClone(INITIAL_STATE)

  return {
    state: () => state,
    run(name, payload) {
      const action = chatSessionsStore.actions[name]
      if (!action) throw new Error(`no such action: ${String(name)}`)
      ;(action as (s: ChatSessionsState, p: unknown) => void)(state, payload)
    },
  }
}

/**
 * Move a session's `updatedAt` back, so ordering can be asserted without sleeping.
 *
 * The actions stamp `Date.now()`, which makes two sessions added in the same millisecond tie. This
 * sets a definite order instead of relying on how fast the test machine is.
 */
export function backdateStore(harness: StoreHarness, id: string, updatedAt: number): void {
  const state = harness.state()
  const index = state.sessions.findIndex((s) => s.id === id)
  if (index === -1) throw new Error(`no such session: ${id}`)
  state.sessions[index] = { ...state.sessions[index], updatedAt }
  // Re-sorted by hand, because the harness writes past the action that would normally do it.
  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}
