/**
 * The auto-update status rule: what the updater's current state is called, and what the surface may offer
 * next.
 *
 * The wiring that produces these states lives in `conveyor/modules/updates.ts`, which turns
 * electron-updater's events into them; the words and the offers live here because they are the part worth
 * asserting. A status line is a claim about what the app is doing, and the two ways it can be wrong are
 * both decided here rather than in a component: a word that cannot tell two states apart, and a button
 * offered for something that cannot happen (a download while the app is fetching it by itself, or a second
 * check while a check is already in flight).
 *
 * The rule takes three inputs and nothing else — the state, the user's auto-download preference, and the
 * error code a failure carries — so it can be called from a component, from a store, or from a test and
 * answer the same thing every time. It reads no store: the preference is an argument, which is what keeps
 * the renderer's read of the preference store and the rule's use of it from becoming two answers that can
 * disagree.
 *
 * Errors carry codes rather than the message electron-updater's own `Error` arrived with. That message is
 * a sentence about an HTTP status or a filesystem path — written for a log, not for a status line — so it
 * never crosses into this module's output: a value that is not one of the declared codes falls back to the
 * state's own word instead of being printed. The code is decided by `updateFailureCode`, because the one
 * `error` event covers both a failed check and a failed download and only the phase they failed in says
 * which is which.
 *
 * The module imports nothing, deliberately, so that it cannot consult a clock, a store, or a component.
 */

/** Every state the mirror can hold, in the order a launch walks them. */
export const UPDATE_STATES = [
  /** Nothing has happened yet: no check has run in this process. */
  'idle',
  /** A check is in flight. */
  'checking',
  /** A check found a newer version; the download may or may not have started. */
  'available',
  /** The update's bytes are being fetched. */
  'downloading',
  /** The update is downloaded and installs on quit. */
  'ready',
  /** The check came back and this build is the newest one published. */
  'up-to-date',
  /** Something failed; the code says what, and `updateFailureCode` says which phase it failed in. */
  'error',
] as const

export type UpdateState = (typeof UPDATE_STATES)[number]

/** The module's refusal when a check, download or install is asked for outside a packaged build. */
export const UPDATES_DISABLED_IN_DEV = 'UPDATES_DISABLED_IN_DEV'
/** A check that did not complete — a lost network, a bad feed, a release that cannot be read. */
export const UPDATES_CHECK_FAILED = 'UPDATES_CHECK_FAILED'
/** A download that did not complete. Its own code because it is the failure a user has to act on. */
export const UPDATES_DOWNLOAD_FAILED = 'UPDATES_DOWNLOAD_FAILED'

export const UPDATE_ERROR_CODES = [UPDATES_DISABLED_IN_DEV, UPDATES_CHECK_FAILED, UPDATES_DOWNLOAD_FAILED] as const

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number]

/**
 * What auto-download starts as: on.
 *
 * A background updater that asked before every download would be one waiting for a click that, this turn,
 * has no surface to come from — so the value that makes the preference meaningful is the one only a user
 * who wants to be asked changes. Read by the preference store's initial state, so the default the store
 * starts from and the default the module falls back to cannot disagree.
 */
export const DEFAULT_AUTO_DOWNLOAD = true

/**
 * What each state is called.
 *
 * One word per state, and no two alike: a status line that read 'Update available' while an update was
 * actually downloading would be telling the user to wait for something that already happened. The
 * preference never moves these — it changes what the app does next, never what has happened.
 */
export const UPDATE_STATUS_WORDS: Record<UpdateState, string> = {
  idle: 'Not checked yet',
  checking: 'Checking for updates',
  available: 'Update available',
  downloading: 'Downloading update',
  ready: 'Update ready to install',
  'up-to-date': 'Up to date',
  error: 'Update failed',
}

/**
 * What each failure code is called — one word per code, for the same reason the states have one each.
 *
 * These are the whole of what a failure says. The sentence that raised it stays in the log the updater
 * wrote it to.
 */
export const UPDATE_ERROR_WORDS: Record<UpdateErrorCode, string> = {
  [UPDATES_DISABLED_IN_DEV]: 'Updates are off in this build',
  [UPDATES_CHECK_FAILED]: 'Could not check for updates',
  [UPDATES_DOWNLOAD_FAILED]: 'Could not download the update',
}

/** The three things a surface can offer, and the word that goes with the state. */
export interface UpdateAvailability {
  statusWord: string
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface UpdateStatusInput {
  state: UpdateState
  /** The user's auto-download preference, read from the preference store by the caller. */
  autoDownload: boolean
  /** The code an `error` state carries. Ignored in every other state. */
  errorCode?: UpdateErrorCode | null
}

/**
 * Whether a value really is one of the declared codes.
 *
 * The membership test is what makes a message unprintable: the code crosses the boundary as a string, and
 * a value that is not in the table is refused here rather than being used to look a word up.
 */
function isUpdateErrorCode(code: unknown): code is UpdateErrorCode {
  return typeof code === 'string' && (UPDATE_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * What the surface calls the state.
 *
 * An error's word follows its code when it carries one: 'Could not download the update' is a different
 * situation from 'Could not check for updates', and the two are told apart by the code rather than by any
 * text the updater produced.
 */
export function updateStatusWord(state: UpdateState, errorCode?: UpdateErrorCode | null): string {
  if (state !== 'error') return UPDATE_STATUS_WORDS[state]
  return isUpdateErrorCode(errorCode) ? UPDATE_ERROR_WORDS[errorCode] : UPDATE_STATUS_WORDS.error
}

/**
 * The three offers for a state, under a preference.
 *
 * At most one is ever true, because each state has exactly one sensible next step: a check when nothing is
 * in flight, a download when an update is known and the app is not fetching it itself, an install once the
 * bits are here. An available update offers its download only with auto-download *off* — with it on, the
 * module is already fetching the update and the state passes through to `downloading` on the first progress
 * event, so a download button would offer work that is underway. A check is offered while a check is in
 * flight by no one: the state says one is running, and a second one would restart what the first is doing.
 *
 * `ready` offers the install and nothing else, deliberately: the downloaded update installs on quit by
 * default, and a check beside it would only offer to replace what is already waiting.
 */
export function updateAvailability(input: UpdateStatusInput): UpdateAvailability {
  const { state, autoDownload } = input

  return {
    statusWord: updateStatusWord(state, input.errorCode),
    canCheck: state === 'idle' || state === 'up-to-date' || state === 'error',
    canDownload: state === 'available' && !autoDownload,
    canInstall: state === 'ready',
  }
}

/**
 * Which code a failure carries, from the phase that failed.
 *
 * electron-updater raises one `error` event for both phases, so the event itself cannot say which failed:
 * the state the mirror was in when it arrived can. A download failure reported as a failed check would
 * send the user to look at their network when the installer is what did not arrive.
 */
export function updateFailureCode(state: UpdateState): UpdateErrorCode {
  return state === 'downloading' ? UPDATES_DOWNLOAD_FAILED : UPDATES_CHECK_FAILED
}

/**
 * The states an update exists in: the three the chrome is allowed to mention.
 *
 * `available` and `downloading` are one piece of news twice — the update has been found, and the app is
 * fetching it — and `ready` is the other one, because the wait is over and the only thing left is a
 * restart. The four that are absent are the ones with nothing to announce, and each for its own reason:
 * `idle` has not asked yet, `checking` is asking, `up-to-date` is no update at all, and `error` is the
 * Updates section's business. A mark in the title bar for a failure would be a permanent one, asking about
 * something a user cannot act on from there.
 */
export const UPDATE_BADGE_STATES = ['available', 'downloading', 'ready'] as const

/** What the chrome says about an update, and whether it says anything at all. */
export interface UpdateBadge {
  /** Whether the mark is drawn. */
  present: boolean
  /** The one sentence for the state — the tooltip and the control's own name. Empty while nothing is drawn. */
  label: string
}

/**
 * What the header says about the updater, from the same mirror the Updates section reads.
 *
 * Both versions travel in the sentence, because "an update is available" is not something a user can place:
 * a version they have never seen means nothing next to one they are running. The words come from here rather
 * than from the component for the reason every other word about the updater does — a badge with its own copy
 * of the sentence would have to be right about the same state twice, and would be the first thing to go
 * quiet the next time a state was added.
 */
export function updateBadge(state: UpdateState, from: string, to: string): UpdateBadge {
  if (!(UPDATE_BADGE_STATES as readonly UpdateState[]).includes(state)) return { present: false, label: '' }

  const subject = state === 'ready' ? 'Update ready to install' : 'New version available'
  return { present: true, label: `${subject}: ${from} → ${to}` }
}
