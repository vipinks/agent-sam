// Test double for `electron-updater`, for the node suites.
//
// The real package is the only thing in this app that downloads and installs a release, and it cannot
// run outside a packaged Electron build: it reads `app-update.yml` off `process.resourcesPath`, spawns
// the downloaded installer, and quits the app. None of that is reachable in a suite — and none of it
// is what the suite beside this file is about.
//
// What it *is* about is the pair of arguments this app installs with, and the phase the quit-time
// install happens in. Both are decided in `conveyor/modules/updates.ts` and handed to `quitAndInstall`,
// so a double that records that call is a faithful seam rather than a simplification: the module cannot
// tell this object from the real one by anything it does with it, and can only tell them apart by
// reaching for behaviour it never intended — which is the property a seam of this kind is meant to have.
const listeners = new Map()
const installs = []

const autoUpdater = {
  // The three settings `wireUpdater` applies before a check. Read back by the suite, because whether
  // they are applied at all is part of what makes the flow a background one.
  allowPrerelease: false,
  autoInstallOnAppQuit: false,
  autoDownload: false,

  /** Subscribe to one of electron-updater's own events. Recorded, never dispatched by anything here. */
  on(event, handler) {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
  },

  /** A check. Never called: the schedule that would call it arms timers the suites neutralise. */
  async checkForUpdates() {
    return null
  },

  /** A manual download. Never called: the preference governing it is asserted, not exercised. */
  async downloadUpdate() {
    return null
  },

  /**
   * The act under test.
   *
   * Recorded with both arguments, including the ones left undefined by a caller that passes neither:
   * the whole defect this double exists to catch was a call site that named no arguments at all, so a
   * recording that defaulted them here would hide it.
   */
  quitAndInstall(isSilent, isForceRunAfter) {
    installs.push({ isSilent, isForceRunAfter })
  },

  /** Every `quitAndInstall` call, in order, as the suite's own record. */
  __installs: installs,
  /** The events the module subscribed to, for the suite to assert against. */
  __events: listeners,
}

module.exports = { autoUpdater }
