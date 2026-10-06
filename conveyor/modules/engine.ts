import { spawn } from 'child_process'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, stream } from '../init'
import {
  ENGINE_CONSENT_CODES,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_PROBE_ARGS,
  ENGINE_SPAWN_CODES,
  engineRows,
  engineVersion,
  resolveEngineSpawn,
  type EngineProbe,
  type EngineRow,
  type PendingEngineConsent,
} from '../protocol/engine'
import type { AcpPermissionRequest } from '../protocol/acp'
import { installedBinaryFor, runCodexTurn } from './engine-codex'
import type { EngineTranscriptChunk } from '../protocol/codex-turn'

/**
 * The engine rail: what is installed, and the one question an engine may ask the user.
 *
 * Main-only, and the only place an engine binary is started for detection or an engine's consent question is
 * turned into a promise. The spawn law itself lives in `conveyor/protocol/engine.ts` — the allowlist, the
 * argument rules, the refusal codes — and this file is the half that needs a process: it resolves a binary
 * through the law, runs it, reads what it printed, and puts a permission question to the renderer's shield.
 *
 * The probe is a spawn and nothing more: `--version`, an array of arguments, `shell: false`. What it answers
 * is a row's worth of truth — installed, and which version — or a code saying which way it was not.
 */

/** A child process as the probe uses it: stdout, and the two events it waits on. */
export interface EngineSpawned {
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown }
  on: {
    (event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
    (event: 'close', listener: (code: number | null) => void): unknown
  }
}

/**
 * How a process is started.
 *
 * Arguments as an array and no shell, by type rather than by promise: there is no member here through which
 * a caller could ask for one. Injectable so a suite can observe what reached the OS, which is the only way
 * the laws about arguments and shells are assertable at all.
 */
export type EngineSpawnImpl = (
  command: string,
  args: string[],
  options: { shell: false; windowsHide: true; cwd?: string }
) => EngineSpawned

/** How long a version probe may take before it is a binary that does not answer. */
const PROBE_TIMEOUT_MS = 5000

export interface EngineProbeDeps {
  /** Left out in the app: the real `child_process.spawn`. Supplied by the suites that watch it. */
  spawnImpl?: EngineSpawnImpl
  /** The allowlist to resolve through. The shipped one unless a suite is proving the mechanism itself. */
  allowlist?: Readonly<Record<string, string>>
  /**
   * The environment the install pattern is expanded against, and how a directory is read.
   *
   * In the app these are `process.env` and the real file system; a suite hands an empty environment so that the
   * machine it happens to run on cannot change what it is proving — which is the difference between a probe that
   * was tested and one that was tested on a laptop that happens to have the engine installed.
   */
  env?: Readonly<Record<string, string | undefined>>
  readdir?: (dir: string) => string[]
  exists?: (path: string) => boolean
}

/**
 * Ask an engine binary what version it is.
 *
 * Every refusal is a code and never a sentence: `ENGINE_NOT_INSTALLED` is a state the picker draws — a row
 * that says the engine is not here rather than an error the user has to read — and the two other ways a probe
 * fails (`ENGINE_SPAWN_FAILED`, `ENGINE_VERSION_UNREADABLE`) are the ones a surface can say plainly.
 *
 * A binary that answers without a version is not installed as far as this app is concerned: an engine whose
 * version nobody can name is an engine whose adapter nobody can choose, which is the decision this probe is
 * for. ENOENT is caught at the start event rather than by a timer, because the OS answers it immediately.
 */
export async function probeEngine(
  input: { engineId: string; binaryOverride?: string },
  deps: EngineProbeDeps = {}
): Promise<EngineProbe> {
  // Where the install pattern finds the binary first, and the allowlisted name on `PATH` after that: the
  // vendor's own install is the location the probe measured and the one that survives the CLI updating itself,
  // so it is preferred when it is there. An override still wins over both, because it is the user's own answer.
  const installed =
    input.binaryOverride ??
    installedBinaryFor(input.engineId, {
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.readdir === undefined ? {} : { readdir: deps.readdir }),
      ...(deps.exists === undefined ? {} : { exists: deps.exists }),
    })

  const resolution = resolveEngineSpawn({
    engineId: input.engineId,
    args: [...ENGINE_PROBE_ARGS],
    ...(installed === undefined ? {} : { binaryOverride: installed }),
    ...(deps.allowlist === undefined ? {} : { allowlist: deps.allowlist }),
  })

  if (!resolution.ok) return { installed: false, code: resolution.code }

  const spawnImpl: EngineSpawnImpl = deps.spawnImpl ?? (spawn as unknown as EngineSpawnImpl)

  return await new Promise<EngineProbe>((resolve) => {
    let output = ''
    let settled = false

    /**
     * The probe's budget, held in a box rather than in a `let`.
     *
     * The timer can only be created once the child exists — and it has to be cleared by `finish`, which is
     * defined before it. A `let` reassigned exactly once is what `prefer-const` exists to flatten, and the box
     * says the same thing the code means: one timer, created later than the closure that reads it.
     */
    const budget: { timer?: ReturnType<typeof setTimeout> } = {}

    const finish = (probe: EngineProbe): void => {
      if (settled) return
      settled = true
      if (budget.timer !== undefined) clearTimeout(budget.timer)
      resolve(probe)
    }

    let child: EngineSpawned
    try {
      child = spawnImpl(resolution.command, resolution.args, { shell: false, windowsHide: true })
    } catch {
      finish({ installed: false, code: ENGINE_SPAWN_CODES.ENGINE_SPAWN_FAILED })
      return
    }

    budget.timer = setTimeout(
      () => finish({ installed: false, code: ENGINE_SPAWN_CODES.ENGINE_PROBE_TIMEOUT }),
      PROBE_TIMEOUT_MS
    )
    // A probe must never be the reason a process stays alive: this timer is unref'd so a machine that is
    // shutting down is not held open by a probe whose child never answered.
    budget.timer.unref?.()

    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    // stderr is read for the same reason stdout is: several CLIs print their version there, and a probe that
    // only listened to one of the two pipes would report a working engine as unreadable.
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })

    child.on('error', (error) => {
      const code =
        error.code === 'ENOENT' ? ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED : ENGINE_SPAWN_CODES.ENGINE_SPAWN_FAILED
      finish({ installed: false, code })
    })

    child.on('close', () => {
      const version = engineVersion(output)
      finish(
        version === null
          ? { installed: false, code: ENGINE_SPAWN_CODES.ENGINE_VERSION_UNREADABLE }
          : { installed: true, version }
      )
    })
  })
}

// ---------------------------------------------------------------- the consent bridge

/**
 * One engine question, as the shield receives it.
 *
 * The shape is the protocol's — flat, all strings, options with their kinds — and it is defined there rather
 * than here so the renderer can name it without importing a module that starts processes.
 */
export type { PendingEngineConsent }

/** Where a pending question goes, and how it is taken back. Installed by the router, which owns the store. */
export interface EngineConsentSink {
  request: (consent: PendingEngineConsent) => void
  clear: (requestId: string) => void
}

let consentSink: EngineConsentSink | null = null

/** Install the fan-out. Called once from `router.ts`, after the router — and so the store — exists. */
export function setEngineConsentSink(sink: EngineConsentSink | null): void {
  consentSink = sink
}

/** The questions asked and not yet answered, by request id. */
const pendingConsent = new Map<string, (optionId: string) => void>()

/**
 * Put one engine question to the user, and answer with the option they picked.
 *
 * The promise is what the ACP client is waiting on: it resolves with an option id, which the client sends back
 * to the engine as the answer to the question it asked. Nothing here invents a decision — a question nobody
 * can be asked is refused by code, and the client tells the agent `cancelled` rather than telling it the user
 * said no.
 */
export function askEngineConsent(engineId: string, request: AcpPermissionRequest): Promise<string> {
  const sink = consentSink
  if (sink === null) {
    return Promise.reject(
      new ConveyorError(ENGINE_CONSENT_CODES.ENGINE_CONSENT_UNANSWERED, 'No window could be asked.')
    )
  }

  return new Promise<string>((resolve) => {
    pendingConsent.set(request.requestId, resolve)
    sink.request({
      requestId: request.requestId,
      engineId,
      engineName: ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS] ?? engineId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options.map((option) => ({ ...option })),
    })
  })
}

/**
 * Answer one engine question with the option the user picked, and take it off the shield.
 *
 * Idempotent on purpose: an answer for a question nobody is waiting on is a click that arrived twice — a
 * second window, a double press — and the honest response to it is nothing at all rather than an error.
 */
export function answerEngineConsent(input: { requestId: string; optionId: string }): void {
  const resolve = pendingConsent.get(input.requestId)
  if (resolve === undefined) return
  pendingConsent.delete(input.requestId)
  consentSink?.clear(input.requestId)
  resolve(input.optionId)
}

// ---------------------------------------------------------------- the module

/** Where the probed rows are published. Installed by the router, which owns the store they land in. */
export interface EngineStatusSink {
  record: (rows: EngineRow[]) => void
}

let statusSink: EngineStatusSink | null = null

/** Install the fan-out. Called once from `router.ts`, after the router — and so the store — exists. */
export function setEngineStatusSink(sink: EngineStatusSink | null): void {
  statusSink = sink
}

/**
 * Probe every allowlisted engine, and publish what was found.
 *
 * The app's own row is built by the protocol's `engineRows`, so the list a picker draws and the list main
 * publishes cannot drift: the app's own row first, then every engine, each with what its own probe answered.
 *
 * Not awaited by its caller, and that is deliberate: a probe starts a process, and nothing about a window
 * appearing should wait on one. A machine with no engine installed answers immediately anyway — the OS
 * refuses the spawn — and a machine that has one gets its rows a moment later.
 *
 * Silent when nobody is listening. A probe is a read for the user's benefit, not a step that can fail a
 * start: a headless run has no store to publish into, which is not an error worth reporting.
 */
export async function refreshEngineStatus(): Promise<void> {
  const probes: Record<string, EngineProbe> = {}
  for (const id of ENGINE_IDS) {
    probes[id] = await probeEngine({ engineId: id })
  }
  statusSink?.record(engineRows(probes))
}

/**
 * The engine rail's whole IPC surface.
 *
 * One member: the write the shield offers when an engine asks. Everything the picker *reads* is state rather
 * than a call — which engines exist and whether they are installed is a fact about this machine, published
 * by main through `refreshEngineStatus` and mirrored by every window — so there is no `list` query here for a
 * renderer to make. A read would be a second detection path for the same fact, and it would put the spawn
 * behind whichever window happened to ask first.
 */
export const engineModule = defineModule({
  /** Answer one engine consent question, by the option the user picked. */
  answerConsent: command(z.object({ requestId: z.string().min(1), optionId: z.string().min(1) }), ({ input }) => {
    answerEngineConsent(input)
  }),

  /**
   * One engine turn, streamed as the transcript chunks the panel already applies.
   *
   * A stream rather than a command, because a turn is long: the panel draws narration as it arrives, and a
   * promise that resolved at the end would hold an answer back until it was complete. The chunks are the shapes
   * the Sam loop's own run produces — narration, a card, its result, usage, an ending — so the pane driving this
   * reads them with the code it already has, and the protocol is not something it has to know.
   *
   * The binary is resolved here rather than in the client, because this is the side that owns the environment: the
   * install pattern is expanded against `process.env` and read off the disk, and what the client is handed is an
   * absolute path the spawn law then judges by its name.
   *
   * A cancel arrives as the stream's own abort. The client kills the child with the spawn layer's escalation and
   * ends silently, so a turn the user stopped is not announced back to them as a defect; a turn that could not
   * start at all — no binary, a refused resolution — is an ending, and one `turn_end` says so.
   */
  turn: stream(
    z.object({
      engineId: z.string().min(1),
      prompt: z.string().min(1),
      cwd: z.string(),
      sessionId: z.string().min(1),
    }),
    async function* ({ input, signal }) {
      const installed = installedBinaryFor(input.engineId)
      const queue: EngineTranscriptChunk[] = []
      let wake: (() => void) | null = null
      let finished = false

      /**
       * Hand the generator back its turn.
       *
       * The wait is taken before it is called, so one arrival cannot resolve two waits and leave a chunk in the
       * queue with nobody watching for it — which would be a turn that appeared to stop mid-answer.
       */
      const notify = (): void => {
        const waiting = wake
        wake = null
        waiting?.()
      }

      const turn = runCodexTurn(
        // An empty root means the conversation has no folder open, and the engine is given the app's own working
        // directory rather than an empty string, which is not a directory a process can be started in.
        { engineId: input.engineId, prompt: input.prompt, cwd: input.cwd === '' ? process.cwd() : input.cwd, signal },
        installed === undefined ? {} : { binaryOverride: installed },
        (chunk) => {
          queue.push(chunk)
          notify()
        }
      )

      void turn
        .then(() => undefined)
        .catch((error: unknown) => {
          // A turn that never started is an ending rather than a thrown stream: a pane handed an exception would
          // hold a turn that went quiet for no stated reason. The failure itself stays out of the transcript —
          // what a user needs to know is that the engine stopped, not which errno the spawn answered with.
          console.warn('[engine] the Codex turn failed', error)
          queue.push({ type: 'turn_end', cause: 'stream_error' })
        })
        .finally(() => {
          finished = true
          notify()
        })

      for (;;) {
        if (queue.length === 0) {
          if (finished) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        yield queue.shift() as EngineTranscriptChunk
      }
    }
  ),
})
