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
 */
setActiveStub(createBridgeStub())

beforeEach(() => {
  setActiveStub(createBridgeStub())
})

afterEach(() => {
  cleanup()
})
