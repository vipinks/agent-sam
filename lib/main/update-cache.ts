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
 * The rule about when is the updater's state and not this module's: only `idle` is swept, because only
 * `idle` means no fetch is underway. With a download in flight the `pending` directory is a file being
 * written, and the sweep is not merely unnecessary — it would corrupt the update this launch is performing.
 * A launch starts `idle` and its first check is ten seconds away, so a packaged startup is exactly the
 * window this is for; anything else refuses.
 *
 * Every failure is swallowed. A locked file, a directory that cannot be read, a cache root that has never
 * existed: none of these are events, and the only user-visible consequence of a failed sweep is that nothing
 * changed. Nothing is ever created, so a machine whose updater has never run is left byte-for-byte as it
 * was — and nothing outside the resolved cache root is ever named.
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
  /** The updater's state. Nothing is swept unless this is `idle`. */
  state: UpdateState
}

/** Whether a file name is one of the downloaded installer artifacts this module removes. */
function isInstallerArtifact(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.exe') || lower.endsWith('.exe.blockmap') || lower === 'current.blockmap'
}

/**
 * Delete the leftover installer artifacts under one cache root, and answer with the paths removed.
 *
 * Two levels and no more: the root itself, and its `pending` subdirectory — the two places the vendored
 * updater writes a download. A nested directory is not descended into, and a name that happens to look like
 * an installer somewhere deeper is left alone: the sweep's job is the files the downloader put exactly
 * where it puts them.
 *
 * The return value exists for the suite that proves the sweep, not for the app: nothing in the app is told
 * what was removed. A failure to remove one file never stops the others — the loop is best effort per file,
 * which is the difference between a locked exe and a launch that throws.
 */
export function sweepDownloadedInstallers({ cacheDir, state }: UpdateCacheSweep): string[] {
  if (state !== 'idle') return []
  if (!existsSync(cacheDir)) return []

  const removed: string[] = []
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
      } catch {
        // Locked, read-only, or gone between the two calls. Swallowed by design: see the module note.
      }
    }
  }

  return removed
}
