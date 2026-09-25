import { WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'

/**
 * What a surface says when a switch was refused.
 *
 * Pure and renderer-only, for the reason `editing.ts` and `changes.ts` are: a sentence is a decision a
 * test should make by calling a function rather than by opening a menu and reading it.
 *
 * Nothing here touches a disk, a store, or electron. The paths arrive from main, and what a root is
 * called — the other half of what a switcher shows — is the shared rule in `protocol/recent-roots`,
 * since the home screen's chips name a folder the same way.
 */

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
