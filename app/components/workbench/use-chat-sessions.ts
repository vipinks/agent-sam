import { useCallback, useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorActions, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import {
  rehydrateTranscript,
  reconcileOrphanedPauses,
  serializeTranscript,
  type TranscriptState,
} from './session-transcript'
import { resumeTurnNumbering, type PendingCall } from './agent-session'
import { planRename } from './rename'
import { createDebouncedSave, isDirty, titleFromMessage, UNTITLED } from './session-rules'
import { planFirstSend, planResumeFinish, planResumeStart } from './session-resume'
import type { PlanStep } from '@/conveyor/protocol/plan'

/**
 * The coordination between the session list, the transcript on screen, and the file it is saved to.
 *
 * This is a hook rather than logic inside the panel because the three actions it exposes each have to
 * do more than one thing in a particular order — create then activate, save then switch, delete then
 * clear — and that ordering is the part worth reading in one place.
 *
 * Transcripts never enter the store: the store broadcasts to every window, and a transcript there
 * would be pushed over IPC once per token. The live transcript stays in component state; only its
 * metadata is in the store.
 */

/** A session whose transcript could not be read. Surfaced on its row, not only as a toast. */
export interface SessionError {
  id: string
  message: string
}

/**
 * What the agent is paused on, and everything needed to continue it.
 *
 * Owned here, beside the transcript, and not by the pane that is showing the card — which is the whole
 * point of the type living in this file. A consent pause is a question about one conversation, and the
 * pane is not the conversation: the workbench keys its resize groups on the window state, so a maximize
 * or a restore remounts every pane under them, and a pause held in a pane's own state would be answered
 * by a remount rather than by the user. The run behind a pause does not survive the pause either — the
 * stream ended and the decision starts a new one — so there is nothing in the pane to lose by keeping
 * the fact above it, and everything to lose by keeping it inside.
 *
 * Carries the session it belongs to, because a pause is a fact about a conversation: the user can
 * switch to another one while this is still waiting, and the decision has to still be here when they
 * come back rather than blocking a conversation it has nothing to do with.
 */
export interface PendingApproval {
  /** The conversation this pause was asked in. */
  sessionId: string
  turnId: string
  /** The one call this decision is about; the rest of `calls` are queued behind it. */
  callId: string
  tool: string
  /** The provider-shaped history the run handed over, echoed back untouched on resume. */
  messages: unknown[]
  /**
   * The frame's calls still awaiting a decision, this one first, as the model sent them. The decision
   * answers only the head; the loop presents the next one when this stream ends.
   */
  calls: PendingCall[]
  steps: number
  /**
   * Auto-continuations the turn had already spent when it paused, handed back like the plan.
   *
   * The budget belongs to the user's turn, not to one generator, so an approval must not refund it: a
   * turn that came back with a fresh count could continue itself past the cap on every permission the
   * model asked for.
   */
  continuations: number
  /**
   * The plan the turn had when it paused, handed back on the decision.
   *
   * The run behind a pause does not survive its stream ending, so the plan is the pane's to keep:
   * without it the resumed turn would come back with an empty plan and finish mid-plan in silence —
   * which is exactly the ending this notice exists to make sayable.
   */
  plan: PlanStep[]
}

export interface ChatSessions {
  /** The live transcript on screen. */
  transcript: TranscriptState
  /** Replaces the transcript, e.g. as a run streams. Marks it dirty. */
  setTranscript: (next: TranscriptState) => void
  /**
   * Whether this conversation runs tools without asking. Off for a session with no stored value, which
   * is every session whose user has never touched the toggle.
   */
  autoApprove: boolean
  /** Turn it on or off for the session on screen, and write the choice down. */
  setAutoApprove: (value: boolean) => void
  /** The session whose transcript failed to load. */
  error: SessionError | null
  /**
   * The session the on-screen transcript belongs to, or null before any has been read.
   *
   * Exposed because a fact about a conversation has to be attributable to a conversation: the pane
   * holds a consent pause per session, so it needs the id of the one it is showing rather than the
   * store's active id, which names a session that may never have been loaded.
   */
  openId: string | null
  /**
   * The consent pauses this process is holding, by the conversation each belongs to.
   *
   * A map rather than one slot: a pause is a question about one conversation, and the user may leave
   * it standing to work somewhere else. One slot would mean the second conversation's pause silently
   * replacing the first. Held here rather than in the pane for the reason on `PendingApproval`, and it
   * is also what the load path consults — a conversation whose pause is still held is loaded as it is,
   * while any other is loaded with the pauses this process did not survive reconciled.
   */
  pauses: Record<string, PendingApproval>
  /**
   * Record the pause a stream has just handed over.
   *
   * One call rather than two, because the map and the set of live conversations are the same fact: a
   * pause held here *is* a pause this process is still holding, and two writers could disagree.
   */
  holdPause: (approval: PendingApproval) => void
  /** Drop the pause of one conversation: the decision was made, or the conversation is gone. */
  clearPause: (id: string) => void
  createSession: () => string
  openSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** Create-on-first-message. Returns the id the message belongs to. */
  ensureSession: (firstMessage: string) => string
  /** Save now if there is anything to save. Used at turn boundaries and on blur. */
  saveNow: () => Promise<void>
  /** Queue the debounced post-turn save. */
  scheduleSave: () => void
  /** Rename a session from its first user message, once. */
  maybeTitle: (id: string, firstMessage: string) => void
  /** Rename a session to a title the user typed. Blank and unchanged titles are refused. */
  renameSession: (id: string, title: string) => void
}

export function useChatSessions(providerId: string, model: string): ChatSessions {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)

  // The last snapshot written for the on-screen transcript, for the dirty check. Null until a
  // session is loaded.
  const savedRef = useRef<ReturnType<typeof serializeTranscript> | null>(null)

  const [transcript, setTranscriptState] = useState<TranscriptState>({ turns: [], interrupted: false })
  const [error, setError] = useState<SessionError | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  /**
   * The conversations whose consent pause this process is still holding, and what each is paused on.
   *
   * One store rather than two — a ref for the load path and a copy of the decision for the pane — because
   * they are the same fact: a conversation is in this map exactly when its pause is live, and the map's
   * own contents are what a load reads. The ref is the truth and the state is its render-facing mirror,
   * so a caller cannot leave one updated and the other behind.
   *
   * A ref as well as state because the load path asks the question synchronously, in the middle of an
   * async load, where a value read from state would be a render behind.
   */
  const pausesRef = useRef<Record<string, PendingApproval>>({})
  const [pauses, setPauses] = useState<Record<string, PendingApproval>>({})

  const holdPause = useCallback((approval: PendingApproval) => {
    pausesRef.current = { ...pausesRef.current, [approval.sessionId]: approval }
    setPauses(pausesRef.current)
  }, [])

  const clearPause = useCallback((id: string) => {
    if (pausesRef.current[id] === undefined) return
    const rest = { ...pausesRef.current }
    delete rest[id]
    pausesRef.current = rest
    setPauses(rest)
  }, [])

  // Mirrors, so the save callback reads the latest values without being re-created — which is what
  // keeps the debounce timer from being thrown away on every render.
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript
  const activeIdRef = useRef(activeSessionId)
  activeIdRef.current = activeSessionId
  // The session the on-screen transcript belongs to — which is NOT the store's `activeSessionId`.
  // The store persists the active id, so after a restart it names a session whose transcript has
  // never been read into memory. Keeping the two separate is what lets a click load it; treating
  // them as one is what made a click on the restored session do nothing.
  // The session list, read through a ref so the callbacks that need the current titles keep a
  // stable identity — they are mostly invoked from event handlers that must not re-create a stream.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const hydratedIdRef = useRef<string | null>(null)

  const setTranscript = useCallback((next: TranscriptState) => {
    transcriptRef.current = next
    setTranscriptState(next)
  }, [])

  /**
   * Write the active transcript, if it has changed.
   *
   * Guarded three ways: no session, nothing written yet, or not actually different. That is what
   * keeps a save from being a disk write per keystroke — the cadence decision is the caller's, but
   * this is the backstop.
   */
  const saveNow = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    const snapshot = serializeTranscript(transcriptRef.current)
    // An empty conversation is never written: a session the user created and left is not a session with a
    // transcript. The exception is the one `isDirty` names — a session whose user turned auto-approve on
    // has a choice to remember even before it has a message.
    if (snapshot.turns.length === 0 && snapshot.autoApprove !== true) return
    if (savedRef.current && !isDirty(transcriptRef.current, savedRef.current)) return

    try {
      await conveyor.sessions.saveTranscript({ id, snapshot })
      savedRef.current = snapshot
    } catch {
      // A failed save must not interrupt the conversation. The next turn boundary tries again, and
      // the transcript is still on screen.
    }
  }, [])

  const debounced = useRef(createDebouncedSave(() => void saveNow()))
  useEffect(() => {
    debounced.current = createDebouncedSave(() => void saveNow())
  }, [saveNow])

  /** Queue the post-turn save. */
  const scheduleSave = useCallback(() => {
    debounced.current.schedule()
  }, [])

  // The session's consent setting, read off the transcript on screen: the record owns it, so the live
  // state is only ever a copy of what was loaded or of what the user has just set.
  const autoApprove = transcript.autoApprove === true

  /**
   * Write the consent setting onto the conversation.
   *
   * Saved the moment it changes rather than at the next turn boundary: the toggle is a deliberate act
   * with no run behind it to wait for, and a session the user toggled and then left would otherwise
   * carry no record of the choice until its next message. The save is guarded by `isDirty`, so turning
   * the toggle to where it already was costs nothing.
   */
  const setAutoApprove = useCallback(
    (value: boolean) => {
      setTranscript({ ...transcriptRef.current, autoApprove: value })
      void saveNow()
    },
    [saveNow, setTranscript]
  )

  // Best-effort saves on the two ways a window can go away. Neither is guaranteed to complete, which
  // is why the debounced save exists as the primary path — these only narrow the window.
  useEffect(() => {
    const onBlur = () => void saveNow()
    const onBeforeUnload = () => void saveNow()
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [saveNow])

  const addSession = useConveyorActions(chatSessionsStore).addSession
  const setActive = useConveyorActions(chatSessionsStore).setActive
  const touchSession = useConveyorActions(chatSessionsStore).touchSession
  const removeSession = useConveyorActions(chatSessionsStore).removeSession

  const createSession = useCallback(() => {
    // `crypto.randomUUID` in the renderer is fine for an id: it only has to be unique and safe as a
    // filename, and the module validates the shape again before it touches the disk.
    const id = crypto.randomUUID()
    addSession({ id, title: UNTITLED, providerId, model })
    setActive({ id })
    activeIdRef.current = id
    savedRef.current = null
    setError(null)
    // A new session is hydrated by definition: it starts empty and that empty transcript belongs to
    // it. Leaving this unset would let a click on the new row try to load a file that cannot exist.
    hydratedIdRef.current = id
    setOpenId(id)
    setTranscript({ turns: [], interrupted: false })
    return id
  }, [addSession, model, providerId, setActive, setTranscript])

  /**
   * Apply a plan's transcript: set it, and remember which session it belongs to.
   *
   * `hydratedIdRef` is the load-bearing part. It is what distinguishes "this session is on screen"
   * from "this session is the active one in the store", and without it a restored-but-unloaded
   * session can never be loaded.
   */
  const applyTranscript = useCallback(
    (id: string, next: TranscriptState) => {
      // Continue the reducer's numbering past the restored turns, or new turns would reuse ids that
      // are already in the transcript.
      resumeTurnNumbering(next.turns)
      hydratedIdRef.current = id
      setOpenId(id)
      setTranscript(next)
    },
    [setTranscript]
  )

  const load = useCallback(
    async (id: string) => {
      try {
        const snapshot = await conveyor.sessions.loadTranscript({ id })
        savedRef.current = snapshot
        setError(null)
        // A pause is a question about now, and the run that asked it is not in this process unless this
        // layer is still holding it. Reconciling the rest is what turns two dead ends — a card whose
        // buttons do nothing, and a turn that is neither running nor ended — into a named ending the
        // transcript can state.
        const loaded = rehydrateTranscript(snapshot)
        applyTranscript(id, pausesRef.current[id] ? loaded : reconcileOrphanedPauses(loaded))
      } catch (err) {
        // Branched on the code, never the message text.
        const corrupt = err instanceof ConveyorError && err.code === 'SESSION_CORRUPT'
        setError({
          id,
          message: corrupt
            ? 'This conversation could not be read, so it was left as it is on disk.'
            : 'This conversation could not be opened.',
        })
        // The row still opens, empty, so the user has somewhere to go from here.
        savedRef.current = null
        applyTranscript(id, { turns: [], interrupted: false })
      }
    },
    [applyTranscript]
  )

  const openSession = useCallback(
    async (id: string) => {
      // The whole click decision, made by the pure function rather than reimplemented here. The
      // load-bearing part is that it tests `hydratedId`, not the store's active id: a session
      // restored from a previous run is active with an empty transcript, and clicking it must load.
      const start = planResumeStart({
        requestedId: id,
        hydratedId: hydratedIdRef.current,
        transcript: transcriptRef.current,
        savedSnapshot: savedRef.current,
      })
      if (start.alreadyShowing) return

      if (start.saveFirst) await saveNow()
      setActive({ id })
      activeIdRef.current = id
      await load(id)

      // The other half of the plan: what the loaded session becomes, including the self-heal for a
      // row stored before titles were applied.
      const session = sessionsRef.current.find((s) => s.id === id)
      const finish = planResumeFinish({
        // Just read, so the stored one is authoritative for this decision.
        loaded: savedRef.current,
        metadataTitle: session?.title ?? UNTITLED,
      })
      if (finish.repairTitle) touchSession({ id, title: finish.repairTitle })
    },
    [load, saveNow, setActive, touchSession]
  )

  /**
   * Restore the session the store says is active, once, on startup.
   *
   * The store persists `activeSessionId`, so after a restart the app knows which conversation was
   * open but holds no transcript for it — the pane would sit on its empty state until the user
   * clicked the row that is already highlighted. This runs the same load the click path uses, so
   * both routes hydrate identically.
   *
   * Declared after `load` because it calls it, and guarded so it fires once: a later store change
   * must not hydrate over turns the user has since typed.
   */
  const hydratedOnceRef = useRef(false)
  useEffect(() => {
    if (hydratedOnceRef.current || !activeSessionId) return
    hydratedOnceRef.current = true
    void load(activeSessionId)
  }, [activeSessionId, load])

  const deleteSession = useCallback(
    async (id: string) => {
      removeSession({ id })
      try {
        await conveyor.sessions.deleteTranscript({ id })
      } catch {
        // The metadata is already gone, so a failure here leaves an orphaned file rather than a
        // broken list. Reported through the row only if the user reopens it.
      }
      // Deleting the open session leaves nothing to look at, so the panel returns to the empty
      // state rather than showing a transcript that no longer has metadata behind it.
      if (activeIdRef.current === id) {
        savedRef.current = null
        setError(null)
        hydratedIdRef.current = null
        setOpenId(null)
        clearPause(id)
        setTranscript({ turns: [], interrupted: false })
      }
    },
    [clearPause, removeSession, setTranscript]
  )

  /**
   * The session a message belongs to, created and named if it does not exist yet.
   *
   * Both halves of the naming decision come from `planFirstSend`: whether to create, and whether this
   * message is the one that names the session. Returning early on an existing id — which is what the
   * Phase 7 code did — is what left every persisted row called "Untitled conversation", because a
   * session restored from a previous run has an id from the moment the app starts.
   */
  const ensureSession = useCallback(
    (firstMessage: string) => {
      const activeId = activeIdRef.current
      const activeTitle = sessionsRef.current.find((s) => s.id === activeId)?.title ?? null

      const plan = planFirstSend({
        activeId,
        activeTitle,
        message: firstMessage,
        isHydrated: hydratedIdRef.current === activeId,
      })

      if (!plan.create) {
        // An existing session: named here only if it is still untitled, which can only happen once.
        if (plan.title && activeId) touchSession({ id: activeId, title: plan.title })
        return activeId as string
      }

      const id = createSession()
      if (plan.title) touchSession({ id, title: plan.title })
      return id
    },
    [createSession, touchSession]
  )

  /**
   * Name a session from its first message, if it is still untitled.
   *
   * Kept as a separate entry point for callers that know they are holding a first message; it reads
   * the current title rather than being called unconditionally.
   */
  const maybeTitle = useCallback(
    (id: string, firstMessage: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (!session || session.title !== UNTITLED) return
      touchSession({ id, title: titleFromMessage(firstMessage) || UNTITLED })
    },
    [touchSession]
  )

  /**
   * Rename a session to a title the user typed.
   *
   * Deliberately not sharing `maybeTitle`'s "only while untitled" guard: an explicit rename is the
   * user overriding both the derived name and any earlier one, so the only refusals are a blank
   * submission and a no-op one. The decision itself is the pure rule, so a blank title cannot become
   * a store write just because this was called from a blur handler rather than a keypress.
   */
  const renameSession = useCallback(
    (id: string, title: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (!session) return
      const plan = planRename(session.title, title)
      if (plan) touchSession({ id, title: plan.title })
    },
    [touchSession]
  )

  return {
    transcript,
    setTranscript,
    autoApprove,
    setAutoApprove,
    error,
    openId,
    pauses,
    holdPause,
    clearPause,
    createSession,
    openSession,
    deleteSession,
    ensureSession,
    saveNow,
    scheduleSave,
    maybeTitle,
    renameSession,
  }
}
