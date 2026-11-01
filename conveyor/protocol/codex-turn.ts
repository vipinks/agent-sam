import type { CodexTurnEndCause, CodexUpdate } from './codex-jsonl'
import { engineMarkerLabel } from './engine'

/**
 * The transcript mapper: what the Codex update dialect becomes in the shapes this app's transcript already
 * consumes, so an engine turn and a Sam turn are the same turn to everything downstream of it.
 *
 * One place, deliberately. The panel that drives a run reads chunks and nothing else — it does not know which
 * protocol produced them — so the only difference an engine introduces is where the chunks came from. That is
 * what keeps `applyAgentChunk`'s reducer, the consent bridge and the usage recorder untouched by a second
 * dialect: the mapper is the dialect's whole cost, and it is pure, so it can be stated without a process.
 *
 * The two translations worth naming. A tool kind becomes a tool in *this* app's vocabulary — a
 * `command_execution` is a `run_command`, so the card says "Running <command>" in the words every other call
 * in this app is described in rather than echoing the CLI's own noun. And every call carries `via`, the engine
 * that ran it: an engine's card must not read as one of our own tool calls, which is a distinction only the
 * transcript can carry.
 */
export type EngineTranscriptChunk =
  | { type: 'text_delta'; text: string }
  /** `via` is the marker: the engine's short name, as the panel draws it under the call. */
  | { type: 'tool_call_start'; callId: string; tool: string; args: Record<string, unknown>; via: string }
  | { type: 'tool_result'; callId: string; ok: boolean; output: string; code?: string }
  | { type: 'usage'; prompt: number; completion: number; cached?: number }
  | { type: 'turn_end'; cause: CodexTurnEndCause }
  /**
   * A turn that died before it answered, with the evidence the process left behind.
   *
   * This is the transcript's existing `turn_end_notice`, not a new event: the panel already records it as
   * the turn's ending, and the engine path is reusing it so the renderer has one notice shape whichever
   * side produced the turn. `failure` is the engine's addition — the two facts a CLI leaves on its exit,
   * the code it exited on or the code word a refused spawn answered with, and the bounded stderr tail.
   *
   * It is a chunk rather than an exception because the pane words every other ending from the stream, and
   * a failure that travels as a rejection is a failure the transcript never sees — exactly the bare
   * `Thinking…` this chunk exists to make impossible.
   *
   * `cause` is the turn's ending, not its diagnosis: a dead child is a stream that stopped arriving, so
   * the cause is `stream_error` and the code word travels beside it. `exitCode` is `null` when no child
   * ever ran; `code` is absent when a real exit code is the whole story.
   */
  | {
      type: 'turn_end_notice'
      cause: CodexTurnEndCause
      resumable: boolean
      failure?: {
        exitCode: number | null
        code?: string
        /** The last of stderr, already bounded by the runner: five lines or 500 bytes, never more. */
        tail: string
      }
    }

/**
 * The tool kinds this app can name in its own words.
 *
 * Only the kinds whose arguments are known: a kind absent here is carded under the CLI's own noun with no
 * arguments, which is honest — a card inventing a `path` or a `command` from an item it has no captured example
 * of would be showing the user a call that was never made. `command_execution` is the one the capture proves.
 */
const CODEX_TOOL_NAMES: Readonly<Record<string, string>> = {
  command_execution: 'run_command',
  file_change: 'write_file',
  mcp_tool_call: 'mcp_tool_call',
  web_search: 'web_search',
}

/** The one argument each known kind carries, read from the title the mapper took off the item. */
function argsFor(kind: string, title: string): Record<string, unknown> {
  if (kind === 'command_execution') return { command: title }
  if (kind === 'file_change') return { path: title }
  return {}
}

/**
 * Turn updates into transcript chunks, in order.
 *
 * An `other` update draws nothing: it exists so a reader of the wire can see that the CLI said something this
 * build does not act on, and a transcript built from it would be showing the user a noun they cannot use. Empty
 * prose draws nothing either — a chunk that would append no characters is a frame, not a sentence.
 */
export function codexTranscriptChunks(updates: readonly CodexUpdate[], engineId: string): EngineTranscriptChunk[] {
  const chunks: EngineTranscriptChunk[] = []
  const via = engineMarkerLabel(engineId)

  for (const update of updates) {
    if (update.type === 'message_chunk') {
      if (update.text !== '') chunks.push({ type: 'text_delta', text: update.text })
      continue
    }

    if (update.type === 'tool_call') {
      chunks.push({
        type: 'tool_call_start',
        callId: update.toolCallId,
        tool: CODEX_TOOL_NAMES[update.kind] ?? update.kind,
        args: argsFor(update.kind, update.title),
        via,
      })
      continue
    }

    if (update.type === 'tool_call_update') {
      chunks.push({
        type: 'tool_result',
        callId: update.toolCallId,
        // A call worked when the CLI's own exit code said zero and nothing else: an engine that reports no code
        // at all has not said it succeeded, and a card that drew a tick for that would be inventing consent.
        ok: update.code === '0',
        output: update.output,
        ...(update.code === '' ? {} : { code: update.code }),
      })
      continue
    }

    if (update.type === 'usage') {
      chunks.push({
        type: 'usage',
        prompt: update.prompt,
        completion: update.completion,
        ...(update.cached === null ? {} : { cached: update.cached }),
      })
      continue
    }

    if (update.type === 'turn_end') chunks.push({ type: 'turn_end', cause: update.cause })
  }

  return chunks
}
