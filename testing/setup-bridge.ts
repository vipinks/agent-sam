import { afterEach, beforeEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'
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

/**
 * jsdom implements no pointer capture, and Radix's Select takes it on its trigger as it opens.
 *
 * The picker cannot be opened at all without this: the take throws inside Radix's own pointer
 * handler, which React reports as an error during the click rather than as a missing method. A no-op is
 * the honest stand-in — nothing here asserts on capture, and a headless document has no pointer to lose.
 * `scrollIntoView` is jsdom's other hole and is reached the moment a listbox with a highlighted item
 * mounts, so it is filled in beside it.
 */
if (typeof HTMLElement.prototype.setPointerCapture !== 'function') {
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
}
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {}
}

beforeEach(() => {
  setActiveStub(createBridgeStub())
})

/**
 * How long a `find*` query waits, raised for the reason `testTimeout` is raised in `vitest.config.ts`.
 *
 * Testing Library's own default is 1000ms, and it is a *separate* allowance from the test timeout: the
 * runner's 20s governs how long a test may take, not how long one query waits before it gives up. So a
 * suite could still fail on a green tree — the observed case is `explorer-double-click.test.tsx`, whose
 * first row lookup timed out while the workbench was still rendering under the full 95-file parallel
 * run, and passed unattended in isolation. Nothing about the assertion was wrong; the wait was.
 *
 * Five seconds, and the assertions are untouched: a query that now waits still has to find the node, and
 * a genuinely missing node still fails. The margin is about machine contention, not about which query
 * happens to be running when it happens — which is the same reasoning the runner's own timeout carries.
 */
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
})
