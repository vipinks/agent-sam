/**
 * The install a user asks for: the pair of arguments it is performed with, and the wiring around it.
 *
 * The defect this suite is written against is a call site that named no arguments at all. electron-updater
 * reads `isSilent` as "pass `/S` to the installer", so a call that omits it runs the assisted NSIS wizard
 * the user already declined by clicking Install and restart — a Next button in a flow whose whole point is
 * that there is nothing left to decide. `isForceRunAfter` is the same kind of fact for the other end: with
 * `oneClick: false`, electron-builder's own script relaunches the app only when the run is *both* silent
 * and force-run (`templates/nsis/installSection.nsh`, the assisted branch), so an install that named the
 * first and not the second would silently leave the user with no app.
 *
 * What is asserted is therefore exactly what crosses the seam: the arguments, in order, on every install
 * the module performs — and that a second request while the mirror says an install is under way is not a
 * second install. The updater itself is a double; it cannot be otherwise, since the real one spawns an
 * installer and quits the app. That the double is faithful where it matters is the point: it records the
 * call rather than accepting it, so a caller that passes neither argument is a recorded `(undefined,
 * undefined)` rather than a call that looks the same as a correct one.
 *
 * The rest of the module is asserted here too, because it is the same act's company: the three settings
 * that make the flow a background one, the six events the mirror is driven by, and the refusal an
 * unpackaged build gets instead of any of it.
 *
 * Residual, named rather than claimed: this proves the arguments this app hands over. Whether the
 * installer honours them — no wizard, and the app back up afterwards — is provable only on a packaged
 * update cycle, one release after this ships.
 */
import { strict as assert } from 'node:assert'
import { autoUpdater } from 'electron-updater'
import { UPDATES_DISABLED_IN_DEV } from '../../conveyor/protocol/updates'
import { startUpdateSchedule, updatesModule } from '../../conveyor/modules/updates'
import { armUpdaterHarness, type RecordedInstall } from './updates-module-harness'

const results: string[] = []

/** The pair every install this app performs is performed with. Stated, not imported: this is the claim. */
const EXPECTED: RecordedInstall = { isSilent: true, isForceRunAfter: true }

/** The six events the mirror is built from — the whole of what electron-updater reports. */
const WIRED_EVENTS = [
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'error',
]

/** The module's own `install` act, as the authoring primitive hands it to the router. */
function installCommand(): () => void {
  return (updatesModule.record.install as unknown as { resolver: () => void }).resolver
}

/** The updater double's three settings, read back for the assertions below. */
function configuredUpdater() {
  return autoUpdater as unknown as { allowPrerelease: boolean; autoInstallOnAppQuit: boolean; autoDownload: boolean }
}

/**
 * The updater is configured the way the design names, and no other way.
 *
 * Three settings, and each is a decision rather than a default: `allowPrerelease` false keeps a beta build
 * from being offered betas as a matter of course, `autoInstallOnAppQuit` true is what makes the flow a
 * background one, and `autoDownload` follows the user's preference. A fourth is not asserted because it is
 * not applied: nothing here touches the publish configuration or the feed.
 */
function theUpdaterIsConfiguredForABackgroundFlow() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()

  const configured = configuredUpdater()
  assert.equal(configured.allowPrerelease, false, 'the non-prerelease channel is stated, not inferred')
  assert.equal(configured.autoInstallOnAppQuit, true, 'a downloaded update installs when the app quits')
  assert.equal(configured.autoDownload, true, 'and the download is not held back behind another click')

  // The running build's version is recorded before any check, which is the state the app spends most of
  // its life in: a surface can say what it is updating *from* without waiting for the feed.
  assert.equal(harness.currentVersion(), '0.0.0-test', 'the mirror carries this build’s version from the start')

  harness.restore()
  results.push('the updater is configured for a background flow, and this build’s version is mirrored at once')
}

/** Every event electron-updater raises becomes one transition in the mirror, so all six are subscribed. */
function everyReportedEventIsSubscribed() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()

  for (const event of WIRED_EVENTS) {
    assert.ok(harness.events.has(event), `${event}: subscribed`)
    assert.ok((harness.events.get(event) as Set<unknown>).size > 0, `${event}: with a handler`)
  }
  assert.equal(harness.events.size, WIRED_EVENTS.length, 'and nothing is subscribed that the design omits')

  harness.restore()
  results.push('all six of the updater’s events are wired to the mirror, and nothing else is subscribed')
}

/**
 * The act the Updates section's button reaches performs one install, silently, and brings the app back.
 *
 * Called through the module's own command resolver rather than through a helper beside it, so the wiring
 * the router registers is what is exercised: a command that reached a different function than the one the
 * quit path uses would be two installs, not one.
 */
function theInstallIsSilentAndRelaunches() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()
  harness.setState('ready')

  installCommand()()

  assert.equal(harness.installs.length, 1, 'one request is one install')
  assert.deepEqual(harness.installs[0], EXPECTED, 'and it is performed silently, bringing the app back up')

  // A second press cannot be a second installer: the first one has already claimed the flow, and a second
  // spawn would install the same build twice while the first is still running.
  installCommand()()
  assert.equal(harness.installs.length, 1, 'a repeated request is refused rather than repeated')

  harness.restore()
  results.push('the install the user asks for passes isSilent and isForceRunAfter true, exactly once')
}

/**
 * An install is only ever asked for when there is one to install.
 *
 * The mirror is what says so. Installing from any other state would have electron-updater dispatch its own
 * "no update filepath provided" error, which the mirror would then report as a failed *check* — a status
 * line about the network for an act the user did not perform.
 */
function anInstallIsRefusedWhileThereIsNothingToInstall() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()

  for (const state of ['idle', 'checking', 'up-to-date', 'available', 'downloading', 'error'] as const) {
    harness.setState(state)
    installCommand()()
    assert.equal(harness.installs.length, 0, `${state}: nothing is installed`)
  }

  harness.restore()
  results.push('no state but `ready` installs anything, so the updater is never asked for a missing file')
}

/** An unpackaged build refuses the act with its own code, before the updater is touched at all. */
function anUnpackagedBuildRefusesTheAct() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()
  harness.setState('ready')

  process.env.SAM_TEST_PACKAGED = '0'
  try {
    assert.throws(
      () => installCommand()(),
      (error: unknown) => (error as { code?: string }).code === UPDATES_DISABLED_IN_DEV,
      'the refusal carries the code the renderer branches on'
    )
    assert.equal(harness.installs.length, 0, 'and the updater is never reached')
  } finally {
    process.env.SAM_TEST_PACKAGED = '1'
    harness.restore()
  }

  results.push('an unpackaged build refuses the install with UPDATES_DISABLED_IN_DEV, not a message')
}

// ---------------------------------------------------------------- report

function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('configuration', theUpdaterIsConfiguredForABackgroundFlow)
  step('events', everyReportedEventIsSubscribed)
  step('nothing to install', anInstallIsRefusedWhileThereIsNothingToInstall)
  step('install', theInstallIsSilentAndRelaunches)
  step('unpackaged', anUnpackagedBuildRefusesTheAct)

  console.log('update install: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

try {
  main()
} catch (err) {
  console.error('UPDATE INSTALL TEST FAILED:', err)
  process.exit(1)
}
