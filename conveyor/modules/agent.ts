import { readFile as readFileFromDisk, stat } from 'fs/promises'
import { relative } from 'path'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, stream } from '../init'
import { readApiKey } from './settings'
import { streamDeltas, type ChatMessage, type FetchLike, type ToolCall, type ToolDefinition } from './llm-engine'
import { EXIT_MARKER, STDERR_MARKER } from '../protocol/terminal'
import { nextCallToPresent, type FrameCall, type GateDecision } from '../protocol/approval'
import { computeFileDiff, type FileDiff } from '../protocol/diff'
import { resolveCwd, runCommand } from './terminal'
import { resolveWorkspacePath } from './workspace-paths'
import { MAX_FILE_BYTES, writeWorkspaceFile } from './workspace'
import { readProjectInstructions } from './project-context'
import { instructionsFileName, planAgentPrompt, planSystemInjection } from '../protocol/context'
import { isResumable, isToolCallCut, turnEndCause, type TurnEndCause } from '../protocol/turn-end'
import { assembleMentionContext, MAX_MENTION_PATHS, type MentionSkipCode } from '../protocol/mentions'
import { MAX_PLAN_STEPS, mergePlan, normalizePlan, planStepSchema, type Plan, type PlanStep } from '../protocol/plan'
import { readMentions } from './mentions'

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
 * Consent is per call. A frame may ask for several calls that each need approval, and one click must
 * not answer all of them: the loop presents the first, waits for its decision, runs or refuses it,
 * appends its tool message, and only then presents the next — re-asking the model once the frame's
 * decisions are all resolved. `nextCallToPresent` owns which call is next, so the order is stated
 * once and tested directly. The batch invariant from the previous fix still holds: the model is not
 * asked anything until every `tool_call_id` in the frame has a tool message, denials included.
 *
 * `set_plan` is the one tool exempt from that gate. Every other tool is gated because it touches the
 * disk, a shell or the network through `executeTool`, and consent is the point of the gate. This one
 * writes nothing, spawns nothing and reaches nothing: it declares an ordered list of steps, merges it
 * over the plan in hand, and yields the result as a chunk. A pause in front of it would be a consent
 * dialog with nothing behind it — and a consent dialog with nothing behind it is how a user is
 * trained to dismiss the ones that matter. The exemption is therefore a property of the tool, stated
 * in `needsApproval`, rather than a special case in the loop where the gating decision is made.
 */

/** Model round-trips allowed in one run. A model that will not stop calling tools must not spin. */
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
 * list and yields it, which is why it never reaches the `gated` queue and why a run can announce a
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
       * The conversation so far, including the assistant turn that asked for this call. The renderer
       * hands this back untouched on resume, so the provider-shaped history never has to be
       * reconstructed on the UI side.
       */
      messages: ChatMessage[]
      /**
       * The calls from this frame still awaiting a decision, this one first, exactly as the model
       * sent them. They arrived in one assistant turn and the provider requires an answer for each
       * before the next request, so the queue is carried rather than rebuilt: the run executes what
       * was approved rather than a display layer's reconstruction of it.
       */
      calls: ToolCall[]
      /** Steps consumed so far, so the budget spans approvals rather than resetting on each one. */
      steps: number
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
   * the Continue button reads, and it stays off the auto-continue path deliberately: the app never
   * sends the next message on its own, and a turn that continued itself would spend the user's
   * budget on a conversation they did not ask to continue.
   */
  | { type: 'turn_end_notice'; cause: TurnEndCause; resumable: boolean }
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

interface PendingDecision {
  /**
   * The gated queue from the paused frame, the decided call first.
   *
   * Only the head is answered by this decision. The rest stay queued and are presented one at a
   * time, because consent is per call.
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
 * Put one gated call in front of the user, with the queue behind it.
 *
 * The queue travels with the chunk so the renderer can show what is still coming, and is handed back
 * unchanged on resume — which is how the run re-enters with the model's own calls rather than a
 * rebuild of them.
 */
async function presentCall(
  queue: ToolCall[],
  history: ChatMessage[],
  steps: number,
  workspaceRoot: string | null
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
    steps,
  }
}

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
  steps?: number
  pending?: PendingDecision
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

  // The plan in hand, carried across the round-trips of this run so each declaration merges over the
  // last rather than replacing it. A frame that names three of six steps therefore cannot shrink the
  // checklist to three. It starts empty and is not persisted here: the renderer owns the turn, and a
  // turn is what a transcript stores.
  let plan: Plan = []

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

  // A resumed run re-enters with the head of the paused queue already decided. `opts.messages`
  // already ends with the assistant turn that asked for these calls, so nothing is reconstructed
  // here — pushing it again would duplicate the turn and orphan the other calls in the same frame.
  //
  // Only this one call is answered now. Its decision settles it with its own tool message, and the
  // rest of the queue is presented in turn: the model is not re-asked until every call in the frame
  // has been run or refused, because the provider requires a result for each `tool_call_id` the
  // assistant turn declared before the next request.
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

    // Who is next is the gate's decision, not this loop's: the frame's calls plus the decision just
    // received, and the first one still unanswered is presented. A queue whose every call is now
    // answered falls through to the model with the whole frame settled.
    const frame: FrameCall[] = queue.map((call) => ({
      callId: call.id,
      needsApproval: needsApproval(call.function.name),
    }))
    const decisions: GateDecision[] = [{ callId: decided.id, outcome: opts.pending.denied ? 'denied' : 'approved' }]
    const next = nextCallToPresent(frame, decisions)

    if (next.kind === 'present') {
      const index = queue.findIndex((call) => call.id === next.callId)
      yield await presentCall(queue.slice(index), history, steps, opts.workspaceRoot)
      return
    }
  }

  for (;;) {
    if (steps >= MAX_STEPS) {
      yield { type: 'done', reason: 'max_steps', steps }
      return
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

    const calls = finalizeCalls(partials)
    const assistantText = text.join('')

    // The assistant turn is recorded either way: an OpenAI-compatible provider expects the turn
    // that asked for tools to be present when its results are sent back.
    history.push({
      role: 'assistant',
      content: assistantText,
      ...(calls.length ? { tool_calls: calls } : {}),
    })

    // Before anything is done with them: did this reply actually finish? Every ending is diagnosed,
    // including the ordinary one — "the model stopped" is a fact the caller has to be able to tell
    // apart from a reply that was cut off, and a diagnosis that only spoke up on failure would leave
    // the two indistinguishable.
    const cause = turnEndCause({
      finishReasons,
      toolCallCut: isToolCallCut([...partials.values()].map((partial) => partial.args)),
      streamErrorCode,
    })

    // A turn that died announces itself before it ends, and a turn that was cut off is over whatever
    // the model asked for: the calls it asked for in the same breath arrived alongside a reply the
    // provider had already stopped writing, so running them would be acting on half a request. The
    // notice is the announcement; whether to continue is the user's click, and `resumable` is what
    // the button reads.
    if (cause !== 'model_stop') {
      yield { type: 'turn_end', cause }
      yield { type: 'turn_end_notice', cause, resumable: isResumable(cause) }
      return
    }

    // No tools asked for: this is the model's answer, and the loop is finished.
    if (calls.length === 0) {
      yield { type: 'turn_end', cause }
      yield { type: 'done', reason: 'complete', steps }
      return
    }

    // Calls that need a decision before they can run. Collected rather than executed, and presented
    // one at a time from here on: the assistant turn was recorded with every call it asked for, so
    // the whole frame must be answered before the next request — but answering it is not the same as
    // asking about it all at once, and asking about it all at once is what gave one click the power
    // to authorise calls the user never looked at.
    const gated: ToolCall[] = []

    for (const call of calls) {
      const tool = call.function.name
      const displayArgs = argsForDisplay(call)
      yield { type: 'tool_call_start', callId: call.id, tool, args: displayArgs }

      if (needsApproval(tool) && !opts.autoApprove) {
        gated.push(call)
        continue
      }

      const outcome = await executeTool(tool, call.function.arguments, opts.workspaceRoot, opts.signal, opts.spawnImpl)
      if (opts.signal.aborted) return

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

    // The history is handed over exactly as it stands, with the whole gated queue but only its head
    // presented. `resume` answers that one call, then presents the next, and so on until the frame is
    // settled — so the run continues rather than restarting this round-trip.
    if (gated.length > 0) {
      yield await presentCall(gated, history, steps, opts.workspaceRoot)
      return
    }
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
    }),
    async function* ({ input, signal }) {
      const apiKey = await requireApiKey(input.providerId)
      yield* runAgentLoop({
        providerId: input.providerId,
        apiKey,
        model: input.model,
        workspaceRoot: input.workspaceRoot,
        messages: input.messages as ChatMessage[],
        autoApprove: input.autoApprove ?? false,
        mentionPaths: input.mentionPaths,
        signal,
      })
    }
  ),

  /**
   * Continue a run that paused for approval.
   *
   * The decision answers one call. If the paused frame had more calls waiting, the loop presents the
   * next one instead of re-asking the model, so consent stays per call while the frame's tool-call
   * contract is still satisfied in full.
   *
   * Denial does not end the conversation: the refusal is fed back as the tool's result, so the model
   * can explain itself rather than the turn dying silently.
   */
  resume: stream(
    z.object({
      providerId: z.string().min(1),
      model: z.string().min(1),
      messages: z.array(messageSchema).min(1),
      workspaceRoot: z.string().nullable(),
      autoApprove: z.boolean().optional(),
      /**
       * The gated queue as it was handed over: the decided call first, the rest still to present.
       * The decision answers the head only.
       */
      calls: z.array(callSchema).min(1, 'At least one call must be answered'),
      steps: z.number().int().min(0).optional(),
      decision: z.enum(['approved', 'denied']),
    }),
    async function* ({ input, signal }) {
      const apiKey = await requireApiKey(input.providerId)
      yield* runAgentLoop({
        providerId: input.providerId,
        apiKey,
        model: input.model,
        workspaceRoot: input.workspaceRoot,
        messages: input.messages as ChatMessage[],
        autoApprove: input.autoApprove ?? false,
        signal,
        steps: input.steps ?? 0,
        pending: {
          calls: input.calls as ToolCall[],
          denied: input.decision === 'denied',
        },
      })
    }
  ),
})

/** The key is read here rather than passed in, so the renderer never holds one. */
async function requireApiKey(providerId: string): Promise<string> {
  const apiKey = await readApiKey(providerId)
  if (!apiKey) {
    throw new ConveyorError(
      'NO_API_KEY',
      `No API key is saved for ${providerId}. Add one in Settings to start chatting.`
    )
  }
  return apiKey
}
