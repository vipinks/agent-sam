import { app } from 'electron'
import { defineModule, query } from '../init'

/**
 * Facts about the running app itself, as opposed to the project it has open.
 *
 * One query, and it exists because the alternative is a small lie: a version written into the
 * renderer is a version kept in step with `package.json` by hand, and the one thing a version report
 * cannot survive is being out of date. `app.getVersion()` is what the shipped binary answers with, so
 * the number the user is shown is the number they are running.
 *
 * Read-only by construction, which is why there is no command beside it and no error code for it to
 * raise: nothing here changes anything, and a read that cannot fail does not need a code for failing.
 * `app.getVersion()` on a build with no version of its own answers with Electron's, which is a
 * truthful answer to "which version is this" rather than an absent one.
 */
export const systemModule = defineModule({
  /** The version of the running app: the packaged one, or the manifest's in development. */
  version: query(() => app.getVersion()),
})
