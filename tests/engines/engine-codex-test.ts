/**
 * Verifies the Codex launch config and the turn that runs it: the arguments the OS is handed, the binary
 * resolution that reaches the AppData install the probe found, the SIGTERM-then-SIGKILL cancel, and the
 * chunks a captured run turns into.
 *
 * The law is proved first, because the launch config is nothing but an argument array the law has to
 * accept: `exec --json --sandbox workspace-write` resolves through the allowlist or it does not run at
 * all. The install pattern is then driven with an injected `readdir` and a synthetic environment, so the
 * machine-specific half of the path — the hash directory this suite cannot know — is the fixture's
 * business rather than the assertion's. The turn is driven against the captured tool run, whose lines are
 * read off disk: the strongest claim here is that the *capture* becomes narration, a `via Codex` marker, a
 * result and a usage chunk, in that order, with nothing invented in between.
 *
 * What this does not prove is anything about the live CLI beyond that capture; the disclosure beside the
 * fixtures records the run, and the acceptance is a person watching the installed binary.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENGINE_INSTALL_PATTERNS,
  ENGINE_LAUNCH_ARGS,
  ENGINE_PERMISSION_MODES,
  ENGINE_SPAWN_CODES,
  expandInstallDir,
  resolveEngineSpawn,
} from '../../conveyor/protocol/engine'
import {
  engineInstallCandidates,
  killCodexChild,
  runCodexTurn,
  type CodexChild,
  type CodexSpawnImpl,
} from '../../conveyor/modules/engine-codex'
import { codexTranscriptChunks, type EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const CODEX = 'codex'
const FIXTURES = join(process.cwd(), 'tests', 'engines', 'fixtures')

function captureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
}

/**
 * A child that answers only when the case tells it to.
 *
 * Written here rather than imported from the probe's suite because this one has to be *driven*: a turn is
 * a conversation, so the lines arrive after the client is listening, and the close arrives after them.
 */
function scriptedChild(): { child: CodexChild; feed: (lines: string[]) => void; signals: string[] } {
  const data: ((chunk: Buffer | string) => void)[] = []
  const close: ((code: number | null) => void)[] = []
  const signals: string[] = []
  let exited = false

  const child: CodexChild = {
    stdout: { on: (_event, listener) => data.push(listener) },
    on: ((event: string, listener: (payload: never) => void) => {
      if (event === 'close') close.push(listener as (code: number | null) => void)
    }) as CodexChild['on'],
    get killed() {
      return exited
    },
    get exitCode() {
      return exited ? 0 : null
    },
    kill: (signal?: string) => {
      signals.push(String(signal ?? 'SIGTERM'))
      return true
    },
  }

  return {
    child,
    signals,
    feed: (lines: string[]) => {
      for (const line of lines) for (const listener of data) listener(line + '\n')
      exited = true
      for (const listener of close) listener(0)
    },
  }
}

/** What a fake spawn recorded, so the laws about arguments and shells are assertable at all. */
function recordingSpawn(child: CodexChild): {
  impl: CodexSpawnImpl
  calls: { command: string; args: readonly string[]; shell: unknown }[]
} {
  const calls: { command: string; args: readonly string[]; shell: unknown }[] = []
  return {
    calls,
    impl: (command, args, options) => {
      calls.push({ command, args, shell: (options as { shell?: unknown }).shell })
      return child
    },
  }
}

// ---------------------------------------------------------------- the launch config

/** The arguments a Codex turn runs under, as the law sees them. */
function theLaunchConfigResolvesThroughTheLaw() {
  const args = [...ENGINE_LAUNCH_ARGS[CODEX], 'a prompt']

  assert.equal(Array.isArray(ENGINE_LAUNCH_ARGS[CODEX]), true, 'the launch arguments are an array')
  assert.deepEqual(ENGINE_LAUNCH_ARGS[CODEX].slice(0, 2), ['exec', '--json'], 'the dialect the mapper reads')
  assert.equal(
    ENGINE_LAUNCH_ARGS[CODEX].includes(ENGINE_PERMISSION_MODES[CODEX]),
    true,
    'the permission mode travels as the sandbox flag'
  )
  assert.equal(
    ENGINE_LAUNCH_ARGS[CODEX].includes('--sandbox'),
    true,
    'named, so the child is confined rather than trusted'
  )
  assert.equal(
    ENGINE_LAUNCH_ARGS[CODEX].includes('--dangerously-bypass-approvals-and-sandbox'),
    false,
    'and the flag that turns the sandbox off is never among them'
  )

  const resolved = resolveEngineSpawn({ engineId: CODEX, args })
  assert.equal(resolved.ok, true, 'they resolve through the law')
  assert.ok(resolved.ok === true && resolved.shell === false, 'and `shell` is stated as false, never omitted')
  assert.ok(resolved.ok === true && resolved.args.length === args.length, 'with the array handed over whole')

  const refused = resolveEngineSpawn({ engineId: CODEX, args, shell: true })
  assert.deepEqual(refused, { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_SHELL_REFUSED }, 'a shell is refused')

  results.push('the launch config is an array the law accepts, under a named sandbox, with no shell in sight')
}

/** The AppData install, which is where the probe found the binary and where `PATH` did not. */
function theInstallPatternReachesTheAppDataBinary() {
  const pattern = ENGINE_INSTALL_PATTERNS[CODEX][0]
  assert.equal(pattern.binary, 'codex', 'the binary inside it is the allowlisted name')
  assert.equal(pattern.dir.includes('*'), true, 'and the build hash is a wildcard rather than a guess')

  const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }
  const expanded = expandInstallDir(pattern.dir, env)
  assert.ok(expanded !== null, 'the template expands where the variable exists')
  assert.equal(expanded.startsWith('C:/Users/someone/AppData/Local/OpenAI/Codex/bin/'), true, 'under the AppData root')
  assert.equal(expanded.endsWith('/*'), true, 'with the one segment still to be read')

  assert.equal(expandInstallDir(pattern.dir, {}), null, 'and answers nothing where the machine has no such variable')

  results.push('the install pattern reaches the AppData binary the probe found, and admits when it cannot')
}

/** The candidates main builds from that pattern, and the law's judgement on the one it picks. */
function theCandidatesResolveThroughTheAllowlist() {
  const env = { LOCALAPPDATA: 'C:/Users/someone/AppData/Local' }
  const dirs = ['12219cbfbcbddde7', '4fe45441001f7a41']
  const candidates = engineInstallCandidates(CODEX, env, () => dirs)

  assert.equal(candidates.length, 2, 'one candidate per directory the install keeps')
  assert.equal(
    candidates.every((candidate) => candidate.includes('OpenAI/Codex/bin/')),
    true,
    'all under the install root'
  )
  assert.equal(candidates[0].includes('12219cbfbcbddde7'), true, 'addressed by the hash, which is the CLI own build id')
  assert.equal(
    candidates.every((candidate) => /codex(\.exe)?$/.test(candidate)),
    true,
    'each naming the binary'
  )

  assert.deepEqual(
    engineInstallCandidates(CODEX, {}, () => dirs),
    [],
    'no variable, no candidates'
  )
  assert.deepEqual(
    engineInstallCandidates(CODEX, env, () => {
      throw new Error('ENOENT')
    }),
    [],
    'and a directory that is not there is no candidates rather than a failure'
  )

  const allowed = resolveEngineSpawn({ engineId: CODEX, args: ['exec'], binaryOverride: candidates[0] })
  assert.ok(allowed.ok === true, 'the law sanctions the absolute path the pattern produced')
  assert.equal(allowed.ok === true && allowed.command, candidates[0], 'and runs that path, not the bare name')

  const stranger = resolveEngineSpawn({ engineId: CODEX, args: ['exec'], binaryOverride: 'C:/elsewhere/git.exe' })
  assert.deepEqual(
    stranger,
    { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED },
    'while a file that is not the allowlisted binary is refused wherever it lives'
  )

  results.push('the pattern produces candidates, and only the one naming codex is sanctioned by the allowlist')
}

// ---------------------------------------------------------------- cancel

/** Cancel is the spawn layer's escalation, and it never fires a signal a dead child would not receive. */
function cancelEscalatesOnceAndOnlyWhileItRuns() {
  const live = scriptedChild()
  const timers: (() => void)[] = []
  killCodexChild(live.child, { graceMs: 2000, setTimer: (fn: () => void) => timers.push(fn) })

  assert.deepEqual(live.signals, ['SIGTERM'], 'the polite signal first')
  assert.equal(timers.length, 1, 'with one escalation armed')
  timers[0]()
  assert.deepEqual(live.signals, ['SIGTERM', 'SIGKILL'], 'which is the one that does not ask twice')

  const gone = scriptedChild()
  const goneTimers: (() => void)[] = []
  gone.feed([])
  killCodexChild(gone.child, { graceMs: 2000, setTimer: (fn: () => void) => goneTimers.push(fn) })
  assert.equal(goneTimers.length, 0, 'a child that already exited is not escalated against')
  assert.deepEqual(gone.signals, [], 'and not signalled at all')

  results.push('cancel is SIGTERM then SIGKILL, armed only while the child is still running')
}

// ---------------------------------------------------------------- the turn

/** The captured tool run, as the transcript sees it. */
async function theCapturedRunBecomesTheTranscript() {
  const lines = captureLines('codex-exec-tool-capture.jsonl')
  const script = scriptedChild()
  const spawn = recordingSpawn(script.child)
  const chunks: EngineTranscriptChunk[] = []

  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'Run the shell command echo hello.', cwd: 'C:/work' },
    { spawnImpl: spawn.impl },
    (chunk) => chunks.push(chunk)
  )
  await new Promise((resolve) => setImmediate(resolve))
  script.feed(lines)
  const outcome = await turn

  assert.equal(spawn.calls.length, 1, 'one child, for one turn')
  assert.equal(spawn.calls[0].shell, false, 'started without a shell')
  assert.equal(spawn.calls[0].command, CODEX, 'by the allowlisted name, since no override was handed it')
  assert.deepEqual(spawn.calls[0].args.slice(0, 2), ['exec', '--json'], 'in the dialect the mapper reads')
  assert.equal(spawn.calls[0].args[spawn.calls[0].args.length - 1].includes('echo hello'), true, 'with the prompt last')

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text_delta', 'tool_call_start', 'tool_result', 'text_delta', 'usage', 'turn_end'],
    'the capture becomes narration, a call, its result, narration, usage, and the ending'
  )

  const call = chunks[1]
  assert.ok(call.type === 'tool_call_start', 'the call is a card')
  assert.equal(call.callId, 'item_2', 'addressed by the id the CLI gave it')
  assert.equal(call.tool, 'run_command', 'named in this app own tool vocabulary rather than in the CLI own')
  assert.equal(String(call.args.command).includes('echo hello'), true, 'with the command as its argument')
  assert.equal(call.via, 'Codex', 'and marked with the engine that ran it')

  const result = chunks[2]
  assert.ok(result.type === 'tool_result', 'the outcome settles the same card')
  assert.equal(result.callId, 'item_2')
  assert.equal(result.ok, true, 'a zero exit code is a call that worked')
  assert.equal(result.code, '0', 'and the code travels, because the card branches on it')
  assert.equal(result.output.includes('hello'), true, 'with the output the CLI aggregated')

  const usage = chunks[4]
  assert.ok(usage.type === 'usage' && usage.prompt === 38314 && usage.completion === 131, 'the turn is measured')
  assert.equal(outcome.cause, 'model_stop', 'and a clean exit with an answer is the ordinary ending')
  assert.equal(
    chunks[5].type === 'turn_end' ? chunks[5].cause : '',
    'model_stop',
    'which is what the transcript is told'
  )

  const quiet = codexTranscriptChunks([], CODEX)
  assert.deepEqual(quiet, [], 'and nothing on the wire draws nothing in the transcript')

  results.push('a captured run becomes the transcript, in order, under this app own tool names')
}

/** A cancelled turn kills the child through the traced path and words no ending of its own. */
async function cancellingTheTurnKillsTheChild() {
  const script = scriptedChild()
  const spawn = recordingSpawn(script.child)
  const chunks: EngineTranscriptChunk[] = []
  const controller = new AbortController()
  const timers: (() => void)[] = []

  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a long job', cwd: 'C:/work', signal: controller.signal },
    { spawnImpl: spawn.impl, graceMs: 50, setTimer: (fn) => timers.push(fn) },
    (chunk) => chunks.push(chunk)
  )
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const outcome = await turn

  assert.deepEqual(script.signals, ['SIGTERM'], 'the cancel reaches the child')
  assert.equal(outcome.cancelled, true, 'and the turn reports that it was stopped by the user')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'turn_end'),
    false,
    'with no ending for the app to word: the user stopped it, which is not a defect to announce'
  )

  results.push('cancel kills the Codex child through the spawn layer path, and draws no notice for it')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('launch config', theLaunchConfigResolvesThroughTheLaw)
  await step('install pattern', theInstallPatternReachesTheAppDataBinary)
  await step('candidates', theCandidatesResolveThroughTheAllowlist)
  await step('cancel', cancelEscalatesOnceAndOnlyWhileItRuns)
  await step('turn', theCapturedRunBecomesTheTranscript)
  await step('cancel (turn)', cancellingTheTurnKillsTheChild)

  console.log('codex launch config: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('CODEX LAUNCH CONFIG TEST FAILED:', err)
  process.exit(1)
})
