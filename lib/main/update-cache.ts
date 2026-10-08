import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UpdateState } from '@/conveyor/protocol/updates'

/**
 * The updater's leftover installers, and the one moment they are safe to remove.
 *
 * electron-updater downloads the release's NSIS setup into a cache directory of its own and runs it from
 * there. That copy outlives the installation it performed: after the install has replaced the app, the exe
 * it launched is still sitting in `%LOCALAPPDATA%\agent-sam-updater\pending\` — tens of megabytes nothing
 * will ever read again, kept because nothing removes them. This module is the removal.
 *
 * Both facts it needs are taken from the vendored packages rather than restated, because a sweep that named
 * its own directory is a sweep that could delete from one the downloader does not use:
 *
 * - **Where.** `electron-updater`'s own adapter resolves the root as
 *   `path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), updaterCacheDirName)`
 *   on win32 (`node_modules/electron-updater/out/AppAdapter.js:8-9` for the base,
 *   `out/AppUpdater.js:550` for the join), and the name it joins is read from the `app-update.yml` that
 *   electron-builder wrote into the app (`out/AppUpdater.js:543`). So this module reads that same file for
 *   that same key, instead of deriving the name from the product name and hoping the two agree.
 * - **What.** The downloads land in `<root>/pending`: the installer is the `artifactName` the packaging
 *   configuration declares (`electron-builder.yml`, `${name}-${version}-setup.${ext}`), its differential
 *   baseline is `current.blockmap` beside it, and the completed download copies that baseline up to
 *   `<root>/current.blockmap` (`out/AppUpdater.js:586-599`). Those three names are what this module removes.
 *
 * The rule about when is the updater's state and not this module's: `idle` and `up-to-date` are swept, and
 * nothing else is, because those two are the states in which any fetch is over — a progress event retires
 * `up-to-date`, and `available`/`downloading`/`ready` mean bytes are being written or waiting. With a
 * download in flight the `pending` directory is a file being written, and the sweep is not merely
 * unnecessary — it would corrupt the update this launch is performing.
 *
 * `up-to-date` is the state a successful install actually reaches, and that is why it is named here. The
 * sweep runs at a launch's start, but a deferred pass (below) can land after the launch's first check has
 * completed, and a check that finds nothing newer reports `update-not-available` — which is `up-to-date`.
 * A gate that accepted only `idle` therefore refused a state it had no argument against, and on a launch
 * whose retry ran late it refused the sweep that install's own startup had asked for.
 *
 * Every failure is swallowed, with one exception that is not a failure: a file the OS is holding. Windows
 * keeps the setup exe locked for a moment after it has launched the app that replaced it — the installer is
 * still closing — and `unlink` answers EPERM or EBUSY. That lock lifts on its own, so a lock buys exactly one
 * deferred pass, scheduled through the caller's `defer`; anything else — a read-only directory, a path that
 * vanished, a directory named like an installer — is the non-event described above and is never retried.
 * Nothing is ever created, so a machine whose updater has never run is left byte-for-byte as it was — and
 * nothing outside the resolved cache root is ever named.
 */

/** What `app-update.yml` calls the cache directory, or null when the file says nothing usable. */
const CACHE_DIR_NAME_KEY = 'updaterCacheDirName'

/**
 * The directory electron-updater downloads into, or null when it cannot be determined here.
 *
 * Null is answered rather than guessed in two cases, and both are swallowed by the caller: the packaged app
 * has no `app-update.yml` (an unpackaged build, which has no feed either), or the file carries no
 * `updaterCacheDirName`. A derived name would be a name this module invented — and deleting from a directory
 * this app merely *believes* is the updater's is the one outcome worse than leaving the files.
 *
 * The file is read for one line rather than parsed: electron-builder writes it as flat `key: value` pairs,
 * the key is the only thing wanted, and pulling a YAML parser into the main process's startup path to read
 * one scalar would be a dependency paid for every launch to learn one word.
 */
export function updaterCacheDir(): string | null {
  // `process.resourcesPath` exists only inside Electron, so a process that is not the app's — a suite, a
  // script — answers null here rather than throwing out of `path.join`. That is the same answer as a
  // packaged app without the config file, and the caller swallows both the same way.
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null

  const configPath = join(resourcesPath, 'app-update.yml')

  let source: string
  try {
    source = readFileSync(configPath, 'utf8')
  } catch {
    return null
  }

  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(`${CACHE_DIR_NAME_KEY}:`))
  const name = line?.slice(CACHE_DIR_NAME_KEY.length + 1).trim()
  if (!name) return null

  return join(appCacheRoot(), name)
}

/**
 * The base directory electron-updater's adapter resolves, per platform.
 *
 * Mirrored from `node_modules/electron-updater/out/AppAdapter.js:6-19` rather than reaching for Electron's
 * own `getPath('cache')`, which is a *different* directory (`%APPDATA%`, not `%LOCALAPPDATA%`, on Windows).
 * The point of this module is to touch the directory the downloader touches, so the expression is the
 * downloader's.
 */
function appCacheRoot(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  return process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
}

export interface UpdateCacheSweep {
  /** The updater's cache root. Injected so a suite can use a directory of its own. */
  cacheDir: string
  /**
   * The updater's state, read when the sweep is about to look.
   *
   * A function rather than a value because the deferred pass below runs later than the call that arranged
   * it: the second look has to see the mirror as it is then, not as it was when the launch started. A
   * download that began in between is exactly what this must not sweep through.
   */
  readState: () => UpdateState
  /**
   * How a deferred pass is scheduled, or absent to run one immediately. Injected because this module owns
   * no clock: the app passes a `setTimeout`, and a suite passes a collector, so neither has to wait.
   */
  defer?: (run: () => void) => void
}

/**
 * How long the single deferred pass waits for a lock to lift.
 *
 * The lock is the installer process finishing its own close, which is a matter of seconds — long enough that
 * the app the setup exe started is already up. Past this the sweep has done its part and the leftover is a
 * machine-state question rather than a startup one.
 */
export const UPDATE_CACHE_SWEEP_RETRY_MS = 5_000

/** The errno codes that mean a live process holds the file rather than that the sweep may not touch it. */
function isLockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY'
}

/** Whether a file name is one of the downloaded installer artifacts this module removes. */
function isInstallerArtifact(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.exe') || lower.endsWith('.exe.blockmap') || lower === 'current.blockmap'
}

/**
 * Whether a state means "nothing is being downloaded into this directory".
 *
 * The list is the module note's rule: `idle` because no check has run, and `up-to-date` because the check
 * that did run came back with nothing to fetch. The remaining five all mean bytes are being written or
 * waiting to be installed, which is the one thing a sweep must never touch.
 */
function isSweepableState(state: UpdateState): boolean {
  return state === 'idle' || state === 'up-to-date'
}

/**
 * Say what the deferred pass removed, when it removed anything.
 *
 * Warn level, and only for the pass that happens seconds after the launch rather than during it: the app's
 * console is the only place a startup that cleaned up after an update can be told apart from one that did
 * not, and the module's silence is otherwise total. Nothing is reported while a sweep fails, because a
 * failure here is not an event. This is production code reached only through the scheduler above.
 */
function reportDeferredSweep(removed: string[]): void {
  console.warn(`[updates] swept ${removed.length} leftover updater file(s)`)
}

/**
 * Delete the leftover installer artifacts under one cache root, and answer with the paths removed.
 *
 * Two levels and no more: the root itself, and its `pending` subdirectory — the two places the vendored
 * updater writes a download. A nested directory is not descended into, and a name that happens to look like
 * an installer somewhere deeper is left alone: the sweep's job is the files the downloader put exactly
 * where it puts them.
 *
 * A file that could not be deleted never stops the others — the loop is best effort per file, which is the
 * difference between a locked exe and a launch that throws. A file that could not be deleted *because it is
 * held* is the one case worth a second attempt, and it gets exactly one: `pass` below is that attempt, run
 * through `defer` if the caller supplied one, and it does not defer again.
 *
 * The return value exists for the suite that proves the sweep, not for the app: nothing in the app is told
 * what was removed. A deferred pass answers the same way, through the caller's own callback, because the
 * paths it removes are the same kind of fact arriving later.
 */
export function sweepDownloadedInstallers({ cacheDir, readState, defer }: UpdateCacheSweep): string[] {
  /** One look at the cache, under one reading of the mirror. `retryOnLock` is false on the second pass. */
  const pass = (retryOnLock: boolean): string[] => {
    if (!isSweepableState(readState())) return []
    if (!existsSync(cacheDir)) return []

    const removed: string[] = []
    let locked: string | null = null

    for (const directory of [cacheDir, join(cacheDir, 'pending')]) {
      let entries: string[]
      try {
        entries = readdirSync(directory)
      } catch {
        // Unreadable or absent: the `pending` directory need not exist, and a root that exists but cannot be
        // listed is the same non-event.
        continue
      }

      for (const entry of entries) {
        if (!isInstallerArtifact(entry)) continue

        const path = join(directory, entry)
        try {
          // Directories are skipped rather than attempted: `unlink` on one fails on every platform, and the
          // one thing this sweep must never do is reach for a recursive removal inside a cache it does not own.
          if (!statSync(path).isFile()) continue
          unlinkSync(path)
          removed.push(path)
        } catch (error) {
          // A held file is the exception the module note describes: the lock lifts, so it earns the one
          // deferred pass — and only the first of them is remembered, since a second pass would only find
          // the same lock with nothing left to learn from it.
          if (retryOnLock && locked === null && isLockedError(error)) locked = path
        }
      }
    }

    if (locked !== null) {
      const again = () => {
        const late = pass(false)
        if (late.length > 0) reportDeferredSweep(late)
      }
      if (defer) defer(again)
      else again()
    }

    return removed
  }

  return pass(true)
}
