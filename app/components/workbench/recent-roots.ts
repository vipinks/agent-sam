import { WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'

/**
 * How the switcher labels a root, and what it says when one could not be opened.
 *
 * Pure and renderer-only, for the reason `editing.ts` and `changes.ts` are: a label and a sentence are
 * decisions a test should make by calling a function rather than by opening a menu and reading it. The
 * component then holds the state and draws the result.
 *
 * Nothing here touches a disk, a store, or electron. The paths arrive from main.
 */

/**
 * A root's last segment: the menu's label, where the full path would not fit.
 *
 * Split on both separators rather than on whichever one this machine uses, because the path was
 * written by the OS the app was running on and a stored root can outlive a change of platform. A
 * trailing separator is dropped rather than named, so a path stored with one still shows its folder.
 */
export function rootTail(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/**
 * The code a folder dialog is reported under when it could not be opened at all.
 *
 * Renderer-owned, unlike `WORKSPACE_MISSING`: nothing crosses the boundary with it. It exists so the
 * one failure that is not about a folder — the dialog itself — is worded from a code like every other
 * refusal, rather than being a bare string at the call site that the next surface has to invent again.
 */
export const PICK_FAILED = 'PICK_FAILED'

/**
 * What a surface says when a switch was refused.
 *
 * Branched on the code, never on a sentence main wrote: the wording is the renderer's to own, and
 * main's is free to change without the UI changing with it. The missing case names the one thing the
 * user can act on — the folder is gone, so the entry is worth forgetting and another is worth opening
 * — rather than reporting a failure with no next move.
 */
export function rootErrorMessage(code: string): string {
  switch (code) {
    case WORKSPACE_MISSING:
      return 'That folder is no longer there. Forget it, or open another one.'
    case PICK_FAILED:
      return 'The folder picker could not be opened.'
    default:
      return 'That folder could not be opened.'
  }
}
