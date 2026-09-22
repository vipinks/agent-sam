import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createBridgeStub, setActiveStub } from './bridge-stub'

/**
 * Per-test isolation for the DOM suite.
 *
 * Two things have to be reset between tests, and both cost a debugging cycle to discover:
 *
 * - The rendered DOM. Testing Library only auto-cleans when its globals are enabled; this project
 *   runs with `globals: false` for lint simplicity, so cleanup has to be explicit. Without it each
 *   test appends another copy and a `findByText` hits "found multiple elements".
 *
 * - The bridge stub. The app's client is built once at import and reads `window.conveyor` when it
 *   does, so a stub has to exist before any app import — which means this file, registered as a
 *   setup script, is the only place it can be installed. A fresh stub per test keeps call records
 *   from leaking between assertions.
 *
 * `ResizeObserver` is installed once below, for the reason stated there.
 */
setActiveStub(createBridgeStub())

/**
 * jsdom lacks `ResizeObserver`, and Radix's tooltip measures its trigger with it.
 *
 * A tooltip now sits on each session row's actions — pencil, download, trash — so hovering a row in a
 * test mounts Radix's popper, which calls `useSize`, which reads `ResizeObserver` at mount. In jsdom
 * that is a `ReferenceError` thrown inside a layout effect: React tears the whole tree down, and the
 * failure surfaces in the next test as "Unable to find a label" against an empty body. The symptom
 * points away from its own cause, which is why it is fixed here once rather than worked around per
 * test.
 *
 * A no-op is honest here rather than a stub of behaviour under test: nothing asserts on a measured
 * size, and an observer that never fires leaves Radix on its initial layout — which is what these
 * assertions describe.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

/**
 * jsdom implements no media queries either, and the shell's theme store reads two of them.
 *
 * `initialTheme` asks whether the OS prefers light, and `withTransition` asks whether motion is turned
 * down before it reaches for a view transition. Without this, the second read is a `ReferenceError`
 * thrown from inside `toggle()` — a theme flip that cannot be exercised at all, which is why this is a
 * prerequisite for testing the toggle rather than a convenience.
 *
 * `matches: false` for every query is the honest answer for a headless document: no preference is
 * expressed for anything, so the code takes the branch it takes when a user has expressed none — the OS
 * preference defaults to dark and the motion path falls through to the instant swap, because jsdom has
 * no `document.startViewTransition` either.
 *
 * Guarded on `typeof`, not on `'matchMedia' in globalThis`. jsdom defines the property as a stub that
 * throws when called, so an `in` test sees it as present and leaves it in place — which is how the first
 * run of the toggle suite failed with "matchMedia is not a function". What matters is whether it can be
 * called, so that is what is checked.
 */
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}

beforeEach(() => {
  setActiveStub(createBridgeStub())
})

afterEach(() => {
  cleanup()
})
