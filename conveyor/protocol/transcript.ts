import { z } from 'zod'

/**
 * The shape of a saved transcript, and its version.
 *
 * Shared because two processes need to agree on it: main validates a file before handing it over,
 * and the renderer must not be handed something it cannot render. Kept free of module imports so it
 * never drags main-only code into the renderer bundle.
 *
 * The renderer's `AgentTurn` is structurally this, which is what lets a snapshot be handed straight
 * to the reducer without a translation layer to keep in step.
 */

/** Bumped when the persisted shape changes in a way readers must know about. */
export const TRANSCRIPT_VERSION = 1

/**
 * A tool step. `status` is the widened set, not just the settled ones: a turn interrupted by a
 * restart can legitimately be saved mid-flight, and refusing to read it back would turn a crash
 * into data loss.
 */
const toolStepSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['running', 'awaiting', 'denied', 'ok', 'failed']),
  output: z.string().optional(),
  code: z.string().optional(),
})

const turnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  steps: z.array(toolStepSchema),
  error: z.string().optional(),
})

/**
 * A serialisable agent-session reducer state.
 *
 * `interrupted` records that a turn was cut off — by a restart, or by a window closed mid-run. It is
 * a flag rather than an error message so the UI can decide how to present it, and so a transcript
 * stays valid: an unfinished turn is a normal thing to find, not corruption.
 */
export const transcriptSnapshotSchema = z.object({
  version: z.number().int(),
  turns: z.array(turnSchema),
  interrupted: z.boolean(),
})

export type TranscriptSnapshot = z.infer<typeof transcriptSnapshotSchema>
export type TranscriptToolStep = z.infer<typeof toolStepSchema>
export type TranscriptTurn = z.infer<typeof turnSchema>

/** An empty transcript, for a session that has never been saved. */
export function emptySnapshot(): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, turns: [], interrupted: false }
}
