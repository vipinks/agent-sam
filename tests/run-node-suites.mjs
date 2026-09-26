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
  { name: 'mcp auto-approve gate (per-server consent)', src: 'agent/mcp-auto-approve-gate-test.ts' },
  { name: 'file diff', src: 'agent/file-diff-test.ts' },
  { name: 'tool protocol', src: 'agent/agent-protocol-test.ts' },
  { name: 'tool protocol (batch)', src: 'agent/agent-protocol2-test.ts' },
  { name: 'agent plan', src: 'agent/plan-test.ts' },
  { name: 'turn end diagnosis', src: 'agent/turn-end-test.ts' },
  { name: 'plan-unfinished notice', src: 'agent/plan-unfinished-test.ts' },
  { name: 'bounded auto-continue', src: 'agent/auto-continue-test.ts' },
  { name: 'workspace events', src: 'agent/events-test.ts' },
  { name: 'engine tests', src: 'llm/engine-test.ts' },
  { name: 'models engine', src: 'llm/models-test.ts' },
  { name: 'custom providers (routing + model list)', src: 'llm/custom-provider-test.ts' },
  { name: 'custom providers (store slice)', src: 'providers/provider-config-store-test.ts' },
  { name: 'terminal module', src: 'llm/terminal-test.ts' },
  { name: 'agent session', src: 'ui/agent-session-test.ts' },
  { name: 'terminal theme mapping', src: 'ui/terminal-theme-test.ts' },
  { name: 'terminal pty sessions', src: 'terminal/terminal-pty-test.ts' },
  { name: 'terminal preferences (bounds + store)', src: 'terminal/terminal-preferences-test.ts' },
  { name: 'terminal wire (chunk framing)', src: 'terminal/terminal-wire-test.ts' },
  { name: 'workspace change invalidation', src: 'ui/workspace-changes-test.ts' },
  { name: 'dock rules (explorer double-click)', src: 'ui/dock-rules-test.ts' },
  { name: 'chat sessions', src: 'sessions/chat-sessions-test.ts' },
  { name: 'session resume', src: 'sessions/session-resume-test.ts' },
  { name: 'session click + title flow', src: 'sessions/session-flow-test.ts' },
  { name: 'transcript storage', src: 'sessions/sessions-test.ts' },
  { name: 'transcript v1 compatibility', src: 'sessions/transcript-v1-test.ts' },
  { name: 'auto-approve persistence', src: 'sessions/auto-approve-persistence-test.ts' },
  { name: 'session search rules', src: 'sessions/session-search-test.ts' },
  { name: 'session export renderer', src: 'sessions/session-export-test.ts' },
  { name: 'session commands (search, export)', src: 'sessions/session-commands-test.ts' },
  { name: 'project instructions', src: 'sessions/project-instructions-test.ts' },
  { name: 'mention rules', src: 'mentions/mentions-test.ts' },
  { name: 'mention files', src: 'mentions/mentions-files-test.ts' },
  { name: 'skill rules', src: 'skills/skills-rules-test.ts' },
  { name: 'skill files', src: 'skills/skills-files-test.ts' },
  { name: 'skill tiers', src: 'skills/skills-tiers-test.ts' },
  { name: 'skill management', src: 'skills/skills-manage-test.ts' },
  { name: 'skill panel rules', src: 'skills/skills-panel-test.ts' },
  { name: 'mcp config rules', src: 'mcp/mcp-rules-test.ts' },
  { name: 'mcp servers (files, trust, secrets)', src: 'mcp/mcp-servers-test.ts' },
  { name: 'mcp runtime (spawn, tools, stderr)', src: 'mcp/mcp-runtime-test.ts' },
  { name: 'mcp bridge (tool list, consent, failures)', src: 'mcp/mcp-bridge-test.ts' },
  { name: 'mcp settings rules (running, trust, start gate)', src: 'mcp/mcp-settings-rules-test.ts' },
  { name: 'mcp panel rules (rows, status, search, page)', src: 'mcp/mcp-panel-test.ts' },
  { name: 'git porcelain parser', src: 'git/porcelain-test.ts' },
  { name: 'git module', src: 'git/git-module-test.ts' },
  { name: 'write guard rules', src: 'workspace/write-guard-test.ts' },
  { name: 'open root', src: 'workspace/open-root-test.ts' },
  { name: 'recent roots store', src: 'workspace/recent-roots-store-test.ts' },
  { name: 'recent project chips', src: 'workspace/recent-project-chips-test.ts' },
  { name: 'write baseline', src: 'workspace/write-baseline-test.ts' },
  { name: 'image read', src: 'workspace/image-read-test.ts' },
  { name: 'spreadsheet read', src: 'workspace/spreadsheet-read-test.ts' },
  { name: 'spreadsheet write', src: 'workspace/spreadsheet-write-test.ts' },
  { name: 'session project rules', src: 'sessions/session-project-test.ts' },
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
        // Also external, for a different reason: the workbook parser is a main-process dependency the
        // app itself externalizes (`externalizeDepsPlugin` in electron.vite.config.ts), and several
        // suites reach it transitively through `workspace.ts`. Inlining it would bundle two megabytes
        // into every one of those bundles — paying a per-suite cost for a parser most of them never
        // call — and would test an artifact the app never runs.
        '--external:exceljs',
        // Also external, for the same reason: the MCP SDK is a main-process dependency the app
        // externalizes too, and it is the thing that actually spawns the child the runtime suite
        // measures. Inlining it would test a copy of the spawner rather than the shipped one.
        '--external:@modelcontextprotocol/sdk',
        '--external:@modelcontextprotocol/sdk/*',
        // Also external, for the same reason again: the manifest parser is a main-process dependency
        // the app externalizes too, and the renderer never reaches it. Inlining it would bundle a
        // parser into suites that never call it, and would test a copy rather than the shipped one.
        '--external:yaml',
        // Also external, for the same reason again: `node-pty` is a native module, whose binary is
        // built or prebuilt per platform, and no suite loads it — the PTY suites drive a fake process
        // instead. Bundling it would try to inline a native binding, and would test a spawner the app
        // never runs.
        '--external:node-pty',
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
