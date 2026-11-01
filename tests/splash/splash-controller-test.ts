/**
 * The startup splash controller, with time and the windows injected.
 *
 * The controller owns the one ordering that matters at launch: the splash is visible, the main window
 * stays hidden until it can paint, and no timer can leave a running app with no window on screen. A real
 * Electron window would make that claim untestable; the ports here record what the controller asked the
 * windows to do, and the fake clock makes the 400 ms floor and the 5000 ms cap exact rather than timing
 * dependent.
 */
import { strict as assert } from 'node:assert'
import { createSplashController, SPLASH_MAX_VISIBLE_MS, SPLASH_MIN_VISIBLE_MS } from '../../lib/main/splash'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/**
 * A controller wired to a fake clock and recording ports.
 *
 * Timers fire in due order, and `now` is moved to each timer's due time before its callback runs. That is
 * what lets the suites below say the splash closed *at* 400 ms, not merely after advancing the clock past
 * it.
 */
function harness() {
  let now = 0
  let nextTimer = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const calls: { name: 'showSplash' | 'showMain' | 'closeSplash'; at: number }[] = []

  const controller = createSplashController({
    now: () => now,
    schedule: (callback, delayMs) => {
      const id = nextTimer++
      timers.set(id, { at: now + delayMs, run: callback })
      return id
    },
    cancel: (handle) => {
      timers.delete(handle as number)
    },
    port: {
      showSplash: () => calls.push({ name: 'showSplash', at: now }),
      closeSplash: () => calls.push({ name: 'closeSplash', at: now }),
      showMain: () => calls.push({ name: 'showMain', at: now }),
    },
  })

  function advance(ms: number): void {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0]
      if (!due) break
      const [id, timer] = due
      timers.delete(id)
      now = timer.at
      timer.run()
    }
    now = target
  }

  return {
    controller,
    calls,
    advance,
    at: (name: 'showSplash' | 'showMain' | 'closeSplash') => calls.find((call) => call.name === name)?.at,
    count: (name: 'showSplash' | 'showMain' | 'closeSplash') => calls.filter((call) => call.name === name).length,
    pending: () => timers.size,
  }
}

/** Ready before the floor: the close waits until 400 ms from the splash becoming visible. */
function readyBeforeFloorWaits() {
  const h = harness()
  h.controller.start()
  h.advance(100)
  h.controller.mainReady()

  assert.equal(h.at('closeSplash'), undefined, 'the splash is still up before the floor')
  assert.equal(h.pending(), 1, 'one floor timer is pending')

  h.advance(SPLASH_MIN_VISIBLE_MS - 100 - 1)
  assert.equal(h.at('closeSplash'), undefined, 'the splash is still up one millisecond before the floor')

  h.advance(1)
  assert.equal(h.at('closeSplash'), SPLASH_MIN_VISIBLE_MS, 'the splash closes exactly at the floor')
  assert.deepEqual(
    h.calls.filter((call) => call.name === 'showMain' || call.name === 'closeSplash'),
    [
      { name: 'showMain', at: SPLASH_MIN_VISIBLE_MS },
      { name: 'closeSplash', at: SPLASH_MIN_VISIBLE_MS },
    ],
    'the main window is shown before the splash is closed'
  )
  results.push('ready before floor waits 400 ms, then shows main before closing splash')
}

/** Ready after the floor: no artificial delay remains, so dismissal is immediate. */
function readyAfterFloorClosesImmediately() {
  const h = harness()
  h.controller.start()
  h.advance(SPLASH_MIN_VISIBLE_MS + 50)
  h.controller.mainReady()

  assert.equal(h.at('showMain'), SPLASH_MIN_VISIBLE_MS + 50, 'main is shown immediately')
  assert.equal(h.at('closeSplash'), SPLASH_MIN_VISIBLE_MS + 50, 'splash closes immediately')
  assert.equal(h.pending(), 0, 'no timer survives an immediate dismissal')
  results.push('ready after floor closes immediately')
}

/** The cap: a main window that never paints still cannot leave the splash up forever. */
function capDismisses() {
  const h = harness()
  h.controller.start()
  h.advance(SPLASH_MAX_VISIBLE_MS - 1)

  assert.equal(h.at('closeSplash'), undefined, 'the splash is still up before the cap')

  h.advance(1)
  assert.equal(h.at('showMain'), SPLASH_MAX_VISIBLE_MS, 'the cap shows main')
  assert.equal(h.at('closeSplash'), SPLASH_MAX_VISIBLE_MS, 'the cap closes the splash')
  results.push('5000 ms cap shows main and closes splash')
}

/** A failed load or renderer: hand the user the main window rather than an invisible app. */
function failureDismisses() {
  const h = harness()
  h.controller.start()
  h.advance(250)
  h.controller.failed()

  assert.equal(h.at('showMain'), 250, 'a failure shows main')
  assert.equal(h.at('closeSplash'), 250, 'a failure closes the splash')
  assert.equal(h.pending(), 0, 'a failure cancels pending timers')
  results.push('load failure shows main and closes splash')
}

/** Dismissal is a one-shot: a later failure or timer cannot show or close anything twice. */
function doubleDismissIsNoOp() {
  const h = harness()
  h.controller.start()
  h.advance(600)
  h.controller.mainReady()
  h.controller.failed()
  h.advance(SPLASH_MAX_VISIBLE_MS)

  assert.equal(h.count('showMain'), 1, 'main is shown once')
  assert.equal(h.count('closeSplash'), 1, 'the splash is closed once')
  results.push('double dismissal is a no-op')
}

/** A closed splash or a quitting app owns no timers any more. */
function closedAndQuitCancelTimers() {
  const closed = harness()
  closed.controller.start()
  closed.advance(100)
  closed.controller.mainReady()
  closed.controller.splashClosed()
  closed.advance(SPLASH_MAX_VISIBLE_MS)

  assert.equal(closed.at('closeSplash'), undefined, 'a closed splash does not close again')
  assert.equal(closed.at('showMain'), undefined, 'a closed splash starts no dismissal')
  assert.equal(closed.pending(), 0, 'closed cancels pending timers')

  const quitting = harness()
  quitting.controller.start()
  quitting.advance(100)
  quitting.controller.mainReady()
  quitting.controller.beforeQuit()
  quitting.advance(SPLASH_MAX_VISIBLE_MS)

  assert.equal(quitting.at('closeSplash'), undefined, 'a quitting app does not close the splash')
  assert.equal(quitting.at('showMain'), undefined, 'a quitting app starts no dismissal')
  assert.equal(quitting.pending(), 0, 'before-quit cancels pending timers')
  results.push('closed and before-quit cancel pending timers')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('floor: ready-to-show before 400 ms waits', readyBeforeFloorWaits)
  step('floor: ready-to-show after 400 ms closes now', readyAfterFloorClosesImmediately)
  step('cap: 5000 ms dismissal', capDismisses)
  step('failure: load/renderer failure dismisses', failureDismisses)
  step('idempotency: double dismissal', doubleDismissIsNoOp)
  step('cancellation: closed and before-quit', closedAndQuitCancelTimers)

  console.log(`splash controller: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

try {
  main()
} catch (err) {
  console.error('SPLASH CONTROLLER TEST FAILED:', err)
  process.exit(1)
}
