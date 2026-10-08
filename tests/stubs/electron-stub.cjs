// Test double for the `electron` module, for the node suites. `app.getPath('userData')` points at a
// temp directory chosen per run, so a suite never reads or writes the real user's app data — an
// important property when the thing under test deletes files by id.
//
// Resolved per call rather than once at load: a suite may set SAM_TEST_USER_DATA after this module is
// required (ESM imports are hoisted, so it cannot always set it first), and a captured value would
// silently ignore that. Resolving late also means a single process can point at a fresh directory
// between cases.
const path = require('path')

// The app-level events a module may subscribe to. Recorded rather than dispatched, because there is no
// Electron to dispatch them: a suite that is about what an app event does calls `__emit` itself.
const appListeners = new Map()

module.exports = {
  app: {
    getPath: () => process.env.SAM_TEST_USER_DATA || path.join(require('os').tmpdir(), 'sam-ai-sessions-test'),
    getName: () => 'Agent Sam',
    getVersion: () => process.env.SAM_TEST_APP_VERSION || '0.0.0-test',
    // A getter rather than a value, for the late-resolution reason `getPath` above gives: a suite sets
    // SAM_TEST_PACKAGED around the one case that needs a packaged build, and a captured boolean would
    // pin every other suite to whatever the environment said when this module was first required.
    get isPackaged() {
      return process.env.SAM_TEST_PACKAGED === '1'
    },
    on(event, handler) {
      const set = appListeners.get(event) ?? new Set()
      set.add(handler)
      appListeners.set(event, set)
    },
    /** Emit an app event to its listeners. Not an Electron API — a suite's own trigger. */
    __emit(event, ...args) {
      for (const handler of appListeners.get(event) ?? []) handler(...args)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    // The save dialog is answered from the environment for the same late-resolution reason as
    // `userData` above: the export command under test needs a real path to write to, and it also
    // needs to be exercised on the cancel path. A suite sets SAM_TEST_SAVE_PATH to have the dialog
    // accept, and leaves it unset to have the dialog dismissed — no suite has to know the shape of
    // either, and nothing here can pop a real dialog.
    showSaveDialog: async () => {
      const path = process.env.SAM_TEST_SAVE_PATH
      return path ? { canceled: false, filePath: path } : { canceled: true, filePath: undefined }
    },
  },
  shell: { openExternal: async () => undefined },
  BrowserWindow: class {},
}
