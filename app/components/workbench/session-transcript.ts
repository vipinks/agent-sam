import {
  emptySnapshot,
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
  type TranscriptTurn,
} from '@/conveyor/protocol/transcript'
import { isInterrupted, isUndecidedPause, LOST_PAUSE_CODE, type AgentTurn } from './agent-session'

/**
 * Turning the live transcript into something that can be saved, and back.
 *
 * The live turns and the stored ones are structurally the same, so this is almost a rename — which
 * is the point: a translation layer between them would be a second shape to keep in step with the
 * reducer, and the reducer is the thing that moves.
 *
 * The one piece of real logic is the interrupted flag. A turn cut off by a restart has to come back
 * as something the transcript can render, not as a crash or a blank conversation, so an unfinished
 * turn is recorded as such rather than being dropped.
 */

/** A snapshot as the renderer holds it: the stored turns, plus what the UI knows about them. */
export interface TranscriptState {
  turns: AgentTurn[]
  /** True when a turn was cut off and the conversation should say so. */
  interrupted: boolean
  /**
   * Whether this conversation runs tools without asking.
   *
   * Optional, like its counterpart on the record: a state that has never had the setting touched carries
   * no key, and off is what absence means. The toggle has nothing to interpret — it reads through
   * `serializeTranscript`'s own rule rather than re-deciding what a missing value is.
   */
  autoApprove?: boolean
  /**
   * Which engine this conversation runs as, and absent for the Sam loop.
   *
   * Optional, like its counterpart on the record, and for the same reason: a conversation that has never
   * named an engine carries no key, and the Sam loop is what absence means. Nothing here resolves it to a
   * default — unlike `autoApprove`, whose two-valued nature a toggle has to be told apart from, an engine id
   * has exactly one way to say "no engine", and it is not being there.
   */
  engineId?: string
  /**
   * The model this conversation's turns ran under, absent for one whose engine kept its own.
   *
   * Optional like its counterpart on the record, and for the same reason: a conversation that never named a
   * model carries no key, and absence means the engine's own default — which a stored empty string could not
   * say, because an engine handed no model and an engine handed `''` are two different turns. Nothing here
   * resolves it to a value: what an engine chose for itself is not this app's to name.
   */
  engineModel?: string
}

/** How a turn's incompleteness is described on screen. */
export const INTERRUPTED_NOTE = 'This turn was interrupted when the app closed.'

/**
 * Read the turns and decide whether the conversation was left mid-turn.
 *
 * A tool step still marked `running` is the signature of an interruption: nothing can still be
 * running in a process that has restarted. An `awaiting` step is deliberately *not* treated as an
 * interruption — a pause for approval is a legitimate state to be in, even though the pause itself
 * is never persisted (the run it belonged to is gone, so the card is left as a record that the
 * action was proposed, not as something still waiting on a decision).
 */
function detectInterrupted(turns: AgentTurn[]): boolean {
  return isInterrupted(turns)
}

/**
 * Frozen into a snapshot: one turn, with the tails parked at it frozen too.
 *
 * Recursive because a branch point holds whole turns and those turns can be branch points of their
 * own: a transcript that parked a tail by writing live objects down would store whatever the caller's
 * array happened to hold a moment later, and one that stopped at the first level would lose the
 * branches inside a parked tail. Each optional field is written only when it is there, so a turn that
 * nothing has happened to is the same object it was before any of these keys existed.
 */
function freezeTurn(turn: AgentTurn): TranscriptTurn {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.content,
    steps: turn.steps.map((step) => ({ ...step })),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    // Written only when the turn was actually sent under instructions, so an ordinary conversation
    // carries no key rather than a null it would then have to be read back out of.
    ...(turn.instructionsFile !== undefined ? { instructionsFile: turn.instructionsFile } : {}),
    ...(turn.instructionsTruncated !== undefined ? { instructionsTruncated: turn.instructionsTruncated } : {}),
    // Paths only, written when the user attached something. A turn with no attachments carries no key,
    // so an ordinary conversation is stored exactly as it was before mentions existed.
    ...(turn.mentionPaths !== undefined && turn.mentionPaths.length > 0 ? { mentionPaths: turn.mentionPaths } : {}),
    // References only, written when the send actually stored an image. Copied rather than referenced for
    // the same reason the plan is: a later edit to the live turn must not reach back into what was just
    // written, and the chips a reopened conversation draws must be the chips that were stored.
    ...(turn.imageRefs !== undefined && turn.imageRefs.length > 0
      ? { imageRefs: turn.imageRefs.map((image) => ({ ...image })) }
      : {}),
    // The trails parked at this turn, written only when it is a branch point: an ordinary conversation
    // carries no key, so a turn that never branched is stored byte for byte as it was before branches
    // existed. The parked turns are frozen by this same function, which is what makes a branch a record
    // rather than a live array a later edit could reach into.
    ...(turn.branchPoints !== undefined && turn.branchPoints.length > 0
      ? { branchPoints: turn.branchPoints.map((tail) => ({ turns: tail.turns.map(freezeTurn) })) }
      : {}),
    ...(turn.branch !== undefined ? { branch: turn.branch } : {}),
    // The plan as the turn ended with it. Written only when there is one, so an ordinary conversation
    // carries no key — the same reason the instructions record is conditional — and copied rather than
    // referenced so a later edit to the live turn cannot reach back into what was just written.
    ...(turn.plan !== undefined ? { plan: turn.plan.map((step) => ({ ...step })) } : {}),
    // The seams this turn continued itself at, copied rather than referenced for the same reason the
    // plan is: a later edit to the live turn must not reach back into what was just written. Written
    // only when there were any, so a turn that never continued itself carries no key at all.
    ...(turn.continuations !== undefined && turn.continuations.length > 0
      ? { continuations: turn.continuations.map((mark) => ({ ...mark })) }
      : {}),
    // How the turn ended, when it ended early — written with the cause and, when there was one, the
    // flag saying a consent pause ended with the process. Actionability is a property of the live
    // session rather than of the record: a card read back from disk offers no Continue button, because
    // the run it would continue is gone. Dropping that here rather than storing and re-reading it is
    // what gives "history is not actionable" one place to be true.
    ...(turn.endNotice !== undefined
      ? {
          endNotice: {
            cause: turn.endNotice.cause,
            ...(turn.endNotice.lostPending ? { lostPending: true } : {}),
            ...(turn.endNotice.unfinishedSteps ? { unfinishedSteps: turn.endNotice.unfinishedSteps } : {}),
          },
        }
      : {}),
  }
}

/**
 * Freeze the live transcript into a snapshot.
 *
 * Interruption is derived rather than trusted from the caller: a stale flag left over from a
 * previous load would otherwise mark a conversation the user has since continued.
 */
export function serializeTranscript(state: TranscriptState): TranscriptSnapshot {
  const interrupted = detectInterrupted(state.turns)
  const turns = state.turns.map(freezeTurn)

  return {
    version: TRANSCRIPT_VERSION,
    turns,
    interrupted,
    // Written only when it is on, which is the same additive rule the optional turn fields follow: a
    // session with the setting off carries no key at all, so its file is byte for byte the file an
    // earlier build wrote for it. A stored `false` would say the user had decided something, and the
    // session that has merely never had the toggle touched has decided nothing.
    ...(state.autoApprove === true ? { autoApprove: true } : {}),
    // Written only when a conversation runs as one, which is the rule every additive field here follows: a
    // session on the Sam loop writes no key at all, so its file stays byte for byte the file an earlier
    // build wrote for it, and an empty string is never written to mean nothing — there is one spelling of
    // "no engine", and it is the key's absence.
    ...(state.engineId === undefined ? {} : { engineId: state.engineId }),
    // And the model, on the same rule: written only when a turn actually carried one, so a conversation whose
    // engine resolved its own model writes no key rather than a placeholder, and every transcript written
    // before this key existed keeps the shape it was written with.
    ...(state.engineModel === undefined ? {} : { engineModel: state.engineModel }),
  }
}

/**
 * Thawed from a snapshot: one turn, with the tails parked at it thawed too.
 *
 * The mirror of `freezeTurn`, and recursive for the same reason. Nothing is defaulted: a key that is
 * not in the file is not in the live turn either, so an ordinary conversation opens as exactly the
 * turns it was saved with.
 */
function thawTurn(turn: TranscriptTurn): AgentTurn {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.content,
    steps: turn.steps.map((step) => ({ ...step })),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    // Carried back so an opened conversation keeps saying what it was sent under, and so an export of
    // it can still name the file.
    ...(turn.instructionsFile !== undefined ? { instructionsFile: turn.instructionsFile } : {}),
    ...(turn.instructionsTruncated !== undefined ? { instructionsTruncated: turn.instructionsTruncated } : {}),
    ...(turn.mentionPaths !== undefined && turn.mentionPaths.length > 0 ? { mentionPaths: turn.mentionPaths } : {}),
    // Carried back so an opened conversation draws the images its messages carried, from the references
    // rather than from the bytes — the bytes are in the attachment store, and what a transcript holds is
    // the pointer. Absent for every turn that attached no image, which is almost all of them.
    ...(turn.imageRefs !== undefined && turn.imageRefs.length > 0
      ? { imageRefs: turn.imageRefs.map((image) => ({ ...image })) }
      : {}),
    // Carried back so a conversation reopened from disk still offers the branches its turns were
    // rewritten into: the switcher is drawn from the turn that holds the position, and checking one out
    // moves the trail the pane shows. Absent for every turn nothing branched at, which is almost all of
    // them.
    ...(turn.branchPoints !== undefined && turn.branchPoints.length > 0
      ? { branchPoints: turn.branchPoints.map((tail) => ({ turns: tail.turns.map(thawTurn) })) }
      : {}),
    ...(turn.branch !== undefined ? { branch: turn.branch } : {}),
    // Carried back so a reopened conversation shows the checklist its turn was working from. It was
    // reconciled on the way out, so nothing here claims to be running — the turn is over, and that is
    // a fact about the file rather than something the reader has to work out.
    ...(turn.plan !== undefined ? { plan: turn.plan.map((step) => ({ ...step })) } : {}),
    // Carried back so a reopened conversation draws the same seams it drew live — the line the user read
    // when the turn continued itself is part of the answer, not a decoration on it. Absent for every
    // turn that never continued, which is almost all of them.
    ...(turn.continuations !== undefined && turn.continuations.length > 0
      ? { continuations: turn.continuations.map((mark) => ({ ...mark })) }
      : {}),
    // Carried back as history: the card says how the answer stopped and offers nothing to click,
    // because the run behind it is not in this process any more. `false` rather than absent, so the
    // card has one flag to read and no third state to handle.
    ...(turn.endNotice !== undefined
      ? {
          endNotice: {
            cause: turn.endNotice.cause,
            resumable: false,
            ...(turn.endNotice.lostPending ? { lostPending: true } : {}),
            ...(turn.endNotice.unfinishedSteps ? { unfinishedSteps: turn.endNotice.unfinishedSteps } : {}),
          },
        }
      : {}),
  }
}

/**
 * Rebuild the live transcript from a snapshot.
 *
 * `null` — a session that has never been saved — becomes an empty conversation, which is what
 * opening a fresh session should look like.
 */
export function rehydrateTranscript(snapshot: TranscriptSnapshot | null): TranscriptState {
  if (!snapshot) return { turns: [], interrupted: false }

  const turns: AgentTurn[] = snapshot.turns.map(thawTurn)

  return {
    turns,
    interrupted: snapshot.interrupted,
    // Resolved to a boolean here rather than carried across as it was stored: absence means off, and the
    // two are not the same thing to a caller that has to render a toggle. Reading it once, where the
    // record is read, is what keeps "never set" and "set to off" from having to be told apart anywhere
    // else in the UI.
    autoApprove: snapshot.autoApprove === true,
    // Left absent rather than resolved to a default, for the reason above and its opposite: the Sam loop was
    // never a choice, so a control reading this must see that nothing was recorded rather than a value that
    // looks like one the user picked.
    ...(snapshot.engineId === undefined ? {} : { engineId: snapshot.engineId }),
    // Carried back for the same reason and by the same rule: a reopened conversation whose turns ran a model
    // still says what it ran, and one whose engine chose for itself carries no key at all rather than a value
    // a reader would have to tell apart from a choice.
    ...(snapshot.engineModel === undefined ? {} : { engineModel: snapshot.engineModel }),
  }
}

/**
 * Reconcile a consent pause the process did not survive.
 *
 * A pause is a question waiting for a person, and the thing that was doing the waiting — the run
 * holding the frame's history — lives in the process that asked. A transcript read back by a later
 * process therefore cannot be shown as still waiting: it would be a card whose buttons do nothing and
 * a turn that is neither running nor ended, which is exactly the state this exists to remove.
 *
 * So a pause found at load ends where it stands. Its calls are recorded as never decided, the turn says
 * so, and the conversation gets a notice. Nothing is guessed about what the user would have answered —
 * an undecided call is not a refused one — and nothing is dropped, so the turn keeps the record of what
 * was proposed. Idempotent: a transcript with no pause comes back untouched.
 */
export function reconcileOrphanedPauses(state: TranscriptState): TranscriptState {
  const turns = state.turns.map((turn) => {
    if (!turn.steps.some(isUndecidedPause)) return turn

    return {
      ...turn,
      steps: turn.steps.map((step) =>
        isUndecidedPause(step) ? { ...step, status: 'interrupted' as const, code: LOST_PAUSE_CODE } : step
      ),
      // The notice lands here rather than beside the transcript because that is where every other
      // notice is read from, so the card above the composer needs no second path to reach it. A turn
      // that somehow already has one keeps it: a diagnosis of the reply is not overwritten by what
      // happened to the pause afterwards.
      endNotice: turn.endNotice ?? { cause: 'model_stop' as const, resumable: false, lostPending: true },
    }
  })

  return { ...state, turns }
}

/** A snapshot for a session with no saved file. */
export function blankTranscript(): TranscriptState {
  return rehydrateTranscript(emptySnapshot())
}
