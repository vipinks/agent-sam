/**
 * Verifies the binary a Codex turn actually starts: the saved override, the install pattern, and the
 * `PATH` fallback are one resolution chain, and the command handed to spawn is always an absolute file.
 *
 * The defect this suite is about is not visible in a runner test that hands `runCodexTurn` its own
 * override: the turn's caller is the half that used to ignore the saved preference and fall back to a
 * bare allowlisted name. These cases drive the turn boundary itself with a recording spawn, so what is
 * asserted is the command the product chose rather than the command the suite supplied.
 *
 * The fixtures are real files in the OS temp directory. A shim, a `.cmd`, and an `.exe` are different
 * files to the resolver, and a fake existence map would let a bug pass by storing the distinction in the
 * test rather than in the product. Every directory is removed when the suite ends.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { ENGINE_SPAWN_CODES } from '../../conveyor/protocol/engine'
import { runEngineTurn, setEnginePreferenceSource, type EngineTurnDeps } from '../../conveyor/modules/engine'
import type { CodexChild, CodexSpawnImpl } from '../../conveyor/modules/engine-codex'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const CODEX = 'codex'
const TURN = {
  engineId: CODEX,
  prompt: 'say hello',
  cwd: process.cwd(),
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
}

/** The one temp root this suite reads and removes; each case gets a directory beneath it. */
let root = ''

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

/** A child that closes cleanly on the next tick, so one turn can finish without a real process. */
function closingChild(): CodexChild {
  let close: ((code: number | null) => void) | null = null

  const child: CodexChild = {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: ((event: string, listener: (payload: never) => void) => {
      if (event === 'close') close = listener as (code: number | null) => void
      return undefined
    }) as CodexChild['on'],
    get killed() {
      return false
    },
    exitCode: null,
    kill: () => true,
  }

  setImmediate(() => close?.(0))
  return child
}

/** One recording spawn, so every case can assert both the command and whether any child was started. */
function recordingSpawn(): { impl: CodexSpawnImpl; calls: { command: string; args: readonly string[] }[] } {
  const calls: { command: string; args: readonly string[] }[] = []
  return {
    calls,
    impl: (command, args) => {
      calls.push({ command, args: [...args] })
      return closingChild()
    },
  }
}

/** Drive the turn boundary with the environment under test. */
async function runTurn(deps: Omit<EngineTurnDeps, 'spawnImpl'>): Promise<{
  calls: { command: string; args: readonly string[] }[]
  chunks: EngineTranscriptChunk[]
}> {
  const spawn = recordingSpawn()
  const chunks: EngineTranscriptChunk[] = []
  const controller = new AbortController()
  for await (const chunk of runEngineTurn(TURN, controller.signal, { ...deps, spawnImpl: spawn.impl })) {
    chunks.push(chunk)
  }
  return { calls: spawn.calls, chunks }
}

function savedPath(path: string | null): void {
  setEnginePreferenceSource({
    read: (engineId) => (engineId === CODEX ? { binaryPath: path } : undefined),
  })
}

// ---------------------------------------------------------------- the four turn cases

/**
 * D5(1): a saved override is the command the turn starts.
 *
 * The extensionless shim and the `.cmd` are both on `PATH`, ahead of everything else — the old bare-name
 * search would have reached one of them. The saved `.exe` wins because it is the file the probe judged.
 * The second half uses a stale saved path: the `isFile` guard must fall through to the install pattern,
 * never to a spawn that would end in ENOENT.
 */
async function aSavedOverrideIsTheCommand(): Promise<void> {
  const dir = join(root, 'saved')
  const override = join(dir, 'tools', 'codex.exe')
  const shimDir = join(dir, 'path')
  const local = join(dir, 'local')
  touch(override)
  touch(join(shimDir, 'codex'))
  touch(join(shimDir, 'codex.cmd'))

  savedPath(override)
  const result = await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: local } })

  assert.equal(result.calls.length, 1, 'the saved override starts one turn')
  assert.equal(result.calls[0]?.command, override, 'and the command is the saved .exe, not the PATH shim')

  const pattern = join(local, 'OpenAI', 'Codex', 'bin', 'build-id', 'codex.exe')
  touch(pattern)
  savedPath(join(dir, 'stale', 'codex.exe'))
  const stale = await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: local } })

  assert.equal(stale.calls.length, 1, 'a stale saved path still starts one turn')
  assert.equal(
    normalize(stale.calls[0]?.command ?? ''),
    normalize(pattern),
    'by falling through to the install pattern'
  )

  results.push('a saved .exe is the command, and a stale saved path falls through to the pattern')
}

/**
 * D5(2): the extensionless shim first on `PATH` does not become the command.
 *
 * The fixture has both names in one directory, with the shim written first. The turn must still hand
 * spawn the `.exe`, because the shim is not a file this app may start under its no-shell law.
 */
async function aPathOrderedShimLosesToTheExe(): Promise<void> {
  const dir = join(root, 'path-order')
  const shimDir = join(dir, 'path')
  const shim = join(shimDir, 'codex')
  const executable = join(shimDir, 'codex.exe')
  touch(shim)
  touch(executable)

  savedPath(null)
  const result = await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: join(dir, 'local') } })

  assert.equal(result.calls.length, 1, 'the fallback starts one turn')
  assert.equal(result.calls[0]?.command, executable, 'and the .exe wins, never the extensionless shim')
  assert.notEqual(result.calls[0]?.command, shim, 'the shim is not the command')

  const patternRoot = join(dir, 'local')
  const pattern = join(patternRoot, 'OpenAI', 'Codex', 'bin', 'build-id', 'codex.exe')
  touch(pattern)
  const patterned = await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: patternRoot } })

  assert.equal(patterned.calls.length, 1, 'the install pattern starts one turn')
  assert.equal(
    normalize(patterned.calls[0]?.command ?? ''),
    normalize(pattern),
    'and its .exe wins even with the shim first on PATH'
  )
  assert.notEqual(normalize(patterned.calls[0]?.command ?? ''), normalize(shim), 'never the shim')

  results.push('with the shim first on PATH, the turn still starts the fallback or pattern .exe')
}

/**
 * D5(3): shims and `.cmd` files alone yield the named absence, not a child and not ENOENT.
 *
 * This is the npm-only machine: `codex` and `codex.cmd` exist, and nothing this app may spawn without a
 * shell does. The turn emits the existing failure notice carrying `ENGINE_NOT_INSTALLED` and starts zero
 * children, so the pane can word the state instead of showing a raw OS error.
 */
async function shimsAloneStartNothingAndNameTheState(): Promise<void> {
  const dir = join(root, 'shims')
  const shimDir = join(dir, 'path')
  touch(join(shimDir, 'codex'))
  touch(join(shimDir, 'codex.cmd'))

  const assertNotInstalled = (result: Awaited<ReturnType<typeof runTurn>>, label: string): void => {
    assert.equal(result.calls.length, 0, `${label}: starts no child`)
    const notice = result.chunks.find((chunk) => chunk.type === 'turn_end_notice' && chunk.failure !== undefined)
    assert.ok(notice, `${label}: emits a failure notice rather than going quiet`)
    assert.equal(
      notice.type === 'turn_end_notice' ? notice.failure?.code : undefined,
      ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED,
      `${label}: carries the named not-installed code`
    )
  }

  savedPath(null)
  assertNotInstalled(await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: join(dir, 'local') } }), 'no override')

  savedPath(join(dir, 'stale', 'codex.exe'))
  assertNotInstalled(await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: join(dir, 'local') } }), 'stale override')

  results.push('shims alone, with or without a stale saved path, spawn nothing and emit ENGINE_NOT_INSTALLED')
}

/**
 * D5(4): a real `.exe` reachable only through the fallback is started.
 *
 * No saved preference and no install pattern: the only codex file is the `.exe` on `PATH`. This is the
 * configuration that must keep working when the bare-name search is removed.
 */
async function aPathExeAloneIsStarted(): Promise<void> {
  const dir = join(root, 'path-exe')
  const shimDir = join(dir, 'path')
  const executable = join(shimDir, 'codex.exe')
  touch(executable)

  savedPath(null)
  const result = await runTurn({ env: { PATH: shimDir, LOCALAPPDATA: join(dir, 'local') } })

  assert.equal(result.calls.length, 1, 'the PATH .exe starts one turn')
  assert.equal(result.calls[0]?.command, executable, 'and the command is that absolute .exe')

  results.push('a PATH-only .exe is resolved to its absolute path and started')
}

// ---------------------------------------------------------------- report

async function main(): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'sam-ai-codex-binary-'))

  // Every case runs, and every failure is reported: the red turn needs all four behaviors measured
  // together rather than only the first one.
  let failed = 0
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    try {
      await fn()
    } catch (error) {
      failed += 1
      console.error(`  FAILED: ${label} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    await step('saved override', aSavedOverrideIsTheCommand)
    await step('PATH ordering', aPathOrderedShimLosesToTheExe)
    await step('shims only', shimsAloneStartNothingAndNameTheState)
    await step('PATH .exe', aPathExeAloneIsStarted)
  } finally {
    setEnginePreferenceSource(null)
    rmSync(root, { recursive: true, force: true })
  }

  console.log('codex turn binary: ' + results.length + ' passed, ' + failed + ' failed')
  for (const result of results) console.log('  pass: ' + result)
  if (failed > 0) process.exitCode = 1
}

void main().catch((err) => {
  console.error('CODEX TURN BINARY TEST FAILED:', err)
  process.exit(1)
})
