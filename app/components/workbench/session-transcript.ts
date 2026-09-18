import {
  emptySnapshot,
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
  type TranscriptTurn,
} from '@/conveyor/protocol/transcript'
import { isInterrupted, type AgentTurn } from './agent-session'

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
 * Freeze the live transcript into a snapshot.
 *
 * Interruption is derived rather than trusted from the caller: a stale flag left over from a
 * previous load would otherwise mark a conversation the user has since continued.
 */
export function serializeTranscript(state: TranscriptState): TranscriptSnapshot {
  const interrupted = detectInterrupted(state.turns)
  const turns = state.turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    content: turn.content,
    steps: turn.steps.map((step) => ({ ...step })),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  }))

  return { version: TRANSCRIPT_VERSION, turns, interrupted }
}

/**
 * Rebuild the live transcript from a snapshot.
 *
 * `null` — a session that has never been saved — becomes an empty conversation, which is what
 * opening a fresh session should look like.
 */
export function rehydrateTranscript(snapshot: TranscriptSnapshot | null): TranscriptState {
  if (!snapshot) return { turns: [], interrupted: false }

  const turns: AgentTurn[] = snapshot.turns.map((turn: TranscriptTurn) => ({
    id: turn.id,
    role: turn.role,
    content: turn.content,
    steps: turn.steps.map((step) => ({ ...step })),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  }))

  return { turns, interrupted: snapshot.interrupted }
}

/** A snapshot for a session with no saved file. */
export function blankTranscript(): TranscriptState {
  return rehydrateTranscript(emptySnapshot())
}
