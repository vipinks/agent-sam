import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MOTION_QUICK_MS, useClosingState, useLeavingItems, useReducedMotion } from '@/app/components/workbench/motion'

/**
 * The motion module's own contract, without a window and without a stylesheet.
 *
 * Every exit in this app is one quick window, and the rules that decide when it is open — a timer, not
 * `animationend`; a re-open cancelling it; reduced motion closing no window at all — are ordinary
 * functions of state. Testing them here rather than through seven surfaces is what keeps the suites
 * that follow about wiring: if this file is green, the only question left for a chip or a fold is
 * whether it asked.
 *
 * Timers are faked rather than waited on: jsdom never fires `animationend`, which is exactly why the
 * module releases on a timer, and a test that slept 150 ms per case would spend the suite's budget on
 * the clock instead of on the contract.
 */

/** A `matchMedia` that answers one query and ignores subscriptions, which is all the hook reads. */
function matchMediaAnswering(matches: boolean): typeof matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the quick motion constant', () => {
  it('is the one duration every shipped exit and its arrival share', () => {
    expect(MOTION_QUICK_MS).toBe(150)
  })
})

describe('a closing window', () => {
  it('releases only when the timer says so, not when an animation would have ended', () => {
    vi.useFakeTimers()
    const view = renderHook(({ open }: { open: boolean }) => useClosingState(open), {
      initialProps: { open: true },
    })

    // Nothing to close while it is open.
    expect(view.result.current).toEqual({ mounted: true, closing: false })

    view.rerender({ open: false })
    // Still mounted on the frame the state says closed, because the exit is what is happening now.
    expect(view.result.current).toEqual({ mounted: true, closing: true })

    act(() => void vi.advanceTimersByTime(MOTION_QUICK_MS - 1))
    expect(view.result.current).toEqual({ mounted: true, closing: true })

    act(() => void vi.advanceTimersByTime(1))
    expect(view.result.current).toEqual({ mounted: false, closing: false })
  })

  it('cancels the window when the same surface is re-opened', () => {
    vi.useFakeTimers()
    const view = renderHook(({ open }: { open: boolean }) => useClosingState(open), {
      initialProps: { open: true },
    })

    view.rerender({ open: false })
    expect(view.result.current.closing).toBe(true)

    view.rerender({ open: true })
    expect(view.result.current).toEqual({ mounted: true, closing: false })

    // The released timer would have set closing false again; nothing may change after it.
    act(() => void vi.advanceTimersByTime(MOTION_QUICK_MS * 4))
    expect(view.result.current).toEqual({ mounted: true, closing: false })
  })

  it('does not open a window at mount, so a surface that starts closed does not animate out', () => {
    vi.useFakeTimers()
    const view = renderHook(() => useClosingState(false))

    expect(view.result.current).toEqual({ mounted: false, closing: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('short-circuits under reduced motion: no window opens and no timer runs', () => {
    vi.stubGlobal('matchMedia', matchMediaAnswering(true))
    vi.useFakeTimers()
    const view = renderHook(({ open }: { open: boolean }) => useClosingState(open), {
      initialProps: { open: true },
    })

    view.rerender({ open: false })

    // Removal is instant and identical to the pre-motion behaviour: nothing mounted, nothing closing.
    expect(view.result.current).toEqual({ mounted: false, closing: false })
    expect(vi.getTimerCount()).toBe(0)
    act(() => void vi.advanceTimersByTime(MOTION_QUICK_MS))
    expect(view.result.current).toEqual({ mounted: false, closing: false })
  })
})

describe('the reduced-motion reader', () => {
  it('reads the preference and follows it when the system changes', () => {
    let changed: ((event: { matches: boolean }) => void) | null = null
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
        changed = listener
      },
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia)

    const view = renderHook(() => useReducedMotion())
    expect(view.result.current).toBe(false)

    act(() => changed?.({ matches: true }))
    expect(view.result.current).toBe(true)
  })
})

describe('a leaving list', () => {
  it('keeps a removed item for the window, marked leaving, then drops it', () => {
    vi.useFakeTimers()
    const view = renderHook(({ items }: { items: string[] }) => useLeavingItems(items, (item) => item), {
      initialProps: { items: ['alpha', 'beta'] },
    })

    view.rerender({ items: ['beta'] })

    const rendered = view.result.current
    expect(rendered.map((entry) => entry.item)).toEqual(['beta', 'alpha'])
    expect(rendered.find((entry) => entry.item === 'alpha')?.leaving).toBe(true)
    expect(rendered.find((entry) => entry.item === 'beta')?.leaving).toBe(false)

    act(() => void vi.advanceTimersByTime(MOTION_QUICK_MS))
    expect(view.result.current.map((entry) => entry.item)).toEqual(['beta'])
  })

  it('does not stack the same removed key twice across renders inside the window', () => {
    vi.useFakeTimers()
    const view = renderHook(({ items }: { items: string[] }) => useLeavingItems(items, (item) => item), {
      initialProps: { items: ['alpha', 'beta'] },
    })

    view.rerender({ items: ['beta'] })
    view.rerender({ items: ['beta'] })
    view.rerender({ items: ['beta'] })

    const alpha = view.result.current.filter((entry) => entry.key === 'alpha')
    expect(alpha).toHaveLength(1)
    expect(alpha[0].leaving).toBe(true)
  })

  it('takes a re-added item back as current and cancels its release', () => {
    vi.useFakeTimers()
    const view = renderHook(({ items }: { items: string[] }) => useLeavingItems(items, (item) => item), {
      initialProps: { items: ['alpha', 'beta'] },
    })

    view.rerender({ items: ['beta'] })
    expect(view.result.current.find((entry) => entry.item === 'alpha')?.leaving).toBe(true)

    view.rerender({ items: ['beta', 'alpha'] })
    const reAdded = view.result.current.find((entry) => entry.item === 'alpha')
    expect(reAdded?.leaving).toBe(false)

    // The release the first removal scheduled must not take the re-added item away.
    act(() => void vi.advanceTimersByTime(MOTION_QUICK_MS * 3))
    expect(view.result.current.map((entry) => entry.item)).toEqual(['beta', 'alpha'])
  })

  it('leaves nothing in the list under reduced motion', () => {
    vi.stubGlobal('matchMedia', matchMediaAnswering(true))
    vi.useFakeTimers()
    const view = renderHook(({ items }: { items: string[] }) => useLeavingItems(items, (item) => item), {
      initialProps: { items: ['alpha', 'beta'] },
    })

    view.rerender({ items: ['beta'] })
    expect(view.result.current.map((entry) => entry.item)).toEqual(['beta'])
    expect(view.result.current.every((entry) => !entry.leaving)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
