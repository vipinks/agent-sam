import { app } from 'electron'
import { join } from 'path'

/**
 * Fix the app's on-disk identity before anything reads it. Import for this side effect, first.
 *
 * ## Why this file exists at all
 *
 * Every piece of durable state this app owns hangs off `app.getPath('userData')`: the encrypted API
 * keys at `settings/api-keys.json`, the transcripts under `sessions/`, and conveyor's
 * `conveyor-stores/*.json`. On Windows that directory is `%APPDATA%\<app.name>`, and Electron derives
 * `app.name` from `productName ?? name` in package.json. So a branding change is a data-location
 * change, and on Windows it is worse than a moved folder:
 *
 * Chromium keeps the key that protects `safeStorage` ciphertext in `<userData>/Local State`. Move
 * `userData` and a fresh, empty `Local State` is created under the new name — so the old ciphertext
 * can never be decrypted again, no matter that the JSON file still exists. That is not a theory; it
 * is measured. With `productName: "Sam AI"` and the default path, all three stored provider keys
 * failed with `Error while decrypting the ciphertext provided to safeStorage.decryptString`, and a
 * saved session could not be found. With the path pinned back to `era`, all three decrypted and the
 * session loaded. See `tests/probes/law0-identity-probe.cjs`, which is that experiment.
 *
 * ## What this module therefore does
 *
 * Pins both halves of the identity to values that keep the existing directory:
 *
 * - `app.setPath('userData', <appData>/era)` — so `%APPDATA%\era`, where the keys and sessions already
 *   are, stays the app's directory. The directory name is a storage contract from here on, not
 *   branding; "Sam AI" is what the user sees in the installer, the window, and the OS, which is what
 *   branding is for.
 * - `app.setName('Sam AI')` — so the name Chromium uses for the Windows AppUserModelID and the macOS
 *   keychain entry matches the product. Without this the *other* half of safeStorage's identity (the
 *   OS-level service name) would still say `era`. See the note below on why the pin is what makes this
 *   safe.
 *
 * ## Why setting the name is safe once the path is pinned
 *
 * `safeStorage` sits on two layers of key material: a key stored in `<userData>/Local State`, and — on
 * macOS — that key wrapped by a Keychain item named after the app. The measured failure above was
 * entirely the first layer: the pinned run kept the name `Sam AI` *and* the old `Local State`, and
 * decrypted cleanly. So the layer that branding would have broken is the one this file pins, and the
 * keychain-name question does not arise on Windows, which is the platform this phase ships to.
 * macOS is untested here and is called out as such in the release notes rather than assumed fine.
 *
 * ## Ordering
 *
 * This must run before `@/conveyor/router` is imported, because `createRouter` reads store state from
 * disk synchronously at module-evaluation time (`conveyor/router.ts` relies on that: its transcript
 * sweep reads restored state immediately after). A pin placed in `main.ts`'s body would run *after*
 * that import and would silently read the wrong directory — the failure mode this module exists to
 * prevent. `app.getPath('appData')` is available before `app.whenReady()`, so no await is needed.
 *
 * ## If the legacy directory is absent
 *
 * Nothing is created or migrated. A fresh install simply starts with an empty `era` directory, which
 * is correct: there is no data to preserve, and pre-creating one would be a migration without a
 * source. Migration is deliberately *not* implemented, because pinning makes it unnecessary — copying
 * files into a new directory would not have restored decryption anyway, since `Local State` is not
 * among the files anyone would think to copy.
 */

/** The directory `%APPDATA%\<this>` that has held this app's data since before it had a name. */
const USER_DATA_DIR = 'era'

/** The name the OS and the user see. Set on the real `app` so every platform surface agrees. */
const DISPLAY_NAME = 'Sam AI'

app.setName(DISPLAY_NAME)
app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR))

/**
 * Exported so a probe or a test can assert the contract without re-deriving it.
 *
 * `appData` is read here, after the calls above, so these are the values the app will actually use.
 */
export const identity = {
  displayName: DISPLAY_NAME,
  userData: app.getPath('userData'),
  appData: app.getPath('appData'),
} as const
