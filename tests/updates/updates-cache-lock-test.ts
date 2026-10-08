/**
 * The sweep on the startup that follows a successful install: the state the mirror is in, and the file the
 * installer that ran from it still holds.
 *
 * Phase 80's defect. After 1.5.0 installed successfully, the 130MB setup exe it had been run from was still
 * sitting in `%LOCALAPPDATA%\agent-sam-updater\pending\`. Two rules were wrong at once, and this suite
 * asserts the corrected pair:
 *
 * - **The gate named a state where the rule is a property.** The sweep refused every state but `idle`, but
 *   what it must refuse is a *download in flight*. `up-to-date` — the state a check leaves behind when it
 *   comes back saying this build is the newest published — has none: the fetch is over, if there ever was
 *   one, and the pending directory is nobody's file being written. A deferred pass (below) can land after
 *   the launch's first check has completed, so the gate has to answer for that state as well as for the
 *   state a launch starts in.
 * - **A locked file was swallowed, so the failure became permanent.** On Windows the setup exe stays held
 *   for a moment after it has launched the app that replaced it — the installer is still closing, and the
 *   file it ran from cannot be deleted while it does — so `unlink` answers EBUSY. The sweep caught that and
 *   told no one, which turned a lock that would have lifted into a leftover that never goes away: the sweep
 *   runs once, at the launch that installs, and a silent failure there is a silent failure forever. A lock
 *   now earns exactly one deferred pass, and nothing else does.
 *
 * Red note, recorded on the defective tree: both cases failed there. `up-to-date` swept nothing, so the
 * installer was still present and unreported, and a locked artifact scheduled no second pass at all — the
 * two failing assertions are the defect, stated as assertions rather than described.
 *
 * The lock is a real one, and making one is harder than it looks. Neither of the two obvious Windows tricks
 * holds a file against `unlink`:
 *
 * - the read-only attribute does not — libuv sees the access-denied, clears `FILE_ATTRIBUTE_NORMAL` and
 *   retries, so `chmodSync(path, 0o444)` deletes happily (measured on this machine, not assumed);
 * - a handle opened in this process does not — node opens with `FILE_SHARE_DELETE`, so the delete succeeds
 *   and the file disappears when the last handle closes.
 *
 * What does hold it is a *second process* that opens the file with share mode `None`, which is the shape the
 * real culprit has: an installer still running from the file it was launched from. So the lock cases spawn a
 * `powershell.exe` that opens the installer that way, wait for it to say it has, and release it by killing
 * the process — the code under test is the product's, and this is only the lock. `powershell.exe` is an OS
 * tool on the platform the case is about rather than a dependency, and the case is skipped off Windows
 * instead of faked there: a POSIX host cannot produce this failure without the same trick.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDownloadedInstallers } from '../../lib/main/update-cache'
import type { UpdateState } from '../../conveyor/protocol/updates'

const results: string[] = []
const skipped: string[] = []

/** Whether a path is still there. */
function present(path: string): boolean {
  return existsSync(path)
}

/**
 * A cache directory laid out the way electron-updater leaves one after an update has installed.
 *
 * The names are the real ones: the installer is the `artifactName` this repo's electron-builder
 * configuration declares (`${name}-${version}-setup.${ext}`) and `update-info.json` is the bookkeeping that
 * points at it — the file the sweep must leave alone, because it is the updater's own to clear.
 */
function cacheAfterAnInstall(): { root: string; installer: string } {
  const root = mkdtempSync(join(tmpdir(), 'sam-ai-update-cache-lock-'))
  const pending = join(root, 'pending')
  mkdirSync(pending, { recursive: true })

  const installer = join(pending, 'agent-sam-1.5.0-setup.exe')
  writeFileSync(installer, 'installer bytes')
  writeFileSync(join(pending, 'agent-sam-1.5.0-setup.exe.blockmap'), 'blockmap bytes')
  writeFileSync(join(pending, 'update-info.json'), '{"fileName":"agent-sam-1.5.0-setup.exe"}')

  return { root, installer }
}

/** How long a holder is allowed to take to say it has the file, before the suite calls that a failure. */
const HOLDER_TIMEOUT_MS = 15_000

/**
 * Hold one file the way a still-closing installer does: a second process, opened with no sharing at all.
 *
 * Held open for a minute rather than for as long as the case needs, because the case ends it: the holder is
 * killed when the lock should lift, and killing the process is what releases the handle. That makes the
 * "lock lifted" moment a fact this suite controls rather than a wall-clock guess, and it means the case does
 * not have to out-wait a sleep to be correct. `stdio` ignores the holder's exit output except for the one
 * readiness line, so a holder that somehow outlives the suite cannot hold the runner's stdout open.
 */
function holdFileLock(path: string): Promise<{ release: () => Promise<void> }> {
  const quoted = path.replace(/'/g, "''")
  const script = [
    `$f=[System.IO.File]::Open('${quoted}',`,
    '[System.IO.FileMode]::Open,',
    '[System.IO.FileAccess]::Read,',
    '[System.IO.FileShare]::None);',
    "[Console]::Out.WriteLine('locked');",
    '[Console]::Out.Flush();',
    'Start-Sleep -Seconds 60;',
    '$f.Close()',
  ].join('')

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })

  const release = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await exited
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void release()
      reject(new Error(`the file lock holder never confirmed the lock on ${path}`))
    }, HOLDER_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (!chunk.includes('locked')) return
      clearTimeout(timer)
      resolve({ release })
    })

    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`the file lock holder exited before it held ${path}`))
    })
  })
}

/**
 * The state a completed check leaves: this build is the newest published one.
 *
 * The sweep is safe here for the reason it is safe at `idle` and for no other reason — no download is in
 * flight — so a gate that accepted only `idle` was refusing a state it had no argument against.
 */
function upToDateSweepsWhatAnInstallLeft() {
  const { root, installer } = cacheAfterAnInstall()
  try {
    const removed = sweepDownloadedInstallers({ cacheDir: root, readState: () => 'up-to-date' })

    assert.equal(present(installer), false, 'the leftover installer is removed')
    assert.ok(removed.includes(installer), 'and is reported as removed')
    assert.equal(
      present(join(root, 'pending', 'update-info.json')),
      true,
      'the updater’s own bookkeeping is left where it is'
    )

    results.push('`up-to-date` sweeps: a completed check is no more a download in flight than a fresh launch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A sweep that removed everything it found has nothing to defer. */
function anUnobstructedSweepDefersNothing() {
  const { root, installer } = cacheAfterAnInstall()
  try {
    const deferred: Array<() => void> = []
    const removed = sweepDownloadedInstallers({
      cacheDir: root,
      readState: () => 'idle',
      defer: (run) => {
        deferred.push(run)
      },
    })

    assert.ok(removed.includes(installer), 'the installer is removed on the first pass')
    assert.equal(deferred.length, 0, 'and a sweep that lost nothing to a lock asks for no second pass')

    results.push('the deferred pass is earned by a lock, not scheduled on every launch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The lock, and the one pass it earns.
 *
 * The first pass runs against a file a live process is holding, which is EBUSY — the state a startup meets
 * when the installer that ran from this exe has not finished closing. Running the deferred pass after the
 * holder is killed is what the app's own five seconds are for: the lock is gone, and the sweep finishes the
 * job it could not finish during the launch.
 */
async function aLockedInstallerIsSweptOnOneDeferredPass() {
  if (process.platform !== 'win32') {
    skipped.push('a held file (EBUSY) needs a second process opening it without sharing; skipped off Windows')
    return
  }

  const { root, installer } = cacheAfterAnInstall()
  const lock = await holdFileLock(installer)
  try {
    const deferred: Array<() => void> = []
    const removed = sweepDownloadedInstallers({
      cacheDir: root,
      readState: () => 'idle',
      defer: (run) => {
        deferred.push(run)
      },
    })

    assert.equal(removed.includes(installer), false, 'the locked installer is not claimed as removed')
    assert.equal(present(installer), true, 'and is still there when the first pass ends')
    assert.equal(deferred.length, 1, 'a locked artifact earns exactly one deferred pass')

    await lock.release()
    deferred[0]()

    assert.equal(present(installer), false, 'the deferred pass removes what the lock was holding')
    assert.equal(deferred.length, 1, 'and does not defer again: one retry, never a loop')

    results.push('a locked installer is removed by the single deferred pass, and one attempt is all a lock buys')
  } finally {
    await lock.release()
    rmSync(root, { recursive: true, force: true })
  }
}

/** The deferred pass decides for itself: the mirror is asked again, and a download in flight is still refused. */
async function theDeferredPassAsksTheMirrorAgain() {
  if (process.platform !== 'win32') {
    skipped.push('the same held file, asked a second question: a download in flight is still not swept')
    return
  }

  const { root, installer } = cacheAfterAnInstall()
  const lock = await holdFileLock(installer)
  try {
    let mirror: UpdateState = 'idle'
    const deferred: Array<() => void> = []
    sweepDownloadedInstallers({
      cacheDir: root,
      readState: () => mirror,
      defer: (run) => {
        deferred.push(run)
      },
    })
    assert.equal(deferred.length, 1, 'the lock is what earns the pass')

    // What the deferred wait is for: the seconds between the launch and the pass can contain the launch's
    // own first check, and a check that finds an update starts a download into this very directory.
    mirror = 'downloading'
    await lock.release()
    deferred[0]()

    assert.equal(present(installer), true, 'the deferred pass refuses while a download is in flight')

    results.push('the deferred pass reads the mirror again, so a download that started in the meantime is not touched')
  } finally {
    await lock.release()
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('up to date', upToDateSweepsWhatAnInstallLeft)
  await step('no lock', anUnobstructedSweepDefersNothing)
  await step('lock', aLockedInstallerIsSweptOnOneDeferredPass)
  await step('lock, then a download starts', theDeferredPassAsksTheMirrorAgain)

  console.log('update cache sweep after an install: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)

  if (skipped.length > 0) {
    console.log('  skipped on this host:')
    for (const s of skipped) console.log('    skip: ' + s)
  }
}

main().catch((err: unknown) => {
  console.error('UPDATE CACHE SWEEP AFTER AN INSTALL TEST FAILED:', err)
  process.exit(1)
})
