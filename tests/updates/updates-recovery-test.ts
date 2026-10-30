/**
 * The recovery half of the updater: the marker a blocked install leaves, the signedness gate, and the log.
 *
 * Every claim here is about a seam that only exists outside a packaged update cycle: the marker file's
 * write/read contract, the setting that decides whether a quit may install, and the logger the updater is
 * handed. The updater itself is the suite's double, as in the install suites — the real one spawns an
 * installer and quits the app.
 *
 * The marker is read the way the next launch reads it: through `restorePendingInstall`, into the mirror the
 * notice draws from. The version table is the contract, including 1.10 against 1.9 — the string comparison
 * that would call 1.10 older is the mistake the numeric reader exists to avoid.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  buildIsSigned,
  restorePendingInstall,
  startUpdateSchedule,
  updatesModule,
} from '../../conveyor/modules/updates'
import type { PendingInstall } from '../../conveyor/protocol/updates'
import { armUpdaterHarness } from './updates-module-harness'

const results: string[] = []

/** The marker's path, derived the way the module derives it: userData, never a hardcoded directory. */
function markerPath(): string {
  return join(app.getPath('userData'), 'pending-update.json')
}

/** The log's expected path: `%APPDATA%\era\logs\updater.log` in a packaged app, under the suite's userData. */
function logPath(): string {
  return join(app.getPath('userData'), 'logs', 'updater.log')
}

function marker(version: string): PendingInstall {
  return {
    version,
    installerPath: join(app.getPath('userData'), 'cache', `AgentSam-${version}-setup.exe`),
    at: 1,
  }
}

function writeMarker(value: unknown): void {
  writeFileSync(markerPath(), JSON.stringify(value), 'utf8')
}

/** The app version the electron stub reports, put back afterwards. */
function withAppVersion<T>(version: string, run: () => T): T {
  const previous = process.env.SAM_TEST_APP_VERSION
  process.env.SAM_TEST_APP_VERSION = version
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.SAM_TEST_APP_VERSION
    else process.env.SAM_TEST_APP_VERSION = previous
  }
}

/** A resources directory holding (or not holding) an app-update.yml with a publisher. */
function withResources<T>(publisher: string | null, run: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'sam-ai-resources-'))
  if (publisher !== null) {
    writeFileSync(join(directory, 'app-update.yml'), `provider: github\npublisherName: ${publisher}\n`, 'utf8')
  }
  const holder = process as unknown as { resourcesPath?: string }
  const previous = holder.resourcesPath
  holder.resourcesPath = directory
  try {
    return run()
  } finally {
    if (previous === undefined) delete holder.resourcesPath
    else holder.resourcesPath = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

function configuredUpdater() {
  return autoUpdater as unknown as { autoInstallOnAppQuit: boolean; logger: Record<string, unknown> | null }
}

/** The launch reads the marker before the packaged gate and hands it to the notice's mirror, then forgets it. */
function theLaunchTakesTheMarkerAndClearsIt() {
  const harness = armUpdaterHarness()
  const pending = marker('1.3.0')
  writeMarker(pending)

  withAppVersion('1.2.0', () => startUpdateSchedule())

  assert.deepEqual(harness.pendingInstall(), pending, 'the marker is handed to the mirror')
  assert.equal(existsSync(markerPath()), false, 'and cleared after surfacing, so the next launch stays quiet')

  harness.restore()
  results.push('the launch reads the install intent, surfaces it once, and clears the file')
}

/** The read contract: younger build gets the marker, at-or-past it does not, and both consume the file. */
function theMarkerIsReadOnlyWhenTheBuildIsOlder() {
  const harness = armUpdaterHarness()
  const cases = [
    { running: '1.2.0', installing: '1.3.0', returned: true },
    { running: '1.3.0', installing: '1.3.0', returned: false },
    { running: '1.4.0', installing: '1.3.0', returned: false },
    { running: '1.10.0', installing: '1.9.0', returned: false },
  ] as const

  for (const item of cases) {
    const pending = marker(item.installing)
    writeMarker(pending)
    const restored = withAppVersion(item.running, () => restorePendingInstall())
    if (item.returned) assert.deepEqual(restored, pending, `${item.running} < ${item.installing} returns the marker`)
    else assert.equal(restored, null, `${item.running} >= ${item.installing} returns null`)
    assert.equal(existsSync(markerPath()), false, 'the marker is consumed either way')
  }

  writeFileSync(markerPath(), 'not a marker', 'utf8')
  assert.equal(restorePendingInstall(), null, 'an unreadable marker is not a notice')
  assert.equal(existsSync(markerPath()), false, 'and does not outlive the launch that found it')

  harness.restore()
  results.push('the marker is returned only while the running build is older, numerically, and is always consumed')
}

/** An unsigned build neither turns the setting on nor installs when the app quits. */
function anUnsignedBuildDoesNotInstallOnQuit() {
  const harness = armUpdaterHarness()

  withResources(null, () => {
    startUpdateSchedule()
    assert.equal(buildIsSigned(), false, 'no publisher in app-update.yml means unsigned')
    assert.equal(configuredUpdater().autoInstallOnAppQuit, false, 'so the quit-time install is off')

    harness.setState('ready')
    harness.emit('before-quit')
    assert.equal(harness.installs.length, 0, 'a quit does not start an installer an unsigned build cannot run')
  })

  harness.restore()
  results.push('an unsigned build gates autoInstallOnAppQuit off and its quit installs nothing')
}

/** A signed build turns the setting on and its quit performs the silent install. */
function aSignedBuildInstallsOnQuit() {
  const harness = armUpdaterHarness()

  withResources('Agent Sam', () => {
    startUpdateSchedule()
    assert.equal(buildIsSigned(), true, 'a publisher in app-update.yml means signed')
    assert.equal(configuredUpdater().autoInstallOnAppQuit, true, 'so the quit-time install is allowed')

    harness.setState('ready')
    harness.emit('before-quit')
    assert.equal(harness.installs.length, 1, 'one quit is one install')
    assert.deepEqual(harness.installs[0], { isSilent: true, isForceRunAfter: true }, 'silently, bringing the app back')
  })

  harness.restore()
  results.push('a signed build gates autoInstallOnAppQuit on and its quit installs silently, once')
}

/** The updater is handed a logger that appends timestamped lines to the app's own logs directory. */
function theUpdaterLogsToItsOwnFile() {
  const harness = armUpdaterHarness()
  rmSync(logPath(), { force: true })
  startUpdateSchedule()

  const logger = configuredUpdater().logger
  assert.ok(logger !== null, 'the updater is handed a logger rather than its console default')
  for (const level of ['info', 'warn', 'error', 'debug']) {
    assert.equal(typeof logger[level], 'function', `${level} is one of the four methods`)
  }

  const write = logger as Record<string, (message: string) => void>
  write.info('checking')
  write.warn('careful')
  write.error('broken')
  write.debug('detail')

  assert.equal(existsSync(logPath()), true, 'the log is created at the expected path on first write')
  const lines = readFileSync(logPath(), 'utf8').trim().split('\n')
  assert.equal(lines.length, 4, 'one line per call')
  for (const [index, level] of ['info', 'warn', 'error', 'debug'].entries()) {
    assert.match(lines[index], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z \\[${level}\\] `))
  }

  harness.restore()
  results.push('autoUpdater.logger writes timestamped lines to userData/logs/updater.log, with no dependency')
}

/** The recovery action hands the pending installer to the OS's file manager. */
function showInstallerOpensThePendingFile() {
  const harness = armUpdaterHarness()
  const pending = marker('1.3.0')
  writeMarker(pending)
  withAppVersion('1.2.0', () => restorePendingInstall())

  const record = shell as unknown as { __shownInFolder: () => string[] }
  const before = record.__shownInFolder().length
  const resolver = (updatesModule.record.showInstaller as unknown as { resolver: () => void }).resolver
  resolver()

  assert.deepEqual(record.__shownInFolder().slice(before), [pending.installerPath], 'the marker’s file, and only it')

  harness.restore()
  results.push('Show installer calls shell.showItemInFolder with the pending installer’s path')
}

// ---------------------------------------------------------------- report

function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('launch', theLaunchTakesTheMarkerAndClearsIt)
  step('read contract', theMarkerIsReadOnlyWhenTheBuildIsOlder)
  step('unsigned gate', anUnsignedBuildDoesNotInstallOnQuit)
  step('signed gate', aSignedBuildInstallsOnQuit)
  step('logger', theUpdaterLogsToItsOwnFile)
  step('show installer', showInstallerOpensThePendingFile)

  console.log('update recovery: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

try {
  main()
} catch (err) {
  console.error('UPDATE RECOVERY TEST FAILED:', err)
  process.exit(1)
}
