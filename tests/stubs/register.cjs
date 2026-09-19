/**
 * Redirects the modules that cannot load outside Electron, for the node suites, via `--require`.
 *
 * Two are needed:
 *
 * - `electron` — no runtime outside an Electron process. The double points `app.getPath('userData')`
 *   at a temp directory, so a suite can never read or write the real user's app data. That matters
 *   here: several suites delete files by id.
 * - `electron-conveyor/main` — imports electron for its window manager and middleware, so it cannot
 *   load either. The suites that exercise a module's logic only need `ConveyorError` from it.
 *
 * Hooked once at resolution rather than aliased per suite, so a suite does not have to know it is
 * running outside Electron.
 */
const Module = require('module')

const electronStub = require('./electron-stub.cjs')
const conveyorStub = require('./electron-main-stub.cjs')

const original = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === 'electron-conveyor/main') return conveyorStub
  return original.call(this, request, parent, isMain)
}
