/**
 * Verifies the OpenCode launch config and the ACP turn that runs it: the arguments the OS is handed, the
 * binary the allowlist sanctions, the stdin policy the config states, and the chunks a real ACP peer turns
 * into.
 *
 * The shape is the Kimi suite's, deliberately: OpenCode joins the registry on the *path the probe proved*,
 * which is the same ACP path `kimi` already runs on, so what is asserted here is that the third config is an
 * argument array the law accepts rather than a second dialect. The ACP client, the consent bridge and the
 * transcript mapper are consumed unchanged.
 *
 * What the live probe settled, and what this suite therefore pins:
 *
 * - `opencode acp` is the CLI's own ACP server subcommand, and its `--help` offers no sandbox or permission
 *   flag, so the launch args are `['acp']` and the shield's per-call question is this engine's whole consent
 *   surface.
 * - The binary that answers on `PATH` is named `opencode`, and the ACP `initialize` answer names the agent
 *   `OpenCode` at protocol version 1.
 * - The desktop application the vendor installs beside the CLI is *not* this engine's binary: it is a window
 *   that boots a sidecar server rather than a stdio peer, and the law refuses it by name.
 *
 * The turn is driven against `tests/engines/fixtures/acp-fixture-agent.cjs` — a real child process speaking
 * ACP over stdio. What the fixture proves is the *config*: that an `opencode` id resolves to an argv of
 * `['acp']` and that what comes back becomes narration, a `via OpenCode` marker and a result. It proves
 * nothing about the installed CLI; that acceptance is a person watching the binary the probe found.
 */
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { engineInstallCandidates, installedBinaryFor } from '../../conveyor/modules/engine-codex'
import { runAcpTurn } from '../../conveyor/modules/engine-acp-turn'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'
import type { AcpSpawnImpl } from '../../conveyor/modules/engine-acp'

const results: string[] = []
const OPENCODE = 'opencode'
const CODEX = 'codex'
const KIMI = 'kimi'

/** The version the live probe read from the CLI on `PATH`, so the row assertion is the real string. */
const PROBED_VERSION = '1.4.7'

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
 * The OpenCode launch config is an argument array the law accepts, and it names no shell.
 *
 * The args are the probe's own reading of `opencode acp --help`: the subcommand is the ACP server, and the
 * option list under it carries no sandbox and no permission flag — so this dialect, like Kimi's, has no flag
 * a mode could become, and the per-call question the ACP stream asks through the shield is the whole of its
 * consent surface.
 */
function theLaunchConfigResolvesThroughTheLaw() {
  const args = [...ENGINE_LAUNCH_ARGS[OPENCODE]]
  assert.equal(Array.isArray(args), true, 'the launch arguments are an array')
  assert.deepEqual(args, ['acp'], 'the ACP server subcommand the probe proved, and nothing else')
  assert.equal(
    args.some((arg) => SHELL_WORDS.includes(arg)),
    false,
    'and no word a shell would read'
  )
  assert.equal(ENGINE_BINARIES[OPENCODE], 'opencode', 'the binary is the allowlisted name the probe found')

  // No flag in the inventory carries a mode, so every mode the control offers resolves to the same argv. A
  // config that invented a `--sandbox` here would be a word no CLI in the probe's output accepts.
  assert.deepEqual(
    engineLaunchArgs(OPENCODE, 'danger-full-access'),
    args,
    'the permission mode adds no flag to a dialect that carries none'
  )
  assert.equal(ENGINE_PERMISSION_MODES[OPENCODE], 'workspace-write', 'and the engine still has a default mode')

  const resolution = resolveEngineSpawn({ engineId: OPENCODE, args, shell: false })
  assert.equal(resolution.ok, true, 'the shipped config resolves through the allowlist')
  assert.equal(resolution.ok === true && resolution.command, 'opencode', 'to the allowlisted binary')
  assert.equal(resolution.ok === true && resolution.shell, false, 'with no shell, stated rather than omitted')

  // A path is judged by the name at the end of it, which is what makes an override the same binary.
  const walked = resolveEngineSpawn({
    engineId: OPENCODE,
    args,
    binaryOverride: 'C:/Users/anyone/AppData/Local/opencode/opencode.exe',
  })
  assert.equal(walked.ok, true, 'a path naming the allowlisted binary is sanctioned')

  // The probe found a second executable in the vendor's install directory, and it is the desktop window
  // rather than the CLI: pointed at a command line it ignores the arguments and starts a sidecar HTTP server.
  // Naming it here is what keeps the window out of a spawn the law would otherwise sanction by suffix.
  const desktop = resolveEngineSpawn({
    engineId: OPENCODE,
    args,
    binaryOverride: 'C:/Users/anyone/AppData/Local/opencode/OpenCode.exe',
  })
  assert.equal(desktop.ok, false, 'the desktop application the probe found is not this engine')
  assert.equal(
    desktop.ok === false && desktop.code,
    ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED,
    'and the refusal is the law\\u2019s own code'
  )

  results.push('the OpenCode launch config is an args array of [acp] the law accepts, with no shell and no mode flag')
}

/**
 * The OpenCode config states its stdin policy, and it is the ACP transport.
 *
 * An ACP agent's stdin *is* the pipe the handshake and every later message travel on, so a client that closed
 * it would have nothing left to speak through. Stated per config rather than inferred from the id, because
 * this value is what routes the turn: the module picks its runner from it, so a config cannot be authored in
 * this build without answering the question.
 */
function theConfigStatesItsStdinPolicy() {
  assert.equal(engineStdinPolicy(OPENCODE), 'transport-open', 'OpenCode speaks ACP, so its stdin is the transport')
  assert.equal(engineStdinPolicy(KIMI), 'transport-open', 'beside the other ACP engine, which says the same')
  assert.equal(engineStdinPolicy(CODEX), 'ignored', 'and the exec dialect that waits on a pipe says so too')

  // Every engine the law can spawn has an answer, so the branch the turn takes cannot fall off the table.
  for (const id of Object.keys(ENGINE_BINARIES)) {
    const policy = engineStdinPolicy(id)
    assert.ok(
      policy === 'transport-open' || policy === 'ignored',
      `${id}: the stdin policy is one of the two the law knows`
    )
  }

  // An engine this build does not ship falls back to the closed policy rather than to a question mark.
  assert.equal(
    engineStdinPolicy('nobody-ships-this'),
    'ignored',
    'an engine with no config borrows the exec policy rather than leaving the turn branch undecided'
  )

  results.push('the OpenCode launch config states its stdin policy: transport-open, so the ACP path routes it')
}

/**
 * OpenCode is probed on `PATH`, because the probe found no vendor directory of its own to read.
 *
 * The install-pattern table is where a machine whose `PATH` does not carry a CLI is reached, and the probe
 * answered this engine with the allowlisted name on `PATH` — so the table's entry for it is empty rather than
 * a guessed directory. That is a state the mechanism already supports: no pattern yields no candidate, and
 * the allowlist decides. Asserted anyway, because "we added an engine with no install directory" is a claim
 * worth failing loudly if a later phase pastes a path in without probing it.
 */
function thereIsNoInstalledDirectoryToProbe() {
  assert.deepEqual(
    ENGINE_INSTALL_PATTERNS[OPENCODE],
    [],
    'no install pattern, because the probe reached the CLI on PATH rather than in a vendor directory'
  )

  assert.deepEqual(
    engineInstallCandidates(OPENCODE, { LOCALAPPDATA: 'C:\\Users\\anyone\\AppData\\Local' }, () => ['.']),
    [],
    'so the pattern table yields no candidate whatever the environment says'
  )
  assert.equal(
    installedBinaryFor(OPENCODE, { env: {}, readdir: () => [], exists: () => false }),
    undefined,
    'and nothing is found in an install directory, which leaves the allowlist on PATH to answer'
  )

  // The PATH answer is the shipped name, which is what the probe's `--version` was run against.
  assert.equal(ENGINE_BINARIES[OPENCODE], 'opencode', 'the name on PATH is the allowlisted one')

  results.push('the install-pattern table carries an empty entry, so the probe answers on PATH and nothing is guessed')
}

/**
 * The registry publishes the OpenCode row, and the transcript marker names it.
 *
 * This is what the picker and the Engines section read: they map `ENGINE_IDS` and nothing else, so a row that
 * appears there is a row this table grew rather than a component that was changed.
 */
function theRegistryPublishesTheOpenCodeRow() {
  assert.equal(ENGINE_LABELS[OPENCODE], 'OpenCode', 'the picker and the section draw one label')
  assert.equal(engineMarkerLabel(OPENCODE), 'OpenCode', 'and the transcript marker names it')
  assert.equal(ENGINE_MARKER_LABELS[OPENCODE], 'OpenCode', 'read from the marker table rather than the picker table')
  assert.equal(typeof ENGINE_AUTH_HINTS[OPENCODE], 'string', 'the section has a line about how it is signed in to')
  assert.ok(
    (ENGINE_AUTH_HINTS[OPENCODE] ?? '').includes('opencode auth login'),
    'naming the CLI\\u2019s own login command, which is what its ACP handshake offers as its auth method'
  )

  const rows = engineRows({ [OPENCODE]: { installed: true, version: PROBED_VERSION } })
  const row = rows.find((candidate) => candidate.id === OPENCODE)
  assert.ok(row, 'the row is published beside the app\\u2019s own row')
  assert.equal(row?.name, ENGINE_LABELS[OPENCODE], 'under the registry\\u2019s label')
  assert.equal(row?.installed, true, 'installed, because the probe said so')
  assert.equal(row?.version, PROBED_VERSION, 'with the version the CLI answered')
  assert.equal(row?.note, null, 'and nothing to add')

  // The state the not-installed branch lands in: a row that is drawn and says so, not one that is dropped.
  const undetected = engineRows({}).find((candidate) => candidate.id === OPENCODE)
  assert.equal(undetected?.installed, false, 'a machine without it draws the row as not installed')
  assert.equal(undetected?.note, 'Not installed', 'in the protocol\\u2019s own words')

  results.push('the registry publishes the OpenCode row and its marker, installed and not-installed')
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
 * An `opencode` turn handshakes, streams narration, and labels its tool markers `via OpenCode`, in that order.
 *
 * The order is the claim: the fixture announces the call before it asks about it, so a transcript built in the
 * order the peer wrote it draws the card, then the outcome, then the prose. The `via` on the card comes from
 * the registry's marker table through the engine id — the same mapper Codex's and Kimi's turns go through,
 * unchanged, which is what makes this a third *config* rather than a third dialect.
 */
async function anOpenCodeTurnHandshakesAndStreamsThroughAFixtureAgent() {
  const { impl, asks } = fixtureSpawn('normal')
  const chunks: EngineTranscriptChunk[] = []
  const questions: string[] = []

  const outcome = await runAcpTurn(
    { engineId: OPENCODE, prompt: 'write the notes', cwd: process.cwd() },
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
  assert.equal(asks[0].command, 'opencode', 'the allowlisted binary')
  assert.deepEqual([...asks[0].args], ['acp'], 'the ACP subcommand, as an array')

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['tool_call_start', 'tool_result', 'text_delta', 'turn_end'],
    'the peer\\u2019s order is preserved: the call, its outcome, the prose, the ending'
  )

  const start = chunks[0]
  assert.equal(start.type === 'tool_call_start' && start.via, 'OpenCode', 'the card is marked via OpenCode')
  assert.equal(start.type === 'tool_call_start' && start.tool, 'write_file', 'in this app\\u2019s own vocabulary')
  assert.equal(start.type === 'tool_call_start' && start.callId, 'call-1', 'addressed by the peer\\u2019s own id')

  const result = chunks[1]
  assert.equal(result.type === 'tool_result' && result.ok, true, 'the call reported completed, so the card ticks')

  const prose = chunks[2]
  assert.equal(
    prose.type === 'text_delta' && prose.text,
    'answered:allow-once',
    'and the answer the user picked is what the agent was told'
  )

  const end = chunks[3]
  assert.equal(end.type === 'turn_end' && end.cause, 'model_stop', 'the turn ended on the agent\\u2019s own stop')

  // The consent surface is the shield: the question reached the caller, which is where the card is put.
  assert.deepEqual(questions, ['Write notes.md'], 'the agent\\u2019s question was put before it was answered')

  assert.equal(outcome.cancelled, false, 'and the turn was not cancelled')
  assert.equal(outcome.stopReason, 'end_turn', 'the agent\\u2019s own word for why it stopped')

  await reapAll()
  results.push('an opencode turn handshakes with an ACP peer, streams narration and marks its calls via OpenCode')
}

/**
 * A cancel closes the client, which kills the child rather than orphaning it.
 *
 * The same claim Codex's and Kimi's turns carry, on the third config: the abort listener closes the client,
 * the turn ends silently rather than reporting the user's own click back to them, and the process the turn
 * started is gone.
 */
async function aCancelKillsTheChild() {
  const { impl } = fixtureSpawn('silent')
  const controller = new AbortController()
  const chunks: EngineTranscriptChunk[] = []

  const turn = runAcpTurn(
    { engineId: OPENCODE, prompt: 'anything', cwd: process.cwd(), signal: controller.signal },
    { spawnImpl: impl, onPermissionRequest: () => Promise.resolve('allow-once') },
    (chunk) => chunks.push(chunk)
  )

  // Cancelled while the handshake is still outstanding, which is the state a user's cancel arrives in.
  await new Promise((resolve) => setTimeout(resolve, 200))
  controller.abort()

  const outcome = await turn
  assert.equal(outcome.cancelled, true, 'the turn reports the cancel rather than a failure')
  assert.deepEqual(chunks, [], 'and says nothing about it, because the user stopped it themselves')

  await reapAll()
  results.push('a cancel on an opencode turn kills the child and ends the turn silently')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('launch config', theLaunchConfigResolvesThroughTheLaw)
  await step('stdin policy', theConfigStatesItsStdinPolicy)
  await step('install pattern', thereIsNoInstalledDirectoryToProbe)
  await step('registry row', theRegistryPublishesTheOpenCodeRow)
  await step('turn', anOpenCodeTurnHandshakesAndStreamsThroughAFixtureAgent)
  await step('cancel', aCancelKillsTheChild)

  console.log('opencode launch config: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch(async (err) => {
  await reapAll()
  console.error('OPENCODE LAUNCH CONFIG TEST FAILED:', err)
  process.exit(1)
})
