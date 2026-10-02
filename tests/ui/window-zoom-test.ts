/**
 * The titlebar's view acts: the zoom rule, and the four window commands that use it.
 *
 * Two halves of one claim. The rule is arithmetic — half a level per step, a reset to the original size,
 * and two bounds the ladder cannot be walked past — so it is checked by calling it. The acts are main
 * process work on a window handle, so they are checked by handing them a handle that records what it was
 * asked to do: which method the act reached, with which number, and what it refuses with when there is
 * no window to reach.
 *
 * The refusal is the part that matters most, and the reason it is asserted as a *code* rather than as
 * words: the renderer branches on `ConveyorError.code` and never on a message, so a handler that let an
 * electron string through — "Object has been destroyed" — would be a failure nothing downstream could
 * name.
 */
import { strict as assert } from 'node:assert'
import { ConveyorError } from 'electron-conveyor/main'
import {
  FULLSCREEN_UNAVAILABLE,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  ZOOM_UNAVAILABLE,
  zoomNext,
} from '../../conveyor/protocol/window'
import { windowModule } from '../../conveyor/modules/window'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- a handle to act on

/**
 * A window handle as the module sees one, with every call it receives written down.
 *
 * Deliberately not a BrowserWindow: what is under test is which of the handle's own behaviours an act
 * reaches and with what number, and a real window would answer those questions with a running Chromium.
 */
function stubHandle(level = 0, fullscreen = false) {
  const calls: string[] = []
  const handle = {
    webContents: {
      getZoomLevel: () => level,
      setZoomLevel: (next: number) => {
        level = next
        calls.push(`setZoomLevel(${next})`)
      },
    },
    isFullScreen: () => fullscreen,
    setFullScreen: (next: boolean) => {
      fullscreen = next
      calls.push(`setFullScreen(${next})`)
    },
  }

  return { handle, calls, level: () => level, fullscreen: () => fullscreen }
}

/** One of the four acts, by the name main registers it under. */
type ViewAct = 'zoomIn' | 'zoomOut' | 'resetZoom' | 'toggleFullscreen'

/**
 * Invoke one act the way main does: through the module's own resolver, with a ctx carrying the handle.
 *
 * The resolver is the handler, not a re-implementation of it, so what is asserted below is the code
 * that ships.
 */
function invoke(act: ViewAct, win: unknown): void {
  windowModule.record[act].resolver({ input: undefined, ctx: { window: win } })
}

/** Run an act expected to fail, and hand back the code it failed with. */
function codeOf(fn: () => void): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConveyorError) return err.code
    throw new Error(`expected a ConveyorError, got ${String(err)}`)
  }

  throw new Error('expected a ConveyorError, got no error at all')
}

// ---------------------------------------------------------------- the rule

function theStepAndItsTwoBoundsAreNamedNumbers() {
  assert.equal(ZOOM_STEP, 0.5, 'one step is half a level — the increment the View menu uses')
  assert.equal(ZOOM_MAX, 6, 'the ceiling is level 6')
  assert.equal(ZOOM_MIN, -3.5, 'the floor is level -3.5')
  // Each bound is the outermost half-step inside the range electron documents for its own zoom policy
  // (300% and 50%, and `scale := 1.2 ^ level` is how a level means a percentage). One half-step further
  // out in either direction leaves that range, so the bound is the last one that is still a level the
  // page can be drawn at rather than a number the platform clamps back.
  assert.ok(1.2 ** ZOOM_MAX <= 3, 'the ceiling is inside 300%')
  assert.ok(1.2 ** (ZOOM_MAX + ZOOM_STEP) > 3, 'and one step above it is not')
  assert.ok(1.2 ** ZOOM_MIN >= 0.5, 'the floor is inside 50%')
  assert.ok(1.2 ** (ZOOM_MIN - ZOOM_STEP) < 0.5, 'and one step below it is not')
  results.push('the step is half a level and each bound is the last half-step inside 50%–300%')
}

function zoomStepsUpAndDownByTheNamedIncrement() {
  assert.equal(zoomNext(0, 'in'), 0.5, 'in, from the original size')
  assert.equal(zoomNext(0, 'out'), -0.5, 'out, from the original size')
  assert.equal(zoomNext(1.5, 'in'), 2, 'in, from a level that is already stepped')
  assert.equal(zoomNext(1.5, 'out'), 1, 'out, from the same level')
  // Half a level is exactly representable, so two steps land exactly rather than nearly: a level that
  // drifted by an ulp would be a level the reset below no longer recognises.
  assert.equal(zoomNext(zoomNext(0, 'in'), 'in'), 1, 'two steps up are exactly one level')
  results.push('a step moves the level by the named increment, in both directions')
}

function zoomCapsAtBothBounds() {
  assert.equal(zoomNext(ZOOM_MAX, 'in'), ZOOM_MAX, 'the ceiling is a fixed point going up')
  assert.equal(zoomNext(ZOOM_MAX - 0.25, 'in'), ZOOM_MAX, 'a partial step up stops at the ceiling')
  assert.equal(zoomNext(ZOOM_MAX + 4, 'in'), ZOOM_MAX, 'a level already past the ceiling comes back to it')
  assert.equal(zoomNext(ZOOM_MIN, 'out'), ZOOM_MIN, 'the floor is a fixed point going down')
  assert.equal(zoomNext(ZOOM_MIN + 0.25, 'out'), ZOOM_MIN, 'a partial step down stops at the floor')
  assert.equal(zoomNext(ZOOM_MIN - 4, 'out'), ZOOM_MIN, 'a level already past the floor comes back to it')
  // The bounds are the bounds, not a brake on the way back: from the ceiling, one step down moves.
  assert.equal(zoomNext(ZOOM_MAX, 'out'), ZOOM_MAX - ZOOM_STEP, 'the ceiling still steps down')
  results.push('the level never leaves the two bounds, from either side')
}

function resetReturnsTheOriginalSizeFromAnyLevel() {
  for (const level of [0, 0.5, 2, 4, 6, -1, -3.5, 12, -12]) {
    assert.equal(zoomNext(level, 'reset'), 0, `reset from ${level}`)
  }
  results.push('reset is zero whatever the level was')
}

// ---------------------------------------------------------------- the four acts

function zoomInAndOutStepTheWindowsOwnPage() {
  const up = stubHandle()
  invoke('zoomIn', up.handle)
  assert.deepEqual(up.calls, ['setZoomLevel(0.5)'], 'zoom in, from the original size')
  assert.equal(up.level(), 0.5, 'the handle is left at the stepped level')

  const down = stubHandle(1.5)
  invoke('zoomOut', down.handle)
  assert.deepEqual(down.calls, ['setZoomLevel(1)'], 'zoom out, from an already stepped level')
  results.push('zoom in and zoom out set the handle to the rule’s next level')
}

function resetReturnsTheWindowToActualSize() {
  const handle = stubHandle(2.5)
  invoke('resetZoom', handle.handle)
  assert.deepEqual(handle.calls, ['setZoomLevel(0)'], 'reset, from a zoomed level')
  assert.equal(handle.level(), 0, 'and it is the original size afterwards')
  results.push('reset sets the handle back to zero from any level')
}

function fullscreenTogglesTheWindowsOwnState() {
  const windowed = stubHandle()
  invoke('toggleFullscreen', windowed.handle)
  assert.deepEqual(windowed.calls, ['setFullScreen(true)'], 'from windowed')
  assert.equal(windowed.fullscreen(), true, 'the window is fullscreen afterwards')

  const fullscreen = stubHandle(0, true)
  invoke('toggleFullscreen', fullscreen.handle)
  assert.deepEqual(fullscreen.calls, ['setFullScreen(false)'], 'from fullscreen')
  assert.equal(fullscreen.fullscreen(), false, 'and it is windowed again')

  // No state is kept anywhere: the handle's own answer is the only thing either act consulted.
  assert.equal(stubHandle(0, true).handle.isFullScreen(), true, 'the stub starts where it was told to')
  results.push('fullscreen flips the handle’s own state, with nothing remembered between calls')
}

function anActWithNoWindowRefusesWithItsOwnCode() {
  for (const act of ['zoomIn', 'zoomOut', 'resetZoom'] as const) {
    assert.equal(
      codeOf(() => invoke(act, undefined)),
      ZOOM_UNAVAILABLE,
      `${act} with no window`
    )
    assert.equal(
      codeOf(() => invoke(act, null)),
      ZOOM_UNAVAILABLE,
      `${act} with a null handle`
    )
  }
  assert.equal(
    codeOf(() => invoke('toggleFullscreen', undefined)),
    FULLSCREEN_UNAVAILABLE,
    'fullscreen'
  )

  // The two codes have to be distinct and stated: a renderer told "this window cannot zoom" must not be
  // the same branch as the one told it cannot go fullscreen.
  assert.equal(ZOOM_UNAVAILABLE, 'ZOOM_UNAVAILABLE', 'the zoom code')
  assert.equal(FULLSCREEN_UNAVAILABLE, 'FULLSCREEN_UNAVAILABLE', 'the fullscreen code')
  assert.notEqual(ZOOM_UNAVAILABLE, FULLSCREEN_UNAVAILABLE, 'and they are not each other')
  results.push('each act with no window refuses under its own code')
}

function aHandleThatThrowsSurfacesTheSameCodeRatherThanItsMessage() {
  // A window that has been destroyed answers neither of these; electron throws its own sentence at the
  // property access, and that sentence is exactly what must not reach the renderer.
  const destroyed = {
    get webContents(): never {
      throw new Error('Object has been destroyed')
    },
  }
  assert.equal(
    codeOf(() => invoke('zoomIn', destroyed)),
    ZOOM_UNAVAILABLE,
    'a destroyed window'
  )
  assert.equal(
    codeOf(() => invoke('resetZoom', destroyed)),
    ZOOM_UNAVAILABLE,
    'on the reset act too'
  )
  assert.equal(
    codeOf(() => invoke('toggleFullscreen', destroyed)),
    FULLSCREEN_UNAVAILABLE,
    'and the fullscreen act refuses under its own code, not the zoom one'
  )

  // A page that refuses the level is the same refusal: the code is what a caller can act on, and a
  // thrown message is not.
  const refusing = {
    ...stubHandle().handle,
    webContents: {
      getZoomLevel: () => 0,
      setZoomLevel: () => {
        throw new Error('cannot set zoom level on a destroyed page')
      },
    },
  }
  const code = codeOf(() => invoke('zoomIn', refusing))
  assert.equal(code, ZOOM_UNAVAILABLE, 'a page that refuses the write')
  assert.equal(typeof code, 'string', 'and the refusal is a code, not a message')
  results.push('a handle that throws surfaces the act’s own code, never its message')
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('rule: constants', theStepAndItsTwoBoundsAreNamedNumbers)
  await step('rule: step', zoomStepsUpAndDownByTheNamedIncrement)
  await step('rule: bounds', zoomCapsAtBothBounds)
  await step('rule: reset', resetReturnsTheOriginalSizeFromAnyLevel)
  await step('acts: zoom', zoomInAndOutStepTheWindowsOwnPage)
  await step('acts: reset', resetReturnsTheWindowToActualSize)
  await step('acts: fullscreen', fullscreenTogglesTheWindowsOwnState)
  await step('acts: no window', anActWithNoWindowRefusesWithItsOwnCode)
  await step('acts: failing handle', aHandleThatThrowsSurfacesTheSameCodeRatherThanItsMessage)

  console.log(`window zoom: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('WINDOW ZOOM TEST FAILED:', err)
  process.exit(1)
})
