/**
 * Redirects the modules that cannot load outside Electron, for the node suites, via `--require`.
 *
 * Three are needed:
 *
 * - `electron` — no runtime outside an Electron process. The double points `app.getPath('userData')`
 *   at a temp directory, so a suite can never read or write the real user's app data. That matters
 *   here: several suites delete files by id.
 * - `electron-conveyor/main` — imports electron for its window manager and middleware, so it cannot
 *   load either. The suites that exercise a module's logic only need `ConveyorError` from it.
 * - `electron-updater` — the package that downloads and installs a release. It reads `app-update.yml`
 *   off `process.resourcesPath`, spawns the downloaded installer and quits the app, so none of it is
 *   reachable in a suite. The one thing a suite is about is the pair of arguments the install is asked
 *   for, which the double records.
 *
 * Hooked once at resolution rather than aliased per suite, so a suite does not have to know it is
 * running outside Electron.
 */
const Module = require('module')

const electronStub = require('./electron-stub.cjs')
const conveyorStub = require('./electron-main-stub.cjs')
const updaterStub = require('./electron-updater-stub.cjs')

const original = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === 'electron-conveyor/main') return conveyorStub
  if (request === 'electron-updater') return updaterStub
  return original.call(this, request, parent, isMain)
}
