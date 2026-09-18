import { z } from 'zod'

/**
 * The workspace-change channel, shared by main and the renderer.
 *
 * Deliberately dependency-free — no module imports — so the modules that emit and the router that
 * installs the sink can all import it without a cycle. `workspace.ts` declares the event,
 * `terminal.ts` emits it too, and `router.ts` wires the sink once the router exists.
 *
 * Why this exists at all: directory listings and file contents are cached per path, and every
 * mutation now happens in main — an agent's `write_file`, a shell command — so the renderer has no
 * mutation of its own to invalidate from. Main pushes, the renderer invalidates.
 */

/** What changed. `path` is absolute and only meaningful for `written`. */
export const workspaceChangedSchema = z.object({
  kind: z.enum(['written', 'command-exited']),
  path: z.string().optional(),
})

export type WorkspaceChanged = z.infer<typeof workspaceChangedSchema>

/**
 * The fan-out installed by main. A single sink rather than a per-module emitter: both the workspace
 * and the terminal modules raise the same event, and one channel keeps the renderer's subscription
 * (and its burst coalescing) in one place instead of two.
 */
let sink: ((payload: WorkspaceChanged) => void) | null = null

/** Install the emitter. Called once from `router.ts`, after `createRouter` has assigned module ids. */
export function setWorkspaceChangeSink(next: ((payload: WorkspaceChanged) => void) | null): void {
  sink = next
}

/**
 * Report a change to every window.
 *
 * Safe to call before the sink exists (during module load, or in a test): the notification is
 * dropped rather than throwing, because a change nobody is listening for should never break the
 * write or the command that caused it.
 */
export function notifyWorkspaceChanged(payload: WorkspaceChanged): void {
  sink?.(payload)
}
