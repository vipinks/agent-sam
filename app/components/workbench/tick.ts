import { useSyncExternalStore } from 'react'

/**
 * The window's one clock, for the readouts that count while a run is in flight.
 *
 * Declared as a seam first, by the red-first rule: the readout pins import these two names so they
 * fail on the behaviour they assert — a value that advances a second at a time — rather than on a
 * module that does not exist yet. The refcount, the interval and the unsubscription below are the
 * next commit's work.
 */

/** Subscribe a readout to the tick. Declared; nothing notifies yet. */
export function subscribeTick(_listener: () => void): () => void {
  // SEAM (next commit): one refcounted interval for the whole window, started by the first reader and
  // cleared by the last.
  return () => {}
}

/** The last whole second the window's clock has reported. Declared; it never moves yet. */
export function useNow(): number {
  return useSyncExternalStore(subscribeTick, () => 0, () => 0)
}
