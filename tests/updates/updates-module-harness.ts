/**
 * The setup the updater-module suites share, and nothing else.
 *
 * The updater module is the only place in this app that talks to electron-updater, and everything it
 * does with it is invisible from outside a packaged build: it configures the updater, subscribes to its
 * events, arms a check schedule, and hands the install a pair of arguments. Two of those are worth a
 * suite of their own — the install the user asks for, and the install the quit performs — and they cannot
 * share a process: the module remembers that it has already asked for an install, so a suite that
 * exercised one path would leave the other's guard already set. Two suites, one setup.
 *
 * Four things have to be arranged before the module is started, and each is a fact about running outside
 * Electron rather than a convenience:
 *
 * - `app.isPackaged` must be true, because every act the module offers refuses an unpackaged build. The
 *   double reads that off the environment, so the suite sets it before starting the schedule.
 * - The check schedule arms a `setTimeout` and a `setInterval`. Neither is what either suite is about —
 *   both drive the acts directly — and a live interval would keep the report from ever ending. They are
 *   replaced for the duration and put back afterwards.
 * - `LOCALAPPDATA` is pointed at a fresh temp directory, so the startup cache cleanup (if this build has
 *   it) can never walk into a real user's updater cache. The directory is removed when the suite is done.
 * - The status mirror and the auto-download preference are installed, because the module reads both: the
 *   mirror is what decides whether an install is welcome at all, and the preference is what it applies to
 *   the updater before a check.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { setAutoDownloadSource, setUpdateStatusSink } from '../../conveyor/modules/updates'
import type { UpdateState } from '../../conveyor/protocol/updates'

/** One recorded install, exactly as the module handed it over — arguments included when it passed none. */
export interface RecordedInstall {
  isSilent?: boolean
  isForceRunAfter?: boolean
}

export interface UpdaterHarness {
  /** Put the mirror into one state, as main does when electron-updater reports a transition. */
  setState: (state: UpdateState) => void
  /** Every install the module asked the updater for, in order. */
  installs: RecordedInstall[]
  /** The events the module subscribed to, by name. */
  events: Map<string, Set<(...args: unknown[]) => void>>
  /** Emit an app event, as Electron would. */
  emit: (event: string) => void
  /** The version the module recorded for the running build, or undefined while it recorded none. */
  currentVersion: () => string | undefined
  /** Put the process back: real timers, the caller's environment, and the temp cache directory gone. */
  restore: () => void
}

/** The updater's own surface, as the double exposes it for a suite to read. */
function updaterRecord() {
  return autoUpdater as unknown as {
    __installs: RecordedInstall[]
    __events: Map<string, Set<(...args: unknown[]) => void>>
  }
}

/** The app double's own trigger for an app-level event. Not an Electron API. */
function appStub() {
  return app as unknown as { __emit: (event: string, ...args: unknown[]) => void }
}

/**
 * Arrange everything the module needs, and hand back the handles a suite asserts through.
 *
 * Nothing here starts the schedule: the two suites differ in what they do after it is started, and one of
 * them is about the instant *before* any check has run.
 */
export function armUpdaterHarness(): UpdaterHarness {
  const updater = updaterRecord()

  // Recorded, then cleared: the suites are about the calls their own acts make, and a record carried over
  // from a previous case would let an assertion pass on someone else's install.
  updater.__installs.length = 0

  const previousLocalAppData = process.env.LOCALAPPDATA
  const cache = mkdtempSync(join(tmpdir(), 'sam-ai-updater-cache-'))
  process.env.LOCALAPPDATA = cache
  process.env.SAM_TEST_PACKAGED = '1'

  const realTimeout = globalThis.setTimeout
  const realInterval = globalThis.setInterval
  globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout
  globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval

  let mirror: UpdateState = 'idle'
  let current: string | undefined

  setUpdateStatusSink({
    read: () => mirror,
    setCurrentVersion: (version) => {
      current = version
    },
    startChecking: () => undefined,
    recordAvailable: () => undefined,
    recordUpToDate: () => undefined,
    startDownloading: () => undefined,
    recordReady: () => undefined,
    recordError: () => undefined,
  })

  // The shipped default, stated rather than assumed: a check downloads unless a user said otherwise.
  setAutoDownloadSource(() => true)

  return {
    setState: (state) => {
      mirror = state
    },
    installs: updater.__installs,
    events: updater.__events,
    emit: (event) => appStub().__emit(event),
    currentVersion: () => current,
    restore: () => {
      globalThis.setTimeout = realTimeout
      globalThis.setInterval = realInterval
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = previousLocalAppData
      delete process.env.SAM_TEST_PACKAGED
      rmSync(cache, { recursive: true, force: true })
    },
  }
}
