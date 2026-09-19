// Test double for the `electron` module, for the node suites. `app.getPath('userData')` points at a
// temp directory chosen per run, so a suite never reads or writes the real user's app data — an
// important property when the thing under test deletes files by id.
//
// Resolved per call rather than once at load: a suite may set SAM_TEST_USER_DATA after this module is
// required (ESM imports are hoisted, so it cannot always set it first), and a captured value would
// silently ignore that. Resolving late also means a single process can point at a fresh directory
// between cases.
const path = require('path')

module.exports = {
  app: {
    getPath: () => process.env.SAM_TEST_USER_DATA || path.join(require('os').tmpdir(), 'sam-ai-sessions-test'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: { openExternal: async () => undefined },
  BrowserWindow: class {},
}
