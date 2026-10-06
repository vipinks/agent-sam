/**
 * Verifies the Kimi launch config and the ACP turn that runs it: the arguments the OS is handed, the binary
 * the allowlist sanctions, the stdin policy the config states, and the chunks a real ACP peer turns into.
 *
 * The law is proved first, for the reason the Codex suite does: a launch config is nothing but an argument
 * array the law has to accept, and `acp` resolves through the allowlist or nothing runs at all. The install
 * pattern is driven with an injected `readdir`/`exists` and a synthetic environment, so the machine-specific
 * half of the path is the fixture's business rather than the assertion's.
 *
 * The turn is then driven against `tests/engines/fixtures/acp-fixture-agent.cjs` — a real child process
 * speaking ACP over stdio — because the claims here are about bytes on a pipe and the order they arrived in.
 * What the fixture proves is the *config*: that a `kimi` id resolves to an argv of `['acp']` and that what
 * comes back becomes narration, a `via Kimi` marker and a result. It proves nothing about the installed CLI;
 * that acceptance is a person watching the binary the probe found.
 */
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  ENGINE_AUTH_HINTS,
  ENGINE_BINARIES,
  ENGINE_INSTALL_PATTERNS,
  ENGINE_LAUNCH_ARGS,
  ENGINE_LABELS,
  ENGINE_MARKER_LABELS,
  ENGINE_PERMISSION_MODES,
  ENGINE_SPAWN_CODES,
  engineLaunchArgs,
  engineMarkerLabel,
  engineRows,
  engineStdinPolicy,
  resolveEngineSpawn,
} from '../../conveyor/protocol/engine'
import { engineInstallCandidates, installedBinaryFor, type CodexSpawnImpl } from '../../conveyor/modules/engine-codex'
import { runAcpTurn } from '../../conveyor/modules/engine-acp-turn'
import { ACP_CODES } from '../../conveyor/protocol/acp'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'
import { createAcpClient, type AcpSpawnImpl } from '../../conveyor/modules/engine-acp'

const results: string[] = []
const KIMI = 'kimi'
const CODEX = 'codex'

const FIXTURE = join(process.cwd(), 'tests', 'engines', 'fixtures', 'acp-fixture-agent.cjs')
if (!existsSync(FIXTURE)) {
  throw new Error(`the ACP fixture is missing at ${FIXTURE}: run the suites from the repository root`)
}

/** Every process this suite started, so each one can be stopped and none is left running. */
const children: ChildProcessWithoutNullStreams[] = []

/** The words a shell would read and an argv must not contain: the launch config is an array, not a line. */
const SHELL_WORDS = ['sh', 'bash', 'cmd', '/bin/sh', 'cmd.exe', 'pwsh', '-c', '/c']

// ---------------------------------------------------------------- the launch config

/**
 * The Kimi launch config is an argument array the law accepts, and it names no shell.
 *
 * Asserted rather than assumed: `ENGINE_LAUNCH_ARGS` is what the OS is handed, so a config that could only
 * be run through a shell would be a config this app must not author. The binary is pinned to the allowlist
 * entry the probe proved, by name, so the row and the spawn cannot disagree about which file runs.
 */
function theLaunchConfigResolvesThroughTheLaw() {
  const args = [...ENGINE_LAUNCH_ARGS[KIMI]]
  assert.equal(Array.isArray(args), true, 'the launch arguments are an array')
  assert.deepEqual(args, ['acp'], 'the ACP subcommand the probe proved, and nothing else')
  assert.equal(
    args.some((arg) => SHELL_WORDS.includes(arg)),
    false,
    'and no word a shell would read'
  )
  assert.equal(ENGINE_BINARIES[KIMI], 'kimi', 'the binary is the allowlisted name the probe found')

  // The mode reaches only a `--sandbox` value, and this dialect carries no such flag: a mode cannot add a
  // flag, so every mode the control offers resolves to the same argv.
  assert.deepEqual(
    engineLaunchArgs(KIMI, 'danger-full-access'),
    args,
    'the permission mode adds no flag to a dialect that carries none'
  )
  assert.equal(ENGINE_PERMISSION_MODES[KIMI], 'workspace-write', 'and the engine still has a default mode')

  const resolution = resolveEngineSpawn({ engineId: KIMI, args, shell: false })
  assert.equal(resolution.ok, true, 'the shipped config resolves through the allowlist')
  assert.equal(resolution.ok === true && resolution.command, 'kimi', 'to the allowlisted binary')
  assert.equal(resolution.ok === true && resolution.shell, false, 'with no shell, stated rather than omitted')

  // A path is judged by the name at the end of it, which is what makes the override the same binary.
  const walked = resolveEngineSpawn({
    engineId: KIMI,
    args,
    binaryOverride: 'C:/Users/anyone/.local/bin/kimi.exe',
  })
  assert.equal(walked.ok, true, 'a path naming the allowlisted binary is sanctioned')

  results.push('the Kimi launch config is an args array the law accepts, with no shell and one flag')
}

/**
 * Every launch config states its stdin policy, and Kimi's is the ACP transport.
 *
 * The Phase 70 Turn 3 lesson, as a rule rather than a comment: an ACP dialect holds the child's stdin open as
 * the pipe the protocol travels on, and an exec dialect that is handed a pipe waits on a terminator nobody
 * sends. A config that cannot state which of the two it is is a config this app does not author.
 */
function everyLaunchConfigStatesItsStdinPolicy() {
  assert.equal(engineStdinPolicy(KIMI), 'transport-open', 'Kimi speaks ACP, so its stdin is the transport')
  assert.equal(engineStdinPolicy(CODEX), 'ignored', 'and the exec dialect that waits on a pipe says so too')

  // Every engine the law can spawn has an answer, so the branch the turn takes cannot fall off the table.
  for (const id of Object.keys(ENGINE_BINARIES)) {
    const policy = engineStdinPolicy(id)
    assert.ok(
      policy === 'transport-open' || policy === 'ignored',
      `${id}: the stdin policy is one of the two the law knows`
    )
  }

  // An engine this build does not ship falls back to the closed policy rather than to a question mark: the
  // branch the turn takes has to answer for every id it is handed, and of the two answers the one whose worst
  // case is a process with nothing to wait for is the safe fallback.
  assert.equal(
    engineStdinPolicy('nobody-ships-this'),
    'ignored',
    'an engine with no config borrows the exec policy rather than leaving the turn branch undecided'
  )

  results.push('each launch config states its stdin policy: transport-open for ACP, ignored for exec')
}

/**
 * The install pattern reaches the location the probe proved, and the allowlist still judges the file.
 *
 * The directory is a template rather than a path, and it is driven here with a synthetic environment and a
 * synthetic `exists`, because that is the half of it this machine cannot decide for another one.
 */
function theInstallPatternReachesTheLocalBinDirectory() {
  const pattern = ENGINE_INSTALL_PATTERNS[KIMI][0]
  assert.ok(pattern, 'the engine has an install pattern to probe')
  assert.equal(pattern.binary, 'kimi', 'the binary inside it is the allowlisted name')

  // The separator varies by platform, and `engineInstallCandidates` appends the launchable extension: the
  // path is `…/.local/bin/kimi.exe` on the platform the probe ran on and `…/.local/bin/kimi` elsewhere.
  const extension = process.platform === 'win32' ? '.exe' : ''
  const candidates = engineInstallCandidates(KIMI, { USERPROFILE: 'C:\\Users\\anyone' }, () => ['.'])
  assert.deepEqual(
    candidates,
    [`C:/Users/anyone/.local/bin/kimi${extension}`],
    'the pattern expands to the user-local bin the probe proved'
  )

  // A machine with no `USERPROFILE` has no such directory, and answers nothing rather than a path literally
  // named after the token.
  assert.deepEqual(
    engineInstallCandidates(KIMI, {}, () => []),
    [],
    'a missing token yields no candidate'
  )

  const found = installedBinaryFor(KIMI, {
    env: { USERPROFILE: 'C:\\Users\\anyone' },
    readdir: () => ['.'],
    exists: (path) => path === `C:/Users/anyone/.local/bin/kimi${extension}`,
  })
  assert.equal(found, `C:/Users/anyone/.local/bin/kimi${extension}`, 'a file that is really there is the answer')

  const missing = installedBinaryFor(KIMI, {
    env: { USERPROFILE: 'C:\\Users\\anyone' },
    readdir: () => ['.'],
    exists: () => false,
  })
  assert.equal(missing, undefined, 'and nothing there leaves the allowlist on PATH to answer')

  results.push('the Kimi install pattern expands to the user-local bin, and the allowlist judges the file')
}

/**
 * The registry publishes the Kimi row, and the transcript marker names it shortly.
 *
 * This is what the picker and the Engines section read: they map `ENGINE_IDS` and nothing else, so a row
 * that appears there is a row this table grew rather than a component that was changed.
 */
function theRegistryPublishesTheKimiRow() {
  assert.equal(ENGINE_LABELS[KIMI], 'Kimi (Moonshot)', 'the picker and the section draw one label')
  assert.equal(engineMarkerLabel(KIMI), 'Kimi', 'and the transcript marker is the short name')
  assert.equal(ENGINE_MARKER_LABELS[KIMI], 'Kimi', 'read from the marker table rather than the picker table')
  assert.equal(typeof ENGINE_AUTH_HINTS[KIMI], 'string', 'the section has a line about how it is signed in to')
  assert.ok((ENGINE_AUTH_HINTS[KIMI] ?? '').includes('login'), 'naming the CLI\u2019s own login')

  const rows = engineRows({ [KIMI]: { installed: true, version: '1.30.0' } })
  const row = rows.find((candidate) => candidate.id === KIMI)
  assert.ok(row, 'the row is published beside the app\u2019s own row')
  assert.equal(row?.name, ENGINE_LABELS[KIMI], 'under the registry\u2019s label')
  assert.equal(row?.installed, true, 'installed, because the probe said so')
  assert.equal(row?.version, '1.30.0', 'with the version the CLI answered')
  assert.equal(row?.note, null, 'and nothing to add')

  // The state the not-installed branch lands in: a row that is drawn and says so, not one that is dropped.
  const undetected = engineRows({}).find((candidate) => candidate.id === KIMI)
  assert.equal(undetected?.installed, false, 'a machine without it draws the row as not installed')
  assert.equal(undetected?.note, 'Not installed', 'in the protocol\u2019s own words')

  results.push('the registry publishes the Kimi row and its short marker, installed and not-installed')
}

// ---------------------------------------------------------------- the turn

/** The spawn that records what it was asked for, and runs the fixture instead of a vendor binary. */
function fixtureSpawn(mode: string): { impl: AcpSpawnImpl; asks: { command: string; args: readonly string[] }[] } {
  const asks: { command: string; args: readonly string[] }[] = []
  const impl: AcpSpawnImpl = (command, args, options) => {
    asks.push({ command, args })
    const child = spawn(process.execPath, [FIXTURE, mode], options as SpawnOptionsWithoutStdio)
    children.push(child)
    return child
  }
  return { impl, asks }
}

/** Stop every child this suite started, so a failing assertion cannot leave one behind. */
async function reapAll(): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

/**
 * A `kimi` turn handshakes, streams narration, and labels its tool markers `via Kimi`, in that order.
 *
 * The order is the claim: the fixture announces the call before it asks about it, so a transcript built in
 * the order the peer wrote it draws the card, then the outcome, then the prose. The `via` on the card is read
 * from the registry's marker table through the engine id, which is the whole of what makes it a Kimi call
 * rather than one of the app's own.
 */
async function aKimiTurnHandshakesAndStreamsThroughAFixtureAgent() {
  const { impl, asks } = fixtureSpawn('normal')
  const chunks: EngineTranscriptChunk[] = []
  const questions: string[] = []

  const outcome = await runAcpTurn(
    { engineId: KIMI, prompt: 'write the notes', cwd: process.cwd() },
    {
      spawnImpl: impl,
      onPermissionRequest: (request) => {
        questions.push(request.title)
        return Promise.resolve('allow-once')
      },
    },
    (chunk) => chunks.push(chunk)
  )

  // What reached the OS, which is the launch config's own claim rather than a restatement of it.
  assert.equal(asks.length, 1, 'one child, for one turn')
  assert.equal(asks[0].command, 'kimi', 'the allowlisted binary')
  assert.deepEqual([...asks[0].args], ['acp'], 'the ACP subcommand, as an array')

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['tool_call_start', 'tool_result', 'text_delta', 'turn_end'],
    'the peer\u2019s order is preserved: the call, its outcome, the prose, the ending'
  )

  const start = chunks[0]
  assert.equal(start.type === 'tool_call_start' && start.via, 'Kimi', 'the card is marked via Kimi')
  assert.equal(start.type === 'tool_call_start' && start.tool, 'write_file', 'in this app\u2019s own vocabulary')
  assert.equal(start.type === 'tool_call_start' && start.callId, 'call-1', 'addressed by the peer\u2019s own id')

  const result = chunks[1]
  assert.equal(result.type === 'tool_result' && result.ok, true, 'the call reported completed, so the card ticks')

  const prose = chunks[2]
  assert.equal(
    prose.type === 'text_delta' && prose.text,
    'answered:allow-once',
    'and the answer the user picked is what the agent was told'
  )

  const end = chunks[3]
  assert.equal(end.type === 'turn_end' && end.cause, 'model_stop', 'the turn ended on the agent\u2019s own stop')

  // The consent surface is the shield: the question reached the caller, which is where the card is put.
  assert.deepEqual(questions, ['Write notes.md'], 'the agent\u2019s question was put before it was answered')

  assert.equal(outcome.cancelled, false, 'and the turn was not cancelled')
  assert.equal(outcome.stopReason, 'end_turn', 'the agent\u2019s own word for why it stopped')

  await reapAll()
  results.push('a kimi turn handshakes with an ACP peer, streams narration and marks its calls via Kimi')
}

/**
 * A handshake the agent refuses is a coded refusal rather than a turn that hangs.
 *
 * The code is what the caller branches on: `ACP_HANDSHAKE_FAILED` says there is no session to be had, and the
 * message is never read by anyone.
 */
async function aRefusedHandshakeEndsTheTurnByCode() {
  const { impl } = fixtureSpawn('refuse')
  let thrown: unknown = null

  try {
    await runAcpTurn(
      { engineId: KIMI, prompt: 'anything', cwd: process.cwd() },
      { spawnImpl: impl, onPermissionRequest: () => Promise.resolve('allow-once') },
      () => undefined
    )
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ConveyorError, 'the refusal is a ConveyorError rather than a bare Error')
  assert.equal((thrown as ConveyorError).code, ACP_CODES.ACP_HANDSHAKE_FAILED, 'and it carries the handshake code')

  await reapAll()
  results.push('a refused handshake is refused by code, so the caller branches rather than reading a sentence')
}

/**
 * An engine the law does not allow is refused before a process exists.
 *
 * The spawn law is the only way in, and this is the proof that the ACP path goes through it rather than
 * around it: the refusal is a code, and nothing was started.
 */
async function anUnknownEngineNeverSpawns() {
  const { impl, asks } = fixtureSpawn('normal')
  let thrown: unknown = null

  try {
    await runAcpTurn(
      { engineId: 'nobody-ships-this', prompt: 'anything', cwd: process.cwd() },
      { spawnImpl: impl, onPermissionRequest: () => Promise.resolve('allow-once') },
      () => undefined
    )
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ConveyorError, 'the refusal is a ConveyorError')
  assert.equal((thrown as ConveyorError).code, ENGINE_SPAWN_CODES.ENGINE_UNKNOWN, 'with the law\u2019s own code')
  assert.equal(asks.length, 0, 'and nothing was started')

  results.push('the ACP turn resolves through the spawn law, and an unlisted engine starts nothing')
}

/** The Codex spawn type is imported so the two turn runners stay comparable; a shell stays unaskable. */
const _shellIsUnaskable: CodexSpawnImpl | null = null
void _shellIsUnaskable

/**
 * A refusal is only useful to a user if it says who refused and why: the child's code and its own words
 * survive into the wrapper rather than being flattened into the client's own sentence.
 *
 * The fixture's `stale-session` mode answers one prompt on a session and refuses every later one the way a
 * real agent refuses an unknown or closed session id — a JSON-RPC error with a code and a message. What the
 * app's own log showed was `ACP_REFUSED ("The engine refused the request")` and nothing else, so the cause
 * the engine stated — here `-32002 Session not found`, in the live run `-32000 Authentication required` —
 * was thrown away at exactly this boundary. Asserted by code, because a branch on the sentence is the defect
 * this assertion exists to prevent.
 */
async function aRefusalKeepsTheEnginesOwnCodeAndWords() {
  const { impl } = fixtureSpawn('stale-session')
  const client = createAcpClient({
    spawn: { command: 'kimi', args: ['acp'], cwd: process.cwd() },
    spawnImpl: impl,
    onPermissionRequest: () => Promise.resolve('allow-once'),
  })

  await client.initialize()
  const sessionId = await client.newSession()
  assert.equal(sessionId, 'fixture-session-1', 'the session the peer opened is the one the client holds')

  const answered = await client.prompt('the first question')
  assert.equal(answered.stopReason, 'end_turn', 'the first prompt on a fresh session is answered')

  let thrown: unknown = null
  try {
    await client.prompt('the second question on the same session')
  } catch (error) {
    thrown = error
  } finally {
    client.close()
  }

  assert.ok(thrown instanceof ConveyorError, 'the refusal is a ConveyorError rather than a bare Error')
  const refusal = thrown as ConveyorError
  assert.equal(refusal.code, ACP_CODES.ACP_REFUSED, 'and it carries the client\u2019s refusal code')
  assert.equal(
    refusal.message.includes('Session not found'),
    true,
    'the sentence repeats the engine\u2019s own words, so the cause can be read without a debugger'
  )

  // The half that makes a future refusal diagnosable: the peer's code is a value, not prose in a sentence.
  const issues = refusal.issues as { code?: unknown; message?: unknown } | undefined
  assert.ok(issues, 'the child\u2019s error object is retained rather than discarded')
  assert.equal(issues?.code, -32002, 'with the child\u2019s own JSON-RPC code, assertable by code')
  assert.equal(issues?.message, 'Session not found', 'and the child\u2019s own message beside it')

  await reapAll()
  results.push('a refused request keeps the engine\u2019s code and words, so a refusal is legible by code')
}

/**
 * The second turn of one conversation opens its own child and its own session — never the first turn's.
 *
 * This is the lifecycle claim the phase asked to be reproduced rather than assumed, and the fixture is the
 * adversary that decides it: it refuses a second prompt on a session it has already answered, exactly as the
 * refuser above does. So a module that reused a closed session, or a child that had already had its turn,
 * would fail *here* with the very refusal the app's log showed. Two turns that both stream and both end are
 * the proof that each turn carries its own child and its own `session/new`, which is what the live probe of
 * the installed CLI could not be made to say while its own account refused every session.
 */
async function aSecondTurnInOneSessionCarriesItsOwnChildAndSession() {
  const { impl, asks } = fixtureSpawn('stale-session')
  const seen: EngineTranscriptChunk[][] = []

  const run = async (prompt: string) => {
    const chunks: EngineTranscriptChunk[] = []
    const outcome = await runAcpTurn(
      { engineId: KIMI, prompt, cwd: process.cwd() },
      { spawnImpl: impl, onPermissionRequest: () => Promise.resolve('allow-once') },
      (chunk) => chunks.push(chunk)
    )
    seen.push(chunks)
    return outcome
  }

  const first = await run('the first question')
  const second = await run('the second question')

  assert.equal(asks.length, 2, 'two turns in one session, two children')
  assert.equal(first.cancelled, false, 'the first turn was not cancelled')
  assert.equal(second.cancelled, false, 'and neither was the second')

  for (const [index, chunks] of seen.entries()) {
    const end = chunks[chunks.length - 1]
    assert.equal(
      end?.type === 'turn_end' && end.cause,
      'model_stop',
      `turn ${index + 1} ended on the agent\u2019s own stop rather than in a refusal`
    )
    const prose = chunks.find((chunk) => chunk.type === 'text_delta')
    assert.equal(
      prose?.type === 'text_delta' && prose.text,
      'said:fixture-session-1',
      `turn ${index + 1} streamed the session its own child opened`
    )
  }

  await reapAll()
  results.push('a second turn in one session opens its own child and session, so it streams like the first')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('launch config', theLaunchConfigResolvesThroughTheLaw)
  await step('stdin policy', everyLaunchConfigStatesItsStdinPolicy)
  await step('install pattern', theInstallPatternReachesTheLocalBinDirectory)
  await step('registry row', theRegistryPublishesTheKimiRow)
  await step('turn', aKimiTurnHandshakesAndStreamsThroughAFixtureAgent)
  await step('handshake', aRefusedHandshakeEndsTheTurnByCode)
  await step('refusal', aRefusalKeepsTheEnginesOwnCodeAndWords)
  await step('second turn', aSecondTurnInOneSessionCarriesItsOwnChildAndSession)
  await step('law', anUnknownEngineNeverSpawns)

  console.log('kimi launch config: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch(async (err) => {
  await reapAll()
  console.error('KIMI LAUNCH CONFIG TEST FAILED:', err)
  process.exit(1)
})
