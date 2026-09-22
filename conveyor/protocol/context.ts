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
 * The agent's own standing instruction, sent on every send regardless of the workspace.
 *
 * Separate from the project instructions because it is not one: this is how the agent is asked to
 * pace itself, and it holds in a folder that has never heard of this app. It earns its place in the
 * budget by paying for itself — a model that narrates its plan for four paragraphs before it emits
 * the call spends the output limit on prose, and a reply cut off at that limit is exactly the dead
 * turn the notice exists to report. Asking for the call early removes the cause rather than
 * announcing it.
 *
 * One line, and deliberately concrete: "two sentences or fewer" is a budget the model can count
 * against, where "be concise" is a preference it can agree with and then ignore.
 */
export const AGENT_SYSTEM_PROMPT =
  'Keep any narration between tool calls to two sentences or fewer, and emit the tool call early.'

/**
 * The one extra line a Windows machine needs: what its terminal actually is.
 *
 * Live use found this the expensive way — most Windows sessions opened with a bash-ism (`&&`, `ls`,
 * `2>/dev/null`, `python3`), which fails before the model has any reason to suspect the shell rather
 * than the command, so it spent a step or two adapting to something it could have been told. The
 * terminal is not a guess: `shellFor` spawns `powershell.exe` on win32, so this line states a fact
 * about the machine rather than a preference about style.
 *
 * One line, and concrete in the same way the pacing line is: it names the shell and says the syntax
 * follows from it, where "be careful with the shell" is a caution the model can agree with and then
 * ignore.
 */
export const POWERSHELL_SHELL_NOTE =
  'On this machine the terminal is Windows PowerShell, so shell commands must use PowerShell syntax.'

/**
 * The agent's standing instruction as the platform composes it.
 *
 * The base line plus, on Windows only, the shell note: a platform-detected addition rather than a
 * second message, so the injection rule still decides one thing — is the standing instruction already
 * in this history — instead of one thing per platform. The platform is a required argument rather
 * than a defaulted `process.platform` because this module is shared with the renderer, where
 * `process` is not the main process's; the caller that runs in main is the side that knows.
 */
export function agentSystemPrompt(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${AGENT_SYSTEM_PROMPT}\n${POWERSHELL_SHELL_NOTE}` : AGENT_SYSTEM_PROMPT
}

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

/**
 * Whether to inject the agent's standing instruction into an outgoing conversation.
 *
 * Refused when the conversation already carries it, which is the resumed case: the pause hands the
 * provider-shaped history back verbatim, including the system messages the original send put at its
 * head, so injecting again would send the same line twice. The history is inspected rather than a
 * flag passed, for the same reason `planSystemInjection` inspects it: "is it already there" is a
 * fact about the array in hand, where a flag would have to be kept correct on both entry points.
 *
 * Matched on the text rather than on the presence of any system message, because the two injections
 * are decided independently: a workspace with no instructions file has no instruction message and
 * must still get this one. The text is the *composed* prompt, because that is the string a send
 * actually wrote: matching the base line instead would fail to recognise this machine's own message
 * on a resume and inject the shell note a second time.
 */
export function planAgentPrompt(
  messages: ReadonlyArray<{ role: string; content?: string }>,
  platform: NodeJS.Platform
): { content: string } | null {
  const prompt = agentSystemPrompt(platform)
  if (messages.some((m) => m.role === 'system' && m.content === prompt)) return null
  return { content: prompt }
}
