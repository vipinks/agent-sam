/**
 * The editor's rules: what a conflict is, what "dirty" means, what Tab does, and what a failed save
 * says.
 *
 * Pure and renderer-only, kept out of the component for the reason `mentions.ts` and `changes.ts` are:
 * these are decisions a test should be able to make by calling a function rather than by typing into a
 * textarea and reading a rendered banner. The component then holds the state and draws the result.
 *
 * Nothing here touches a disk, a process, or electron. The contents arrive from main.
 */

/**
 * How the open buffer and the disk stand relative to each other.
 *
 * Three states rather than a boolean, because the interesting case is not "the buffer has unsaved
 * changes" — that is normal and needs no interruption — but whether the *disk moved underneath them*.
 * Collapsing the two would mean showing "this file changed on disk" for a file that did not, and the
 * user would then reload and lose their edits to a file that never moved.
 */
export type ConflictDecision = 'clean' | 'dirty' | 'conflict'

/**
 * Decide what to do when the open path is reported as changed.
 *
 * `baseline` is the content last known to be on disk — what was loaded, or what we last saved. `local`
 * is what the buffer holds now. `disk` is what a fresh read returns.
 *
 * - `clean`: the buffer has no edits. Nothing of the user's is at stake, so the fresh content is simply
 *   adopted — the refetch that happened before the viewer could edit anything.
 * - `dirty`: the buffer has edits and the disk still holds the baseline. Something wrote the same bytes,
 *   or touched the file. There is nothing to warn about and nothing to reload.
 * - `conflict`: both moved. The only case where the user is asked to choose.
 *
 * Compared exactly rather than trimmed: reindenting a line is an edit, and treating whitespace as
 * insignificant would report a real divergence as clean and then overwrite the buffer.
 */
export function decideConflict(input: { baseline: string; local: string; disk: string }): ConflictDecision {
  if (input.local === input.baseline) return 'clean'
  return input.disk === input.baseline ? 'dirty' : 'conflict'
}

/**
 * Whether the buffer holds unsaved edits.
 *
 * A missing buffer is not an edit: a file that has merely been opened must not show the dirty dot. So
 * the comparison needs both sides, and either one absent reads as not dirty.
 */
export function isDirty(baseline: string | null, local: string | null): boolean {
  if (baseline === null || local === null) return false
  return baseline !== local
}

/** How many spaces Tab inserts. */
export const TAB_SPACES = 2

/**
 * Insert an indent at the selection, replacing it if there is one.
 *
 * Returned as the new text and the caret position rather than applied to an element, so the rule can be
 * exercised directly — and so the component stays responsible for the DOM, which is the half a test
 * cannot check anyway. A replaced selection makes Tab an indent and a dedent-by-replace, which is the
 * behaviour a plain textarea can honestly offer without a tokenizer.
 */
export function insertTab(text: string, selectionStart: number, selectionEnd: number): { text: string; caret: number } {
  const spaces = ' '.repeat(TAB_SPACES)
  // Clamped rather than trusted: the caller reads these off a live element, and a stale or reversed
  // range must not splice the text at a position that does not exist.
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))

  return { text: text.slice(0, start) + spaces + text.slice(end), caret: start + TAB_SPACES }
}

/**
 * Whether a failure leaves the file editable.
 *
 * A read the viewer refused has no contents, and an editor opened on an empty buffer would overwrite a
 * file nobody has seen. Two codes refuse that way, and they are the same refusal at two limits: a text
 * file past the viewer's 1 MB, and an image past its own 2 MB. An image over the cap never reaches the
 * image branch at all — it fails before there are bytes to render — so without this second code the pane
 * would offer to edit a picture it could not show. Every other failure has no contents either, but the
 * component renders its own state for those rather than disabling this one, so the rule stays about the
 * cases that need a disabled control.
 */
export function canEdit(errorCode: string | null): boolean {
  return errorCode !== 'FILE_TOO_LARGE' && errorCode !== 'IMAGE_TOO_LARGE'
}

/**
 * What the viewer says about a failed save.
 *
 * Branched on the code, never on a sentence main wrote: the wording is the renderer's to own, and
 * main's is free to change without the UI changing with it. `WRITE_FAILED` says outright that nothing
 * on disk changed, because a failure that leaves that unsaid leaves the user unsure whether to trust
 * what they are looking at.
 */
export function writeErrorMessage(code: string): string {
  switch (code) {
    case 'WRITE_CONFLICT':
      // The optimistic-concurrency refusal. Worded as a fact about the file rather than as a failure
      // of the save, because the save did exactly what it should: it declined to overwrite.
      return 'This file changed on disk since you opened it, so it was not overwritten.'
    case 'PATH_TRAVERSAL':
      return 'That path is outside the open folder, so it was not written.'
    case 'FILE_TOO_LARGE':
      return 'That file is too large to save from the editor.'
    case 'WRITE_FAILED':
      return 'The file could not be written. Nothing on disk was changed.'
    case 'NO_WORKSPACE':
      return 'Open a folder before saving — there is nowhere to write it.'
    case 'INVALID_PATH':
      return 'That path is not one the workspace can write.'
    case 'FILE_UNAVAILABLE':
      return 'The file could not be read, so there is nothing to save over.'
    default:
      return 'The file could not be saved.'
  }
}
