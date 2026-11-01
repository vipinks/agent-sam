/**
 * The startup splash handoff: when the splash goes away and the main window appears.
 *
 * Pure by construction. Time and the three window operations are injected, so the two rules that make
 * the handoff safe are decidable without Electron: the splash is visible for at least
 * `SPLASH_MIN_VISIBLE_MS`, and a main window that never paints still cannot leave the splash up past
 * `SPLASH_MAX_VISIBLE_MS`. The controller never imports `electron`; `app.ts` owns the port that talks
 * to real windows.
 *
 * The order in `dismiss` is the contract: show main, then close splash. Reversing it would expose the
 * desktop for a frame, which is the one thing a startup splash exists to prevent.
 */

/**
 * How long the splash must remain visible after it is shown, even if the main window is ready sooner.
 * Keep it below `SPLASH_MAX_VISIBLE_MS`, or the cap would fire before the floor.
 */
export const SPLASH_MIN_VISIBLE_MS = 3000

/** The hard cap: dismiss the splash and reveal main even when ready-to-show never arrives. */
export const SPLASH_MAX_VISIBLE_MS = 5000

type TimerHandle = unknown

/** The real-window operations the controller is allowed to request. */
export interface SplashPort {
  showSplash: () => void
  closeSplash: () => void
  showMain: () => void
}

/** The clock and timer seam, injected so the suite can make both deadlines exact. */
export interface SplashControllerDeps {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => TimerHandle
  cancel: (handle: TimerHandle) => void
  port: SplashPort
}

/** The handoff's public surface, as the main process wires it to window events. */
export interface SplashController {
  /** Show the splash and start its deadlines. Called from the splash's own ready-to-show. */
  start: () => void
  /** The main window's native ready-to-show fired. */
  mainReady: () => void
  /** A load failure or a gone renderer process: reveal main rather than keep an invisible app. */
  failed: () => void
  /** The splash window closed; there is no longer anything to time. */
  splashClosed: () => void
  /** The app is quitting; no timer should outlive it. */
  beforeQuit: () => void
}

/**
 * Build one controller.
 *
 * `dismissed` and `stopped` are deliberately separate: the first says the handoff already ran, the
 * second says the splash or app ended. Either makes every later request a no-op, which is what keeps a
 * late `ready-to-show`, a repeated failure and the cap from showing main twice.
 */
export function createSplashController(deps: SplashControllerDeps): SplashController {
  let started = false
  let dismissed = false
  let stopped = false
  let shownAt = 0
  let mainReadyAt: number | null = null
  let capTimer: TimerHandle | null = null
  let floorTimer: TimerHandle | null = null

  function cancelTimer(handle: TimerHandle | null): void {
    if (handle !== null) deps.cancel(handle)
  }

  function cancelTimers(): void {
    cancelTimer(capTimer)
    cancelTimer(floorTimer)
    capTimer = null
    floorTimer = null
  }

  function dismiss(): void {
    if (dismissed || stopped) return
    dismissed = true
    cancelTimers()
    deps.port.showMain()
    deps.port.closeSplash()
  }

  function scheduleFloor(): void {
    if (dismissed || stopped || floorTimer !== null) return
    const elapsed = deps.now() - shownAt
    if (elapsed >= SPLASH_MIN_VISIBLE_MS) {
      dismiss()
      return
    }
    // The floor is always earlier than the cap, so once main is ready the cap has nothing left to
    // guard against. Dropping it keeps one handoff timer live instead of two racing to dismiss.
    cancelTimer(capTimer)
    capTimer = null
    floorTimer = deps.schedule(() => {
      floorTimer = null
      dismiss()
    }, SPLASH_MIN_VISIBLE_MS - elapsed)
  }

  return {
    start() {
      if (started || dismissed || stopped) return
      started = true
      shownAt = deps.now()
      deps.port.showSplash()
      capTimer = deps.schedule(() => {
        capTimer = null
        dismiss()
      }, SPLASH_MAX_VISIBLE_MS)
      if (mainReadyAt !== null) scheduleFloor()
    },

    mainReady() {
      if (dismissed || stopped) return
      if (mainReadyAt === null) mainReadyAt = deps.now()
      // The splash may still be waiting for its own first paint. `start` will pick this up.
      if (started) scheduleFloor()
    },

    failed() {
      dismiss()
    },

    splashClosed() {
      stopped = true
      cancelTimers()
    },

    beforeQuit() {
      stopped = true
      cancelTimers()
    },
  }
}
