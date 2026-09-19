import type { TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { serializeTranscript, type TranscriptState } from './session-transcript'

/**
 * The small decisions the session list makes, kept out of React so they can be tested directly.
 *
 * These are the rules that are easy to get subtly wrong and hard to notice: when a session is
 * renamed, when a transcript is considered dirty, and whether a save is worth doing at all. The
 * component calls these; it does not decide them.
 */

/** Title length, as specified: the first user message, truncated. */
export const TITLE_MAX = 48

/**
 * Cap a title at the documented length.
 *
 * Truncation happens on the trimmed text, so trailing whitespace cannot eat into the 48 characters,
 * and an ellipsis is appended so a clipped title reads as clipped rather than as a short one.
 */
export function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= TITLE_MAX) return trimmed
  return `${trimmed.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

/** The title a session gets when its first message is somehow blank. */
export const UNTITLED = 'Untitled conversation'

/**
 * Whether a transcript is worth writing.
 *
 * Streaming is the reason this exists: a session is saved at turn boundaries, and this is the guard
 * that keeps a no-op save — an empty conversation, or one that has not changed since the last write
 * — from touching the disk at all.
 */
export function isDirty(state: TranscriptState, lastSaved: TranscriptSnapshot | null): boolean {
  const current = serializeTranscript(state)
  if (!lastSaved) return current.turns.length > 0
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
 */
export function mayPersist(state: TranscriptState): boolean {
  return !state.turns.some((turn) => turn.steps.some((step) => step.status === 'awaiting' || step.status === 'queued'))
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
