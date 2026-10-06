import { ConveyorError } from 'electron-conveyor/main'
import { ACP_CODES, type AcpPermissionRequest } from '../protocol/acp'
import { acpTranscriptChunks } from '../protocol/acp-turn'
import {
  ENGINE_SPAWN_CODES,
  engineLaunchArgs,
  engineStdinPolicy,
  resolveEngineSpawn,
  type EngineId,
} from '../protocol/engine'
import type { EngineTranscriptChunk } from '../protocol/codex-turn'
import { createAcpClient, type AcpSpawnImpl } from './engine-acp'

/**
 * The ACP engine's turn, as a process: the binary the law sanctions, the session the client opens, and the
 * chunks the agent's updates become.
 *
 * Main-only. The client below it owns the child and the request ids; this file owns one turn's shape — resolve,
 * handshake, open a session, prompt, and end — which is the same shape the Codex runner has, for the same
 * reason: the pane that drives a turn knows nothing about dialects, so both runners have to answer with the
 * same chunks and the same silent cancel.
 *
 * The binary is resolved through the law exactly as the Codex turn's is, and by the same two inputs: the
 * arguments come from the registry's launch config for this engine, and the install pattern's absolute path
 * arrives as `binaryOverride` from the caller that owns the environment. Nothing here writes a flag of its own
 * — `kimi acp` takes none — so a launch config's words are the words the OS is handed.
 *
 * The consent question is not this file's to answer. `onPermissionRequest` is handed in by the module that owns
 * the shield, so a Kimi agent asking to write a file is put to the user through the same card, and answered
 * with the same option id, that a Codex turn's permission request is.
 */

/** One ACP turn's inputs, spelled as the Codex runner spells them so a caller can hand either one the same record. */
export interface AcpTurnInput {
  engineId: string
  prompt: string
  cwd: string
  /** Carried but unused by this dialect: `kimi acp` takes no argument, so no mode becomes a flag. */
  permissionMode?: unknown
  /** Fires when the user cancels. The turn closes the client, which kills the child rather than orphaning it. */
  signal?: AbortSignal
}

export interface AcpTurnDeps {
  /** An absolute path the allowlist sanctions, resolved by the caller that owns the environment. */
  binaryOverride?: string
  /** Left out in the app: the real `child_process.spawn`. Supplied by the suites that watch it. */
  spawnImpl?: AcpSpawnImpl
  /** Put one permission question to whoever can answer it, and answer with the option id they picked. */
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<string>
  /** A line that was not JSON, reported rather than swallowed. */
  onMalformedLine?: (line: string) => void
}

export interface AcpTurnOutcome {
  /** The agent's own word for how the turn ended, as the response carried it. */
  stopReason: string
  /** True when the user stopped the turn, which is not an ending the app has anything to say about. */
  cancelled: boolean
}

/**
 * Run one ACP turn, and stream its chunks as they arrive.
 *
 * A cancel closes the client — which kills the child — and ends the turn silently, for the reason the Codex
 * runner's cancel does: the user stopped it, and a notice saying the stream ended early would be reporting
 * their own click back to them. The `finally` closes the client on every path, so one turn is one child and no
 * agent outlives the answer it gave.
 *
 * The ending is drawn here rather than by the mapper, because the protocol's own ending is a *response* rather
 * than an update on the wire: `model_stop` when the turn said something and stopped, and `empty_stop` when it
 * stopped having said nothing — the same two words the exec dialect's ending is worded with, so the pane's own
 * notice needs no second vocabulary.
 *
 * A refusal to resolve, a handshake the agent answered with an error, and a session that could not be opened
 * all travel as `ConveyorError`s with the law's or the protocol's own code. The caller branches on the code and
 * never on the sentence.
 */
export async function runAcpTurn(
  input: AcpTurnInput,
  deps: AcpTurnDeps,
  onChunk: (chunk: EngineTranscriptChunk) => void
): Promise<AcpTurnOutcome> {
  // The policy is read before anything is started, and it is a refusal rather than a warning: an engine this
  // runner was handed whose stdin nobody holds open has no transport for this dialect, and starting it anyway
  // would be a process speaking into a closed pipe.
  if (engineStdinPolicy(input.engineId) !== 'transport-open') {
    throw new ConveyorError(ENGINE_SPAWN_CODES.ENGINE_UNKNOWN, 'This engine does not speak ACP.')
  }

  const args = [...engineLaunchArgs(input.engineId as EngineId, input.permissionMode)]
  const resolution = resolveEngineSpawn({
    engineId: input.engineId,
    args,
    ...(deps.binaryOverride === undefined ? {} : { binaryOverride: deps.binaryOverride }),
  })

  if (!resolution.ok) {
    throw new ConveyorError(resolution.code, 'The engine could not be resolved to a binary.')
  }

  let sawText = false

  const emit = (chunks: readonly EngineTranscriptChunk[]): void => {
    for (const chunk of chunks) {
      if (chunk.type === 'text_delta' && chunk.text.trim() !== '') sawText = true
      onChunk(chunk)
    }
  }

  const client = createAcpClient({
    spawn: { command: resolution.command, args: resolution.args, cwd: input.cwd },
    ...(deps.spawnImpl === undefined ? {} : { spawnImpl: deps.spawnImpl }),
    onEvent: (event) => emit(acpTranscriptChunks([event], input.engineId)),
    onPermissionRequest: deps.onPermissionRequest,
    ...(deps.onMalformedLine === undefined ? {} : { onMalformedLine: deps.onMalformedLine }),
  })

  let cancelled = false
  const onAbort = (): void => {
    cancelled = true
    client.close()
  }

  if (input.signal?.aborted === true) onAbort()
  else input.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (cancelled) return { stopReason: '', cancelled: true }

    const handshake = await client.initialize()
    if (handshake.refused) {
      throw new ConveyorError(
        ACP_CODES.ACP_HANDSHAKE_FAILED,
        'The engine answered a protocol version this build does not speak.'
      )
    }

    await client.newSession()
    const result = await client.prompt(input.prompt)
    if (cancelled) return { stopReason: result.stopReason, cancelled: true }

    emit([{ type: 'turn_end', cause: sawText ? 'model_stop' : 'empty_stop' }])
    return { stopReason: result.stopReason, cancelled: false }
  } catch (error) {
    // A cancel rejects the call that was in flight — the client refuses what it was waiting on when it closes —
    // and that refusal is the user's own click arriving back here. It is answered the way Codex's cancel is:
    // silently, with no notice to read.
    if (cancelled) return { stopReason: '', cancelled: true }
    throw error
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    client.close()
  }
}
