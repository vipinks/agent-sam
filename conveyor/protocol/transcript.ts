import { z } from 'zod'
import { planStepSchema } from './plan'

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

/**
 * Bumped when the persisted shape changes in a way readers must know about.
 *
 * Version 2 widened a tool step's status with `queued`: consent is per call now, so a frame whose
 * calls are waiting behind the one being decided has to be describable on disk as well as live. An
 * older build reading such a file refuses it rather than silently showing a queue as one pause.
 *
 * The project-instructions record did *not* bump it. A turn gained two optional fields, so a file
 * written before them — by this build or the last one — has neither key, and an absent optional key is
 * stripped rather than defaulted. Old files are valid reads, and a new file read by an older build
 * loses only the two fields it never knew about. Nothing a reader has to be told about is a version
 * bump; only a change it would otherwise get wrong is.
 */
export const TRANSCRIPT_VERSION = 2

/**
 * A tool step. `status` is the widened set, not just the settled ones: a turn interrupted by a
 * restart can legitimately be saved mid-flight, and refusing to read it back would turn a crash
 * into data loss.
 */
const toolStepSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['running', 'awaiting', 'queued', 'denied', 'ok', 'failed']),
  output: z.string().optional(),
  code: z.string().optional(),
})

const turnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  steps: z.array(toolStepSchema),
  error: z.string().optional(),
  /**
   * The instructions file this turn was sent under, and whether that read was capped.
   *
   * On the turn rather than on the snapshot, because the context a conversation is sent under can
   * change: a repository that adopts `SAMAI.md` halfway through has turns that were sent under
   * `AGENTS.md` and turns that were not, and a single name for the file would misdate one half.
   *
   * The name, never the text. Instructions are recomputed per send and are not a thing the app stores
   * — a transcript records the conversation, not the folder it happened in.
   */
  instructionsFile: z.string().optional(),
  /** True when only the first 16 KB of that file was read, so the name is not mistaken for the whole. */
  instructionsTruncated: z.boolean().optional(),
  /**
   * The workspace files this turn's message pointed at, as paths.
   *
   * Paths only, and deliberately: the contents are read fresh per send and sent to the provider, and a
   * transcript records the conversation rather than a copy of the user's source tree. A transcript
   * that carried the contents would also go stale the moment the file changed, and could be orders of
   * magnitude larger than the conversation it belongs to.
   *
   * The paths are in the order the user attached them, because that is what a chip row renders and
   * what the export notes; reordering here would quietly disagree with the message the user sent.
   */
  mentionPaths: z.array(z.string()).optional(),
  /**
   * The plan the model had declared when this turn ended, if it had one.
   *
   * Stored so a reopened conversation can show the checklist its turn was working from, and stored
   * *reconciled*: whatever the loop announced, a turn that has ended cannot have a step still in
   * progress, so nothing in this array is `in_progress` by the time it is written.
   *
   * Optional, and it did not bump the version for the same reason the instructions record did not: a
   * file written before plans existed simply has no key, and an absent optional key is stripped
   * rather than defaulted, so old files stay valid reads.
   */
  plan: z.array(planStepSchema).optional(),
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
