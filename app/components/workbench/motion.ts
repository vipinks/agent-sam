import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The quick window every shipped exit shares with its arrival.
 *
 * One number because the feature has one duration: 150 ms, ease-out, the curve the collapses and chips
 * already arrive on. A second constant for a 200 ms surface is deliberately absent — there is no
 * shipped exit long enough to earn one, and a module that offered the number would invite the next
 * surface to use it without asking whether it should.
 */
export const MOTION_QUICK_MS = 150

/** The media query the hooks read. One string, so the reader and the short-circuit cannot drift. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * The OS preference, read guarded and kept current.
 *
 * Guarded on `typeof` rather than on `'matchMedia' in window`: an environment can define the property
 * as something that is not callable (jsdom's own stub was one), and asking whether it is a function is
 * the only check that survives that. Subscribed to `change` so the window follows the setting while it
 * is open — a reader who turns motion down mid-session gets the instant behaviour without a reload.
 *
 * Both listener spellings are attempted because the older `addListener` is still what some engines
 * ship; neither is an error path, and a query that offers none simply leaves the initial reading.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof matchMedia !== 'function') return false
    return matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(REDUCED_MOTION_QUERY)
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches)

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    }
    if (typeof query.addListener === 'function') {
      query.addListener(listener)
      return () => query.removeListener(listener)
    }
    return
  }, [])

  return reduced
}

/** Whether a surface is in its exit window, and whether it is still drawn for it. */
export interface ClosingWindow {
  /** Still on screen: open, or closed and inside the window. */
  mounted: boolean
  /** Closed, drawn, and waiting for the timer. */
  closing: boolean
}

/**
 * One closing window for a surface that is rendered while it leaves.
 *
 * The release is a timer and never `animationend`: jsdom fires no animation event, and a real window
 * must not depend on a stylesheet being present to unmount. The timer is cancelled by a re-open, so a
 * surface that comes back mid-window neither blinks nor disappears under the reader.
 *
 * `closing` is derived during render rather than set in an effect, so the frame that flips `open` to
 * false already draws the exit classes — an effect would paint one frame with the surface hidden, then
 * paint it back. The transition is remembered in state, which is also what keeps a surface that mounts
 * closed from playing an exit it never had.
 *
 * Reduced motion short-circuits the whole thing: closed is closed, `closing` is false, no timer runs,
 * and the surface is exactly as instant as it was before this feature.
 */
export function useClosingState(open: boolean, ms: number = MOTION_QUICK_MS): ClosingWindow {
  const reduced = useReducedMotion()
  const [state, setState] = useState<{ open: boolean; closing: boolean }>({ open, closing: false })

  if (state.open !== open) {
    // Adjusting state during render is deliberate: React re-renders this component before committing,
    // so the exit classes and the mounted body appear in the same frame the caller closed it.
    setState({ open, closing: !open && !reduced && state.open })
  }

  const closing = state.closing && !reduced

  // A layout effect so a timer is scheduled before paint, and cleaned up when the surface re-opens or
  // unmounts. `state.closing` is the stored fact; `closing` is what the caller is allowed to see.
  useLayoutEffect(() => {
    if (!state.closing) return
    const timer = setTimeout(() => setState((current) => ({ ...current, closing: false })), ms)
    return () => clearTimeout(timer)
  }, [state.closing, ms])

  return { mounted: open || closing, closing }
}

/** One rendered entry of a leaving list: the item, its stable key, and whether it is on its way out. */
export interface LeavingEntry<T> {
  item: T
  key: string
  leaving: boolean
}

/**
 * The union of the current list and the items leaving it, with the leaving ones still drawable.
 *
 * A chip row cannot ask an item to fade after it has been unmounted: the chip *is* the thing that owns
 * the object URL, and unmounting it early is how a blob is revoked before the picture has finished
 * leaving. So the hook keeps the item in the rendered list for one quick window, marks it `leaving`,
 * and lets the caller draw it with the exit classes and no controls. A re-added key comes back as
 * current and cancels its release; a repeated render inside the window does not stack the same key.
 *
 * The state adjustment happens during render for the same reason `useClosingState` does it: the first
 * frame after the removal must already contain the leaving item, or React commits the union without
 * it and the chip unmounts for a frame.
 *
 * The key function must be stable in meaning (the same item produces the same key for the life of the
 * list); it is not required to be referentially stable, because it is called during render and never
 * captured by the timer.
 */
export function useLeavingItems<T>(
  items: readonly T[],
  key: (item: T) => string,
  ms: number = MOTION_QUICK_MS
): readonly LeavingEntry<T>[] {
  const reduced = useReducedMotion()
  const [state, setState] = useState<{
    source: readonly T[]
    leaving: readonly { item: T; key: string }[]
  }>({ source: [], leaving: [] })
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  // Compared by key, not by array identity: a caller may pass a fresh array of the same items on every
  // render, and re-running the adjustment for that would be an infinite render loop. The key sequence is
  // the thing this hook is about; the array reference is not.
  const incomingKeys = items.map((item) => key(item))
  const sourceKeys = state.source.map((item) => key(item))
  const changed =
    incomingKeys.length !== sourceKeys.length || incomingKeys.some((itemKey, index) => itemKey !== sourceKeys[index])

  if (changed || (reduced && state.leaving.length > 0)) {
    const currentKeys = new Set(incomingKeys)
    const carried = state.leaving.filter((entry) => !currentKeys.has(entry.key))
    const dropped = state.source.filter((item) => !currentKeys.has(key(item)))
    const leaving = reduced ? [] : [...carried]
    if (!reduced) {
      for (const item of dropped) {
        const itemKey = key(item)
        if (!leaving.some((entry) => entry.key === itemKey)) leaving.push({ item, key: itemKey })
      }
    }
    setState({ source: items, leaving })
  }

  useLayoutEffect(() => {
    const wanted = new Set(reduced ? [] : state.leaving.map((entry) => entry.key))

    for (const [entryKey, timer] of timers.current) {
      if (wanted.has(entryKey)) continue
      clearTimeout(timer)
      timers.current.delete(entryKey)
    }

    for (const entryKey of wanted) {
      if (timers.current.has(entryKey)) continue
      timers.current.set(
        entryKey,
        setTimeout(() => {
          timers.current.delete(entryKey)
          setState((current) =>
            current.leaving.some((entry) => entry.key === entryKey)
              ? { ...current, leaving: current.leaving.filter((entry) => entry.key !== entryKey) }
              : current
          )
        }, ms)
      )
    }
  }, [state.leaving, reduced, ms])

  // Timers belong to this hook, not to the component that asked: unmounting the row releases them
  // rather than letting a callback set state on a tree that is gone.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
    },
    []
  )

  const rendered: LeavingEntry<T>[] = items.map((item) => ({ item, key: key(item), leaving: false }))
  if (reduced) return rendered

  for (const entry of state.leaving) {
    if (rendered.some((candidate) => candidate.key === entry.key)) continue
    rendered.push({ ...entry, leaving: true })
  }
  return rendered
}
