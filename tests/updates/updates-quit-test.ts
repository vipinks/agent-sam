/**
 * The install a quit performs: the same act, the same two arguments, and the guard that keeps it one.
 *
 * A downloaded update installs when the app quits — on a signed build, which is the only build whose quit
 * registers the listener (`buildIsSigned` gates both it and `autoInstallOnAppQuit`). That is what makes the
 * flow a background one, and it is why the Updates section can offer an install *now* as an alternative
 * rather than as the only way to get one. What the quit path must not do is differ from the button: a quit
 * that ran the installer with the wizard, while the button ran it silently, would be two different installs
 * of one update depending on how the user happened to leave. The unsigned half — a quit installs nothing — is
 * asserted beside this suite, in `updates-recovery-test.ts`.
 *
 * The two arguments are therefore asserted here exactly as they are beside this file, against the call
 * `quitAndInstall` receives. The pair is load-bearing at both ends: electron-updater turns `isSilent` into
 * `/S`, and electron-builder's own assisted-installer script relaunches the app only when the run is both
 * silent *and* force-run — so a quit that named the first and not the second would install the update and
 * leave the user with nothing on screen.
 *
 * Three claims, and the second is the one that is easy to get wrong:
 *
 * - A quit with nothing downloaded installs nothing. The mirror is the only thing that says there is an
 *   update to install, and an install asked for from any other state would have electron-updater dispatch
 *   its own "no update filepath provided" error — which the mirror would then report as a failed check.
 * - A quit with an update pending installs it once, silently, bringing the app back up.
 * - A second quit event is not a second installer. That is the guard's whole job: the install asks the app
 *   to quit, so the event that triggered it fires again, and an unguarded second pass would install the
 *   same build while the first installer is still running.
 *
 * Residual, named rather than claimed: this proves the arguments this app hands over, and that the quit
 * event is what hands them over. Whether the installer honours them is provable only on a packaged update
 * cycle, one release after this ships.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startUpdateSchedule } from '../../conveyor/modules/updates'
import { armUpdaterHarness, type RecordedInstall } from './updates-module-harness'

const results: string[] = []

/** The pair every install this app performs is performed with. Stated, not imported: this is the claim. */
const EXPECTED: RecordedInstall = { isSilent: true, isForceRunAfter: true }

// A signed build, arranged before the schedule is armed: the quit-time listener is registered only when
// app-update.yml names a publisher, which is the gate this suite is the signed half of. The real resources
// directory is put back at the end, so the other suites' environment is left as it was.
const resources = mkdtempSync(join(tmpdir(), 'sam-ai-signed-resources-'))
writeFileSync(join(resources, 'app-update.yml'), 'provider: github\npublisherName: Agent Sam\n', 'utf8')
const realResourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
;(process as unknown as { resourcesPath?: string }).resourcesPath = resources

// One schedule, armed once, before either step: both steps are about the same listener, and starting the
// updater twice would subscribe the mirror's six events twice over.
const harness = armUpdaterHarness()
startUpdateSchedule()

/** A quit is not an install. Only the mirror saying `ready` makes it one. */
function aQuitWithNothingDownloadedInstallsNothing() {
  for (const state of ['idle', 'checking', 'up-to-date', 'available', 'downloading', 'error'] as const) {
    harness.setState(state)
    harness.emit('before-quit')
    assert.equal(harness.installs.length, 0, `${state}: a quit installs nothing`)
  }

  results.push('a quit installs nothing in any state but `ready`, so the updater is never asked for a missing file')
}

/** The quit's install, and the guard that makes a repeated quit event the same install. */
function theQuitInstallsSilentlyAndOnlyOnce() {
  harness.setState('ready')
  harness.emit('before-quit')

  assert.equal(harness.installs.length, 1, 'a quit with an update pending installs it')
  assert.deepEqual(harness.installs[0], EXPECTED, 'silently, and bringing the app back up')

  // The install asks the app to quit, so this event arrives again on the way out. It must not be a second
  // installer: the first has already claimed the flow and is still running.
  harness.emit('before-quit')
  assert.equal(harness.installs.length, 1, 'and a repeated quit event is not a second install')

  results.push('the install a quit performs passes isSilent and isForceRunAfter true, once and only once')
}

// ---------------------------------------------------------------- report

function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  try {
    step('nothing downloaded', aQuitWithNothingDownloadedInstallsNothing)
    step('quit with an update', theQuitInstallsSilentlyAndOnlyOnce)
  } finally {
    harness.restore()
    const holder = process as unknown as { resourcesPath?: string }
    if (realResourcesPath === undefined) delete holder.resourcesPath
    else holder.resourcesPath = realResourcesPath
    rmSync(resources, { recursive: true, force: true })
  }

  console.log('update install on quit: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

try {
  main()
} catch (err) {
  console.error('UPDATE INSTALL ON QUIT TEST FAILED:', err)
  process.exit(1)
}
