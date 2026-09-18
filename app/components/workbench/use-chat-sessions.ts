import { useCallback, useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorActions, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { rehydrateTranscript, serializeTranscript, type TranscriptState } from './session-transcript'
import { resumeTurnNumbering } from './agent-session'
import { createDebouncedSave, isDirty, titleFromMessage, UNTITLED } from './session-rules'

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

  const [transcript, setTranscriptState] = useState<TranscriptState>({ turns: [], interrupted: false })
  const [error, setError] = useState<SessionError | null>(null)

  // Mirrors, so the save callback reads the latest values without being re-created — which is what
  // keeps the debounce timer from being thrown away on every render.
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript
  const activeIdRef = useRef(activeSessionId)
  activeIdRef.current = activeSessionId
  // The last snapshot written, for the dirty check. Null until a session is loaded.
  const savedRef = useRef<ReturnType<typeof serializeTranscript> | null>(null)

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
    savedRef.current = null
    setError(null)
    setTranscript({ turns: [], interrupted: false })
    return id
  }, [addSession, model, providerId, setActive, setTranscript])

  const load = useCallback(
    async (id: string) => {
      try {
        const snapshot = await conveyor.sessions.loadTranscript({ id })
        const next = rehydrateTranscript(snapshot)
        // Continue the reducer's numbering past the restored turns, or new turns would reuse ids
        // that are already in the transcript.
        resumeTurnNumbering(next.turns)
        savedRef.current = snapshot
        setError(null)
        setTranscript(next)
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
        setTranscript({ turns: [], interrupted: false })
      }
    },
    [setTranscript]
  )

  const openSession = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return
      // Save before leaving: switching away is exactly when unsaved turns would be lost.
      await saveNow()
      setActive({ id })
      activeIdRef.current = id
      await load(id)
    },
    [load, saveNow, setActive]
  )

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
        setTranscript({ turns: [], interrupted: false })
      }
    },
    [removeSession, setTranscript]
  )

  const ensureSession = useCallback(
    (firstMessage: string) => {
      const existing = activeIdRef.current
      if (existing) return existing
      const id = createSession()
      // The title is set here, once, and never again — later messages must not rename a session the
      // user has come to recognise.
      touchSession({ id, title: titleFromMessage(firstMessage) || UNTITLED })
      return id
    },
    [createSession, touchSession]
  )

  const maybeTitle = useCallback(
    (id: string, firstMessage: string) => {
      // Only the first message names a session, which is why this checks the current title rather
      // than being called unconditionally by the caller.
      const session = sessions.find((s) => s.id === id)
      if (!session || session.title !== UNTITLED) return
      touchSession({ id, title: titleFromMessage(firstMessage) || UNTITLED })
    },
    [sessions, touchSession]
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
