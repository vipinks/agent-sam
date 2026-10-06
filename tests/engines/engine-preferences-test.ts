/**
 * Verifies the per-engine preferences: the rule that turns a chosen permission mode into the sandbox
 * flag the CLI is handed, the order a stored path override is resolved in, and what a probe that
 * refuses does to the value already stored.
 *
 * The mode rule is asserted for all three traced sandbox values, and the default is asserted to *be*
 * the shipped launch config rather than to resemble it: `ENGINE_LAUNCH_ARGS` is what this phase
 * replaced as a pin, so the array a turn runs with when nobody has chosen anything has to come out of
 * the rule byte for byte. The turn itself is then driven, because "the chosen mode feeds the launch
 * args" is a claim about what reached the OS and nothing weaker.
 *
 * The override is proved as an order rather than as three separate answers: an absent override leaves
 * the allowlist exactly as it was, a set one wins, and the probe gates it — so a path is written only
 * after something has run it. The last case drives the save against a scripted spawn, which is the only
 * way the two halves of "refused, so the last good value survives" can be observed together: the
 * refusal is the error's code, and the survival is the sink that was not called.
 *
 * What this does not prove is anything about a live engine binary on this machine; the acceptance for
 * that is a person watching an installed CLI answer under a chosen mode.
 */
import { strict as assert } from 'node:assert'
import {
  ENGINE_AUTH_HINTS,
  ENGINE_DEFAULT_PERMISSION_MODE,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_LAUNCH_ARGS,
  ENGINE_PERMISSION_MODE_IDS,
  ENGINE_PERMISSION_MODE_LABELS,
  ENGINE_PERMISSION_MODE_WARNINGS,
  ENGINE_PERMISSION_MODES,
  ENGINE_SPAWN_CODES,
  engineLaunchArgs,
  enginePathRefusalWord,
  enginePreference,
  resolveEnginePathOverride,
  resolveEngineSpawn,
} from '../../conveyor/protocol/engine'
import {
  clearEngineBinaryPath,
  saveEngineBinaryPath,
  setEngineBinaryPathSink,
  type EngineSpawnImpl,
  type EngineSpawned,
} from '../../conveyor/modules/engine'
import { runCodexTurn, type CodexChild, type CodexSpawnImpl } from '../../conveyor/modules/engine-codex'
import { enginePreferencesStore, type EnginePreferencesState } from '../../conveyor/stores/engine-preferences'

const results: string[] = []
const CODEX = 'codex'

/** A child that answers however a case needs it to, without starting anything. */
function fakeChild(script: { stdout?: string; error?: NodeJS.ErrnoException; exit?: number | null }): EngineSpawned {
  const dataListeners: ((chunk: Buffer | string) => void)[] = []
  const errorListeners: ((error: NodeJS.ErrnoException) => void)[] = []
  const closeListeners: ((code: number | null) => void)[] = []

  const child: EngineSpawned = {
    stdout: { on: (_event, listener) => void dataListeners.push(listener) },
    on: ((event: string, listener: (payload: never) => void) => {
      if (event === 'error') errorListeners.push(listener as (error: NodeJS.ErrnoException) => void)
      if (event === 'close') closeListeners.push(listener as (code: number | null) => void)
    }) as EngineSpawned['on'],
  }

  // Delivered on a later tick, so a probe that subscribes after spawning still hears it.
  queueMicrotask(() => {
    if (script.error) errorListeners.forEach((listener) => listener(script.error as NodeJS.ErrnoException))
    if (script.stdout !== undefined) dataListeners.forEach((listener) => listener(script.stdout as string))
    if (script.exit !== undefined) closeListeners.forEach((listener) => listener(script.exit as number | null))
  })

  return child
}

/** A spawn that records what it was asked for and answers with one scripted child per call. */
function recordingSpawn(children: EngineSpawned[]): {
  impl: EngineSpawnImpl
  calls: { command: string; args: string[] }[]
} {
  const calls: { command: string; args: string[] }[] = []
  let next = 0
  return {
    calls,
    impl: (command, args) => {
      calls.push({ command, args: [...args] })
      const child = children[Math.min(next, children.length - 1)]
      next += 1
      return child as EngineSpawned
    },
  }
}

/** An error the OS answers with when the file a caller named is not there. */
function enoent(command: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
}

// ---------------------------------------------------------------- the mode rule

/**
 * Every traced sandbox value maps to its own flag, and the default is the config this app shipped.
 *
 * The default is compared against `ENGINE_LAUNCH_ARGS` rather than written out again: that table was
 * the pin this phase replaced, and a rule whose default disagreed with it by one word would be a
 * different launch config wearing the same name.
 */
function theModeRuleMapsEachModeToItsFlag() {
  assert.deepEqual(
    [...ENGINE_PERMISSION_MODE_IDS],
    ['read-only', 'workspace-write', 'danger-full-access'],
    'the three sandbox values the CLI traces, strictest first'
  )
  assert.equal(ENGINE_DEFAULT_PERMISSION_MODE, 'workspace-write', 'and the default is the one this app shipped')

  for (const mode of ENGINE_PERMISSION_MODE_IDS) {
    const args = engineLaunchArgs(CODEX, mode)
    const at = args.indexOf('--sandbox')
    assert.ok(at >= 0, `${mode}: the sandbox flag is named`)
    assert.equal(args[at + 1], mode, `${mode}: and carries the traced value`)

    // The flag that turns the sandbox off is a different flag, and this app never passes it — not even
    // for the mode that would look like its reason.
    assert.equal(
      args.includes('--dangerously-bypass-approvals-and-sandbox'),
      false,
      `${mode}: the bypass flag is never among them`
    )

    const resolved = resolveEngineSpawn({ engineId: CODEX, args: [...args, 'a prompt'] })
    assert.equal(resolved.ok, true, `${mode}: the array still resolves through the spawn law`)
  }

  // Nobody has chosen: the array is the shipped one, word for word.
  assert.deepEqual(engineLaunchArgs(CODEX), [...ENGINE_LAUNCH_ARGS[CODEX]], 'the default is the shipped launch config')
  assert.equal(ENGINE_PERMISSION_MODES[CODEX], ENGINE_DEFAULT_PERMISSION_MODE, 'which is the table of defaults')
  assert.equal(engineLaunchArgs(CODEX)[engineLaunchArgs(CODEX).indexOf('--sandbox') + 1], 'workspace-write')

  // A value no rule offered is not interpolated: the default answers for it.
  const invented = engineLaunchArgs(CODEX, 'god-mode' as unknown as (typeof ENGINE_PERMISSION_MODE_IDS)[number])
  assert.equal(invented[invented.indexOf('--sandbox') + 1], 'workspace-write', 'an unknown mode is not passed through')

  // Every mode a reader is offered has a word, and only the one that grants the machine warns.
  for (const mode of ENGINE_PERMISSION_MODE_IDS) {
    assert.equal(typeof ENGINE_PERMISSION_MODE_LABELS[mode], 'string', `${mode}: the control has a word for it`)
  }
  assert.equal(ENGINE_PERMISSION_MODE_WARNINGS['read-only'], null, 'a confined mode says nothing extra')
  assert.equal(ENGINE_PERMISSION_MODE_WARNINGS['workspace-write'], null, 'and neither does the default')
  assert.match(
    ENGINE_PERMISSION_MODE_WARNINGS['danger-full-access'] ?? '',
    /full machine access/i,
    'while the one that grants the machine names what it grants'
  )

  results.push('the mode rule maps each traced sandbox value to its flag, and the default is the shipped config')
}

/** The chosen mode is what the OS is handed, which is the whole point of the rule above. */
async function theChosenModeReachesTheSpawnedArgs() {
  const spawn = recordingSpawn([fakeChild({ stdout: '', exit: 0 })])
  await runCodexTurn(
    { engineId: CODEX, prompt: 'a prompt', cwd: 'C:/work', permissionMode: 'read-only' },
    { spawnImpl: spawn.impl as unknown as CodexSpawnImpl },
    () => undefined
  )

  const args = spawn.calls[0].args
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only', 'the stricter mode is the flag the child was given')
  assert.equal(args[args.length - 1], 'a prompt', 'with the prompt still last, past the mode')

  const fallback = recordingSpawn([{ ...(fakeChild({ stdout: '', exit: 0 }) as CodexChild) }])
  await runCodexTurn(
    { engineId: CODEX, prompt: 'a prompt', cwd: 'C:/work' },
    { spawnImpl: fallback.impl as unknown as CodexSpawnImpl },
    () => undefined
  )
  assert.equal(
    fallback.calls[0].args[fallback.calls[0].args.indexOf('--sandbox') + 1],
    ENGINE_DEFAULT_PERMISSION_MODE,
    'and a turn nobody chose a mode for runs under the default'
  )

  results.push('the chosen mode is the sandbox value the engine child is started with')
}

// ---------------------------------------------------------------- the override order

/**
 * The order a stored path override is resolved in: it wins, the probe gates it, the allowlist answers
 * when there is none.
 *
 * Pure, and proved as an order — the three answers together are the rule, and any one of them alone
 * would be satisfied by a function that always said the same thing. The codes are asserted to travel
 * untouched, because the caller branches on them and a rule that collapsed them into one refusal would
 * make "the user named something that is not the engine" and "nothing is there" the same sentence.
 */
function theOverrideOrderIsOverrideThenProbeThenAllowlist() {
  // No override: the allowlist answers, exactly as it did before this preference existed.
  assert.deepEqual(
    resolveEnginePathOverride({ override: null }),
    { ok: true, path: null, source: 'allowlist' },
    'an engine nobody overrode resolves through the allowlist'
  )
  assert.deepEqual(
    resolveEnginePathOverride({ override: '' }),
    { ok: true, path: null, source: 'allowlist' },
    'and an emptied field is the same as never having set one'
  )

  // A set override that the probe ran: the override wins over both locations the law knows.
  assert.deepEqual(
    resolveEnginePathOverride({ override: 'D:/tools/codex.exe', probe: { installed: true, version: '0.154.0' } }),
    { ok: true, path: 'D:/tools/codex.exe', source: 'override' },
    'a probe that ran the path is what makes the override the answer'
  )

  // The probe gates: every way it can refuse travels as its own code, and no path is answered.
  for (const code of [
    ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED,
    ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED,
    ENGINE_SPAWN_CODES.ENGINE_VERSION_UNREADABLE,
    ENGINE_SPAWN_CODES.ENGINE_SPAWN_FAILED,
    ENGINE_SPAWN_CODES.ENGINE_PROBE_TIMEOUT,
  ]) {
    assert.deepEqual(
      resolveEnginePathOverride({ override: 'D:/tools/elsewhere.exe', probe: { installed: false, code } }),
      { ok: false, code },
      `${code}: refused by the probe's own code`
    )
  }

  // An override nobody probed is not trusted for being the user's.
  assert.deepEqual(
    resolveEnginePathOverride({ override: 'D:/tools/codex.exe' }),
    { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED },
    'a path with no probe behind it is refused rather than assumed to work'
  )

  // And the allowlist still judges what an override *names*: the law is unchanged, which is what keeps
  // a settings file from being a way to run something else.
  const stranger = resolveEngineSpawn({ engineId: CODEX, args: ['--version'], binaryOverride: 'D:/tools/git.exe' })
  assert.deepEqual(
    stranger,
    { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED },
    'a path naming another binary is refused wherever it lives'
  )
  const sanctioned = resolveEngineSpawn({ engineId: CODEX, args: ['--version'], binaryOverride: 'D:/tools/codex.exe' })
  assert.equal(sanctioned.ok === true && sanctioned.command, 'D:/tools/codex.exe', 'while the engine own binary runs')

  results.push('the override wins, the probe gates it, and an absent override leaves the allowlist unmoved')
}

// ---------------------------------------------------------------- the save

/**
 * A refused probe yields its code and leaves the last good path where it was.
 *
 * Both halves are observed on the same run: the error's `code` is the assertion that the refusal named
 * why, and the sink's record is the assertion that *nothing* was written — a save that threw after
 * recording would pass a test that only watched the error, and would be the defect this case exists for.
 */
async function aRefusedProbeYieldsItsCodeAndKeepsTheLastGoodPath() {
  const recorded: { engineId: string; path: string }[] = []
  let clears = 0
  setEngineBinaryPathSink({
    record: (input) => void recorded.push(input),
    clear: () => void (clears += 1),
  })

  try {
    const good = recordingSpawn([fakeChild({ stdout: 'codex-cli 0.154.0\n', exit: 0 })])
    await saveEngineBinaryPath({ engineId: CODEX, path: 'D:/tools/codex.exe' }, { spawnImpl: good.impl, env: {} })
    assert.deepEqual(
      recorded,
      [{ engineId: CODEX, path: 'D:/tools/codex.exe' }],
      'a path the probe ran is the one recorded'
    )
    assert.equal(good.calls[0].command, 'D:/tools/codex.exe', 'and the probe is what ran it')

    // A path that is not there: the OS refuses the spawn, and the code says so.
    const missing = recordingSpawn([fakeChild({ error: enoent('D:/tools/nope/codex.exe') })])
    await assert.rejects(
      () =>
        saveEngineBinaryPath(
          { engineId: CODEX, path: 'D:/tools/nope/codex.exe' },
          { spawnImpl: missing.impl, env: {} }
        ),
      (error: unknown) => (error as { code?: string }).code === ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED,
      'a path nothing is at is refused by the probe own code'
    )
    assert.deepEqual(recorded, [{ engineId: CODEX, path: 'D:/tools/codex.exe' }], 'and the last good path survives')

    // A path naming something that is not this engine: the law refuses before anything is started.
    const stranger = recordingSpawn([fakeChild({ stdout: 'git version 2.44.0\n', exit: 0 })])
    await assert.rejects(
      () => saveEngineBinaryPath({ engineId: CODEX, path: 'D:/tools/git.exe' }, { spawnImpl: stranger.impl, env: {} }),
      (error: unknown) => (error as { code?: string }).code === ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED,
      'a binary the allowlist does not sanction is refused as such'
    )
    assert.equal(stranger.calls.length, 0, 'without starting it')
    assert.deepEqual(recorded, [{ engineId: CODEX, path: 'D:/tools/codex.exe' }], 'and still nothing was written')

    // A path the user emptied is the allowlist again, and it is written as an absence rather than as a
    // path of nothing.
    clearEngineBinaryPath({ engineId: CODEX })
    assert.equal(clears, 1, 'clearing asks the store for the absence, not for a blank path')
    assert.deepEqual(recorded, [{ engineId: CODEX, path: 'D:/tools/codex.exe' }], 'and writes no path of its own')

    // Every refusal a reader can be shown has words of its own, branched on the code.
    for (const code of Object.values(ENGINE_SPAWN_CODES)) {
      assert.ok(enginePathRefusalWord(code).length > 0, `${code}: the code has a word`)
    }
    assert.notEqual(
      enginePathRefusalWord(ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED),
      enginePathRefusalWord(ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED),
      'and two different codes are not one sentence'
    )
  } finally {
    setEngineBinaryPathSink(null)
  }

  results.push('a refused path yields the probe own code, writes nothing, and the last good path survives')
}

// ---------------------------------------------------------------- the store

/** The store carries one path and one mode per engine, and a partial record is filled from the shipped defaults. */
function theStoreCarriesBothValuesPerEngine() {
  const actions = enginePreferencesStore.actions as unknown as Record<
    string,
    (draft: EnginePreferencesState, input: unknown) => void
  >

  let state: EnginePreferencesState = { engines: {} }
  const apply = (method: string, input: unknown) => {
    const next = structuredClone(state)
    actions[method](next, input)
    state = next
  }

  apply('setPermissionMode', { engineId: CODEX, mode: 'danger-full-access' })
  assert.equal(state.engines[CODEX].permissionMode, 'danger-full-access', 'the mode is kept per engine')
  assert.equal(enginePreference(state.engines[CODEX], CODEX).binaryPath, null, 'and setting it leaves no path behind')

  apply('recordBinaryPath', { engineId: CODEX, path: 'D:/tools/codex.exe' })
  assert.equal(state.engines[CODEX].binaryPath, 'D:/tools/codex.exe', 'the path is kept beside it')
  assert.equal(
    enginePreference(state.engines[CODEX], CODEX).permissionMode,
    'danger-full-access',
    'and neither value clears the other'
  )

  apply('clearBinaryPath', { engineId: CODEX })
  assert.equal(
    enginePreference(state.engines[CODEX], CODEX).binaryPath,
    null,
    'clearing takes the path off — as an absence, which is the state of a machine that never set one'
  )
  assert.equal(state.engines[CODEX].permissionMode, 'danger-full-access', 'while the mode stays where it is')

  // An engine nobody has touched, and a record read off a file that named one field only: both answer
  // with the shipped defaults rather than with what happens to be missing.
  const untouched = enginePreference(undefined, CODEX)
  assert.deepEqual(untouched, { binaryPath: null, permissionMode: ENGINE_DEFAULT_PERMISSION_MODE })
  const partial = enginePreference({ binaryPath: 'D:/tools/codex.exe' }, CODEX)
  assert.equal(partial.permissionMode, ENGINE_DEFAULT_PERMISSION_MODE, 'a record with no mode runs at the default')
  assert.equal(partial.binaryPath, 'D:/tools/codex.exe', 'and keeps the field it does name')
  const invented = enginePreference({ permissionMode: 'god-mode' }, CODEX)
  assert.equal(invented.permissionMode, ENGINE_DEFAULT_PERMISSION_MODE, 'a mode no rule offered is not honoured')

  // The store is persisted: a preference is not a fact about the conversation that happened to set it.
  assert.equal(enginePreferencesStore.persist, true, 'the preferences are written to the store own file')

  results.push('the store carries one path and one mode per engine, and fills the rest from the shipped defaults')
}

/** The section has a line to write for every engine, so an engine joining later cannot be drawn mute. */
function everyEngineHasARowToBeDrawnFrom() {
  // The account word each engine's own line names. Pinned per id rather than one word for all of them,
  // because there is no shared answer to give: this app never sees a credential, and each CLI signs itself
  // in with its own account — so a line copied from the engine beside it fails here rather than in the section.
  const ACCOUNTS: Readonly<Record<string, RegExp>> = { codex: /ChatGPT/, kimi: /Kimi/, opencode: /OpenCode/ }

  for (const id of ENGINE_IDS) {
    assert.ok(ENGINE_LABELS[id].length > 0, `${id}: the row has a name`)
    assert.ok(ENGINE_AUTH_HINTS[id].length > 0, `${id}: and an auth line`)
    assert.match(ENGINE_AUTH_HINTS[id], ACCOUNTS[id], `${id}: naming the account the user signs in with`)
  }

  results.push('every allowlisted engine has a label and an auth line, each naming its own account')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('mode rule', theModeRuleMapsEachModeToItsFlag)
  await step('mode reaches the spawn', theChosenModeReachesTheSpawnedArgs)
  await step('override order', theOverrideOrderIsOverrideThenProbeThenAllowlist)
  await step('save', aRefusedProbeYieldsItsCodeAndKeepsTheLastGoodPath)
  await step('store', theStoreCarriesBothValuesPerEngine)
  await step('auth hints', everyEngineHasARowToBeDrawnFrom)

  console.log('engine preferences: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('ENGINE PREFERENCES TEST FAILED:', err)
  process.exit(1)
})
