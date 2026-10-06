/**
 * Verifies the spawn law and the version probe: which binaries may be resolved at all, how a refusal is
 * spelled, and what detection reports about an engine that is and is not on this machine.
 *
 * The law is the one thing every future engine inherits, so it is asserted as a rule rather than as the
 * behaviour of one caller: args are an array or it refuses, `shell: true` is refused rather than
 * honoured, an engine nobody allowlisted is refused by id, and a binary override only ever names the
 * binary the allowlist already sanctions. Every refusal carries a code — never a sentence — because the
 * branch belongs to the caller and a message is not something anything may branch on.
 *
 * The probe is then driven two ways. Against an injected spawn, so the laws about what reaches the OS
 * are assertable at all: the command, the array, and the absence of a shell. And against a real child
 * process over a real pipe, with `node` standing in for the engine binary through the same allowlist the
 * shipped app uses — because a probe that only ever ran against a fake would be a claim about the fake.
 *
 * The live Codex binary is not probed here. Its path is this machine's, and a suite that hardcoded it
 * would be a suite that fails on the next machine for a reason that is not a defect; the probe's evidence
 * about the real CLI lives in the phase report, where a reader can see what was asked and answered.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_SAM_ENGINE_NAME,
  ENGINE_BINARIES,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_NOT_INSTALLED_NOTE,
  ENGINE_PROBE_ARGS,
  ENGINE_SPAWN_CODES,
  engineRows,
  engineVersion,
  isEngineId,
  resolveEngineSpawn,
  type EngineProbe,
} from '../../conveyor/protocol/engine'
import { probeEngine, type EngineSpawnImpl, type EngineSpawned } from '../../conveyor/modules/engine'

const results: string[] = []

/** The first engine this build allowlists, named rather than indexed, so a rename fails here loudly. */
const CODEX = 'codex'

/** The second, added by the phase that proved its installed CLI answers with an ACP server. */
const KIMI = 'kimi'

/** Where the law lives, from the root the suite is run from. */
const LAW_PATH = join(process.cwd(), 'conveyor', 'protocol', 'engine.ts')

/**
 * A child process that answers however a case needs it to, without starting anything.
 *
 * Written as a two-method object rather than an EventEmitter subclass because the probe uses exactly
 * these two events, and a stand-in that offered more would let a case assert against behaviour the
 * product does not have.
 */
function fakeChild(script: { stdout?: string; error?: NodeJS.ErrnoException; exit?: number | null }): EngineSpawned {
  const dataListeners: ((chunk: Buffer | string) => void)[] = []
  const errorListeners: ((error: NodeJS.ErrnoException) => void)[] = []
  const closeListeners: ((code: number | null) => void)[] = []

  const child: EngineSpawned = {
    stdout: {
      on: (_event, listener) => {
        dataListeners.push(listener)
      },
    },
    on: ((event: string, listener: (payload: never) => void) => {
      if (event === 'error') errorListeners.push(listener as (error: NodeJS.ErrnoException) => void)
      if (event === 'close') closeListeners.push(listener as (code: number | null) => void)
    }) as EngineSpawned['on'],
  }

  // Delivered on the next tick, so a caller that subscribes after spawning still hears it — which is
  // the difference between a probe that works and one that races its own process.
  queueMicrotask(() => {
    if (script.error) errorListeners.forEach((listener) => listener(script.error as NodeJS.ErrnoException))
    if (script.stdout !== undefined) dataListeners.forEach((listener) => listener(script.stdout as string))
    if (script.exit !== undefined) closeListeners.forEach((listener) => listener(script.exit as number | null))
  })

  return child
}

/** Record what a spawn was asked for, and answer with the child a case supplied. */
function recordingSpawn(child: EngineSpawned): {
  impl: EngineSpawnImpl
  calls: { command: string; args: string[]; options: { shell: false; windowsHide: true; cwd?: string } }[]
} {
  const calls: { command: string; args: string[]; options: { shell: false; windowsHide: true; cwd?: string } }[] = []
  const impl: EngineSpawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
  return { impl, calls }
}

// ---------------------------------------------------------------- the allowlist

/**
 * The allowlist is the law, and every engine it names is listed here.
 *
 * Asserted rather than assumed: an engine that could be spawned without being listed would make every
 * refusal below meaningless, and the labels and binaries are pinned to the same id set so a row can
 * never be offered for an engine the law would refuse.
 */
function theAllowlistIsTheOnlyWayIn() {
  assert.deepEqual([...ENGINE_IDS], [CODEX, KIMI], 'the phase allowlists two engines, in this order')
  assert.deepEqual(Object.keys(ENGINE_BINARIES).sort(), [...ENGINE_IDS].sort(), 'every engine has a binary')
  assert.deepEqual(Object.keys(ENGINE_LABELS).sort(), [...ENGINE_IDS].sort(), 'and a label to be drawn by')

  for (const id of ENGINE_IDS) {
    assert.ok(isEngineId(id), `${id}: the id is one the law knows`)
    assert.equal(typeof ENGINE_LABELS[id], 'string', `${id}: the label is a string`)
    assert.ok(ENGINE_LABELS[id].length > 0, `${id}: and not empty`)
    // Each engine is run by a binary of its own name: the allowlist is keyed by id, so `binaryNameOf`
    // judges a settings path by the id's own word rather than by one shared name.
    assert.equal(ENGINE_BINARIES[id], id, `${id}: the binary is the one the id names`)
  }

  assert.equal(isEngineId('sam'), false, 'the app itself is not an engine the law spawns')
  assert.equal(isEngineId(''), false, 'and neither is nothing')
  assert.equal(isEngineId(undefined), false, 'nor an absent value')

  results.push('the allowlist names two engines, and each binary, label and id agree')
}

// ---------------------------------------------------------------- refusals

/**
 * Every refusal is a code, and each of the four ways to be wrong has its own.
 *
 * `shell: true` is refused rather than ignored: a caller asking for a shell is asking for arguments to
 * be re-parsed by one, which is precisely the class of bug an array exists to prevent — and a law that
 * quietly passed `shell: false` instead would leave the caller believing it had a shell.
 */
function everyRefusalIsACode() {
  const unknown = resolveEngineSpawn({ engineId: 'claude', args: [] })
  assert.equal(unknown.ok, false, 'an engine nobody allowlisted is refused')
  assert.equal(unknown.ok === false && unknown.code, ENGINE_SPAWN_CODES.ENGINE_UNKNOWN, 'by its own code')

  const notAnArray = resolveEngineSpawn({ engineId: CODEX, args: 'codex --version' })
  assert.equal(notAnArray.ok, false, 'a command line offered as args is refused')
  assert.equal(notAnArray.ok === false && notAnArray.code, ENGINE_SPAWN_CODES.ENGINE_ARGS_NOT_ARRAY, 'by its own code')

  const notStrings = resolveEngineSpawn({ engineId: CODEX, args: ['--version', 7] })
  assert.equal(notStrings.ok, false, 'an argument that is not a string is refused')
  assert.equal(
    notStrings.ok === false && notStrings.code,
    ENGINE_SPAWN_CODES.ENGINE_ARGS_NOT_STRINGS,
    'by its own code'
  )

  const shell = resolveEngineSpawn({ engineId: CODEX, args: ['--version'], shell: true })
  assert.equal(shell.ok, false, 'shell: true is refused')
  assert.equal(shell.ok === false && shell.code, ENGINE_SPAWN_CODES.ENGINE_SHELL_REFUSED, 'by its own code')

  const outsideTheAllowlist = resolveEngineSpawn({
    engineId: CODEX,
    args: ['--version'],
    binaryOverride: 'C:/Users/someone/Downloads/not-codex.exe',
  })
  assert.equal(outsideTheAllowlist.ok, false, 'an override that names another binary is refused')
  assert.equal(
    outsideTheAllowlist.ok === false && outsideTheAllowlist.code,
    ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED,
    'by its own code'
  )

  const codes = Object.values(ENGINE_SPAWN_CODES)
  assert.equal(new Set(codes).size, codes.length, 'no two codes are the same string')
  for (const code of codes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `${code}: a code is a code, not a sentence`)
  }

  results.push('every refusal carries its own code: unknown, non-array, non-string, shell, unallowed binary')
}

/**
 * What the law lets through is the allowlisted binary, the caller's own array, and no shell.
 *
 * The args array is compared by identity of contents rather than by reference: a law that re-spelled a
 * caller's arguments would be a second place the command line is written down.
 */
function whatPassesIsTheBinaryAndTheArray() {
  const plain = resolveEngineSpawn({ engineId: CODEX, args: ['exec', '--json', 'hello world'] })
  assert.equal(plain.ok, true, 'the allowlisted binary is resolved')
  assert.equal(plain.ok === true && plain.command, ENGINE_BINARIES[CODEX], 'the command is the allowlisted name')
  assert.deepEqual(plain.ok === true && plain.args, ['exec', '--json', 'hello world'], 'the array is the caller’s')
  assert.equal(plain.ok === true && plain.shell, false, 'and the shell is off, stated rather than omitted')

  const noArgs = resolveEngineSpawn({ engineId: CODEX, args: [] })
  assert.equal(noArgs.ok, true, 'an empty array is an array')

  const probed = resolveEngineSpawn({ engineId: CODEX, args: [...ENGINE_PROBE_ARGS] })
  assert.equal(probed.ok, true, 'the probe’s own arguments are legal')
  assert.ok(ENGINE_PROBE_ARGS.length > 0, 'and there is at least one of them to read a version from')

  // An override is a path, so it is judged by the file it names: the allowlisted binary under a
  // directory of the user's choosing. `codex.exe` is the same binary on Windows, and `.cmd` is how a
  // package manager installs one — both sanctioned, and nothing else is.
  for (const override of ['C:/Program Files/codex/codex.exe', 'C:\\Tools\\codex\\codex.cmd', '/usr/local/bin/codex']) {
    const resolved = resolveEngineSpawn({ engineId: CODEX, args: ['--version'], binaryOverride: override })
    assert.equal(resolved.ok, true, `${override}: the allowlisted binary by absolute path is allowed`)
    assert.equal(resolved.ok === true && resolved.command, override, `${override}: and the path is what is run`)
  }

  results.push('the allowlisted binary runs with the caller’s own array, and never through a shell')
}

// ---------------------------------------------------------------- the version

/**
 * A version is read out of whatever the binary printed, and nothing is invented when nothing is there.
 *
 * Both real shapes are pinned: the vendor CLI's `codex-cli 0.154.0-alpha.6.2`, and a bridge binary that
 * prints its own name first. A line with no version in it answers null rather than the nearest number,
 * because the caller has a code for "the binary answered something I cannot read" and needs to reach it.
 */
function aVersionIsReadOrRefused() {
  assert.equal(engineVersion('codex-cli 0.154.0-alpha.6.2\n'), '0.154.0-alpha.6.2', 'the CLI’s own line')
  assert.equal(engineVersion('v0.8.0\n'), '0.8.0', 'a leading v is not part of the number')
  assert.equal(engineVersion('codex-acp 0.8.0\n'), '0.8.0', 'a name and a version, in that order')
  assert.equal(engineVersion('  \n'), null, 'blank output has no version')
  assert.equal(engineVersion('command not found'), null, 'and neither does prose')

  results.push('a version is read from the output, or answered as null rather than guessed at')
}

/**
 * The probe resolves the binary through the law, runs it with an array, and reads its version.
 *
 * The recorded spawn is the assertion that matters: the fake child could be told anything, but what
 * reaches it is the product's decision — the allowlisted command, the probe's own argument array, and
 * `shell: false`. ENOENT is then the one failure with a code of its own, because "the user has not
 * installed this engine" is a state the picker draws rather than an error it reports.
 */
async function theProbeResolvesAndReads() {
  const child = fakeChild({ stdout: 'codex-cli 9.9.9\n', exit: 0 })
  const { impl, calls } = recordingSpawn(child)

  // An empty environment, so the install pattern produces no candidates and the probe's answer is this machine's
  // notwithstanding: the cases below are about the mechanism, and a suite that let the real Codex install — which
  // is present on the machine this phase was built on — into the resolution would be asserting against a laptop.
  const found = await probeEngine({ engineId: CODEX }, { spawnImpl: impl, env: {} })
  assert.equal(found.installed, true, 'a binary that answers is installed')
  assert.equal(found.version, '9.9.9', 'and its version is the one it printed')
  assert.equal(found.code, undefined, 'with no code, because nothing was refused')

  assert.equal(calls.length, 1, 'the probe spawned exactly once')
  assert.equal(calls[0].command, ENGINE_BINARIES[CODEX], 'the allowlisted binary')
  assert.deepEqual(calls[0].args, [...ENGINE_PROBE_ARGS], 'with the probe’s own arguments as an array')
  assert.equal(calls[0].options.shell, false, 'and never through a shell')

  const missingChild = fakeChild({ error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) })
  const missing = await probeEngine({ engineId: CODEX }, { spawnImpl: recordingSpawn(missingChild).impl, env: {} })
  assert.equal(missing.installed, false, 'a binary that is not there is not installed')
  assert.equal(missing.code, ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED, 'reported as not installed, by code')
  assert.equal(missing.version, undefined, 'and no version is claimed for it')

  const silentChild = fakeChild({ stdout: 'nothing useful here\n', exit: 0 })
  const silent = await probeEngine({ engineId: CODEX }, { spawnImpl: recordingSpawn(silentChild).impl, env: {} })
  assert.equal(silent.installed, false, 'a binary that answers without a version is not usable')
  assert.equal(silent.code, ENGINE_SPAWN_CODES.ENGINE_VERSION_UNREADABLE, 'and says which way it failed')

  const refused = await probeEngine({ engineId: 'claude' }, { spawnImpl: recordingSpawn(child).impl, env: {} })
  assert.equal(refused.installed, false, 'an engine the law refuses is not probed at all')
  assert.equal(refused.code, ENGINE_SPAWN_CODES.ENGINE_UNKNOWN, 'and the refusal is the law’s own code')

  results.push('the probe resolves the allowlisted binary, reads its version, and codes every failure')
}

/**
 * The same probe, over a real pipe, against a real child process.
 *
 * `node` is put in the allowlist for this case alone, so the mechanism being proved — resolve, spawn with
 * an array, read stdout, parse a version — is proved against the OS rather than against a stand-in. It
 * is the same code path the shipped probe takes for `codex`; only the allowlist entry differs.
 */
async function theProbeRunsARealProcess() {
  const allowlist = { [CODEX]: 'node' }
  const resolved = resolveEngineSpawn({ engineId: CODEX, args: ['--version'], allowlist })
  assert.equal(resolved.ok, true, 'an injected allowlist resolves through the same law')

  const real: EngineSpawnImpl = (command, args, options) => spawn(command, args, options) as unknown as EngineSpawned
  const probed = await probeEngine({ engineId: CODEX }, { spawnImpl: real, allowlist, env: {} })

  assert.equal(probed.installed, true, 'the real child is found')
  assert.match(probed.version ?? '', /^v?\d+\.\d+\.\d+/, `a real version came back: ${probed.version}`)

  results.push('the probe resolves, spawns and reads a version over a real pipe with the real spawner')
}

// ---------------------------------------------------------------- the rows

/**
 * The picker's list starts with the app itself, and every engine after it says whether it is here.
 *
 * The first row is the default rather than a member of the allowlist: a conversation that names no engine
 * runs the Sam loop, which is what every conversation written before this phase does. An engine nobody
 * has probed is drawn as not installed rather than omitted — a row that vanished until it was detected
 * would be an engine the user cannot find, and cannot be told why.
 */
function theRowsStartWithTheAppItself() {
  const rows = engineRows({})
  assert.equal(rows.length, ENGINE_IDS.length + 1, 'the app’s own row, then one per engine')
  assert.equal(rows[0].id, null, 'the first row is the default, which names no engine')
  assert.equal(rows[0].name, AGENT_SAM_ENGINE_NAME, 'and it is called what the app is called')
  assert.equal(rows[0].installed, true, 'the default is always available')
  assert.equal(rows[0].version, null, 'and has no version to report')

  const undetected = rows[1]
  assert.equal(undetected.id, CODEX, 'the engine follows it')
  assert.equal(undetected.name, ENGINE_LABELS[CODEX], 'under the label the law gives it')
  assert.equal(undetected.installed, false, 'not installed until the probe says otherwise')
  assert.equal(undetected.note, ENGINE_NOT_INSTALLED_NOTE, 'and it says so, rather than being dropped')

  const probes: Partial<Record<string, EngineProbe>> = {
    [CODEX]: { installed: true, version: '0.154.0-alpha.6.2' },
  }
  const detected = engineRows(probes)
  assert.equal(detected[1].installed, true, 'a probed engine is installed')
  assert.equal(detected[1].version, '0.154.0-alpha.6.2', 'and carries the version it reported')
  assert.equal(detected[1].note, null, 'with nothing left to warn about')
  assert.equal(detected[0].installed, true, 'and the default row is unmoved by an engine being present')

  const refused = engineRows({ [CODEX]: { installed: false, code: ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED } })
  assert.equal(refused[1].installed, false, 'a refused probe leaves the row not installed')
  assert.equal(refused[1].note, ENGINE_NOT_INSTALLED_NOTE, 'and still says why it cannot be picked')

  results.push('the rows start with the app itself, and every engine states whether it is installed')
}

// ---------------------------------------------------------------- purity

/**
 * The law imports nothing.
 *
 * Read rather than inferred: an import of `path` would be the first step towards a platform rule living
 * in a second place, and an import of a store or a module would be an input the law could consult. It
 * answers from its own tables and its argument, which is what makes it testable by a suite that starts
 * nothing at all.
 */
function theLawHoldsNoSecondInput() {
  assert.ok(existsSync(LAW_PATH), `the law is where this suite reads it: ${LAW_PATH}`)
  const source = readFileSync(LAW_PATH, 'utf8')
  const imports = source.match(/^\s*import\b/gm) ?? []

  assert.equal(imports.length, 0, `the law declares no imports, found ${imports.length}`)

  results.push('the law module declares no imports at all — no path, no store, no clock')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('allowlist', theAllowlistIsTheOnlyWayIn)
  await step('refusals', everyRefusalIsACode)
  await step('what passes', whatPassesIsTheBinaryAndTheArray)
  await step('version', aVersionIsReadOrRefused)
  await step('probe', theProbeResolvesAndReads)
  await step('probe (real pipe)', theProbeRunsARealProcess)
  await step('rows', theRowsStartWithTheAppItself)
  await step('purity', theLawHoldsNoSecondInput)

  console.log('engine spawn law: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('ENGINE SPAWN LAW TEST FAILED:', err)
  process.exit(1)
})
