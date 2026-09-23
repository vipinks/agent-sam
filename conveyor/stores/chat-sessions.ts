import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'

/**
 * The chat session list: what conversations exist, and which one is open.
 *
 * Metadata only, deliberately. Store changes broadcast to every window, so a transcript kept here
 * would flood IPC once per token during streaming — transcripts live on disk instead, via
 * `sessions.ts`. What belongs here is the small, rarely-changing part the list UI renders.
 *
 * Pure (no electron, no react) because both processes import it: main registers it as the source of
 * truth, and the renderer mirrors it through `useConveyorStore`.
 */

/** One conversation, as the list needs it. */
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId: string
  model: string
  /**
   * The folder this conversation was last used in, or absent when it has never had a turn.
   *
   * Absent rather than defaulted, deliberately: "no project yet" is a state the app has to be able to
   * tell apart from "this project", because selecting the first keeps the window where it is and
   * selecting the second moves it. An empty string would read as a project nobody can open, which is
   * why nothing writes one.
   *
   * Stamped at turn starts and only when it differs from what is stored, so a value here is a record
   * of where the work actually happened rather than a guess at where it might. It is additive: an
   * entry written before this field existed simply has no key, and behaves the way it did before it.
   */
  lastRoot?: string
}

// Exported, not just local: the router's inferred type references this store, and a declaration
// that cannot name the state type fails to emit (TS4023).
export interface ChatSessionsState {
  /** Most recently touched first. */
  sessions: ChatSession[]
  activeSessionId: string | null
}

/**
 * An id that cannot escape `userData/sessions`.
 *
 * A UUID is the expected shape, and the pattern excludes separators, dots, and traversal segments by
 * construction — so the module that turns an id into a filename is not the only thing standing
 * between a crafted id and a write somewhere else.
 */
export const sessionIdSchema = z
  .string()
  .min(1)
  .regex(/^[0-9a-fA-F-]{36}$/, 'A session id must be a UUID.')

/** Sorting is by `updatedAt`, so the list is the same in every window without anyone re-sorting. */
function sortByRecency(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export const chatSessionsStore = defineStore('chat-sessions', {
  state: { sessions: [], activeSessionId: null } as ChatSessionsState,

  // Payloads cross the trust boundary, so every action's argument type comes from its schema.
  schemas: {
    addSession: z.object({
      id: sessionIdSchema,
      title: z.string().min(1),
      providerId: z.string().min(1),
      model: z.string().min(1),
      // The same field and rule as `touchSession` carries below: a conversation created while a folder
      // is open is created in that folder, and one created with nothing open has none. Min one, so a
      // blank path cannot become a project; absent is how "no project yet" is spelled.
      lastRoot: z.string().min(1).optional(),
    }),
    touchSession: z.object({
      id: sessionIdSchema,
      title: z.string().min(1).optional(),
      providerId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      // Min one, so a blank path cannot become a project: the field's whole meaning is that it names
      // a folder, and absence is how "none" is spelled.
      lastRoot: z.string().min(1).optional(),
    }),
    removeSession: z.object({ id: sessionIdSchema }),
    setActive: z.object({ id: sessionIdSchema.nullable() }),
  },

  actions: {
    addSession: (state, { id, title, providerId, model, lastRoot }) => {
      const now = Date.now()
      // Idempotent: a re-add of an id that already exists would otherwise give the list two rows
      // with one transcript between them.
      if (state.sessions.some((s) => s.id === id)) return
      state.sessions = sortByRecency([
        ...state.sessions,
        // The project travels with the row rather than being stamped by a second action: a create
        // followed by a stamp would have a moment between them in which the conversation belongs to
        // nowhere, and the list would draw it under the wrong header if the second write were lost.
        {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          providerId,
          model,
          ...(lastRoot !== undefined ? { lastRoot } : {}),
        },
      ])
    },

    /**
     * Record that a session was used.
     *
     * `title` is only ever set by the caller when it should change — the first user message names a
     * session once, and later messages must not rename it. `lastRoot` is passed the same way and for
     * the same reason: the caller compares it against what is stored before asking, so a touch that
     * says nothing about the project leaves the recorded one exactly as it was.
     */
    touchSession: (state, { id, title, providerId, model, lastRoot }) => {
      const index = state.sessions.findIndex((s) => s.id === id)
      if (index === -1) return
      state.sessions = sortByRecency(
        state.sessions.map((s, i) =>
          i === index
            ? {
                ...s,
                updatedAt: Date.now(),
                ...(title !== undefined ? { title } : {}),
                ...(providerId !== undefined ? { providerId } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(lastRoot !== undefined ? { lastRoot } : {}),
              }
            : s
        )
      )
    },

    removeSession: (state, { id }) => {
      state.sessions = state.sessions.filter((s) => s.id !== id)
      // Clearing the pointer matters: leaving it aimed at a deleted session would have the panel
      // render a row that is not in the list.
      if (state.activeSessionId === id) state.activeSessionId = null
    },

    setActive: (state, { id }) => {
      state.activeSessionId = id
    },
  },

  persist: true,
})
