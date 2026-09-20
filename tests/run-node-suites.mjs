/**
 * Runs the node suites — the non-DOM tests that exercise main-process modules and pure renderer
 * logic directly.
 *
 * These were previously bundled by hand into a gitignored scratch area (`.preview/`), which is why
 * they were invisible to lint and un-runnable by any single command. This is the one entry point:
 * each suite is bundled with esbuild into a temp file and executed with node, and the process exits
 * non-zero if any suite fails, so it works as a gate.
 *
 * Run: node tests/run-node-suites.mjs
 *
 * Electron is stubbed for the suites that need it (see `tests/stubs/`), because a suite must not
 * touch the real user's app data — several of them delete files by id.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, '.build')

const esbuild = join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
if (!existsSync(esbuild)) throw new Error(`esbuild not found at ${esbuild}`)

/** Every node suite, with the aliases it needs. */
const SUITES = [
  { name: 'agent loop', src: 'agent/agent-test.ts' },
  { name: 'approval gate', src: 'agent/approval-gate-test.ts' },
  { name: 'file diff', src: 'agent/file-diff-test.ts' },
  { name: 'tool protocol', src: 'agent/agent-protocol-test.ts' },
  { name: 'tool protocol (batch)', src: 'agent/agent-protocol2-test.ts' },
  { name: 'workspace events', src: 'agent/events-test.ts' },
  { name: 'engine tests', src: 'llm/engine-test.ts' },
  { name: 'models engine', src: 'llm/models-test.ts' },
  { name: 'terminal module', src: 'llm/terminal-test.ts' },
  { name: 'agent session', src: 'ui/agent-session-test.ts' },
  { name: 'terminal session', src: 'ui/terminal-session-test.ts' },
  { name: 'workspace change invalidation', src: 'ui/workspace-changes-test.ts' },
  { name: 'chat sessions', src: 'sessions/chat-sessions-test.ts' },
  { name: 'session resume', src: 'sessions/session-resume-test.ts' },
  { name: 'session click + title flow', src: 'sessions/session-flow-test.ts' },
  { name: 'transcript storage', src: 'sessions/sessions-test.ts' },
  { name: 'transcript v1 compatibility', src: 'sessions/transcript-v1-test.ts' },
  { name: 'session search rules', src: 'sessions/session-search-test.ts' },
  { name: 'session export renderer', src: 'sessions/session-export-test.ts' },
  { name: 'session commands (search, export)', src: 'sessions/session-commands-test.ts' },
  { name: 'orphan sweep', src: 'sessions/sweep-test.ts' },
]

mkdirSync(outDir, { recursive: true })

// `electron` and `electron-conveyor/main` are external (they cannot load outside electron), and are
// redirected to the stubs by a `--require` preload rather than by editing each suite.
const requireShim = join(here, 'stubs', 'register.cjs')

let failed = 0
for (const suite of SUITES) {
  const entry = join(here, suite.src)
  const out = join(outDir, suite.src.replace(/[\\/]/g, '-').replace(/\.ts$/, '.cjs'))

  // A private userData directory per suite, so the electron stub's `app.getPath` and the suite agree
  // on where files go — and so no suite can touch the real user's app data. The sessions suites
  // refuse to run without it, which is the property that makes them safe to run anywhere.
  const userData = mkdtempSync(join(tmpdir(), 'sam-ai-node-suite-'))

  try {
    execFileSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--outfile=${out}`,
        // Left external so the runtime `require` goes through tests/stubs/register.cjs. Bundling
        // them inlines the real Electron entry point, which throws outside Electron before the stub
        // can be reached.
        '--external:electron',
        '--external:electron-conveyor/main',
        '--log-level=error',
      ],
      { stdio: 'inherit' }
    )
  } catch {
    console.log(`${suite.name}: BUNDLE FAILED`)
    failed++
    continue
  }

  try {
    execFileSync(process.execPath, ['--require', requireShim, out], {
      stdio: 'inherit',
      env: { ...process.env, SAM_TEST_USER_DATA: userData },
    })
    console.log(`${suite.name}: ok`)
  } catch {
    console.log(`${suite.name}: FAILED`)
    failed++
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
}

rmSync(outDir, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} node suite(s) failed`)
  process.exit(1)
}
console.log(`\nall ${SUITES.length} node suites passed`)
