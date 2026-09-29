import { useCallback, useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorActions, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { buddiesStore } from '@/conveyor/stores/buddies'
import { workspaceStore } from '@/conveyor/stores/workspace'
import {
  rehydrateTranscript,
  reconcileOrphanedPauses,
  serializeTranscript,
  type TranscriptState,
} from './session-transcript'
import { resumeTurnNumbering, type AgentTurn, type PendingCall } from './agent-session'
import type { DraftAttachment } from './attachments'
import { planRename } from './rename'
import { createDebouncedSave, isDirty, titleFromMessage, UNTITLED } from './session-rules'
import { planFirstSend, planResumeFinish, planResumeStart } from './session-resume'
import { planRootStamp, planSelectRoot, planSessionSwitch, selectNotice } from './session-project'
import { useWorkbenchStore } from './store'
import type { PlanStep } from '@/conveyor/protocol/plan'
import { applySkillToggle } from '@/conveyor/protocol/skills'
import { buddySessionSeed, readBuddySession, resolveBuddy } from '@/conveyor/protocol/buddies'

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
 * Only when the buffer is clean. An unsaved edit is the user's work, and a click on a conversation — or
 * a folder chosen from the home screen — is not a decision to throw it away: the confirmation in front
 * of that belongs to the pane that can ask for it, which is not this one.
 */
export function releaseViewer(): void {
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
   * The images the next send will attach, in the order they were taken.
   *
   * Beside the draft text and above the pane, for the same reason the text is: a maximize or a restore
   * remounts the chat pane, and a screenshot the user had chosen is exactly as much theirs as a sentence
   * they had half written. Held as bytes in memory and nowhere else — nothing is written until the send,
   * so an abandoned draft leaves nothing behind, and the array is lost with the window.
   */
  images: DraftAttachment[]
  /**
   * Why the last image attempt was refused, or null. Cleared by the next one.
   *
   * Its own field rather than shared with `mentionNote`, because the two are answers to two different
   * gestures: attaching a file and pasting a screenshot write different sentences, and a note that both
   * wrote would be replaced by whichever came second for reasons the user could not see.
   */
  attachmentNote: string | null
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
  return { text: '', mentionPaths: [], mentionNote: null, images: [], attachmentNote: null, heights: {} }
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
   * The skills the conversation on screen runs with, by id, in the order they were turned on.
   *
   * The record's own list when a conversation is open — the record is the source of truth, so a
   * conversation reopened tomorrow opens with the skills it was working from — and the composer's own
   * pending choice on the home screen, where there is no record yet to hold it. That pending choice is
   * written onto the conversation the first message creates, which is what keeps a skill a property of
   * the conversation rather than of the window: the next conversation starts from none.
   */
  activeSkillIds: string[]
  /**
   * The role the conversation on screen was created as, snapshotted on its record then, or null.
   *
   * Read off the record rather than resolved again from the Buddy's id, because the snapshot is what the
   * conversation runs as: a Buddy edited after the fact must not change what a conversation already
   * running as it was set up to do. Null on the home screen, where there is no conversation to run as
   * anything, and null for every conversation created before Buddies existed — which is the case that
   * must keep sending exactly what it always sent.
   */
  buddyRolePrompt: string | null
  /**
   * The MCP servers the conversation on screen was created limited to, or null for no limit.
   *
   * Handed to the send as it stands, and intersected with the running servers there: this is what the
   * conversation was restricted to, not what it may reach, and the difference is the whole safety
   * property of the feature. Null is the SamAi case and means the full trusted set, exactly as before.
   */
  buddyMcpSubset: string[] | null
  /**
   * The Buddy the conversation on screen was created as, or null for the SamAi default and at home.
   *
   * The id rather than a name, because the one rule that knows what an id is *called* is `buddyLabel`:
   * an id that resolves to nothing is a removed Buddy there, and a name spelled here would be a second
   * answer to that. Read off the record rather than resolved again, for the reason the two snapshots
   * above are — a Buddy edited since must not change what this conversation already runs as.
   */
  buddyId: string | null
  /**
   * The Buddy chosen on the home screen, or null while the default is what the next conversation runs as.
   *
   * Held here, above the pane, for the same reason the composer's draft and the pending skill chips are:
   * the workbench keys its resize groups on the window state, and a choice held in the pane would be
   * dropped by a maximize. It is not a second copy of a conversation's Buddy — the record is the source
   * of truth once one exists — only the answer to which Buddy the first message creates, which is why
   * the create is the one thing that reads it.
   */
  pendingBuddyId: string | null
  /**
   * Choose the Buddy the next conversation is created as.
   *
   * `null` is the SamAi default rather than a third state: a conversation that names nobody runs as the
   * app does, so there is no difference to draw between "SamAi" and "nothing chosen", and storing one
   * would make the create below carry a key that says what its own absence already says.
   */
  setPendingBuddyId: (buddyId: string | null) => void
  /**
   * Turn one skill on or off for the conversation in front of the user.
   *
   * A toggle rather than a setter, because the control is a list of switches and the number that
   * decides the outcome — how many are already on — belongs in one place rather than in every caller.
   * At the cap the choice is refused and both the record and the screen are left exactly as they were:
   * a fourth skill cannot be half-on.
   */
  toggleSkill: (id: string) => void
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
  /**
   * Whether the pane is showing the home screen rather than a conversation.
   *
   * Two facts, and both are needed. There is no active session — nothing is open in this window, which
   * is what home *is* — and nothing has been loaded into the pane either, because the store broadcast
   * that names a new conversation arrives a round trip after the send that created it. Reading only
   * the store would leave the first message of a conversation sitting on a welcome screen until main
   * answered; reading only the pane would flash the welcome screen on every launch that resumes a
   * conversation. Together they say the thing both are trying to: nothing is being worked on here.
   */
  atHome: boolean
  /**
   * Put the pane back on the home screen, creating nothing.
   *
   * The create path is the first message, and this is the other half of that decision: a new chat is
   * not a conversation until there are words in it, so the control that asks for one only clears the
   * window. That is also what retires the empty row every new-session click used to leave in the list
   * — the transcript that made it a conversation never arrives, so neither does the row.
   *
   * The composer is deliberately left alone: a half-written message is the user's, and moving to a
   * blank window is not a reason to delete it. The approval chip is reset with the transcript, because
   * its value is the one the next conversation will be created with, and "off" is what a choice that
   * has not been made means.
   */
  goHome: () => void
  createSession: (buddyId?: string | null) => string
  openSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** Create-on-first-message. Returns the id the message belongs to. */
  ensureSession: (firstMessage: string, buddyId?: string | null) => string
  /** Save now if there is anything to save. Used at turn boundaries and on blur. */
  saveNow: () => Promise<void>
  /** Queue the debounced post-turn save. */
  scheduleSave: () => void
  /** Rename a session from its first user message, once. */
  maybeTitle: (id: string, firstMessage: string) => void
  /** Rename a session to a title the user typed. Blank and unchanged titles are refused. */
  renameSession: (id: string, title: string) => void
  /**
   * Record what one reply cost, against the conversation it belongs to.
   *
   * Counters rather than a total, because the addition belongs to main's reducer: this layer only
   * carries the report across, and the id is chosen by the caller because the stream that produced the
   * numbers knows which conversation it was started for — see `runStream`'s `sessionId`, which is read
   * when the turn begins rather than when the usage frame arrives.
   */
  recordUsage: (id: string, counters: { prompt: number; completion: number; cached?: number }) => void
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
   * Whether the pane is on the home screen. Read as the state it is: the store's pointer names no
   * conversation, and the pane is not showing one either — which differ only in the round trip after a
   * send creates one. See the interface for why both halves are read.
   */
  const atHome = activeSessionId === null && openId === null

  /**
   * The skills chosen before there was a conversation to choose them for.
   *
   * Held here, above the pane, for the same reason the composer's draft is: the workbench keys its
   * resize groups on the window state, and a choice held in the pane would be dropped by a maximize.
   * It is not a second copy of the session's own list — the record is still the source of truth once
   * one exists — only the answer to "what did the user ask for while there was nowhere to write it".
   */
  const [pendingSkillIds, setPendingSkillIds] = useState<string[]>([])
  const pendingSkillsRef = useRef<string[]>(pendingSkillIds)
  pendingSkillsRef.current = pendingSkillIds

  /**
   * The Buddy chosen before there is a conversation to create as one.
   *
   * The same lift as the skill chips beside it, and the same mirror: the create reads the ref, because a
   * send built before this render would otherwise close over the choice that was there then. `null` is
   * the default, and it is what the create turns into an absent key.
   */
  const [pendingBuddyId, setPendingBuddyId] = useState<string | null>(null)
  const pendingBuddyRef = useRef<string | null>(pendingBuddyId)
  pendingBuddyRef.current = pendingBuddyId

  // The user's own Buddies, mirrored from main, and read at the moment a conversation is created rather
  // than at the moment this callback was: the record a Buddy is resolved from is the one main holds now,
  // which is why the ref is here and why the create below does not depend on the list's identity.
  const customBuddies = useConveyorStore(buddiesStore).custom
  const customBuddiesRef = useRef(customBuddies)
  customBuddiesRef.current = customBuddies

  const sessionRecord = sessions.find((s) => s.id === activeSessionId)
  const activeSkillIds = atHome ? pendingSkillIds : (sessionRecord?.activeSkillIds ?? [])
  // What this conversation was created as, read off the record in front of the user — the same read the
  // skills above are, and stripped rather than trusted, because these two keys reach a provider as
  // standing context and a malformed one must inject nothing rather than inject something. At home there
  // is no conversation, so there is nothing to run as and both are null.
  const buddySession = readBuddySession(atHome ? null : sessionRecord)
  // Read by the toggle and by the send, both of which run outside a render: the list they must agree
  // with is the one on screen, not the one from whenever the callback was created.
  const activeSkillsRef = useRef<string[]>(activeSkillIds)
  activeSkillsRef.current = activeSkillIds
  const atHomeRef = useRef(atHome)
  atHomeRef.current = atHome

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
  const dispatchUsage = useConveyorActions(chatSessionsStore).recordUsage

  /**
   * Hand one reply's counters to the store that keeps the running total.
   *
   * Fire-and-forget, like every other action here: the answer is the broadcast that comes back, and the
   * Overview reads that mirror rather than a copy of its own. The counters are passed through as they
   * arrived — the store's schema is what bounds them, and rounding a provider's report here would be
   * this layer deciding what was measured.
   */
  const recordUsage = useCallback(
    (id: string, counters: { prompt: number; completion: number; cached?: number }) => {
      void dispatchUsage({ id, ...counters })
    },
    [dispatchUsage]
  )

  /**
   * Turn one skill on or off, for whichever of the two places is holding the choice.
   *
   * The refusal at the cap changes nothing at all — nothing is written, and nothing is turned off on
   * the user's behalf to make room — which is reported by the picker as a disabled row rather than
   * here. This is the backstop under that, not the ordinary path.
   */
  const toggleSkill = useCallback(
    (id: string) => {
      const current = activeSkillsRef.current
      const result = applySkillToggle(current, id, !current.includes(id))
      if (!result.ok) return

      // Nothing chosen before a conversation exists is written down: there is no record to write it
      // onto. It is carried into the record the first message creates, so a toggle on the home screen
      // is a choice about the conversation that is about to start and not about the window.
      if (atHomeRef.current) {
        setPendingSkillIds(result.activeSkillIds)
        return
      }

      const activeId = activeIdRef.current
      // On screen but not yet named by the store — the round trip after a send created it. The only way
      // to be in that moment is during the run that created it, which is exactly when the controls are
      // disabled, so this is unreachable rather than a case with behaviour. Nothing is guessed at: the
      // id the store names is the only one whose record this layer may write.
      if (activeId === null) return

      touchSession({ id: activeId, activeSkillIds: result.activeSkillIds })
    },
    [touchSession]
  )
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

  const createSession = useCallback(
    (buddyId: string | null = null) => {
      // `crypto.randomUUID` in the renderer is fine for an id: it only has to be unique and safe as a
      // filename, and the module validates the shape again before it touches the disk.
      const id = crypto.randomUUID()
      // The folder the conversation is created in, decided by the rule a turn start uses rather than by a
      // second one: a session's project is where its work happened, and a conversation started while a
      // folder is open has happened in that folder. With nothing open there is no project to record —
      // which is the same absent field a conversation with no turns has, and the reason a brand-new row
      // is not silently pinned to the last folder anyone opened.
      const lastRoot = planRootStamp({ sessionLastRoot: undefined, windowRoot: rootPathRef.current })
      // The Buddy this conversation is created as, resolved once here and snapshotted onto the row. The
      // resolution is against the store's records as well as the built-ins, because a user's own Buddy is
      // as real as one the app ships. An id that resolves to nothing — the SamAi default, or an id whose
      // record was deleted between the choice and the send — seeds nothing, which is the same conversation
      // a send without a Buddy creates rather than an error on the way to one.
      const buddy = resolveBuddy(buddyId, customBuddiesRef.current)
      const seed = buddy === null ? null : buddySessionSeed(buddy)
      // The skills the user turned on while there was no conversation to hold them. Written onto the row
      // rather than kept beside it: from here on the record is the only place the choice lives, which is
      // what makes it the conversation's choice and not the window's. An empty pending list adds no key
      // at all, so a conversation started without skills says nothing rather than saying "none". A Buddy
      // that declares skills starts the conversation on them — the chips the user set before there was a
      // conversation are the fallback, not the other way round, because a Buddy is what was chosen.
      const chosenSkills = seed?.activeSkillIds ?? pendingSkillsRef.current
      addSession({
        id,
        title: UNTITLED,
        // A Buddy that pins a provider and a model runs as it was meant to. Both travel together, so
        // there is no case here of a pinned model on whichever provider the window happened to be on.
        providerId: seed?.providerId ?? providerId,
        model: seed?.model ?? model,
        ...(lastRoot === null ? {} : { lastRoot }),
        ...(chosenSkills.length > 0 ? { activeSkillIds: [...chosenSkills] } : {}),
        // The snapshots, taken now and never rewritten: the role this conversation runs in, and the
        // servers it may use. Written as separate keys only when the Buddy declares them, so a
        // conversation created without one carries no key at all — which is what the SamAi default is.
        ...(seed === null ? {} : { buddyId: seed.buddyId, rolePrompt: seed.rolePrompt }),
        ...(seed?.mcpSubset === undefined ? {} : { mcpSubset: [...seed.mcpSubset] }),
      })
      setActive({ id })
      // The startup restore is decided here as much as by the effect that reads the store's active id: a
      // conversation created by this window is one this window is already showing, and the store naming
      // it a moment later must not be read as "restore the one from last time" — reading it back from a
      // file that does not exist yet would empty the transcript the first message is filling. That is
      // the home screen's ordinary path: nothing is open, so nothing was restored, and the send that
      // creates the conversation is the first thing that touches the store.
      hydratedOnceRef.current = true
      activeIdRef.current = id
      savedRef.current = null
      setError(null)
      setNotice(null)
      // A new session is hydrated by definition: it starts empty and that empty transcript belongs to
      // it. Leaving this unset would let a click on the new row try to load a file that cannot exist.
      hydratedIdRef.current = id
      setOpenId(id)
      setTranscript({ turns: [], interrupted: false })
      // And the last thing a Buddy decides, after the empty transcript above has replaced whatever was
      // there: a Buddy that runs without asking is a conversation that starts already answered, and the
      // write has to come after the reset for that reason. Only ever written on — a Buddy declaring false
      // is asking for the default, which is the absent key this transcript is already carrying.
      if (seed?.autoApprove === true) setTranscript({ ...transcriptRef.current, autoApprove: true })
      return id
    },
    [addSession, model, providerId, setActive, setTranscript]
  )

  /**
   * Leave whatever is open and go home, creating nothing.
   *
   * The save comes first and is not awaited: a turn that ended a moment ago may still be waiting on the
   * debounced write, and it belongs to the session the pointer still names — clearing first would leave
   * that save describing the empty transcript of the window it was moved to. `saveNow` is also the
   * guard that makes this free: a conversation with no turns and no choice of its own writes nothing.
   *
   * The pointer is cleared before anything else, so the two facts home is read from agree as soon as
   * the broadcast lands rather than a render later.
   */
  const goHome = useCallback(() => {
    void saveNow()
    setActive({ id: null })
    activeIdRef.current = null
    savedRef.current = null
    hydratedIdRef.current = null
    setError(null)
    setNotice(null)
    setOpenId(null)
    // The pending skill choice goes with the conversation that carried it, for the reason the approval
    // chip is reset here: a choice that has not been made is what the next conversation should start
    // from, and "none" is what that is. What the conversation the user just left was working from is
    // still on its own record.
    setPendingSkillIds([])
    setTranscript({ turns: [], interrupted: false })
  }, [saveNow, setActive, setTranscript])

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
      // A conversation is on screen, so the startup question — is there one from last time to restore?
      // — has been settled by getting here, whatever the store names next.
      hydratedOnceRef.current = true
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
   * Follow the conversation main says is open, once.
   *
   * Which conversation is open is main's state, not this window's: the pointer is read here so a
   * window told about one loads it the way a click's own selection does, and a conversation
   * restored-but-unloaded is a state that never reaches a pane.
   *
   * A launch is the case this deliberately does not describe: main clears the pointer before any
   * window exists, so a launch has nothing open and lands on the home screen, and what that screen
   * offers back is the list rather than a conversation opened for the user.
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
    (firstMessage: string, buddyId: string | null = pendingBuddyRef.current) => {
      const activeId = activeIdRef.current
      const activeTitle = sessionsRef.current.find((s) => s.id === activeId)?.title ?? null
      // Read before the create, which replaces the transcript a session is about to be built from.
      const pendingApproval = transcriptRef.current.autoApprove === true

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

      // The Buddy travels with the create and with nothing else: a conversation is created once, so the
      // role and the snapshot are written once, and a message in a conversation that already exists runs
      // as that conversation was created to run.
      const id = createSession(buddyId)
      if (plan.title) touchSession({ id, title: plan.title })
      // And the choice the user made before there was a conversation to make it on: with the chip set,
      // the record has to answer that the conversation on screen is already running that way — the
      // session was entered from the chip's own value, and re-reading it would say off.
      if (pendingApproval) setTranscript({ ...transcriptRef.current, autoApprove: true })
      return id
    },
    [createSession, setTranscript, touchSession]
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
    activeSkillIds,
    // What this conversation runs as, for the send: the role its record was created with, and the servers
    // it was created to be limited to. Null for a conversation that named no Buddy — which is every
    // conversation that existed before Buddies, and which asks for exactly the request it always sent.
    buddyRolePrompt: buddySession.rolePrompt,
    buddyMcpSubset: buddySession.mcpSubset,
    // The conversation's own Buddy for the header to name, and the choice that Buddy is made from while
    // there is no conversation yet. Null in both places is the SamAi default, which is not a Buddy to
    // render but a state of the select: the app's own behavior, offered first and offered again.
    buddyId: buddySession.buddyId,
    pendingBuddyId,
    setPendingBuddyId,
    toggleSkill,
    streaming,
    setStreaming,
    stampRoot,
    notice,
    error,
    openId,
    pauses,
    holdPause,
    clearPause,
    atHome,
    goHome,
    createSession,
    openSession,
    deleteSession,
    ensureSession,
    saveNow,
    scheduleSave,
    maybeTitle,
    renameSession,
    recordUsage,
  }
}
