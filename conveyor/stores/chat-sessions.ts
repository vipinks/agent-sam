import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { MAX_ACTIVE_SKILLS, MAX_SKILL_ID_CHARS } from '../protocol/skills'

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
  /**
   * The skills this conversation runs with, by id, in the order the user turned them on.
   *
   * On the session rather than in a window, because a skill changes what the model is told for every turn
   * of that conversation: a conversation that was working from a review checklist should still be working
   * from it when it is reopened tomorrow, and the next conversation should not inherit it.
   *
   * Additive and optional, like `lastRoot` above: an entry written before skills existed simply has no
   * key, and absence means none chosen — which is what every such session meant. Nothing writes an empty
   * list to say "none": that would rewrite every record on the first launch after the feature landed, to
   * say something the absent key already said. The exception is the user turning the last skill off, which
   * is a change they made and is stored as the empty list it is.
   *
   * Ids only. The skill's own title, summary and body are the disk's answer, read fresh by the turn that
   * uses them, so a session never carries a stale copy of a skill someone has since edited.
   */
  activeSkillIds?: string[]
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

/**
 * The ids one conversation may carry.
 *
 * Bounded here as well as in the control that offers the toggles, because this is the boundary the
 * renderer's payload actually crosses: the cap is a property of the app's prompt budget, so a payload
 * claiming nine active skills is refused rather than stored and then discovered at the next turn start.
 * `min(1)` on each id, so a blank string cannot name a skill nobody can resolve.
 */
const activeSkillIdsSchema = z.array(z.string().min(1).max(MAX_SKILL_ID_CHARS)).max(MAX_ACTIVE_SKILLS)

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
      // The skills the conversation is created with, when the user chose them before there was a
      // conversation to choose them on. Absent for one created without any; an empty list is refused
      // nowhere and written nowhere — `addSession` drops it below, so a new record says "none" the way
      // every record written before this field existed says it: by having no key at all.
      activeSkillIds: activeSkillIdsSchema.optional(),
    }),
    touchSession: z.object({
      id: sessionIdSchema,
      title: z.string().min(1).optional(),
      providerId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      // Min one, so a blank path cannot become a project: the field's whole meaning is that it names
      // a folder, and absence is how "none" is spelled.
      lastRoot: z.string().min(1).optional(),
      // The skill choice, on the same terms as `lastRoot` above and with one difference that matters:
      // an empty list here *is* a change — the user turned the last skill off — so it is stored rather
      // than dropped. Only a caller that says nothing about skills leaves the stored ones alone.
      activeSkillIds: activeSkillIdsSchema.optional(),
    }),
    removeSession: z.object({ id: sessionIdSchema }),
    setActive: z.object({ id: sessionIdSchema.nullable() }),
  },

  actions: {
    addSession: (state, { id, title, providerId, model, lastRoot, activeSkillIds }) => {
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
          // An empty list is skipped for the same reason the absent key is the default everywhere else:
          // a record that names no skill and a record with no such key mean the same thing, and writing
          // the key would be a second spelling of it. A conversation the user chose skills for carries
          // them from its first row.
          ...(activeSkillIds !== undefined && activeSkillIds.length > 0 ? { activeSkillIds: [...activeSkillIds] } : {}),
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
    touchSession: (state, { id, title, providerId, model, lastRoot, activeSkillIds }) => {
      const index = state.sessions.findIndex((s) => s.id === id)
      if (index === -1) return
      state.sessions = sortByRecency(
        state.sessions.map((s, i) =>
          i === index
            ? {
                // The whole record is spread first, so a field this action says nothing about — the
                // skills among them — is carried through rather than dropped by a write about something
                // else. Every named field below is an override of that base, never a rebuild of it.
                ...s,
                updatedAt: Date.now(),
                ...(title !== undefined ? { title } : {}),
                ...(providerId !== undefined ? { providerId } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(lastRoot !== undefined ? { lastRoot } : {}),
                // Unlike the create above, an empty list is written: it is the user turning the last
                // skill off, and that is a change rather than the absence of one.
                ...(activeSkillIds !== undefined ? { activeSkillIds: [...activeSkillIds] } : {}),
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

    /**
     * Land a launch on the home screen: every conversation is there, and none of them is open.
     *
     * This pointer is persisted, so the state a launch starts from names whatever was open when the app
     * was last closed. Inheriting it is what kept the home screen from being what a launch shows: the
     * pane reads a pointer as "this conversation is open" and opens it — a conversation nobody asked
     * for, on the screen whose whole job is to ask.
     *
     * So a launch clears it. Main dispatches this the moment the store is readable and before any window
     * exists, which is also why no window is told that it happened.
     *
     * Only the pointer: what the last run left is what home and the conversation list offer back, and
     * that is a read of `sessions` rather than of this.
     *
     * Declares no payload, which is what makes it the one action conveyor needs no schema for.
     */
    landOnHome: (state) => {
      state.activeSessionId = null
    },
  },

  persist: true,
})
