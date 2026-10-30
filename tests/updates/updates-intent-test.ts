/**
 * The install intent: the pair every install is performed with, and the marker written before it starts.
 *
 * The marker is what makes the next launch able to say an install did not finish, so its ordering is the
 * claim: it must exist by the time `quitAndInstall` is called, not be written afterwards on a process that
 * is already leaving. The suite wraps the updater's own call and reads the file from inside it — a marker
 * written one line later would fail here even though a file existed at the end of the test.
 *
 * The pair is restated rather than imported: `UPDATES_INSTALL_IS_SILENT` and
 * `UPDATES_INSTALL_IS_FORCE_RUN_AFTER` are the claim, and the visible fallback's `(false, true)` is a
 * different act, asserted in the recovery suite's company rather than folded into this one.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  startUpdateSchedule,
  updatesModule,
  UPDATES_INSTALL_IS_FORCE_RUN_AFTER,
  UPDATES_INSTALL_IS_SILENT,
} from '../../conveyor/modules/updates'
import type { PendingInstall } from '../../conveyor/protocol/updates'
import { armUpdaterHarness } from './updates-module-harness'

const results: string[] = []

function markerPath(): string {
  return join(app.getPath('userData'), 'pending-update.json')
}

/** The module's own install act, as the authoring primitive hands it to the router. */
function installCommand(): () => void {
  return (updatesModule.record.install as unknown as { resolver: () => void }).resolver
}

/** The shipped pair is unchanged: the silent install is still the one the button performs. */
function theSilentPairIsUnchanged() {
  assert.equal(UPDATES_INSTALL_IS_SILENT, true, 'the install stays silent')
  assert.equal(UPDATES_INSTALL_IS_FORCE_RUN_AFTER, true, 'and brings the app back up')

  results.push('UPDATES_INSTALL_IS_SILENT and UPDATES_INSTALL_IS_FORCE_RUN_AFTER remain true')
}

/** The marker exists at the moment quitAndInstall is called, and carries the downloaded update. */
function theIntentIsRecordedBeforeTheInstallerStarts() {
  const harness = armUpdaterHarness()
  startUpdateSchedule()

  const installer = join(app.getPath('userData'), 'updater', 'AgentSam-1.3.0-setup.exe')
  harness.emitUpdater('update-downloaded', { version: '1.3.0', downloadedFile: installer })
  harness.setState('ready')

  const updater = autoUpdater as unknown as { quitAndInstall: (silent?: boolean, force?: boolean) => void }
  const original = updater.quitAndInstall
  const capture: { marker: PendingInstall | null } = { marker: null }
  updater.quitAndInstall = (silent, force) => {
    capture.marker = JSON.parse(readFileSync(markerPath(), 'utf8')) as PendingInstall
    original.call(updater, silent, force)
  }

  try {
    installCommand()()
  } finally {
    updater.quitAndInstall = original
  }

  assert.ok(capture.marker !== null, 'the marker exists when the installer is asked to run')
  const recorded = capture.marker as PendingInstall
  assert.equal(recorded.version, '1.3.0', 'it names the version being installed')
  assert.equal(recorded.installerPath, installer, 'and the file that was downloaded')
  assert.equal(typeof recorded.at, 'number', 'with the time of the attempt')
  assert.equal(Number.isFinite(recorded.at), true, 'as a real timestamp')

  assert.deepEqual(
    harness.installs,
    [{ isSilent: true, isForceRunAfter: true }],
    'the install itself still uses the unchanged silent pair'
  )
  assert.equal(
    (autoUpdater as unknown as { autoInstallOnAppQuit: boolean }).autoInstallOnAppQuit,
    true,
    'the explicit button is the second arm of the signedness gate'
  )

  harness.restore()
  results.push('the install intent is written before quitAndInstall, with version, installer path and time')
}

// ---------------------------------------------------------------- report

function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('silent pair', theSilentPairIsUnchanged)
  step('install intent', theIntentIsRecordedBeforeTheInstallerStarts)

  console.log('update install intent: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

try {
  main()
} catch (err) {
  console.error('UPDATE INSTALL INTENT TEST FAILED:', err)
  process.exit(1)
}
