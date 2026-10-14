/**
 * Phase 82 the live-CLI probe: how does the installed `codex` expose model selection at its boundary?
 *
 * Run with: node tests/probes/codex-model-flag-probe.mjs
 *
 * Two arms, because the flag's existence and the CLI's answer to a model it does not know are two different
 * facts and only the second one is about behaviour:
 *
 * - A  `codex exec --help`, read verbatim. The flag name and its argument shape are in the CLI's own words
 *      rather than in a guess made from this app's argument array.
 * - B  one real `exec` with a model id that cannot exist, so the refusal is the CLI's own. What is recorded
 *      is the exact error text and the exit code, since the feature turn has to know what a wrong model looks
 *      like on the way back rather than only that the flag exists.
 *
 * The binary is resolved the way the app resolves it: the install pattern first — `%LOCALAPPDATA%` with one
 * `*` segment, which is where the CLI puts itself and where `ENGINE_INSTALL_PATTERNS` points — and `PATH`
 * after it. `CODEX_BIN` overrides both, which is how the probe is pointed at a build under test.
 *
 * stdin is `ignore` for arm B, and that is load-bearing rather than tidy: `codex exec` appends a *piped* stdin
 * to its prompt and waits for that pipe to end, so a probe that inherited this process's stdin records
 * "Reading additional input from stdin..." and then waits forever. The same measurement is written in
 * `conveyor/modules/engine-codex.ts`'s header, taken with this file's own argument array.
 *
 * Nothing here imports the app: the point is to observe the CLI, not to agree with our own client about what
 * it said. Exit 0 is the pass; a missing binary is a clean skip, not a failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120_000)
const START = Date.now()

/** The model id arm B asks for. Long and unmistakable, so no installed model can answer to it by accident. */
const UNKNOWN_MODEL = 'phase82-not-a-real-model-xyz'

function record(kind, payload) {
  process.stdout.write(JSON.stringify({ t: Date.now() - START, kind, ...payload }) + '\n')
}

/**
 * The Codex binary to probe, chosen the way `installedBinaryFor` chooses it.
 *
 * The install pattern is expanded here rather than imported: this probe is deliberately standalone, and the
 * pattern it mirrors is one line of `ENGINE_INSTALL_PATTERNS` — a single `*` directory segment under
 * `%LOCALAPPDATA%/OpenAI/Codex/bin`. Every candidate is checked with `existsSync` before it is returned, so a
 * build directory that holds only the CLI's bundled tools is skipped rather than handed to a spawn.
 */
function resolveCodex() {
  if (process.env.CODEX_BIN) return { path: process.env.CODEX_BIN, source: 'CODEX_BIN' }

  const local = process.env.LOCALAPPDATA
  if (local) {
    const binDir = join(local, 'OpenAI', 'Codex', 'bin')
    if (existsSync(binDir)) {
      for (const entry of readdirSync(binDir)) {
        const candidate = join(binDir, entry, 'codex.exe')
        if (existsSync(candidate)) return { path: candidate, source: 'install pattern' }
      }
    }
  }

  // `PATH` last, and reached only when the install pattern found nothing: on this machine both exist and
  // they are different builds, so which one answered is part of what the probe records.
  const onPath = spawnSync('where', ['codex'], { encoding: 'utf8', shell: false })
  const first = String(onPath.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && line.toLowerCase().endsWith('.exe'))
  if (first) return { path: first, source: 'PATH' }

  return null
}

/** One spawn, captured whole: the exit code, stdout and stderr, and the seconds it took. */
function run(binary, args, options = {}) {
  const started = Date.now()
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    // `ignore` rather than inherited, for the reason in this file's header: a piped or inherited stdin makes
    // `codex exec` wait for a terminator that a probe has no reason to send.
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    cwd: options.cwd,
  })
  return {
    exitCode: result.status,
    signal: result.signal,
    seconds: Math.round((Date.now() - started) / 1000),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error) : null,
  }
}

/**
 * The model flag as the CLI's own help states it.
 *
 * Read as the line it appears on rather than as a match for a fixed spelling: the flag may be `-m, --model`
 * with a value placeholder, and a probe that asserted one exact string would break on the next formatting
 * change instead of recording it.
 */
function modelFlagLine(help) {
  return help.split(/\r?\n/).find((line) => /--model\b/.test(line) && /^\s*-/.test(line))
}

const failures = []
const notes = {}

function armHelp(binary) {
  const help = run(binary, ['exec', '--help'])
  record('codex-exec-help', {
    exitCode: help.exitCode,
    seconds: help.seconds,
    error: help.error,
  })

  const text = help.stdout + help.stderr
  const line = modelFlagLine(text)
  const usage = text.split(/\r?\n/).find((candidate) => /--model\b/.test(candidate) && !/^\s*-/.test(candidate))

  record('codex-model-flag', { flag: line ?? null, describesAs: usage ?? null, helpExitCode: help.exitCode })

  if (line === undefined) {
    failures.push('arm A: `codex exec --help` named no --model flag')
    return
  }

  // The argument shape, recorded rather than assumed: the placeholder between the angle brackets is the
  // CLI's own name for the value, and whether the short form `-m` is offered is a second fact about it.
  notes.flag = line.trim()
  notes.shortForm = /(^|\s)-m\b/.test(line) ? '-m' : null
  notes.valuePlaceholder = /<([^>]+)>/.exec(line)?.[1] ?? null
}

function armUnknownModel(binary, cwd) {
  const args = [
    'exec',
    '--model',
    UNKNOWN_MODEL,
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    'reply with the single word hi',
  ]
  const outcome = run(binary, args, { cwd })
  const text = outcome.stdout + outcome.stderr

  // The error shape, kept as the lines the CLI printed rather than as a paraphrase: a reader of the report has
  // to be able to see whether the refusal was the model's, the login's, or the network's.
  const errorLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(ERROR|error:)/.test(line) || /invalid_request_error|not supported|not found/i.test(line))
  const echoedModel = text.includes(UNKNOWN_MODEL)

  record('codex-unknown-model', {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    seconds: outcome.seconds,
    error: outcome.error,
    echoedModelInOutput: echoedModel,
    errorLines,
  })

  notes.unknownModelExitCode = outcome.exitCode
  notes.unknownModelErrors = errorLines

  // A refusal, not a success: the arm proves the model reaches the CLI. Nothing about the *wording* is
  // asserted, because the wording is what this arm exists to record — an offline machine answers with a
  // connection error instead, and both are a determinate answer about the model id.
  if (outcome.exitCode === 0) failures.push('arm B: an unknown model id was accepted')
  if (!echoedModel) failures.push('arm B: the model id never reached the CLI')
}

const resolution = resolveCodex()
if (resolution === null) {
  record('skip', { note: 'no codex binary found through CODEX_BIN, the install pattern, or PATH' })
  process.stdout.write('codex-model-flag-probe: SKIPPED (no codex binary)\n')
  process.exit(0)
}

record('binary', { path: resolution.path, source: resolution.source })

const version = run(resolution.path, ['--version'])
record('codex-version', { exitCode: version.exitCode, text: (version.stdout + version.stderr).trim() })
notes.version = (version.stdout + version.stderr).trim()

// The turn's own working directory is a real one: Codex refuses a directory it cannot resolve before it ever
// reads the model, which would make arm B measure the wrong refusal. A gitignored scratch dir is enough — the
// turn carries `--skip-git-repo-check` so a fresh empty folder is not itself a refusal.
const cwd = process.env.PROBE_CWD || process.cwd()

armHelp(resolution.path)
armUnknownModel(resolution.path, cwd)

record('summary', { ...notes, failures })
if (failures.length > 0) {
  process.stdout.write(`codex-model-flag-probe: FAILED (${failures.length})\n`)
  process.exit(1)
}
process.stdout.write(`codex-model-flag-probe: ok (${notes.flag})\n`)
process.exit(0)
