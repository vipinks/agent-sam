import { useCallback, useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorActions, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { rehydrateTranscript, serializeTranscript, type TranscriptState } from './session-transcript'
import { resumeTurnNumbering } from './agent-session'
import { createDebouncedSave, isDirty, titleFromMessage, UNTITLED } from './session-rules'
import { planFirstSend, planResumeFinish, planResumeStart } from './session-resume'

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

export interface ChatSessions {
  /** The live transcript on screen. */
  transcript: TranscriptState
  /** Replaces the transcript, e.g. as a run streams. Marks it dirty. */
  setTranscript: (next: TranscriptState) => void
  /** The session whose transcript failed to load. */
  error: SessionError | null
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
}

export function useChatSessions(providerId: string, model: string): ChatSessions {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)

  // The last snapshot written for the on-screen transcript, for the dirty check. Null until a
  // session is loaded.
  const savedRef = useRef<ReturnType<typeof serializeTranscript> | null>(null)

  const [transcript, setTranscriptState] = useState<TranscriptState>({ turns: [], interrupted: false })
  const [error, setError] = useState<SessionError | null>(null)

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
    // An empty conversation is never written: a session the user created and left is not a session
    // with a transcript.
    if (snapshot.turns.length === 0) return
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
        applyTranscript(id, rehydrateTranscript(snapshot))
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
        setTranscript({ turns: [], interrupted: false })
      }
    },
    [removeSession, setTranscript]
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

  return {
    transcript,
    setTranscript,
    error,
    createSession,
    openSession,
    deleteSession,
    ensureSession,
    saveNow,
    scheduleSave,
    maybeTitle,
  }
}
