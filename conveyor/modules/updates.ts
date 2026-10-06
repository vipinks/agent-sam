import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { ConveyorError } from 'electron-conveyor/main'
import { command, defineModule } from '../init'
import {
  DEFAULT_AUTO_DOWNLOAD,
  updateFailureCode,
  UPDATES_DISABLED_IN_DEV,
  type UpdateErrorCode,
  type UpdateState,
} from '../protocol/updates'

/**
 * The updater: a packaged-only check schedule, a background download governed by one preference, and the three
 * acts a surface can ask for.
 *
 * electron-updater does the work; this module is the part that decides *when* it runs and what it is allowed
 * to do, and the part that keeps the renderer's mirror of it honest. Nothing here is reachable in
 * development: `app.isPackaged` is false for every `npm run dev` launch and every unpackaged build, and both
 * the schedule and the three actions refuse there. That is not caution for its own sake — an unpackaged build
 * has no `app-update.yml` to read a feed from, so a check would fail on every launch and offer a status line
 * about a missing file rather than about the app.
 *
 * The failure mode this module exists to avoid is the visible one: an update flow that takes over a window
 * nobody asked to interrupt. So the schedule is quiet — a first check ten seconds after the app is ready, then
 * one every four hours — the download happens in the background, and the install happens on quit. Nothing is
 * announced; the status mirror is what a later surface reads.
 *
 * The updater's own behaviour is provable only in a packaged build. What lives here is the wiring: the
 * schedule's bounds, the settings each check is made under, the three actions and their refusal code, and the
 * events that become transitions in the status store — all of them typed against electron-updater's own
 * declarations, so a method or an event this module names is one the installed version actually has.
 */

/** How long after the app is ready the first check of a packaged launch runs. */
export const UPDATES_FIRST_CHECK_DELAY_MS = 10_000

/** How often a packaged launch checks after that. Four hours: often enough to notice a release, rare enough
 * that the feed is not polled for nothing. */
export const UPDATES_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * What the module tells the status store, and the one thing it asks it.
 *
 * A two-way port rather than a list of callbacks because one decision needs the mirror's own answer: the
 * updater raises a single `error` event for both a failed check and a failed download, so the code a failure
 * carries is decided by the phase the mirror was in when it arrived — and reading the state the renderer also
 * reads is what keeps that from becoming a second copy of it here, drifting.
 *
 * Installed by `conveyor/router.ts`, for the reason every sink there is: the store does not exist until
 * `createRouter` has returned, and this module is imported *by* that file — reaching for the router from here
 * would close the cycle.
 */
export interface UpdateStatusSink {
  /** The state the mirror is in right now. */
  read: () => UpdateState
  setCurrentVersion: (version: string) => void
  startChecking: () => void
  recordAvailable: (version: string, at: number) => void
  recordUpToDate: (at: number) => void
  startDownloading: () => void
  recordReady: (version: string) => void
  recordError: (code: UpdateErrorCode) => void
}

let statusSink: UpdateStatusSink | null = null

/** Install the status store's transitions. Called once, by the router. */
export function setUpdateStatusSink(sink: UpdateStatusSink): void {
  statusSink = sink
}

let autoDownloadSource: () => boolean = () => DEFAULT_AUTO_DOWNLOAD

/**
 * Give the module the user's auto-download preference.
 *
 * Read through a function rather than handed over as a boolean, for the reason the terminal's scrollback
 * preference is: the value a user changes in Settings is not the value this file saw at startup, and the
 * module reads it as it applies its settings before each check — so a change governs the next check rather
 * than a copy taken once and never revisited.
 */
export function setAutoDownloadSource(read: () => boolean): void {
  autoDownloadSource = read
}

/** Whether the updater can do anything at all in this build. False in development and in unpackaged builds. */
function isPackaged(): boolean {
  return app.isPackaged
}

/**
 * Refuse one of the three actions outside a packaged build.
 *
 * The refusal carries a code rather than a sentence, because the renderer branches on codes: a caller in
 * development is told updates are off in this build, which is a fact about the build rather than a failure of
 * the call.
 */
function requirePackaged(): void {
  if (!isPackaged()) {
    throw new ConveyorError(UPDATES_DISABLED_IN_DEV, 'Updates are only available in a packaged build.')
  }
}

/**
 * Configure the updater and subscribe to its report.
 *
 * The settings are the three the approved design names, and each is here rather than in the packaging config
 * because they are decisions about behaviour, not about what is shipped:
 *
 * - `allowPrerelease` false keeps this build on the non-prerelease channel. electron-updater would otherwise
 *   infer the channel from the running version's own prerelease tag, and a beta build would then be offered
 *   betas as a matter of course.
 * - `autoInstallOnAppQuit` true makes the flow a background one: a downloaded update installs when the app
 *   quits, without a window having to be found in the moment.
 * - `autoDownload` follows the user's preference, and is re-applied before every check for the reason
 *   `setAutoDownloadSource` explains.
 *
 * The events are the whole of what the updater reports, and each becomes one transition in the mirror. The
 * `error` event's own `Error` is deliberately dropped: it carries a sentence about an HTTP status or a path,
 * and the code that travels instead is decided by the phase the failure happened in.
 */
function wireUpdater(): void {
  autoUpdater.allowPrerelease = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoDownload = autoDownloadSource()

  statusSink?.setCurrentVersion(app.getVersion())

  autoUpdater.on('checking-for-update', () => {
    statusSink?.startChecking()
  })

  autoUpdater.on('update-available', (info) => {
    statusSink?.recordAvailable(info.version, Date.now())
  })

  autoUpdater.on('update-not-available', () => {
    statusSink?.recordUpToDate(Date.now())
  })

  // The first progress event is the first evidence a download is underway. There is no event that announces one
  // started, and with auto-download on this is what moves the mirror off `available`; once it is off, nothing
  // here acts on later progress — the status carries no percentage, so one transition is all there is to make.
  autoUpdater.on('download-progress', () => {
    if (statusSink?.read() !== 'available') return
    statusSink.startDownloading()
  })

  autoUpdater.on('update-downloaded', (event) => {
    statusSink?.recordReady(event.version)
  })

  autoUpdater.on('error', () => {
    // The phase is read once: a sink that is absent leaves the code at the check's, which is the phase an
    // unwired updater would have failed in anyway.
    const phase = statusSink?.read() ?? 'idle'
    statusSink?.recordError(updateFailureCode(phase))
  })
}

/**
 * Run one check, quietly.
 *
 * Awaited rather than fired and forgotten, so the failure lands in this catch instead of surfacing as an
 * unhandled rejection — and logged at warn rather than reported to the mirror, because the mirror is told by
 * the `error` event that raised the same failure, and two writers of one state are two answers that can
 * disagree.
 */
async function checkForUpdates(): Promise<void> {
  autoUpdater.autoDownload = autoDownloadSource()

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.warn('[updates] check for updates failed', error)
  }
}

/**
 * Wire the updater and start the launch's check schedule.
 *
 * Called from the app-ready hook in `lib/main/main.ts`, which is the first moment electron-updater may be
 * configured at all — and before any window exists, so the mirror already carries this build's version by the
 * time a renderer reads it.
 *
 * Inert in development: nothing is wired, no timer is armed, and the three actions refuse with their own code.
 * The first check is delayed by `UPDATES_FIRST_CHECK_DELAY_MS` rather than run here, because a check is
 * network work and the launch belongs to the window: ten seconds in, the app is up and a slow feed cannot be
 * felt. The interval is not a retry — a failed check waits for the next four-hourly one rather than looping,
 * because the failure the user sees is the status word, not a spinner.
 */
export function startUpdateSchedule(): void {
  if (!isPackaged()) return

  wireUpdater()

  setTimeout(() => void checkForUpdates(), UPDATES_FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkForUpdates(), UPDATES_CHECK_INTERVAL_MS)
}

/**
 * The updater's three acts.
 *
 * Each refuses outside a packaged build with `UPDATES_DISABLED_IN_DEV` before touching the updater, and none of
 * them writes the mirror: the transitions come from the updater's own events, so what the surface reports is
 * what the updater did rather than what the call was asked to do. `download` is the manual half of the
 * auto-download preference, and `install` is the act the quit-time install already performs by default — the
 * two are offered so a later surface can let a user start a download the preference deferred, or install now
 * instead of at quit.
 */
export const updatesModule = defineModule({
  check: command(async () => {
    requirePackaged()
    await checkForUpdates()
  }),

  download: command(async () => {
    requirePackaged()
    await autoUpdater.downloadUpdate()
  }),

  install: command(() => {
    requirePackaged()
    autoUpdater.quitAndInstall()
  }),
})
