/**
 * Project instructions: which file holds them, how much of it is read, and what main injects.
 *
 * Pure, and shared rather than main-only, for the same reason the transcript shape is: the export
 * renderer has to name the instructions file, the transcript records that name, and main reads the
 * file — three processes' worth of interest in one small rule, which is exactly the kind of thing
 * that drifts when it is written down twice.
 *
 * Nothing here touches the disk. Main resolves the candidates against the open folder and hands the
 * text in; this decides whether there is a system message at all and what it says.
 */

/**
 * The files that may hold project instructions, in the order they are tried.
 *
 * `SAMAI.md` first because it is this app's own convention, then `AGENTS.md` and `CLAUDE.md`, which
 * are the two names the wider tooling already uses — a repository that has either of those already
 * meant them as instructions for a coding agent, and this app should honour that rather than
 * requiring a second, app-specific copy.
 */
export const INSTRUCTIONS_CANDIDATES = ['SAMAI.md', 'AGENTS.md', 'CLAUDE.md'] as const

/**
 * How much of an instructions file is read.
 *
 * 16 KB is a byte budget, not a character one: the point is to bound what main reads off the disk
 * and what the provider is sent, and bytes are what the disk and the wire measure. A file at the
 * limit is taken whole; a larger one is cut at the boundary and marked, so the model is told its
 * instructions are partial rather than being left to assume it has all of them.
 */
export const MAX_INSTRUCTIONS_BYTES = 16 * 1024

/** The note appended to a truncated instructions file, so the model knows it is reading a prefix. */
export const TRUNCATION_NOTE = '[Project instructions truncated: only the first 16 KB of this file was read.]'

/**
 * The system message for a project, or null when there is nothing to inject.
 *
 * `null` in, `null` out: an empty workspace, or one with none of the candidate files, has no
 * instructions, and inventing a message for it would spend context saying nothing. So would a
 * candidate file that is present but empty — a headerless file instructs nobody.
 *
 * The fence is deliberately explicit about what follows: the text is the user's own file, it arrives
 * before the conversation, and it is to be treated as project instructions rather than as something
 * the person just said. Saying so is cheap; leaving the model to guess the provenance of a wall of
 * text at the head of a conversation is not.
 */
export function assembleSystemContext(instructionsText: string | null): { content: string } | null {
  if (instructionsText === null) return null

  const trimmed = instructionsText.trim()
  if (trimmed === '') return null

  return {
    content: [
      'The following are the project instructions for this workspace, read from the repository.',
      'Treat them as standing guidance for everything in this conversation.',
      '',
      trimmed,
    ].join('\n'),
  }
}

/**
 * The name of the instructions file, as the transcript and the export record it.
 *
 * A name rather than a path: the candidates are all at the workspace root, and recording an absolute
 * path would put a machine-specific string into a transcript that is meant to be portable.
 */
export function instructionsFileName(path: string | null): string | null {
  if (!path) return null
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || null
}

/**
 * The instructions record a transcript's turns carry, if any of them was sent under one.
 *
 * Read back out of the turns rather than kept beside them, because that is where it lives: the record
 * is per turn, since the context a conversation is sent under can change mid-conversation. This is
 * the answer to "what was behind this conversation", which is what an export needs — the first turn
 * that has a record names it, and a conversation whose turns predate the record has none.
 *
 * Structurally typed rather than importing the transcript shape, so this stays a rule about a
 * transcript rather than a second declaration of one.
 */
export function recordedInstructions(
  turns: ReadonlyArray<{ instructionsFile?: string; instructionsTruncated?: boolean }>
): { file: string; truncated: boolean } | null {
  for (const turn of turns) {
    if (turn.instructionsFile) return { file: turn.instructionsFile, truncated: turn.instructionsTruncated === true }
  }
  return null
}

/**
 * Whether to inject the project instructions into an outgoing conversation.
 *
 * Two refusals, both load-bearing:
 *
 * - A conversation that already opens with a system message is left alone. That is what makes this
 *   safe to call on a *resumed* run: the pause hands the provider-shaped history back verbatim, and
 *   prepending again would send the instructions twice — spending the budget twice and putting two
 *   copies of the same wall of text in front of the model.
 * - No instructions, no message, per `assembleSystemContext`.
 *
 * The history is inspected rather than a flag passed, because the flag would have to be kept correct
 * on both entry points, and "is there already one" is a fact about the array in hand.
 */
export function planSystemInjection(
  messages: ReadonlyArray<{ role: string }>,
  instructionsText: string | null
): { content: string } | null {
  if (messages.some((m) => m.role === 'system')) return null
  return assembleSystemContext(instructionsText)
}
