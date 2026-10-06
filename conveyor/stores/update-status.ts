import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import { UPDATE_ERROR_CODES, type UpdateErrorCode, type UpdateState } from '../protocol/updates'

/**
 * What the updater is doing, mirrored to every window.
 *
 * Deliberately **not persisted**, and it is the only store in this app that is not. Every other store holds
 * something a user chose and expects back tomorrow; this one holds a fact about the running process — a check
 * that is in flight, a download that has been fetched, a version this build has — and a copy of that restored
 * from a file written before the last quit would be a status line describing an update that no longer exists
 * in this process. The store starts where every launch starts, at `idle`, and the module writes the truth as
 * electron-updater reports it.
 *
 * The fields are the module's own report and nothing more: the state, the version an update would install,
 * the version this build is, when a check last completed, and the code a failure carries. No message travels
 * with the code — that is the rule's subject, and `protocol/updates` is where a code becomes a word.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it and
 * dispatches the transitions, the renderer mirrors it through `useConveyorStore`. The ids of the states and
 * codes come from `protocol/updates`, so the store cannot hold a state the rule has no word for.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that cannot
// name the state type fails to emit (TS4023).
export interface UpdateStatusState {
  /** Which of the seven states the updater is in. */
  state: UpdateState
  /** The version a found update would install, or null when none is known. */
  availableVersion: string | null
  /** The version of the running build, read from `app.getVersion()` when the updater is wired. */
  currentVersion: string
  /** Epoch ms of the last check that completed — found, up to date, or failed. Null before the first one. */
  lastCheckedAt: number | null
  /** The code a failure carries, or null while nothing has failed. Never a message. */
  errorCode: UpdateErrorCode | null
}

export const updateStatusStore = defineStore('update-status', {
  state: {
    state: 'idle',
    availableVersion: null,
    currentVersion: '',
    lastCheckedAt: null,
    errorCode: null,
  } as UpdateStatusState,

  // Payloads cross the trust boundary, so each action's argument type comes from its schema: a state the rule
  // has no word for and a code the rule cannot word are both refused here rather than stored.
  schemas: {
    setCurrentVersion: z.object({ version: z.string() }),
    recordAvailable: z.object({ version: z.string(), at: z.number() }),
    recordUpToDate: z.object({ at: z.number() }),
    recordReady: z.object({ version: z.string() }),
    recordError: z.object({ code: z.enum(UPDATE_ERROR_CODES) }),
  },

  actions: {
    /**
     * Record which build is running.
     *
     * Dispatched once, when the updater is wired, so a surface can say what it is updating *from* before any
     * check has run — which is the state the app spends most of its life in.
     */
    setCurrentVersion: (state, { version }) => {
      state.currentVersion = version
    },

    /** A check has started. Offered by no state a check could be asked for, which is what stops a second one. */
    startChecking: (state) => {
      state.state = 'checking'
      state.errorCode = null
    },

    /**
     * A check found a newer version.
     *
     * `lastCheckedAt` is recorded here rather than when the check started, because the timestamp answers "when
     * did this build last hear from the feed" — a check still in flight has not heard anything yet.
     */
    recordAvailable: (state, { version, at }) => {
      state.state = 'available'
      state.availableVersion = version
      state.lastCheckedAt = at
      state.errorCode = null
    },

    /** A check came back and this build is the newest published one. */
    recordUpToDate: (state, { at }) => {
      state.state = 'up-to-date'
      state.lastCheckedAt = at
      state.errorCode = null
    },

    /**
     * The update's bytes are being fetched.
     *
     * Entered from `available` on the updater's first progress event: with auto-download on there is no event
     * that announces a download *started*, and progress is the first evidence one is underway.
     */
    startDownloading: (state) => {
      state.state = 'downloading'
    },

    /**
     * The update is downloaded and installs when the app quits.
     *
     * `lastCheckedAt` is left as it stands: the download completing is not a check, and the timestamp would
     * then answer a question nobody asked it.
     */
    recordReady: (state, { version }) => {
      state.state = 'ready'
      state.availableVersion = version
      state.errorCode = null
    },

    /**
     * Something failed, and the code says what — a sentence from the updater's own Error never arrives here.
     *
     * The version already found is kept when there is one: a download that failed still says which update the
     * user was trying to get, and clearing it would make the retry a mystery.
     */
    recordError: (state, { code }) => {
      state.state = 'error'
      state.errorCode = code
    },
  },
})
