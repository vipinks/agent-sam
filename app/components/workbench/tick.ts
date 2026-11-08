import { useSyncExternalStore } from 'react'

/**
 * The window's one clock, for the readouts that count while a run is in flight.
 *
 * Three readouts now say how long something has been going — the working row, a run that has gone quiet
 * mid-turn, and the card of a call in flight — and the performance rule makes one clock the only
 * acceptable answer. A timer per readout would be a wake-up per readout per second for a number they all
 * read from the same second, and a transcript can hold dozens of cards.
 *
 * So the interval belongs to the module and is refcounted, not owned by a component: the first reader to
 * subscribe starts it, the last one to leave stops it, and a second reader joins the clock that is
 * already running. That is also why the subscription is by the leaf readouts alone — the memoised
 * bubbles and the virtualized transcript must not re-render once a second because a clock moved.
 *
 * One whole second of granularity, and no animation: what is drawn is text, so the reduced-motion rule
 * governs the spinner glyphs on the rows, never this.
 */

const TICK_MS = 1000

/** The second the readouts are reading, shared by every subscriber in this window. */
let now = 0
/** The one interval, present exactly while at least one readout is subscribed. */
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

/**
 * Subscribe a readout to the window's clock.
 *
 * The first subscription takes the current second and starts the interval; every later one joins it.
 * Unsubscribing the last reader clears the interval, so a settled conversation has no timer at all
 * rather than an idle one waking the window once a second forever.
 */
export function subscribeTick(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, TICK_MS)
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** The last second this window's clock reported. Stable between ticks, which is what the hook needs. */
function snapshot(): number {
  return now
}

/**
 * The window's clock, for a leaf readout.
 *
 * `useSyncExternalStore` rather than a state hook per component: the store is the module above, so every
 * readout reads the same second and subscribing is the only thing a mount does. The third argument is
 * the server snapshot — there is no server here, and returning the same value keeps the signature honest
 * rather than leaving a hole a later reader would fill with a fresh `Date.now()`.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribeTick, snapshot, snapshot)
}
