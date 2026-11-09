import type { TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { serializeTranscript, type TranscriptState } from './session-transcript'

/**
 * The small decisions the session list makes, kept out of React so they can be tested directly.
 *
 * These are the rules that are easy to get subtly wrong and hard to notice: when a session is
 * renamed, when a transcript is considered dirty, and whether a save is worth doing at all. The
 * component calls these; it does not decide them.
 *
 * The title rule itself now lives in the shared protocol module, because main derives a filename from
 * the same rule when exporting — so this re-exports it rather than keeping a second copy that could
 * drift. Callers here keep importing from where they always have.
 */
export { TITLE_MAX, titleFromMessage, UNTITLED } from '@/conveyor/protocol/session-title'

/**
 * Whether a transcript is worth writing.
 *
 * Streaming is the reason this exists: a session is saved at turn boundaries, and this is the guard
 * that keeps a no-op save — an empty conversation, or one that has not changed since the last write
 * — from touching the disk at all.
 *
 * The one empty conversation worth a file is one whose user turned auto-approve on. That is a choice
 * the user made rather than a by-product of sending a message, and a session toggled on and then left
 * without one should still open with it on — so "nothing has ever been written" is not the same
 * question as "there is nothing to write".
 */
export function isDirty(state: TranscriptState, lastSaved: TranscriptSnapshot | null): boolean {
  const current = serializeTranscript(state)
  if (!lastSaved) return current.turns.length > 0 || current.autoApprove === true
  // Comparing the serialised forms is what makes this exact: they are the same shape that is written
  // to disk, so a difference here is a difference that would land in the file.
  return JSON.stringify(current) !== JSON.stringify(lastSaved)
}

/**
 * Whether a transcript may be written.
 *
 * A pause awaiting approval is not persisted: the run it belongs to cannot survive a restart, so
 * saving it would restore a card that looks actionable but is not. Everything else is saved, which
 * is what makes an unfinished turn — a `running` step — come back as interrupted rather than as a
 * lost conversation.
 *
 * `queued` is checked alongside `awaiting` for the same reason and not for symmetry: a call waiting
 * its turn is part of the same unresumable pause, and a restored queue would look like a decision
 * the user could still make.
 *
 * The parked trails are walked too, and recursively: a branch point holds whole turns, and a turn
 * with a pause parked under it is the same unresumable state as one on the checked-out trail. A file
 * carrying either would be read back the same way, so the predicate has to see both.
 */
export function mayPersist(state: TranscriptState): boolean {
  return !state.turns.some(holdsUnansweredDecision)
}

/** One turn, or any turn parked in its branches, still waiting on a person. */
function holdsUnansweredDecision(turn: TranscriptState['turns'][number]): boolean {
  if (turn.steps.some((step) => step.status === 'awaiting' || step.status === 'queued')) return true
  return (turn.branchPoints ?? []).some((tail) => tail.turns.some(holdsUnansweredDecision))
}

/** Coalescing delay for the post-turn save. Roughly one pause in a person's reading. */
export const SAVE_DEBOUNCE_MS = 1500

/**
 * A debounced save, with flush and cancel.
 *
 * Injected clock for the same reason as elsewhere in this codebase: a test should be able to drive
 * the timing rather than wait for it.
 */
export interface DebouncedSave {
  /** Queue a save. Repeated calls inside the window collapse into one. */
  schedule: () => void
  /** Run a queued save now, if there is one. */
  flush: () => void
  /** Drop a queued save. */
  cancel: () => void
}

export function createDebouncedSave(
  save: () => void,
  options: { delayMs?: number; schedule?: typeof setTimeout; cancel?: typeof clearTimeout } = {}
): DebouncedSave {
  const delayMs = options.delayMs ?? SAVE_DEBOUNCE_MS
  const scheduleTimer = options.schedule ?? setTimeout
  const cancelTimer = options.cancel ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer === null) return
    cancelTimer(timer)
    timer = null
    save()
  }

  return {
    schedule() {
      // The window is not extended by later calls: a stream that keeps producing must still save
      // once, roughly on time, rather than postponing until it stops.
      if (timer === null) timer = scheduleTimer(flush, delayMs)
    },
    flush,
    cancel() {
      if (timer !== null) cancelTimer(timer)
      timer = null
    },
  }
}
