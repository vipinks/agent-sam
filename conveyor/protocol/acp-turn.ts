import type { AcpEvent } from './acp'
import { engineMarkerLabel } from './engine'
import type { EngineTranscriptChunk } from './codex-turn'

/**
 * The second transcript mapper: what an ACP agent's updates become in the shapes this app's transcript already
 * consumes.
 *
 * The same translation `codex-turn.ts` performs for the exec dialect, stated separately because the two dialects
 * say different things in different members rather than the same things in different spellings: a Codex item
 * carries an exit code in its completion, and an ACP `tool_call_update` carries a status word and nothing else.
 * Writing one mapper with a protocol flag inside it would put both vocabularies' edge cases behind a branch that
 * a reader has to hold in their head; two files that each speak one dialect is what the protocol split already
 * established for `codex-jsonl.ts` and `acp.ts`.
 *
 * What is shared is shared: the chunk vocabulary is `EngineTranscriptChunk` — the panel's own, read by
 * `applyAgentChunk` — so a Kimi turn and a Codex turn are the same turn to everything downstream of this file,
 * and `via` is the engine's short name from the law's marker table rather than anything this mapper decides.
 *
 * Pure, and with one import of the law and one of a type: it reads events it was handed and answers chunks, so
 * every claim below can be stated in a suite without starting a process.
 */

/**
 * The tool kinds this app can name in its own words.
 *
 * The ACP protocol's own `kind` values, mapped to this app's vocabulary so a card says "Running <command>" in
 * the words every other call in this app is described in rather than echoing the agent's noun. A kind absent
 * here is carded under the agent's own word with no arguments, which is honest: inventing a `command` or a
 * `path` from a kind nobody has captured an example of would be showing the user a call that was never made.
 */
const ACP_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: 'read_file',
  edit: 'write_file',
  delete: 'delete_file',
  move: 'move_file',
  search: 'search',
  execute: 'run_command',
  fetch: 'fetch_url',
}

/**
 * The one argument each known kind carries, read from the title the agent gave the call.
 *
 * The title is the only field the protocol's announcement carries that names what is about to happen — the
 * `rawInput` an agent may add is not part of the reading this build does — so it is what a card is drawn from.
 */
function argsFor(kind: string, title: string): Record<string, unknown> {
  if (kind === 'execute') return { command: title }
  if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move') return { path: title }
  return {}
}

/**
 * Turn ACP events into transcript chunks, in the order the agent wrote them.
 *
 * A `tool_call` is the card, a `tool_call_update` is its outcome, and a `message_chunk` is prose. An `other`
 * event draws nothing — it exists so a reader of the stream can see that the agent said something this build
 * does not act on — and empty prose draws nothing either, because a chunk that would append no characters is a
 * frame rather than a sentence.
 *
 * No ending is drawn here. A JSONL stream's ending is its exit, which arrives as an update; an ACP turn's ending
 * is the response to `session/prompt`, which is the runner's to word — so this file has no `turn_end` member to
 * emit and cannot report an ending it never saw.
 */
export function acpTranscriptChunks(events: readonly AcpEvent[], engineId: string): EngineTranscriptChunk[] {
  const chunks: EngineTranscriptChunk[] = []
  const via = engineMarkerLabel(engineId)

  for (const event of events) {
    if (event.type === 'message_chunk') {
      if (event.text !== '') chunks.push({ type: 'text_delta', text: event.text })
      continue
    }

    if (event.type === 'tool_call') {
      chunks.push({
        type: 'tool_call_start',
        callId: event.toolCallId,
        tool: ACP_TOOL_NAMES[event.kind] ?? event.kind,
        args: argsFor(event.kind, event.title),
        via,
      })
      continue
    }

    if (event.type === 'tool_call_update') {
      chunks.push({
        type: 'tool_result',
        callId: event.toolCallId,
        // The protocol's own word for a call that ran to the end. Nothing else counts: a `failed` status is a
        // call that did not work, and a call still `pending` has not said either way — and a card that drew a
        // tick for an unanswered call would be inventing consent the agent never gave.
        ok: event.status === 'completed',
        output: '',
      })
      continue
    }
  }

  return chunks
}
