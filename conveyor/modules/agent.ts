import { readFile as readFileFromDisk, stat } from 'fs/promises'
import { relative } from 'path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, stream } from '../init'
import { readApiKey } from './settings'
import { streamDeltas, type ChatMessage, type FetchLike, type ToolCall, type ToolDefinition } from './llm-engine'
import { EXIT_MARKER, STDERR_MARKER } from '../protocol/terminal'
import { nextGateIndex, type FrameCall } from '../protocol/approval'
import { computeFileDiff, type FileDiff } from '../protocol/diff'
import { resolveCwd, runCommand } from './terminal'
import { resolveWorkspacePath } from './workspace-paths'
import { MAX_FILE_BYTES, writeWorkspaceFile } from './workspace'
import { readProjectInstructions } from './project-context'
import { instructionsFileName, planAgentPrompt, planSystemInjection } from '../protocol/context'
import {
  AUTO_CONTINUE_MAX,
  autoContinueNudge,
  isResumable,
  isToolCallCut,
  planUnfinishedNotice,
  shouldAutoContinue,
  turnEndCause,
  unfinishedPlanSteps,
  type TurnEndCause,
} from '../protocol/turn-end'
import { assembleMentionContext, MAX_MENTION_PATHS, type MentionSkipCode } from '../protocol/mentions'
import {
  MAX_PLAN_STEPS,
  mergePlan,
  normalizePlan,
  planStepSchema,
  reconcilePlanOnTurnEnd,
  type Plan,
  type PlanStep,
} from '../protocol/plan'
import { readMentions } from './mentions'
import { resolveActiveSkills, userSkillsDir } from './skills'
import { assembleSkillsSection, MAX_ACTIVE_SKILLS, planSkillsInjection } from '../protocol/skills'

/**
 * The agent loop: the model's reasoning and the app's hands, connected.
 *
 * A ReAct loop is a conversation with the model that keeps going while the model asks for tools:
 * send the history, take whatever tool calls come back, run them, append the results as `tool`
 * turns, and ask again. It ends when the model answers with prose and no tool calls, or when the
 * step budget runs out.
 *
 * Two decisions shape this file.
 *
 * The loop lives here rather than in the renderer because tools touch the disk and spawn processes,
 * and the architectural rule is that only `conveyor/modules/*` may do that. The renderer sees
 * chunks: text, a call being made, its result, and — when a call needs consent — a pause.
 *
 * Approval cannot be a pause *inside* one stream. A conveyor `stream()` handler receives input once,
 * at the start, and has no channel back from the renderer, so there is nothing to resume into. The
 * loop is therefore split: `chatWithTools` runs until a call needs approval and then yields
 * `awaiting_approval` and ends, and `resume` continues from the decision. The UI's Approve button
 * starts a new stream rather than unpausing an old one.
 *
 * Consent is per call, and the frame is walked strictly in the order the model wrote it. One click
 * must not answer several calls, and no call may overtake a decision either: the walk stops dead at
 * the first call that needs consent, runs nothing behind it, and resumes where it stopped once that
 * decision lands. `nextGateIndex` owns where the walk stops, so the order is stated once and tested
 * directly, and the renderer-side half of the same law — no outcome below an undecided call — is
 * `firstPauseViolation`. The batch invariant from the previous fix still holds: the model is not
 * asked anything until every `tool_call_id` in the frame has a tool message, denials included.
 *
 * A refusal is the one decision that does not resume the walk. It ends the turn where it stopped:
 * the refused call is answered with the refusal so the frame's record is complete, and the calls
 * behind it are never run — a turn that has ended asks the model nothing further, so there is no
 * request for their results to be missing from.
 *
 * `set_plan` is the one tool exempt from that gate. Every other tool is gated because it touches the
 * disk, a shell or the network through `executeTool`, and consent is the point of the gate. This one
 * writes nothing, spawns nothing and reaches nothing: it declares an ordered list of steps, merges it
 * over the plan in hand, and yields the result as a chunk. A pause in front of it would be a consent
 * dialog with nothing behind it — and a consent dialog with nothing behind it is how a user is
 * trained to dismiss the ones that matter. The exemption is therefore a property of the tool, stated
 * in `needsApproval`, rather than a special case in the loop where the gating decision is made.
 */

/**
 * Model round-trips allowed in one segment of a run.
 *
 * A segment is the stretch between two auto-continuations, and the counter starts over at each nudge: this
 * is what stops a model that will not stop calling tools from spinning, while the bound on the turn as a
 * whole is the auto-continue budget — the one number the user reads on the seam. So one turn may pay this
 * many round-trips per segment, for as many segments as its budget buys, and the marker drawn at each seam
 * is what makes that spend visible.
 */
export const MAX_STEPS = 10

/** Output handed back to the model. A build log should inform it, not exhaust its context. */
const MAX_TOOL_OUTPUT = 20_000

export const TOOL_NAMES = ['read_file', 'write_file', 'run_command', 'set_plan'] as const
export type AgentToolName = (typeof TOOL_NAMES)[number]

/**
 * The tools, in OpenAI's function-calling dialect. The descriptions are the model's only
 * documentation, so they say what each tool is for and what the paths are relative to.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the open workspace. Use this to inspect code before changing it. Paths are relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. src/app.ts' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a text file in the open workspace, creating parent directories as needed. Overwrites the file if it exists, so read it first. Paths are relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. src/utils/format.ts' },
          content: { type: 'string', description: 'The complete new file contents' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its combined output and exit code. Use it for tests, builds, and inspecting the repository.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run' },
          cwd: { type: 'string', description: 'Optional directory to run in, relative to the workspace root' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_plan',
      description:
        'Declare the plan for the work in hand as an ordered list of steps. Send the whole list every time: an entry whose id already exists updates that step, an id that is new is added, and a step you leave out is kept exactly as it was. Mark the one step you are working on in_progress, and nothing else. This only records the plan for the user — it reads and writes no files and runs no commands.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'The plan, in the order the work should be read.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A stable identifier for the step, reused to update it' },
                text: { type: 'string', description: 'The step as the user should read it' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done'],
                  description: 'Where this step has got to',
                },
              },
              required: ['id', 'text', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    },
  },
]

/** Argument shapes, validated before anything touches the disk or a shell. */
const TOOL_ARG_SCHEMAS = {
  read_file: z.object({ path: z.string().min(1) }),
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  run_command: z.object({ command: z.string().min(1), cwd: z.string().optional() }),
  // A plan beyond the cap is refused rather than truncated, so the model is told its declaration did
  // not land instead of having steps dropped and then working from a list the user cannot see.
  set_plan: z.object({ steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS) }),
} satisfies Record<AgentToolName, z.ZodType>

/**
 * Write and shell access need consent; reading is safe, and so is declaring a plan. An unrecognised
 * tool is treated as needing approval, because the safer default for something unclassified is to
 * ask.
 *
 * Both exemptions are tools that cannot act on anything outside this process. `set_plan` merges a
 * list and yields it, which is why a walk never stops in front of it and why a run can announce a
 * plan mid-turn without stopping to ask — the property the node plan suite asserts directly.
 */
export function needsApproval(tool: string): boolean {
  return tool !== 'read_file' && tool !== 'set_plan'
}

function isAgentTool(tool: string): tool is AgentToolName {
  return (TOOL_NAMES as readonly string[]).includes(tool)
}

/** What a tool produced, in the form both the model and the UI need. */
export interface ToolOutcome {
  ok: boolean
  /** A stable code for the UI to branch on, absent when the tool simply succeeded. */
  code?: string
  /** Text for the model. On failure this explains what was refused. */
  output: string
}

/** Cut a long tool result down to something a model can use. */
function cap(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… output truncated at ${MAX_TOOL_OUTPUT} characters`
}

/** How a workspace path is shown back to the user: relative to the folder they opened. */
function displayPath(workspaceRoot: string | null, absolute: string): string {
  if (!workspaceRoot) return absolute
  const rel = relative(workspaceRoot, absolute)
  return rel && !rel.startsWith('..') ? rel : absolute
}

/**
 * The root a write needs, as a non-null string.
 *
 * `resolveWorkspacePath` already refuses a missing root with NO_WORKSPACE; this narrows the type so
 * the shared write helper — which the renderer's command also calls with a required root — can take
 * a plain string.
 */
function requireRoot(workspaceRoot: string | null): string {
  if (!workspaceRoot) {
    throw new ConveyorError('NO_WORKSPACE', 'Open a folder before writing files.')
  }
  return workspaceRoot
}

/**
 * Run one tool call.
 *
 * A refused operation is returned as `ok: false` rather than thrown: the model should be told that
 * its write was blocked and be given the chance to respond, and killing the whole stream would take
 * that chance away. Only a programming error escapes as a throw.
 *
 * `spawnImpl` is threaded through so `run_command` can be driven from a test.
 */
export async function executeTool(
  tool: string,
  argsJson: string,
  workspaceRoot: string | null,
  signal: AbortSignal,
  spawnImpl?: typeof import('child_process').spawn
): Promise<ToolOutcome> {
  if (!isAgentTool(tool)) {
    return { ok: false, code: 'UNKNOWN_TOOL', output: `There is no tool called '${tool}'.` }
  }

  // Models occasionally emit invalid JSON, usually by trailing a comma or wrapping the object in
  // prose. Reporting it back is more useful than failing the run.
  let rawArgs: unknown
  try {
    rawArgs = JSON.parse(argsJson || '{}')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      code: 'BAD_TOOL_ARGS',
      output: `The arguments for ${tool} were not valid JSON (${reason}). Send a single JSON object.`,
    }
  }

  const parsed = TOOL_ARG_SCHEMAS[tool].safeParse(rawArgs)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')
    return { ok: false, code: 'INVALID_TOOL_ARGS', output: `The arguments for ${tool} were invalid — ${issues}.` }
  }

  try {
    switch (tool) {
      case 'read_file': {
        const { path } = parsed.data as { path: string }
        // Reads are confined too. The workspace is the boundary of what the agent may look at, not
        // only of what it may change.
        const target = resolveWorkspacePath(workspaceRoot, path)

        let size: number
        try {
          size = (await stat(target)).size
        } catch {
          return { ok: false, code: 'FILE_UNAVAILABLE', output: `There is no file at ${path}.` }
        }
        if (size > MAX_FILE_BYTES) {
          return {
            ok: false,
            code: 'FILE_TOO_LARGE',
            output: `${path} is ${(size / 1024 / 1024).toFixed(1)} MB, above the ${MAX_FILE_BYTES / 1024 / 1024} MB read limit.`,
          }
        }

        const content = await readFileFromDisk(target, 'utf8')
        return { ok: true, output: cap(content) }
      }

      case 'write_file': {
        const { path, content } = parsed.data as { path: string; content: string }
        // Through the workspace's own write path rather than `fs` directly: that is what announces
        // the change to the renderer, so the explorer and the open file pick the edit up.
        //
        // No baseline, deliberately: the agent writes content it was handed, not content it read, so it
        // has nothing to compare against and this write stays unguarded. The guard is for an editor
        // saving a buffer over a file that changed since it was loaded.
        const written = await writeWorkspaceFile(requireRoot(workspaceRoot), path, content)
        const bytes = Buffer.byteLength(content, 'utf8')
        return {
          ok: true,
          output: `Wrote ${bytes} bytes to ${displayPath(workspaceRoot, written.path)}.`,
        }
      }

      case 'run_command': {
        const { command, cwd } = parsed.data as { command: string; cwd?: string }
        const workingDirectory = resolveCwd(cwd ?? workspaceRoot ?? '', workspaceRoot)
        if (signal.aborted) return { ok: false, code: 'ABORTED', output: 'The command was cancelled.' }

        // Collected rather than streamed: the model consumes the whole result at once, so there is
        // nothing to gain from handing it a partial picture.
        const chunks: string[] = []
        for await (const chunk of runCommand({ command, cwd: workingDirectory, signal, spawnImpl })) {
          chunks.push(chunk)
        }

        const exit = chunks.find((c) => c.startsWith(EXIT_MARKER))
        const body = chunks
          .filter((c) => !c.startsWith(EXIT_MARKER))
          // The stderr marker is the terminal's wire format; the model should just see the text.
          .map((c) => (c.startsWith(STDERR_MARKER) ? c.slice(STDERR_MARKER.length) : c))
          .join('')

        const code = exit ? Number(exit.slice(EXIT_MARKER.length, -1)) : null
        const summary = code === 0 ? 'Command succeeded (exit code 0).' : `Command exited with code ${code}.`
        const output = body.trim() ? `${body}\n${summary}` : summary
        return { ok: code === 0, code: code === 0 ? undefined : 'COMMAND_FAILED', output: cap(output) }
      }

      case 'set_plan': {
        // Nothing is done here, deliberately. The list was validated against the schema above, and the
        // loop merges it into the plan in hand — the loop is the side that can yield the result, and a
        // merge here would be a second place for the same rule to be decided.
        const { steps } = parsed.data as { steps: PlanStep[] }
        return { ok: true, output: `Recorded a plan of ${steps.length} step${steps.length === 1 ? '' : 's'}.` }
      }
    }
  } catch (err) {
    // Containment failures arrive here as typed errors; anything else is reported as-is so the model
    // can see why it failed rather than being told a generic failure.
    if (err instanceof ConveyorError) {
      return { ok: false, code: err.code, output: err.message }
    }
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, code: 'TOOL_FAILED', output: `${tool} failed: ${reason}` }
  }
}

// ---------------------------------------------------------------- the loop

/** Chunks the renderer understands. Each is plain data, so it survives the IPC hop. */
export type AgentChunk =
  | { type: 'text_delta'; text: string }
  /**
   * The project instructions this send is being made under, announced before the model answers.
   *
   * Announced so the turn can record it: the transcript has to be able to say which file stood behind
   * an answer, and the renderer is the side that owns the turn. Yielded only when the instructions are
   * actually injected — a resumed run re-enters with what the pause handed back, so it announces
   * nothing and the name it already recorded stands.
   */
  | { type: 'project_instructions'; file: string; truncated: boolean }
  /**
   * A file the user attached that could not be included.
   *
   * Reported rather than swallowed, and carrying the code rather than a sentence: the UI says what
   * happened in its own words, and the model is told the same fact in the section. A skip that reached
   * the renderer as prose would have to be parsed back out of it to be shown.
   *
   * The paths themselves need no chunk: the renderer sent them, so it already holds the list and can
   * record it on the turn. This is only for what it could not know — which of them did not make it.
   */
  | { type: 'context_notice'; path: string; code: MentionSkipCode }
  | { type: 'tool_call_start'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; tool: string; ok: boolean; code?: string; output: string }
  /**
   * The plan as it stands after a `set_plan` declaration, merged in the loop rather than handed over
   * exactly as the model sent it.
   *
   * Merged here, once, for the same reason the transcript shape is shared: the renderer would
   * otherwise have to merge as well, and two merges can disagree. The chunk therefore carries the
   * whole plan — a checklist is small, and a diff of one would be a second representation to keep
   * correct — and it is announced on every declaration rather than only when something changed, so the
   * UI has one rule to follow instead of two.
   *
   * Yielded only when the declaration carried a usable step: an empty plan is no plan, and a chunk
   * announcing one would put a checklist on screen with nothing in it.
   */
  | { type: 'plan'; plan: PlanStep[] }
  | {
      type: 'awaiting_approval'
      /** The one call this decision is about. Every other card in the queue is not yet actionable. */
      callId: string
      tool: string
      args: Record<string, unknown>
      /**
       * The change this write would make, when it is a `write_file` and the baseline could be read.
       * Computed in main — the renderer must not read the disk — and absent for every other tool.
       */
      diff?: FileDiff
      /**
       * The plan the turn had in hand when it paused, as the checklist is showing it.
       *
       * Carried because the run does not survive the pause: the resumed stream is a new generator,
       * and a turn that came back with an empty plan would finish mid-plan and report nothing about
       * it. Handed back untouched on resume, like the history beside it.
       */
      plan: PlanStep[]
      /**
       * The conversation so far, including the assistant turn that asked for this call. The renderer
       * hands this back untouched on resume, so the provider-shaped history never has to be
       * reconstructed on the UI side.
       */
      messages: ChatMessage[]
      /**
       * The calls of this frame from the one being asked about, in the model's own order: this one
       * first, then everything it is holding back.
       *
       * Everything, not only the calls that will need a decision of their own. An exempt call behind
       * the parked one has not run and will not run until this decision lands, so it belongs to the
       * queue as much as a gated one does — and leaving it out would drop it from the run entirely,
       * because the queue is what the resume walks. They arrived in one assistant turn and the
       * provider requires an answer for each before the next request, so the queue is carried rather
       * than rebuilt: the run executes what the model asked for, in the order it asked.
       */
      calls: ToolCall[]
      /** Steps consumed so far, so the budget spans approvals rather than resetting on each one. */
      steps: number
      /**
       * Auto-continuations spent so far, carried for the same reason `steps` is.
       *
       * The budget belongs to the user's turn, and a turn that paused for consent is still that turn:
       * a count that came back as zero would let an approval reset it, and a model that asked for a
       * permission between every stretch of work could then continue itself without limit.
       */
      continuations: number
    }
  /**
   * How the assistant's reply ended, for every turn that ends by the model's own answering rather
   * than by a pause or the step budget.
   *
   * Yielded whether or not anything went wrong, because "the model finished" is a diagnosis too and
   * the one the renderer must be able to distinguish from the two that went wrong. Nothing is
   * recorded from this chunk: the ordinary ending needs no memory, and the two endings that do are
   * carried by the notice below.
   */
  | { type: 'turn_end'; cause: TurnEndCause }
  /**
   * A turn that died: the provider cut the reply off, or the reply stopped arriving.
   *
   * Sent only for those two causes, and only when the turn is over — so it is both the announcement
   * that a stop was not silent and the only chunk a transcript keeps about it. `resumable` is what
   * the Continue button reads. A reply that stopped arriving is the manual ending and stays manual:
   * nothing this app sends reopens a dropped connection. A reply the provider cut off at its output cap
   * is not manual any more — the loop nudges it while there is work on the plan and budget left to
   * spend, so the card under it is the one that appears once that budget is spent.
   *
   * `unfinishedSteps` is what a plan-shaped ending adds to the same chunk rather than travelling in a
   * second one: a cut-off reply under an unfinished plan is one ending with two things true about it,
   * and two cards would read as two events. Its presence is what tells the card to say the work is not
   * done, and — unlike `resumable` — a complete answer can carry it, because work left undone is a
   * reason to continue that has nothing to do with how the reply ended.
   */
  | { type: 'turn_end_notice'; cause: TurnEndCause; resumable: boolean; unfinishedSteps?: number }
  /**
   * A turn that picked itself up again, and how much of its budget it has now spent.
   *
   * Yielded *instead* of the ending above when an ending the auto-continue rule can answer is reached
   * with steps left on the plan: the run then asks the model again rather than ending, so there is no
   * ending to announce and the turn is not over. `count`, `max` and the cause travel with it rather than
   * being known by the pane, so the line the user reads is the loop's own account of what it did — one
   * turn's `2 of 8` can never be confused with another build's different budget, and the reason it kept
   * going is never guessed at from the reply that followed.
   */
  | { type: 'auto_continue'; count: number; max: number; cause: TurnEndCause }
  | { type: 'done'; reason: 'complete' | 'max_steps'; steps: number }

/** A tool call as it is being assembled from stream fragments. */
interface PartialCall {
  index: number
  id?: string
  name?: string
  args: string
}

function finalizeCalls(partials: Map<number, PartialCall>): ToolCall[] {
  return [...partials.values()]
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      id: p.id ?? `call_${p.index}`,
      type: 'function' as const,
      function: { name: p.name ?? '', arguments: p.args },
    }))
}

/** Parse the arguments of a call for display, falling back to the raw string. */
function argsForDisplay(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { raw: call.function.arguments }
  }
}

/** A one-line description of a call, for the action card's title. */
export function describeToolCall(tool: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : undefined
  switch (tool) {
    case 'read_file':
      return path ? `Reading ${path}` : 'Reading a file'
    case 'write_file':
      return path ? `Writing ${path}` : 'Writing a file'
    case 'run_command':
      return typeof args.command === 'string' ? `Running ${args.command}` : 'Running a command'
    case 'set_plan':
      return Array.isArray(args.steps) ? `Planning ${args.steps.length} steps` : 'Planning'
    default:
      return `Calling ${tool}`
  }
}

/**
 * How a frame walk ended.
 *
 * Three endings rather than a boolean, because the caller has to do something different with each:
 * a settled frame goes on to the next model round-trip, a pause ends the stream so the decision can
 * start the next one, and an abort ends the run without the app deciding anything for the user.
 */
type WalkEnd = 'settled' | 'paused' | 'aborted'

interface PendingDecision {
  /**
   * The frame's calls from the paused one, in frame order: the call this decision answers first.
   *
   * The head is the only call the decision settles. What follows it is the rest of the frame, and on
   * an approval the walk takes them in order from there — running the ones that need no consent and
   * stopping again at the next one that does, because consent is per call.
   */
  calls: ToolCall[]
  denied: boolean
}

/**
 * The change a `write_file` would make, for the consent card.
 *
 * Read here, in main, because the renderer must never touch the disk: only the finished diff crosses
 * the IPC hop. A write whose target cannot be resolved or read gets no preview rather than a failed
 * pause — executing it will report the real problem, and the user still needs the card to decide on.
 */
async function previewWriteDiff(
  workspaceRoot: string | null,
  tool: string,
  argsJson: string
): Promise<FileDiff | undefined> {
  if (tool !== 'write_file') return undefined

  let requested: { path: string; content: string }
  try {
    requested = TOOL_ARG_SCHEMAS.write_file.parse(JSON.parse(argsJson || '{}'))
  } catch {
    // Malformed arguments are the execution's problem to report, not the card's.
    return undefined
  }

  let target: string
  try {
    target = resolveWorkspacePath(workspaceRoot, requested.path)
  } catch {
    // Outside the workspace, or no workspace at all. Both are refused at execution time with a code
    // the UI branches on; the card just shows the call.
    return undefined
  }

  let before: string | null
  try {
    const size = (await stat(target)).size
    // Above the read limit the baseline is not worth loading, and the diff would be capped anyway.
    if (size > MAX_FILE_BYTES) return undefined
    before = await readFileFromDisk(target, 'utf8')
  } catch {
    // Absent is the ordinary "new file" case, which is a diff of pure additions.
    before = null
  }

  return computeFileDiff(before, requested.content)
}

/**
 * Put the call the walk stopped at in front of the user, with the frame's remainder behind it.
 *
 * The queue travels with the chunk so the renderer can show what is waiting and hand it back
 * unchanged on resume — which is how the run re-enters with the model's own calls rather than a
 * rebuild of them, and why the calls behind this one stay unexecuted rather than disappearing.
 */
async function presentCall(
  queue: ToolCall[],
  history: ChatMessage[],
  steps: number,
  continuations: number,
  workspaceRoot: string | null,
  plan: readonly PlanStep[]
): Promise<AgentChunk> {
  const call = queue[0]
  const tool = call.function.name

  return {
    type: 'awaiting_approval',
    callId: call.id,
    tool,
    args: argsForDisplay(call),
    diff: await previewWriteDiff(workspaceRoot, tool, call.function.arguments),
    calls: queue,
    messages: history.map((m) => ({ ...m })),
    plan: plan.map((step) => ({ ...step })),
    steps,
    continuations,
  }
}

/**
 * End the turn here, and say what the ending owes the user.
 *
 * The one place a turn ends in this loop: an ending that runs out of output room, an ending that is
 * the model's own answer, and an ending that hits the step budget all come through here, so no way
 * out can leave a plan claiming work is under way while another way out would have reconciled it. A
 * pause does not come through here — a pause ends the stream, not the turn — which is why the caller
 * that presents a call returns before reaching this.
 *
 * One ending is decided here rather than announced: an ending the auto-continue rule says this turn
 * should be picked up from. That ending does not end the turn — it yields the auto-continue chunk the
 * user reads and hands the caller the nudge to send, and the loop asks the model again. It is decided in
 * this function rather than beside it for the same reason everything else here is: every ending passes
 * through one place, so a turn that continues itself cannot be a turn that skipped the reconciliation,
 * the counting, or the budget.
 *
 * The plan is reconciled rather than reported as declared: a turn that has ended cannot have a step
 * in progress, and the notice counts the reconciled plan, so a step stopped midway through is counted
 * as the unfinished work it is instead of being reported as done.
 */
async function* finishTurn(
  plan: Plan,
  cause: TurnEndCause,
  steps: number,
  reason: 'complete' | 'max_steps' | null,
  usedBudget: number,
  /**
   * Whether a nudge may answer this ending at all.
   *
   * The rule below decides *which* endings are worth continuing; this says whether the caller has an
   * ending whose continuation would be meaningful, which it knows and this function cannot. One caller
   * passes false: a refusal is a decision the user has already made, which the app must not answer with
   * "try again anyway". The loop's own step budget passes true — a segment's budget spent with work left on
   * the plan is an unfinished turn like any other, and the caller restarts the step counter for the segment
   * the nudge opens, so that ending is not asked about by the same ceiling all over again immediately. A
   * cut-off turn passes it when the frame holds nothing to run,
   * which for a reply the provider cut off is every time: the loop empties a cut reply's frame of its
   * calls before it gets here, because a cut reply never runs its own tool calls — so what this is asked
   * about is a frame with no half-request left in it to refuse.
   */
  continuable: boolean
): AsyncGenerator<AgentChunk, TurnEnding, undefined> {
  const reconciled = reconcilePlanOnTurnEnd(plan)

  if (continuable && shouldAutoContinue(cause, reconciled, usedBudget)) {
    // The cause travels with the count, because the user is owed the reason the machine kept going: a
    // turn picked up after the provider ran out of room is a different event from one picked up after
    // the model stopped, and only the second is something the user can do anything about.
    yield { type: 'auto_continue', count: usedBudget + 1, max: AUTO_CONTINUE_MAX, cause }
    return autoContinueNudge(unfinishedPlanSteps(reconciled))
  }

  yield { type: 'turn_end', cause }

  // Two ways a turn earns something said about it, merged into one card: the reply that stopped
  // arriving, and the work that is not done. A turn can be both, and a user reading one of them still
  // needs the other, so they travel in the same chunk rather than as two rows.
  const unfinished = planUnfinishedNotice(reconciled, cause)
  if (unfinished) {
    yield {
      type: 'turn_end_notice',
      cause,
      resumable: unfinished.resumable,
      unfinishedSteps: unfinished.unfinishedSteps,
    }
  } else if (cause !== 'model_stop') {
    // The reply's own ending, when there is no plan to speak for. An ordinary ending with a finished
    // plan is still the one ending that says nothing: the card exists for the turns that need
    // explaining, and a row under every answer is how it stops being read.
    yield { type: 'turn_end_notice', cause, resumable: isResumable(cause) }
  }

  if (reason !== null) yield { type: 'done', reason, steps }
  return null
}

/**
 * What a finishing turn hands back to the loop: the nudge to send when the turn is not over, and null
 * when it is.
 *
 * A message rather than a flag, because the message is the whole of what a continuation needs and the
 * loop is the only side that may put it on the wire. Returning it here keeps the count, the plan and
 * the wording in the one place that reconciled them, rather than having the caller reconcile a second
 * time to write the same sentence.
 */
type TurnEnding = string | null

/**
 * The plan a `set_plan` call declared, or `null` when the call carried nothing usable.
 *
 * Read back out of the call's own arguments rather than returned by the tool: `executeTool` is shared
 * with every other tool and its result is text for the model, while a plan is a structure for the
 * renderer. Parsed leniently — through the same `normalizePlan` the renderer uses — so one malformed
 * row costs a row rather than the plan, and a blob that is not JSON at all is simply no plan.
 */
function declaredPlan(argsJson: string): Plan | null {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}')
    return normalizePlan((parsed as { steps?: unknown })?.steps)
  } catch {
    return null
  }
}

interface LoopOptions {
  providerId: string
  apiKey: string
  model: string
  /**
   * The descriptor of a provider the user added, when this run's provider is one.
   *
   * Unvalidated here on purpose: this loop is handed whatever a caller has, and the descriptor is
   * checked where it is used — in `llm-engine`, at the same boundary that decides between a built-in
   * provider and a custom one, so there is exactly one place that says what a runnable descriptor is.
   */
  provider?: unknown
  workspaceRoot: string | null
  messages: ChatMessage[]
  autoApprove: boolean
  signal: AbortSignal
  /**
   * Workspace-relative files the user attached to this send, in the order they attached them.
   *
   * Read here, in main, and appended to the user's message as a context section: the renderer knows
   * which paths the user picked and nothing about their contents. Absent for a resumed run, which
   * re-sends the history it was handed back — including the section already in it — rather than
   * reading the files a second time and appending them twice.
   */
  mentionPaths?: string[]
  /**
   * The skills this session has activated, by id, in the order the user turned them on.
   *
   * Ids only, and resolved to bodies in main at the turn start: a skill is a file on the user's own disk,
   * and what it says now is the only copy worth sending. Absent for a run with none, and for a resumed
   * run — which is the same turn continuing, with the section already in the history it handed back.
   */
  activeSkillIds?: readonly string[]
  steps?: number
  pending?: PendingDecision
  /**
   * The auto-continuations this turn had already spent when it paused, on a resumed run.
   *
   * Beside `steps`, and for the same reason: the budget is the turn's, and a resume is that turn
   * continuing rather than a new one. Absent for a fresh run, which has spent nothing.
   */
  continuations?: number
  /**
   * The plan the turn had in hand when it paused, on a resumed run.
   *
   * A resumed run is the same turn continuing, so its plan comes back with it: a resume that started
   * from an empty plan would report a turn that had done nothing as having nothing left to do.
   */
  plan?: readonly PlanStep[]
  /**
   * The platform the run is on, which decides what the terminal is.
   *
   * Injected for the same reason `fetchImpl` is: the standing instruction's shell line is
   * platform-detected, so the suite that pins it has to be able to say which platform it is pinning —
   * a rule keyed on the machine running the test could only ever be verified on one kind of machine.
   * The module members leave it unset, and main's own `process.platform` is the real value.
   */
  platform?: NodeJS.Platform
  /** Injected so the loop can be driven from a test; the module members leave it unset. */
  fetchImpl?: FetchLike
  spawnImpl?: typeof import('child_process').spawn
}

/**
 * The loop itself. Shared by `chatWithTools` and `resume`, which differ only in whether the run
 * starts fresh or continues past a decision.
 *
 * Exported for the same reason `executeTool` is: the module members do the key lookup and nothing
 * else, so the reasoning loop is exercised directly against a mocked provider rather than only
 * through a real one.
 */
export async function* runAgentLoop(opts: LoopOptions): AsyncGenerator<AgentChunk, void, undefined> {
  const history: ChatMessage[] = opts.messages.map((m) => ({ ...m }))
  let steps = opts.steps ?? 0
  /**
   * How many times this turn has continued itself, spent against `AUTO_CONTINUE_MAX`.
   *
   * Per *turn*, which is what a user send is: a fresh send starts a fresh loop and so a fresh budget,
   * while a resume from a consent pause is the same turn continuing and comes back with the count it
   * had already spent — carried through the pause beside the step count, for exactly the same reason.
   * That is also why the counter lives here rather than being derived from the history: a budget read
   * out of the transcript would be a second source of truth a reopened conversation could disagree with.
   */
  let continuations = opts.continuations ?? 0

  // The plan in hand, carried across the round-trips of this run so each declaration merges over the
  // last rather than replacing it. A frame that names three of six steps therefore cannot shrink the
  // checklist to three. It is not persisted here: the renderer owns the turn, and a turn is what a
  // transcript stores. A resumed run starts from the plan the pause handed back, because it is the
  // same turn continuing — starting empty would let a turn finish mid-plan and say nothing about it.
  let plan: Plan = opts.plan ? opts.plan.map((step) => ({ ...step })) : []

  // The project instructions, read fresh on every send rather than kept anywhere.
  //
  // Recomputing is the point: editing AGENTS.md and sending again must take effect immediately, and
  // a cached copy would be a second source of truth that no one thinks to invalidate. They are also
  // never written to a transcript — a transcript records the conversation, and instructions belong to
  // the folder it happened in. That is why this is a read per send rather than a stored field.
  const instructions = await readProjectInstructions(opts.workspaceRoot)
  const injection = planSystemInjection(history, instructions?.text ?? null)
  // The agent's own standing instruction, decided from the same untouched history: the two messages
  // are independent, so a workspace with no instructions file still gets this one. Read before
  // either is unshifted, because both rules answer "is it already there" and the first unshift would
  // answer for the second.
  const agentPrompt = planAgentPrompt(history, opts.platform ?? process.platform)

  // The skills this session has activated, resolved here, at the turn start, from the same folder the
  // run is in and the user's own skills folder beside it.
  //
  // Resolved rather than carried from the renderer, because what a skill *says* is the disk's answer:
  // the renderer holds ids, and a body that travelled with a message could be an edit old or a file
  // deleted since. A skill that cannot be found, cannot be read, or does not fit refuses the turn from
  // in here — nothing is sent, and nothing is dropped quietly to keep the turn going.
  //
  // Decided from the same untouched history as the two above, for the same reason: all three rules
  // answer "is this already in the conversation", and the first unshift would answer for the rest. A
  // resumed run re-enters with the history its pause handed back, skills section included, so this
  // finds it already there and adds nothing — which is what keeps a continued turn from carrying two
  // copies of the same instructions.
  const activeSkills = await resolveActiveSkills({
    rootPath: opts.workspaceRoot,
    userDir: userSkillsDir(app.getPath('appData')),
    activeSkillIds: opts.activeSkillIds ?? [],
  })
  const skillsInjection = planSkillsInjection(history, assembleSkillsSection(activeSkills))

  // Appended at the end of the standing-context block: closest to the conversation it governs, and
  // after the project's own instructions, which are the folder's word rather than a skill's.
  if (skillsInjection) history.unshift({ role: 'system', content: skillsInjection.content })

  if (injection) {
    // Position 0, before the conversation: the provider treats a system message as standing context
    // for everything after it, and a leading one is the only place that is unambiguously true.
    history.unshift({ role: 'system', content: injection.content })

    // And the renderer is told what was read, so the turn it is filling in can record the name and
    // whether the read was capped. The name, never the text: this is a label for the transcript, and
    // the text it labels is deliberately stored nowhere.
    const file = instructionsFileName(instructions?.path ?? null)
    if (file) yield { type: 'project_instructions', file, truncated: instructions?.truncated ?? false }
  }

  // And ahead of it, the instruction that holds in every workspace: how to pace itself between tool
  // calls. Unshifted after the project's so it reads first, which is where standing context for the
  // whole conversation belongs.
  if (agentPrompt) history.unshift({ role: 'system', content: agentPrompt.content })

  // The files the user attached, read here and appended to the last user turn.
  //
  // Appended rather than sent as their own message, because they are context *for* that message: a
  // separate turn would put a wall of file content between the user's sentence and the model's answer
  // to it, and the model would have to guess which one it was being asked about.
  //
  // Only on a fresh send. A resumed run re-enters with the history the pause handed back, which
  // already carries the section inside its user turn — reading and appending again would duplicate
  // every attached file in the request.
  if (!opts.pending && opts.mentionPaths && opts.mentionPaths.length > 0) {
    // Re-capped here even though the schema already did: the schema guards the IPC boundary, and this
    // guards the loop, which is also called directly from tests and could be handed anything.
    const paths = opts.mentionPaths.slice(0, MAX_MENTION_PATHS)
    const reads = await readMentions(opts.workspaceRoot, paths)
    const { section, notices } = assembleMentionContext(reads)

    // The user's message gets the section. Found from the end because the last user turn is the one
    // this send is about; an earlier one already went to the provider without it.
    const lastUser = history.findLast((m) => m.role === 'user')
    if (lastUser && section) lastUser.content = `${lastUser.content}\n\n${section}`

    // Each skip is reported as it is found, so the renderer can mark the chip the user is looking at
    // rather than only telling them after the answer arrived.
    for (const notice of notices) {
      yield { type: 'context_notice', path: notice.path, code: notice.code }
    }
  }

  // ---------------------------------------------------------------- the frame walk

  /**
   * Walk a frame's calls from `cursor`, in the order the model wrote them.
   *
   * This is where the serialization law lives. The walk runs every call in front of the gate — they
   * need no decision, so there is nothing to wait for — and then stops dead in front of the first
   * call that needs one: that call is announced and put to the user, and *nothing behind it runs*,
   * an approval-exempt call included. Both halves matter. A walk that ran the exempt calls behind the
   * parked one would be executing work the user has not agreed to the surrounding action for, in the
   * same frame, in an order the user never sanctioned; the reported session is exactly that shape —
   * a command waiting on a decision with two file reads already marked done behind it.
   *
   * A resumed run calls this again with the queue the pause handed over, so one rule covers a fresh
   * frame and a continued one: the cursor is where the run has got to, and the gate answers whether
   * it may take the next step.
   */
  async function* walkFrame(frame: ToolCall[], cursor: number): AsyncGenerator<AgentChunk, WalkEnd, void> {
    const calls: FrameCall[] = frame.map((call) => ({
      callId: call.id,
      // Auto-approve answers every question in advance, so the gate has nothing to stop at. It is read
      // here, once, where the flags are built: a walk that consulted the setting per call would be a
      // second place for the same decision about the same run.
      needsApproval: needsApproval(call.function.name) && !opts.autoApprove,
    }))
    const gate = nextGateIndex(calls, cursor)
    // Where the stretch with nothing to decide ends: the gate itself when there is one, and the end
    // of the frame when there is not.
    const stop = gate === -1 ? frame.length : gate

    for (let index = cursor; index < stop; index += 1) {
      const call = frame[index]
      const tool = call.function.name
      yield { type: 'tool_call_start', callId: call.id, tool, args: argsForDisplay(call) }

      const outcome = await executeTool(tool, call.function.arguments, opts.workspaceRoot, opts.signal, opts.spawnImpl)
      if (opts.signal.aborted) return 'aborted'

      yield { type: 'tool_result', callId: call.id, tool, ok: outcome.ok, code: outcome.code, output: outcome.output }
      // A declared plan is announced after its result, so what the user sees in the checklist and what
      // the model was told arrive in the same order they happened. Merged over the plan in hand, and
      // only when the call carried one: a refused call or an empty list leaves the plan as it was.
      if (tool === 'set_plan' && outcome.ok) {
        const declared = declaredPlan(call.function.arguments)
        if (declared) {
          plan = mergePlan(plan, declared)
          yield { type: 'plan', plan }
        }
      }
      // Failures go back to the model as ordinary tool output, which is what lets it adapt instead of
      // the run collapsing.
      history.push({ role: 'tool', tool_call_id: call.id, content: outcome.output })
    }

    if (gate === -1) return 'settled'

    // The gate's own call, announced before it is put to the user so there is a card to decide on,
    // and unanswered by anything behind it. The queue is the frame from here on as the model wrote
    // it, so a resume continues the frame rather than a display layer's idea of it.
    const parked = frame[gate]
    yield { type: 'tool_call_start', callId: parked.id, tool: parked.function.name, args: argsForDisplay(parked) }
    yield await presentCall(frame.slice(gate), history, steps, continuations, opts.workspaceRoot, plan)
    return 'paused'
  }

  // A resumed run re-enters with the head of the paused queue already decided. `opts.messages`
  // already ends with the assistant turn that asked for these calls, so nothing is reconstructed
  // here — pushing it again would duplicate the turn and orphan the other calls in the same frame.
  //
  // Only this one call is answered now. Its decision settles it with its own tool message, and the
  // walk then takes the rest of the frame in order — which is why the model is not re-asked until
  // every call in it has been run or refused: the provider requires a result for each `tool_call_id`
  // the assistant turn declared before the next request.
  if (opts.pending) {
    const queue = opts.pending.calls
    const decided = queue[0]
    const tool = decided.function.name

    const outcome: ToolOutcome = opts.pending.denied
      ? {
          ok: false,
          code: 'DENIED',
          output:
            'The user denied permission to run this tool. Do not retry it. Explain what you were trying to do and ask how they would like to proceed.',
        }
      : await executeTool(tool, decided.function.arguments, opts.workspaceRoot, opts.signal, opts.spawnImpl)

    // The result is yielded as well as recorded, so the card already on screen can be completed
    // rather than left looking like it is still running.
    yield { type: 'tool_result', callId: decided.id, tool, ok: outcome.ok, code: outcome.code, output: outcome.output }
    history.push({ role: 'tool', tool_call_id: decided.id, content: outcome.output })
    steps += 1

    // A refusal ends the turn here, and the ending is the one every ending passes through. Nothing
    // behind the refused call is walked — not the calls that needed no consent, and not the next one
    // that did — because a decision the user already made against this frame cannot be followed by
    // acting on it. The model is not asked again either: the refusal is the answer, and a turn that
    // has ended asks nothing, so there is no request in which the frame's unrun calls would be owed
    // a result.
    if (opts.pending.denied) {
      // The budget is passed through as the counter stands and the ending still cannot spend it: a
      // denial is the user's own decision, and the app does not answer it by asking the model again.
      yield* finishTurn(plan, 'model_stop', steps, null, continuations, false)
      return
    }

    // The approval answers one call and says nothing about the rest. They are walked in the frame's
    // own order from behind it: the calls that need no consent actually run, and the next one that
    // does stops the walk again for its own decision.
    const walked = yield* walkFrame(queue, 1)
    if (walked !== 'settled') return
  }

  for (;;) {
    if (steps >= MAX_STEPS) {
      // The budget ran out, which is an ending like any other: whatever the plan still holds is work
      // the turn did not do, and this is the ending a user is least able to see for themselves. The
      // cause is the ordinary one — the last reply arrived complete; it was the loop that stopped —
      // so the cause copy says nothing and the plan is what the card is about.
      //
      // Continuable, because the ceiling is the loop's own limit rather than the model's answer. Passing
      // false here was the defect this phase fixes: the guard short-circuited before `shouldAutoContinue`
      // was ever asked, so the ending a long turn most often has left — a plan still unfinished with the
      // auto-continue budget untouched — put the card up while there was still money in the pocket. What
      // the rule decides is unchanged; this exit lets it decide.
      const nudge = yield* finishTurn(plan, 'model_stop', steps, 'max_steps', continuations, true)
      if (nudge === null) return

      // The step budget is a segment's length rather than the turn's, so the counter starts over behind the
      // nudge: the segment a nudge opens is as long as the one that ended, and the bound the user watches
      // stays the one they can read — AUTO_CONTINUE_MAX nudges on one turn's plan, with a line drawn on the
      // answer at each. A nudge that came back to a spent counter would be answered by this same ceiling at
      // once, which is a round-trip paid to reach the wall the turn has just left.
      continuations += 1
      history.push({ role: 'user', content: nudge })
      steps = 0
      continue
    }
    steps += 1

    // One model round-trip. Tool calls arrive as fragments spread across frames, so they are
    // accumulated by index and only interpreted once the stream has ended.
    const text: string[] = []
    const partials = new Map<number, PartialCall>()
    // What the provider said about its own ending, and whether the reply broke instead. Collected per
    // round-trip, because each reply is diagnosed on its own facts.
    const finishReasons: string[] = []
    let streamErrorCode: string | undefined

    try {
      for await (const delta of streamDeltas({
        providerId: opts.providerId,
        apiKey: opts.apiKey,
        model: opts.model,
        messages: history,
        tools: TOOL_DEFINITIONS,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        provider: opts.provider,
      })) {
        if (opts.signal.aborted) return

        if (delta.finishReason) finishReasons.push(delta.finishReason)

        if (delta.text) {
          text.push(delta.text)
          yield { type: 'text_delta', text: delta.text }
        }

        // Every fragment in the frame, not just the first: a provider may batch several calls into one
        // `tool_calls` array, and a call that never gets accumulated is a call that never gets answered.
        for (const fragment of delta.toolCalls ?? []) {
          const existing = partials.get(fragment.index) ?? { index: fragment.index, args: '' }
          if (fragment.id) existing.id = fragment.id
          if (fragment.name) existing.name = fragment.name
          if (fragment.argumentsDelta) existing.args += fragment.argumentsDelta
          partials.set(fragment.index, existing)
        }
      }
    } catch (err) {
      // Only a reply that stopped arriving is diagnosed here. A provider that refused the request
      // outright — no key, a rejected key, a rate limit, a bad model — threw before any of the answer
      // existed, and that is a failure to report rather than a turn to continue: it propagates
      // unchanged, so the wording the renderer already has for it stays what the user sees. Branched
      // on the code, never on the message.
      if (!(err instanceof ConveyorError) || err.code !== 'STREAM_ERROR') throw err
      streamErrorCode = err.code
    }

    const assistantText = text.join('')

    // Before anything is done with them: did this reply actually finish? Every ending is diagnosed,
    // including the ordinary one — "the model stopped" is a fact the caller has to be able to tell
    // apart from a reply that was cut off, and a diagnosis that only spoke up on failure would leave
    // the two indistinguishable.
    const cause = turnEndCause({
      finishReasons,
      toolCallCut: isToolCallCut([...partials.values()].map((partial) => partial.args)),
      streamErrorCode,
    })

    // The frame a reply the provider cut off is allowed to keep: none of its calls.
    //
    // Phase 23's rule, applied where it decides something — a cut reply never runs its own tool calls.
    // The calls it asked for arrived alongside a reply that had already stopped being written, so
    // running them would be acting on half a request, and that holds whatever the cut landed on: a payload
    // that never became valid JSON, or one that did.
    //
    // Emptied rather than passed through, because of what reads the frame next: the gate below asks
    // whether the frame asked for anything, and any call left in it answers yes. That is the defect this
    // phase fixes. The death a long turn actually has is the provider running out of output room in the
    // middle of a tool-call payload, and the partial call that leaves behind was read as work in hand —
    // so a truncated turn with an unfinished plan and budget left ended on the card instead of being
    // nudged, over a reply that had nothing it could run.
    //
    // Discarding is safe for one reason, and it is the invariant this rests on: nothing in this frame has
    // run. A frame's calls are executed by `walkFrame`, which this run reaches only on the `model_stop`
    // path below, so a frame whose calls were parsed and executed has the ordinary ending and never
    // arrives here. Discarding them also keeps the nudge honest — those calls are sent to no one and
    // answered by nothing, so leaving them on the assistant turn would ask the provider for the results of
    // calls that were never run.
    //
    // A dropped connection keeps its frame as it arrived: `shouldAutoContinue` refuses that cause
    // outright, so that ending is the card whatever the frame holds.
    const calls = cause === 'truncated' ? [] : finalizeCalls(partials)

    // The assistant turn is recorded either way: an OpenAI-compatible provider expects the turn
    // that asked for tools to be present when its results are sent back.
    history.push({
      role: 'assistant',
      content: assistantText,
      ...(calls.length ? { tool_calls: calls } : {}),
    })

    // A turn that died announces itself before it ends, and a turn that was cut off is over whatever
    // the model asked for: the calls it asked for in the same breath arrived alongside a reply the
    // provider had already stopped writing, so running them would be acting on half a request — which is
    // why the frame above was emptied of them. The notice is the announcement. Whether to continue is
    // decided by `finishTurn`, which is the one place holding the reconciled plan and the budget — and
    // the reason the reply was cut off is not a reason to stop: a truncated reply with nothing to run
    // asks the loop for the rest, which is the click the user would have made. That is what the flag
    // below says, and it is now true of every truncated frame, because there is no call left in one to
    // be work in hand. A connection that dropped asks for nothing and continues nothing, whatever the
    // frame said.
    if (cause !== 'model_stop') {
      const nudge = yield* finishTurn(plan, cause, steps, null, continuations, calls.length === 0)
      if (nudge === null) return

      // A nudge opens a segment, and a segment's length is the step budget: reset here for the same reason
      // the step-budget exit resets it — a nudge that came back to a spent counter would be answered by the
      // same ceiling immediately.
      continuations += 1
      history.push({ role: 'user', content: nudge })
      steps = 0
      continue
    }

    // No tools asked for: this is the model's answer, and the loop is finished — unless the answer left
    // work on the plan, in which case this ending does not end the turn. `finishTurn` is the judge of
    // that, because it is the one place holding the reconciled plan and the budget; all this side does
    // is take the nudge it hands back and put it on the wire. The nudge goes out as a user-role message
    // — the only role the provider has for the operator speaking — and is sent to the provider and
    // nowhere else: no chunk carries it, so the pane never renders it as something the user typed, and
    // the transcript of this conversation gains no turn from it.
    if (calls.length === 0) {
      const nudge = yield* finishTurn(plan, cause, steps, 'complete', continuations, true)
      if (nudge === null) return

      // The step budget starts over with the segment, as it does at the ceiling and at a dead reply: the
      // counter measures one segment's spend, never the turn's.
      continuations += 1
      history.push({ role: 'user', content: nudge })
      steps = 0
      continue
    }

    // The frame is walked in the model's own order, and the walk is where the decision gate lives: it
    // runs the calls in front of the gate and stops dead at it, so nothing behind a call the user has
    // not decided yet runs — exempt or not. A pause ends this stream; `resume` continues the walk from
    // the queue the pause handed over, so the run carries on rather than restarting this round-trip.
    const walked = yield* walkFrame(calls, 0)
    if (walked !== 'settled') return
  }
}

// ---------------------------------------------------------------- the module

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })
    )
    .optional(),
  tool_call_id: z.string().optional(),
})

const callSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
})

export const agentModule = defineModule({
  /**
   * Start an agent run. Streams reasoning text, the calls it makes, their results, and — when a call
   * needs consent — a pause for the user to approve or deny.
   */
  chatWithTools: stream(
    z.object({
      providerId: z.string().min(1),
      model: z.string().min(1),
      messages: z.array(messageSchema).min(1, 'A conversation needs at least one message'),
      workspaceRoot: z.string().nullable(),
      autoApprove: z.boolean().optional(),
      /**
       * The files the user attached, as workspace-relative paths.
       *
       * Capped here, at the boundary, rather than trusted: this array is renderer-supplied and each
       * path becomes a disk read, so an uncapped one would be an arbitrary number of reads per send. A
       * non-string is refused by the schema rather than coerced, and an empty list is simply no
       * mentions.
       */
      mentionPaths: z.array(z.string()).max(MAX_MENTION_PATHS).optional(),
      /**
       * The skills the session has active, by id.
       *
       * Capped at this boundary as well as in the store that holds them, because this array decides how
       * much standing context a send carries: the cap is the app's prompt budget, so a payload claiming
       * nine skills is refused here rather than resolved and sent. A non-string is refused by the schema
       * rather than coerced, and an empty list is simply no skills.
       */
      activeSkillIds: z.array(z.string().min(1)).max(MAX_ACTIVE_SKILLS).optional(),
      /**
       * The descriptor of a provider the user added, when this run's provider is one.
       *
       * `unknown` on purpose: the loop is handed whatever a caller has, and what makes a descriptor
       * runnable is decided where it is used — in `llm-engine`, at the boundary that chooses between a
       * built-in provider and a custom one. Validating it here as well would be a second answer to the
       * same question, and the two would eventually disagree.
       */
      provider: z.unknown().optional(),
    }),
    async function* ({ input, signal }) {
      const { apiKey, provider } = await resolveRun(input.providerId, input.provider)
      yield* runAgentLoop({
        providerId: input.providerId,
        apiKey,
        model: input.model,
        provider,
        workspaceRoot: input.workspaceRoot,
        messages: input.messages as ChatMessage[],
        autoApprove: input.autoApprove ?? false,
        mentionPaths: input.mentionPaths,
        // Straight through: the ids the session holds, which main resolves against the disk at this turn
        // start. A resume does not carry them — it is the turn that paused continuing, and its history
        // already has the section this would rebuild.
        activeSkillIds: input.activeSkillIds,
        signal,
      })
    }
  ),

  /**
   * Continue a run that paused for approval.
   *
   * The decision answers one call. An approval resumes the frame's walk where it stopped — the calls
   * that need no consent run, and the next call that needs one is presented instead of re-asking the
   * model — so consent stays per call while the frame's tool-call contract is still satisfied in
   * full.
   *
   * A denial ends the turn instead, through the same ending every other ending passes through: the
   * refused call is answered with the refusal and the calls behind it are never run. The turn is over
   * at that point, so nothing further is asked of the model.
   */
  resume: stream(
    z.object({
      providerId: z.string().min(1),
      model: z.string().min(1),
      messages: z.array(messageSchema).min(1),
      workspaceRoot: z.string().nullable(),
      autoApprove: z.boolean().optional(),
      /**
       * The frame's calls from the paused one, in frame order: the decided call first, then everything
       * the pause was holding back. The decision answers the head only; an approval walks the rest.
       */
      calls: z.array(callSchema).min(1, 'At least one call must be answered'),
      steps: z.number().int().min(0).optional(),
      /**
       * The auto-continuations the turn has already spent, handed straight back like the step count.
       *
       * Validated rather than trusted for the same reason: it crosses the IPC boundary and it bounds how
       * much work the app does on the user's behalf. A count past the cap reads as spent, so a payload
       * cannot buy extra round-trips by claiming a negative one either.
       */
      continuations: z.number().int().min(0).max(AUTO_CONTINUE_MAX).optional(),
      /**
       * The plan the pause handed over, handed straight back.
       *
       * Validated as a plan and not trusted: this crosses the IPC boundary, and the checklist it
       * becomes is rendered from it. Capped like a declaration, because the two are the same list seen
       * at two moments.
       */
      plan: z.array(planStepSchema).max(MAX_PLAN_STEPS).optional(),
      decision: z.enum(['approved', 'denied']),
      /** The same descriptor the run started with: a resumed turn is the same turn. */
      provider: z.unknown().optional(),
    }),
    async function* ({ input, signal }) {
      const { apiKey, provider } = await resolveRun(input.providerId, input.provider)
      yield* runAgentLoop({
        providerId: input.providerId,
        apiKey,
        model: input.model,
        provider,
        workspaceRoot: input.workspaceRoot,
        messages: input.messages as ChatMessage[],
        autoApprove: input.autoApprove ?? false,
        signal,
        steps: input.steps ?? 0,
        // The count of continuations this turn has already spent, so an approval does not refund it.
        continuations: input.continuations ?? 0,
        // The plan the pause handed back, so the turn that continues is the turn it was. Absent on a
        // resume from a turn that had declared none, which is a turn with nothing to carry.
        ...(input.plan ? { plan: input.plan } : {}),
        pending: {
          calls: input.calls as ToolCall[],
          denied: input.decision === 'denied',
        },
      })
    }
  ),
})

/**
 * The credential and the descriptor a run goes out with.
 *
 * The key is read here rather than passed in, so the renderer never holds one. What "a key" means
 * differs between the two kinds of provider, and that is the whole reason this is one function rather
 * than two calls at the two stream handlers:
 *
 * - A provider that ships with the app needs a key. There is no route to it without one, so a missing
 *   key is `NO_API_KEY` — the failure the user can act on, since Settings is one click away.
 *
 * - A provider the user added may have none, and for a server on their own machine that is the ordinary
 *   case rather than an unfinished setup. So the descriptor's own `apiKey` is filled in from the key
 *   store rather than trusted from the payload: the renderer sends the descriptor it holds, where that
 *   field is always empty, because the list it comes from is mirrored to every window.
 */
async function resolveRun(providerId: string, descriptor: unknown): Promise<{ apiKey: string; provider: unknown }> {
  const stored = await readApiKey(providerId)

  if (descriptor === undefined || descriptor === null) {
    if (!stored) {
      throw new ConveyorError(
        'NO_API_KEY',
        `No API key is saved for ${providerId}. Add one in Settings to start chatting.`
      )
    }
    return { apiKey: stored, provider: undefined }
  }

  // Not an object: handed through untouched, for the engine to refuse with `INVALID_PROVIDER`. Nothing
  // here can fold a key into something that is not a descriptor, and guessing at one would be the
  // second validator the engine's own check exists to avoid.
  if (typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { apiKey: stored ?? '', provider: descriptor }
  }

  return { apiKey: stored ?? '', provider: { ...descriptor, apiKey: stored ?? '' } }
}
