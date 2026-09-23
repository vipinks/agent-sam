import { useCallback, useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorActions, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { workspaceStore } from '@/conveyor/stores/workspace'
import {
  rehydrateTranscript,
  reconcileOrphanedPauses,
  serializeTranscript,
  type TranscriptState,
} from './session-transcript'
import { resumeTurnNumbering, type AgentTurn, type PendingCall } from './agent-session'
import { planRename } from './rename'
import { createDebouncedSave, isDirty, titleFromMessage, UNTITLED } from './session-rules'
import { planFirstSend, planResumeFinish, planResumeStart } from './session-resume'
import { planRootStamp, planSelectRoot, planSessionSwitch, selectNotice } from './session-project'
import { useWorkbenchStore } from './store'
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
 *
 * A conversation knows the folder it was last used in, and this layer is what acts on that: a click
 * opens that folder before the session renders, an unstamped session leaves the window alone, and a
 * turn start records where the turn ran. It also owns the two facts a click has to be refused against
 * — a turn streaming, and a decision pending. Where the folder itself lives is the workspace store's
 * business, and it is global rather than per-window: every window browses the same folder.
 */

/**
 * Close the file the viewer is holding, because the folder it belonged to just stopped being open.
 *
 * The same act the explorer's own switch performs, and for the same reason: a path from the previous
 * root is now outside the workspace the tree, the git panel and the viewer are all pointed at.
 *
 * Only when the buffer is clean. An unsaved edit is the user's work, and a click on a conversation is
 * not a decision to throw it away — the confirmation in front of that belongs to the pane that can ask
 * for it, which is not this one.
 */
function releaseViewer(): void {
  const workbench = useWorkbenchStore.getState()
  if (workbench.editor.dirty) return
  workbench.setSelectedFile(null)
  workbench.setSelectedChange(null)
  workbench.setEditorDirty(null, false)
}

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

/**
 * What the composer is holding but has not sent.
 *
 * One object rather than several fields on the session state, because these are one thing from the
 * user's side — the message they are in the middle of writing, with the files they attached to it and
 * the height they gave the box — and a remount restores or loses them together.
 */
export interface ComposerState {
  /**
   * The text in the box.
   *
   * Not keyed by session, and not cleared by a session switch: a draft is the user's unfinished thought
   * rather than part of any conversation, and that is how it behaved before this moved.
   */
  text: string
  /** The files the next send will attach. */
  mentionPaths: string[]
  /** Why the last attach attempt was refused, or null. Cleared by the next one. */
  mentionNote: string | null
  /**
   * The height the user dragged the composer to, per session key.
   *
   * Not persisted, deliberately: the height a user dragged to is a fact about this window's layout
   * rather than about the conversation, and a transcript carrying it would store something no reader of
   * that record has a use for. Per session because one long message should not leave every other
   * conversation's composer stretched.
   */
  heights: Record<string, number>
}

/** The composer as it opens: nothing typed, nothing attached, every session at the default height. */
function emptyComposer(): ComposerState {
  return { text: '', mentionPaths: [], mentionNote: null, heights: {} }
}

export interface ChatSessions {
  /** The live transcript on screen. */
  transcript: TranscriptState
  /**
   * Replace the turns, keeping everything about the conversation the pane does not own.
   *
   * The narrow writer, and deliberately the only one the pane has. A run rewrites the transcript on
   * every chunk, and a pane holding a whole-record setter can name only the fields it happens to know:
   * the consent setting is set by the toggle and touched by no chunk, so the first write of a turn
   * dropped it, the toggle read off on the next render, and the file was saved without the key — which
   * the next read resolves to off. Narrowing is the fix rather than a reminder to spread, because a
   * caller cannot drop what it was never handed.
   */
  setTurns: (turns: AgentTurn[]) => void
  /**
   * The composer's in-progress state: what the user has typed and not sent, and what goes with it.
   *
   * Held here for the same reason the consent pause is: the workbench keys its resize groups on the
   * window state, so a maximize or a restore remounts every pane under them — and a draft held in the
   * pane was deleted by the swap. The pane is not the conversation, and a half-written message is
   * exactly as much the user's as an unanswered question is.
   */
  composer: ComposerState
  /** Merge a change into the composer state. */
  setComposer: (patch: Partial<ComposerState>) => void
  /**
   * Whether this conversation runs tools without asking. Off for a session with no stored value, which
   * is every session whose user has never touched the toggle.
   */
  autoApprove: boolean
  /** Turn it on or off for the session on screen, and write the choice down. */
  setAutoApprove: (value: boolean) => void
  /**
   * Whether a turn is streaming in this window.
   *
   * Held here rather than in the pane that runs it, because it is the fact a session click is refused
   * against: the run is writing into the transcript on screen, so opening another conversation
   * mid-stream would hand it the rest of an answer it was never about. It also survives a remount,
   * which the pane's own state did not — the workbench keys its groups on the window state, so a
   * maximize used to reset a flag about a run that was still going.
   */
  streaming: boolean
  /** Record that a turn started or ended in this window. */
  setStreaming: (streaming: boolean) => void
  /**
   * Note that a turn is starting in a session, and stamp it with the folder the turn runs in.
   *
   * Called at every turn start: the project follows the work, so a conversation picked up in another
   * folder is stamped there rather than keeping a folder the user has moved on from. A stamp equal to
   * the one already stored writes nothing.
   */
  stampRoot: (id: string) => void
  /**
   * Why the last selection did not happen, worded from its code, or null.
   *
   * Kept here rather than in the row that was clicked, and cleared by the next attempt: what a click
   * could not do is a fact about the selection, and the list that offered it is where the user is
   * looking.
   */
  notice: string | null
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
  // The folder this window is showing, from the store main owns — the same one the explorer, the tree
  // and the agent's tool paths are all answered against. A session's project is compared with it at a
  // click and recorded from it at a turn start.
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)

  // The last snapshot written for the on-screen transcript, for the dirty check. Null until a
  // session is loaded.
  const savedRef = useRef<ReturnType<typeof serializeTranscript> | null>(null)

  const [transcript, setTranscriptState] = useState<TranscriptState>({ turns: [], interrupted: false })
  const [error, setError] = useState<SessionError | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  /**
   * The composer's in-progress state, and the ref behind it.
   *
   * The same two-store shape as the pauses below, and for the same reason: the mirror is what a handler
   * that writes twice in one event reads back — the picker committing a path and then removing the
   * token it came from — and the state is what the render reads. Nothing here is serialised; it is a
   * fact about this window, held where a window-state swap cannot reach it.
   */
  const composerRef = useRef<ComposerState>(emptyComposer())
  const [composer, setComposerState] = useState<ComposerState>(emptyComposer)

  const setComposer = useCallback((patch: Partial<ComposerState>) => {
    const next = { ...composerRef.current, ...patch }
    composerRef.current = next
    setComposerState(next)
  }, [])

  /**
   * Whether a turn is streaming in this window, and the ref the click path reads.
   *
   * The same two-store shape as the composer above and the pauses below: the ref is what a decision
   * made mid-event reads back, the state is what the render sees. Nothing serialises it — it is a fact
   * about this window's right now, and it lives above the pane deliberately, so a window-state swap
   * cannot reset a flag about a run that is still going.
   */
  const streamingRef = useRef(false)
  const [streaming, setStreamingState] = useState(false)

  const setStreaming = useCallback((value: boolean) => {
    streamingRef.current = value
    setStreamingState(value)
  }, [])

  /**
   * Why the last selection did not happen, in the words the list shows.
   *
   * A sentence rather than a code: the code was branched on where the decision was made — this side's
   * own two, or main's `WORKSPACE_MISSING` — and what the panel needs from here is what to say.
   */
  const [notice, setNotice] = useState<string | null>(null)

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
  // The folder this window is showing, mirrored for the callbacks below: a click and a turn start both
  // read it, and both have to keep a stable identity or a switch would re-create the run's handlers.
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  const setTranscript = useCallback((next: TranscriptState) => {
    transcriptRef.current = next
    setTranscriptState(next)
  }, [])

  /**
   * Replace the turns, and nothing else.
   *
   * Spread rather than rebuilt, so every field the pane does not name — the consent setting above all —
   * is carried through by construction. `interrupted: false` is the one thing set beyond the turns: a
   * run is writing turns, so a flag left over from a previous load must not survive turns produced
   * after it.
   */
  const setTurns = useCallback((turns: AgentTurn[]) => {
    const next: TranscriptState = { ...transcriptRef.current, turns, interrupted: false }
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
  // The one write a session-driven switch makes: main checks the folder is still there, and this puts
  // the answer where every panel reads it.
  const setRootPath = useConveyorStore(workspaceStore).setRootPath

  /**
   * Record the folder a turn is starting in.
   *
   * Read from the mirror rather than assumed, because a stamp is a comparison with what the store
   * already holds and the comparison belongs to `planRootStamp`. A session the store has not broadcast
   * back yet — one created by this very send — is skipped rather than guessed at: its stamp would be
   * this same folder anyway, and its next turn writes it.
   */
  const stampRoot = useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (!session) return
      const next = planRootStamp({ sessionLastRoot: session.lastRoot, windowRoot: rootPathRef.current })
      if (next !== null) touchSession({ id, lastRoot: next })
    },
    [touchSession]
  )

  const createSession = useCallback(() => {
    // `crypto.randomUUID` in the renderer is fine for an id: it only has to be unique and safe as a
    // filename, and the module validates the shape again before it touches the disk.
    const id = crypto.randomUUID()
    addSession({ id, title: UNTITLED, providerId, model })
    setActive({ id })
    activeIdRef.current = id
    savedRef.current = null
    setError(null)
    setNotice(null)
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

      // Which folder this click belongs in, and whether it may happen at all. Both answers are the pure
      // rules'; this only carries out what they decided. A session with no project resolves to no
      // switch, which is the silent case: its first turn is what gives it one.
      const row = sessionsRef.current.find((s) => s.id === id)
      const project = planSelectRoot({ sessionLastRoot: row?.lastRoot, currentRoot: rootPathRef.current })
      setNotice(null)

      const refusal = planSessionSwitch({
        streaming: streamingRef.current,
        // A pause held anywhere in this window, not only in the conversation being opened: the turn it
        // belongs to has not ended, and what is refused is moving the workspace under it.
        pendingDecision: Object.keys(pausesRef.current).length > 0,
        movesRoot: project.switchTo !== null,
      })
      if (refusal !== null) {
        setNotice(
          selectNotice(refusal, {
            path: project.switchTo ?? rootPathRef.current ?? '',
            currentRoot: rootPathRef.current,
          })
        )
        return
      }

      // The folder moves before the session renders: the tree, the git reads and the agent's tool paths
      // are all answered against whatever the workspace store holds, so the transcript must not arrive
      // first and be read against the wrong one.
      //
      // A folder that is gone is reported and the window stays where it is. The conversation still
      // opens, because the click was about the conversation — the notice explains that its project is
      // missing, not that the click failed.
      if (project.switchTo !== null) {
        const target = project.switchTo
        try {
          const opened = await conveyor.workspace.openRoot({ path: target })
          setRootPath(opened.path)
          releaseViewer()
        } catch (err) {
          // Branched on the code, never on the message text.
          const code = err instanceof ConveyorError ? err.code : 'UNKNOWN'
          setNotice(selectNotice(code, { path: target, currentRoot: rootPathRef.current }))
        }
      }

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
    [load, saveNow, setActive, setRootPath, touchSession]
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
    setTurns,
    composer,
    setComposer,
    autoApprove,
    setAutoApprove,
    streaming,
    setStreaming,
    stampRoot,
    notice,
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
