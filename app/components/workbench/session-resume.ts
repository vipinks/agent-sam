import type { TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { rehydrateTranscript, serializeTranscript, type TranscriptState } from './session-transcript'
import { isDirty, titleFromMessage, UNTITLED } from './session-rules'

/**
 * The decision of what a session click and a first send should actually do.
 *
 * Extracted from the hook because the Phase 7 defects both lived in exactly this decision and were
 * invisible from outside: the reasoning was tangled with React state and so never exercised directly.
 * A hook that returns the wrong sequence is hard to test; a function that returns the wrong plan is
 * hard to get wrong twice.
 *
 * Two rules carry the weight, and both were learned from live use.
 *
 * First, "which session is active" is not "which transcript is loaded". The store persists the
 * active id, so after a restart a session is active with an empty transcript on screen — and any
 * guard that treats those as the same thing will refuse to load the very session the user clicks.
 * `hydratedId` is therefore tracked separately: it names the session the in-memory transcript
 * actually belongs to, and it is null until something is loaded.
 *
 * Second, a session needs saving before it is switched away from, but only if the transcript on
 * screen belongs to it. Saving on a switch away from a session that was never loaded would write an
 * empty conversation over a real one.
 */

/** What a single session click should do, in order. */
export interface ResumePlan {
  /** Persist the transcript currently on screen before switching. */
  saveFirst: boolean
  /** The session to read from disk. */
  loadId: string | null
  /** Set the active id in the store. */
  activateId: string | null
  /** The turns to put on screen; null leaves the transcript untouched. */
  apply: TranscriptState | null
  /** A title to persist because the session was still untitled but has a user message. */
  repairTitle: string | null
}

export interface ResumeInput {
  /** The session the user asked for. */
  requestedId: string
  /** The session the on-screen transcript belongs to, or null when nothing is loaded. */
  hydratedId: string | null
  /** The transcript on screen. */
  transcript: TranscriptState
  /** The last snapshot written for the on-screen transcript, for the dirty check. */
  savedSnapshot: TranscriptSnapshot | null
}

/**
 * The part of a resume that can be decided before the disk is touched.
 *
 * Split from the rest because the answer to "should this click do anything" does not depend on what
 * is in the file — and the click has to decide that *before* paying for a read.
 */
export interface ResumeStart {
  /** Stop: the requested session is already the one on screen. */
  alreadyShowing: boolean
  /** Persist the transcript on screen before switching away. */
  saveFirst: boolean
  /** Whether to go on and read the transcript. */
  load: boolean
  /** Set the active id in the store. */
  activateId: string | null
}

/**
 * Decide whether a click on a session row does anything, and what it does first.
 *
 * The test is `hydratedId`, not the store's active id. The store persists the active id, so after a
 * restart it names a session whose transcript has never been read — and guarding on that id is what
 * made a click on the restored session return early and load nothing.
 */
export function planResumeStart(input: ResumeInput): ResumeStart {
  const { requestedId, hydratedId, transcript, savedSnapshot } = input

  // Already showing this session: re-reading it would discard unsaved turns for no reason.
  if (requestedId === hydratedId) {
    return { alreadyShowing: true, saveFirst: false, load: false, activateId: null }
  }

  return {
    alreadyShowing: false,
    // Only when the transcript on screen belongs to a session: saving one that was never loaded
    // would write an empty conversation over a real one.
    saveFirst: hydratedId !== null && isDirty(transcript, savedSnapshot),
    load: true,
    activateId: requestedId,
  }
}

/** What the finished resume does to the transcript and the row's title. */
export interface ResumeFinish {
  /** The turns to put on screen. */
  apply: TranscriptState
  /** A title to persist because the session was untitled but its transcript has a user message. */
  repairTitle: string | null
}

/**
 * Decide what a resumed session becomes, once its transcript has been read.
 *
 * This is where the self-heal lives: a row stored before titles were applied has no name but does
 * have a first user message, which is the title it should have had.
 */
export function planResumeFinish(input: { loaded: TranscriptSnapshot | null; metadataTitle: string }): ResumeFinish {
  const apply = rehydrateTranscript(input.loaded)
  return { apply, repairTitle: deriveRepairTitle(input.metadataTitle, apply) }
}

/**
 * Decide what a click on a session row does, end to end.
 *
 * Composed from the two halves so a caller that has the snapshot in hand can use one call, and a
 * caller that has to fetch it can use the halves. Both go through the same decisions.
 */
export function planResume(
  input: ResumeInput & { loaded: TranscriptSnapshot | null; metadataTitle: string }
): ResumePlan {
  const start = planResumeStart(input)
  if (start.alreadyShowing) {
    return { saveFirst: false, loadId: null, activateId: null, apply: null, repairTitle: null }
  }

  const finish = planResumeFinish({ loaded: input.loaded, metadataTitle: input.metadataTitle })
  return {
    saveFirst: start.saveFirst,
    loadId: start.activateId,
    activateId: start.activateId,
    apply: finish.apply,
    repairTitle: finish.repairTitle,
  }
}

/**
 * The title a loaded transcript implies, when the session has none.
 *
 * A session created before titles were applied has no name but does have a first user message, which
 * is exactly the title it should have had. Deriving it here is what lets those rows repair
 * themselves rather than staying "Untitled conversation" forever.
 */
export function deriveRepairTitle(metadataTitle: string, transcript: TranscriptState): string | null {
  if (metadataTitle !== UNTITLED) return null
  const firstUser = transcript.turns.find((turn) => turn.role === 'user' && turn.content.trim())
  if (!firstUser) return null
  return titleFromMessage(firstUser.content)
}

/**
 * Decide what sending a message does to the session list.
 *
 * Returns whether a session must be created and, when the target session is still untitled, the
 * title to set. The title is derived whenever the session has none — including a session restored
 * from a previous run, which is the case that left persisted rows untitled.
 *
 * `isHydrated` is accepted but deliberately does not gate the decision: a session restored by the
 * store is a real session to send into, whether or not its transcript has arrived yet. The title is
 * what decides whether naming is still owed.
 */
export function planFirstSend(input: {
  /** The session the message will land in, from the store. */
  activeId: string | null
  /** That session's current title, when there is one. */
  activeTitle: string | null
  /** The message being sent. */
  message: string
  /** Whether a transcript is actually on screen for the active session. */
  isHydrated: boolean
}): { create: boolean; title: string | null } {
  const { activeId, activeTitle, message } = input

  if (activeId) {
    // A session still showing the default is named from this message; after that its title is no
    // longer the default, so later messages cannot rename it. That is what "set once" means here.
    return {
      create: false,
      title: activeTitle === UNTITLED ? titleFromMessage(message) || UNTITLED : null,
    }
  }

  return { create: true, title: titleFromMessage(message) || UNTITLED }
}

/** Whether a plan changes anything at all. */
export function planIsNoop(plan: ResumePlan): boolean {
  return plan.loadId === null && plan.activateId === null && plan.apply === null && !plan.saveFirst
}

export { serializeTranscript }
