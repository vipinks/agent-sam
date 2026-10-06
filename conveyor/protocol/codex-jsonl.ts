/**
 * `codex exec --json`, as lines: what the CLI prints on stdout, read into the update dialect the rest of
 * the app already speaks.
 *
 * The ACP client is the other speaker of that dialect, and this file exists so there is only one of them:
 * a `message_chunk` is prose, a `tool_call` announces a card and `tool_call_update` settles it, and the
 * two additions below — `usage` and a `turn_end` cause — are the fields the ACP stream carries inside its
 * own payloads and this one carries as events. The renderer's reducer, the transcript mapper and the
 * consent bridge therefore read one vocabulary whether an engine was reached over ACP or over JSONL.
 *
 * Pure, and by exactly one import: the framer. A chunk may carry half a line, one line or three, and that
 * rule already exists in `conveyor/protocol/acp.ts` for the peer that writes JSON-RPC down a pipe — this
 * CLI writes JSONL down the same kind of pipe, so the framing is reused rather than respelled. Nothing
 * else is reachable from here: no clock, no path, no process, which is what lets a suite drive the whole
 * mapper off a captured file.
 *
 * The vocabulary below is the capture's, not a schema's. `tests/engines/fixtures/` holds the verbatim
 * stdout of two runs of the CLI installed on this machine, and every event and item kind the mapper acts
 * on is one those runs printed. The kinds it does *not* act on are reported as `other` rather than
 * dropped, so a reader of the stream can see that the CLI said something this build has no opinion about.
 */

import { parseAcpChunk } from './acp'

/**
 * The event kinds the CLI prints, as reported by the capture.
 *
 * The three `item.*` members are the item lifecycle: one started item, one update and its completion.
 * A kind absent from here is still mapped — as `other`, which is the honest answer for a line this build
 * does not act on — because a CLI that invents an event must not be able to stop a turn.
 */
export const CODEX_EVENT_TYPES = {
  threadStarted: 'thread.started',
  turnStarted: 'turn.started',
  turnCompleted: 'turn.completed',
  turnFailed: 'turn.failed',
  itemStarted: 'item.started',
  itemUpdated: 'item.updated',
  itemCompleted: 'item.completed',
} as const

/**
 * The item kinds, split by what this app can do with them.
 *
 * `agent_message` is prose and `command_execution` is a card; the two other tool-ish kinds are listed
 * because a CLI that runs them should draw a card from the same row rather than fall through to `other`.
 * `error` is the CLI's own non-fatal notice — the capture shows one on every run, about a trimmed skills
 * budget — and it is reported rather than drawn: it is not a call and not an answer, and a card for it
 * would put a warning above a conversation that is going fine.
 */
export const CODEX_ITEM_TYPES = {
  agentMessage: 'agent_message',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  error: 'error',
} as const

/** The item kinds that become a card, by the two halves of a card's life. */
const TOOL_ITEM_TYPES: readonly string[] = [
  CODEX_ITEM_TYPES.commandExecution,
  CODEX_ITEM_TYPES.fileChange,
  CODEX_ITEM_TYPES.mcpToolCall,
]

/**
 * How a turn ended, in the vocabulary this app words endings with.
 *
 * The same closed set as `conveyor/protocol/turn-end.ts`, written out rather than imported because the
 * framer is this mapper's one import and a second one would put the vocabulary's module — and whatever it
 * reaches — behind a per-line parser. The node suite asserts the two sets are equal, which is what keeps a
 * restatement from becoming a second, drifting definition.
 */
export const CODEX_TURN_END_CAUSES = ['model_stop', 'empty_stop', 'truncated', 'stream_error'] as const
export type CodexTurnEndCause = (typeof CODEX_TURN_END_CAUSES)[number]

/**
 * One thing the CLI said, as the app reads it.
 *
 * The four members the ACP client already emits keep its names and its field spellings, `sessionId` and
 * all: main's transcript mapper and the shield branch on the same discriminant whichever protocol the
 * update came off, and a second spelling of `tool_call` would be a second branch to keep in step. The two
 * additions are the fields that protocol carries inside a payload — what a turn cost, and how it ended —
 * and they are members here because a JSONL stream has nowhere else to put them.
 */
export type CodexUpdate =
  | { type: 'message_chunk'; sessionId: string; text: string }
  | { type: 'tool_call'; sessionId: string; toolCallId: string; title: string; kind: string; status: string }
  | {
      type: 'tool_call_update'
      sessionId: string
      toolCallId: string
      status: string
      /** What the call printed, as the CLI aggregated it. Empty when it printed nothing. */
      output: string
      /** The child's own exit code, as a string: the card branches on a code and never on its number. */
      code: string
    }
  | { type: 'usage'; sessionId: string; prompt: number; completion: number; cached: number | null }
  | { type: 'turn_end'; sessionId: string; cause: CodexTurnEndCause }
  | { type: 'other'; sessionId: string; kind: string }

/** What one line became: the updates it carried, and the thread they belong to. */
export interface CodexMapped {
  /** The thread id the CLI named, carried forward — read from the stream rather than invented here. */
  threadId: string | null
  updates: CodexUpdate[]
}

/** What one read of the pipe left behind. */
export interface CodexFramed extends CodexMapped {
  /** The tail of an unterminated line, to be prefixed to the next chunk. */
  rest: string
  /** Every line that did not parse. Reported rather than thrown: one bad line is not the end of a turn. */
  malformed: string[]
}

/**
 * The title a tool item is announced with.
 *
 * The item's own words, never a sentence written here: an engine's command is the engine's, and a mapper
 * that dressed it as "Running a command" would be inventing a description of work it cannot see — and the
 * transcript mapper is where words live. The first field that carries one wins, because the tool-ish item
 * kinds spell the same idea differently (`command`, `path`, the server's tool name), and an item with none
 * falls back to its kind, which is at least true.
 */
function toolTitleOf(item: Record<string, unknown>, kind: string): string {
  for (const key of ['command', 'path', 'query', 'name', 'tool']) {
    const value = item[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return kind
}

/** A number off a payload, or `null` when the CLI did not report one. Never a zero it did not say. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One parsed line, as updates.
 *
 * The thread id is the one piece of state the stream carries between lines: `thread.started` names it and
 * every later update is filed under it, so the caller hands in what it has and gets back what it now
 * knows. Everything else answers from the line alone, which is what makes each case here provable against
 * the capture rather than against a running process.
 */
function mapCodexEvent(event: Record<string, unknown>, threadId: string | null): CodexMapped {
  const kind = typeof event.type === 'string' ? event.type : ''
  const sessionId = threadId ?? ''

  if (kind === CODEX_EVENT_TYPES.threadStarted) {
    // The one line that answers with a name rather than an update: a thread is what the rest of the turn
    // is filed under, and there is nothing to draw for it.
    const named = typeof event.thread_id === 'string' ? event.thread_id : ''
    return { threadId: named === '' ? null : named, updates: [] }
  }

  if (
    kind === CODEX_EVENT_TYPES.itemStarted ||
    kind === CODEX_EVENT_TYPES.itemUpdated ||
    kind === CODEX_EVENT_TYPES.itemCompleted
  ) {
    const item = (event.item ?? {}) as Record<string, unknown>
    const itemType = typeof item.type === 'string' ? item.type : ''
    const toolCallId = typeof item.id === 'string' ? item.id : ''
    const status = typeof item.status === 'string' ? item.status : ''

    if (itemType === CODEX_ITEM_TYPES.agentMessage) {
      const text = typeof item.text === 'string' ? item.text : ''
      if (text === '') return { threadId, updates: [] }
      return { threadId, updates: [{ type: 'message_chunk', sessionId, text }] }
    }

    if (TOOL_ITEM_TYPES.includes(itemType)) {
      // The announcement and its outcome are two halves of one card, addressed by the item id the CLI
      // gave it — the same rule the ACP client follows, where a call is settled by its own id and never
      // by the order two events happened to arrive in.
      if (kind === CODEX_EVENT_TYPES.itemStarted) {
        return {
          threadId,
          updates: [
            {
              type: 'tool_call',
              sessionId,
              toolCallId,
              title: toolTitleOf(item, itemType),
              kind: itemType,
              status: status === '' ? 'in_progress' : status,
            },
          ],
        }
      }

      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
      const exit = numberOrNull(item.exit_code)
      return {
        threadId,
        updates: [
          {
            type: 'tool_call_update',
            sessionId,
            toolCallId,
            status: status === '' ? 'completed' : status,
            output,
            // Absent while a call is still running, and absent on kinds that have no exit code at all:
            // an empty string is the honest answer for both, because neither is an exit code of zero.
            code: exit === null ? '' : String(exit),
          },
        ],
      }
    }

    // Everything else an item can be — the CLI's own notice, its reasoning, a todo list, a kind a newer
    // build invents — is reported rather than acted on, so a stream carrying one is still readable.
    return { threadId, updates: [{ type: 'other', sessionId, kind: itemType === '' ? 'item' : itemType }] }
  }

  if (kind === CODEX_EVENT_TYPES.turnCompleted) {
    const usage = (event.usage ?? {}) as Record<string, unknown>
    const prompt = numberOrNull(usage.input_tokens)
    const completion = numberOrNull(usage.output_tokens)
    // Both halves are the measurement; one of them missing is not half a measurement, and a tile lit by
    // `0` where the CLI said nothing is the claim this app's em dashes exist to refuse.
    if (prompt === null || completion === null) return { threadId, updates: [] }
    return {
      threadId,
      updates: [{ type: 'usage', sessionId, prompt, completion, cached: numberOrNull(usage.cached_input_tokens) }],
    }
  }

  if (kind === CODEX_EVENT_TYPES.turnFailed) {
    // The CLI's own sentence is deliberately dropped: the app words its endings itself, and a turn that
    // failed is a stream that stopped mid-sentence as far as anything downstream is concerned.
    return { threadId, updates: [{ type: 'turn_end', sessionId, cause: 'stream_error' }] }
  }

  return { threadId, updates: [{ type: 'other', sessionId, kind }] }
}

/**
 * One line, as updates.
 *
 * A line that is not JSON, or that is JSON but not an object, answers with nothing at all rather than an
 * error: this is called for every line a CLI prints, and a peer that writes a log line into its event
 * stream should not be able to end a turn. The thread id is handed through untouched, which is what keeps
 * the updates after a stray line filed under the thread they belong to.
 */
export function mapCodexLine(line: string, threadId: string | null): CodexMapped {
  if (line.trim() === '') return { threadId, updates: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { threadId, updates: [] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { threadId, updates: [] }
  return mapCodexEvent(parsed as Record<string, unknown>, threadId)
}

/**
 * One read of the pipe: its lines framed, each mapped, and what is left of a partial line handed back.
 *
 * The framing rule is the ACP framer's, called rather than copied — a chunk may split a line, carry
 * several, or end mid-message, and every one of those is a state this has to survive. The thread id
 * threads through the lines of a chunk in order, so a chunk carrying `thread.started` and the reply that
 * followed it files the reply under the thread the same read opened.
 */
export function mapCodexChunk(buffer: string, chunk: string, threadId: string | null): CodexFramed {
  const framed = parseAcpChunk(buffer, chunk)
  const updates: CodexUpdate[] = []
  let current = threadId

  for (const message of framed.messages) {
    const mapped =
      typeof message === 'object' && message !== null && !Array.isArray(message)
        ? mapCodexEvent(message as Record<string, unknown>, current)
        : { threadId: current, updates: [] }
    current = mapped.threadId
    updates.push(...mapped.updates)
  }

  return { threadId: current, updates, rest: framed.rest, malformed: framed.malformed }
}

/**
 * How a turn ended, read off the child.
 *
 * The exit code is the whole of the evidence a JSONL stream leaves behind: the CLI has no `done` frame of
 * its own, so the process ending *is* the ending. A clean exit with an answer is the ordinary one, a clean
 * exit with no answer is the ending that needs said out loud, and anything else — a non-zero code, or a
 * child killed before it exited — is a stream that stopped mid-sentence. Truncation is the one cause this
 * cannot observe: the CLI reports no output limit, so nothing here claims one.
 */
export function codexTurnEndCause(exitCode: number | null, sawAgentText: boolean): CodexTurnEndCause {
  if (exitCode !== 0) return 'stream_error'
  return sawAgentText ? 'model_stop' : 'empty_stop'
}
