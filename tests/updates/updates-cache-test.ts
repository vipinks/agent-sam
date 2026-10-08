/**
 * The updater's leftover installers: what a packaged startup deletes, and what it must not.
 *
 * The updater downloads the release's NSIS setup into its own cache directory and runs it from there. That
 * copy outlives the installation it performed: once the install has replaced the app, the exe it ran sits in
 * `%LOCALAPPDATA%\agent-sam-updater\pending\` — tens of megabytes that nothing will ever read again, kept
 * because nothing ever removes them. This module is the removal, and it is deliberately the smallest thing
 * that does the job:
 *
 * - **Only installers, and only from that directory.** The sweep walks the updater's own cache root and its
 *   `pending` subdirectory, and deletes the files that are a downloaded NSIS artifact: the `*.exe` setup, its
 *   `*.exe.blockmap`, and the `current.blockmap` differential baseline beside them. Everything else there —
 *   an older installer's own bookkeeping, a `.7z` package, a directory — is left where it is. Nothing
 *   outside the cache root is ever named, and the walk never descends past one level.
 * - **Never while a download is in flight.** A sweep is only for what a *previous* launch left behind: with
 *   a fetch underway the pending directory is a file being written, and deleting it would corrupt the update
 *   this launch is performing. The state is the rule's own, and only `idle` — the state a launch starts in,
 *   before its first check — is swept.
 * - **Best effort, and silent.** A read-only directory, a file locked by an antivirus scanner, a cache root
 *   that has never existed: none of these are events. A failure is swallowed here and reported nowhere in the
 *   UI, because the only user-visible consequence of a failed sweep is that nothing changed. The one thing it
 *   must not do is *create* anything — a sweep on a machine whose updater has never run leaves no trace.
 *
 * Red note, recorded on the defective tree: this suite's first run failed to bundle, because the module it
 * names did not exist — the honest red for a removal that had never been written, rather than an
 * assertion on a function that was there and wrong.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDownloadedInstallers } from '../../lib/main/update-cache'

const results: string[] = []

/**
 * A cache directory laid out the way electron-updater leaves one after an update has installed.
 *
 * The names are the real ones: the installer is the `artifactName` this repo's electron-builder
 * configuration declares (`${name}-${version}-setup.${ext}`), the blockmap is the differential baseline the
 * updater writes beside it, and `update-info.json` is the bookkeeping that points at the exe. The decoys are
 * the files the sweep must leave alone: a package file for the non-NSIS path, a directory, and a stray exe
 * that is not an installer.
 */
function cacheAfterAnUpdate(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-ai-update-cache-'))
  const pending = join(root, 'pending')
  mkdirSync(pending, { recursive: true })

  writeFileSync(join(pending, 'agent-sam-1.4.0-setup.exe'), 'installer bytes')
  writeFileSync(join(pending, 'agent-sam-1.4.0-setup.exe.blockmap'), 'blockmap bytes')
  writeFileSync(join(pending, 'current.blockmap'), 'differential baseline')
  writeFileSync(join(pending, 'update-info.json'), '{"fileName":"agent-sam-1.4.0-setup.exe"}')
  writeFileSync(join(pending, 'package-1.4.0.7z'), 'package bytes')
  writeFileSync(join(root, 'current.blockmap'), 'the older baseline')
  writeFileSync(join(root, 'agent-sam-1.4.0-setup.exe'), 'an older installer at the root')
  mkdirSync(join(pending, 'elsewhere'), { recursive: true })
  writeFileSync(join(pending, 'elsewhere', 'agent-sam-1.4.0-setup.exe'), 'a nested installer')

  return root
}

/** Whether a path is still there. */
function present(path: string): boolean {
  return existsSync(path)
}

/** The installer artifacts a sweep removes, and only those. */
function aPackagedStartupRemovesWhatAnUpdateLeftBehind() {
  const root = cacheAfterAnUpdate()
  try {
    const removed = sweepDownloadedInstallers({ cacheDir: root, state: 'idle' })

    // The installer, its blockmap, and the differential baseline beside them: the three files whose only
    // purpose was the install that has already happened.
    for (const gone of [
      join(root, 'pending', 'agent-sam-1.4.0-setup.exe'),
      join(root, 'pending', 'agent-sam-1.4.0-setup.exe.blockmap'),
      join(root, 'pending', 'current.blockmap'),
      join(root, 'current.blockmap'),
      join(root, 'agent-sam-1.4.0-setup.exe'),
    ]) {
      assert.equal(present(gone), false, `${gone} is removed`)
      assert.ok(removed.includes(gone), `${gone} is reported as removed`)
    }

    // And nothing else. The bookkeeping is the updater's own to clear (it self-heals a missing file), the
    // package belongs to the non-NSIS path, and a nested installer is outside the one level this walk reads.
    for (const kept of [
      join(root, 'pending', 'update-info.json'),
      join(root, 'pending', 'package-1.4.0.7z'),
      join(root, 'pending', 'elsewhere', 'agent-sam-1.4.0-setup.exe'),
    ]) {
      assert.equal(present(kept), true, `${kept} is left where it is`)
    }

    results.push('a packaged startup removes the leftover installer, its blockmap and the baseline, and nothing else')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Nothing is swept while a download is in flight: the pending directory is a file being written. */
function nothingIsSweptWhileADownloadIsInFlight() {
  for (const state of ['available', 'downloading', 'ready', 'checking', 'up-to-date', 'error'] as const) {
    const root = cacheAfterAnUpdate()
    try {
      const removed = sweepDownloadedInstallers({ cacheDir: root, state })

      assert.equal(removed.length, 0, `${state}: nothing is removed`)
      assert.equal(present(join(root, 'pending', 'agent-sam-1.4.0-setup.exe')), true, `${state}: the installer stays`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  results.push('no state but `idle` sweeps anything, so a download underway is never touched')
}

/** A cache root that has never existed is not a reason to make one. */
function anAbsentCacheDirectoryIsNoOp() {
  const root = join(mkdtempSync(join(tmpdir(), 'sam-ai-update-cache-')), 'never-run')
  const parent = join(root, '..')
  try {
    const removed = sweepDownloadedInstallers({ cacheDir: root, state: 'idle' })

    assert.deepEqual(removed, [], 'nothing is reported')
    assert.equal(present(root), false, 'and nothing is created')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }

  results.push('an absent cache directory is a no-op that creates nothing')
}

/** A directory it cannot read or delete is a non-event, not a crash and not a UI report. */
function anUnremovableArtifactIsSwallowed() {
  const root = cacheAfterAnUpdate()
  try {
    // A directory named like an installer: the walk sees the name, and cannot unlink it. The sweep has to
    // come out the other side reporting what it did manage, rather than throwing into the app's startup.
    mkdirSync(join(root, 'pending', 'agent-sam-9.9.9-setup.exe'), { recursive: true })

    const removed = sweepDownloadedInstallers({ cacheDir: root, state: 'idle' })

    assert.ok(removed.length > 0, 'the rest of the sweep still happened')
    assert.equal(present(join(root, 'pending', 'agent-sam-9.9.9-setup.exe')), true, 'and the directory is still there')

    results.push('an artifact that cannot be removed is swallowed, and the rest of the sweep still runs')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- report

function main() {
  const step = (label: string, fn: () => void) => {
    process.stdout.write(`... ${label}\n`)
    fn()
  }

  step('sweep', aPackagedStartupRemovesWhatAnUpdateLeftBehind)
  step('in flight', nothingIsSweptWhileADownloadIsInFlight)
  step('absent', anAbsentCacheDirectoryIsNoOp)
  step('failure', anUnremovableArtifactIsSwallowed)

  console.log('update cache sweep: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

try {
  main()
} catch (err) {
  console.error('UPDATE CACHE SWEEP TEST FAILED:', err)
  process.exit(1)
}
