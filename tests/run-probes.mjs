/**
 * Runs the probe suite — the live-engine probes that measure an engine's own boundary rather than this app's
 * behaviour against it.
 *
 * These probes are deliberately not part of `test:node`. Each one spawns an installed engine binary and, where
 * that binary is signed in, talks to the network through it, so its verdict depends on the machine it runs on:
 * a probe whose binary is absent says `SKIPPED` rather than passing, which is honest but is not the same answer
 * every time. The six gates have to answer the same way everywhere, so the probes get their own entry point
 * instead of a seat inside a gate. This runner is that entry point: it names every probe in the suite, runs it
 * with node, and exits non-zero when a probe failed on something that was its own.
 *
 * Run: node tests/run-probes.mjs
 *
 * A probe's exit code is its verdict. Zero is a pass — including a probe that could not measure an engine,
 * because an absent binary or an expired login is an environment rather than a defect, and each probe states
 * that reason in its own output. Non-zero is a failure of the thing the probe was written to settle. Each probe
 * carries its own watchdog and its own wall clock, so this runner adds only the order and the total.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const START = Date.now()

/** Every probe in the suite, in the order a reader of the report meets them. */
const PROBES = [
  {
    name: 'codex model flag (exec --help shape, refusal of an unknown model id)',
    src: 'probes/codex-model-flag-probe.mjs',
  },
  {
    name: 'acp model surface (kimi, opencode: initialize, session/new, set_model, unknown model)',
    src: 'probes/acp-model-surface-probe.mjs',
  },
]

let failed = 0
for (const probe of PROBES) {
  const entry = join(here, probe.src)
  const probeStarted = Date.now()
  try {
    // `stdio: 'inherit'` rather than captured: a probe's own record lines are its evidence, and a runner that
    // swallowed them would leave a failing probe with nothing to read afterwards.
    execFileSync(process.execPath, [entry], { stdio: 'inherit' })
    console.log(`${probe.name}: ok (${((Date.now() - probeStarted) / 1000).toFixed(1)}s)`)
  } catch {
    console.log(`${probe.name}: FAILED (${((Date.now() - probeStarted) / 1000).toFixed(1)}s)`)
    failed++
  }
}

const seconds = ((Date.now() - START) / 1000).toFixed(1)

if (failed) {
  console.error(`\n${failed} probe(s) failed`)
  process.exit(1)
}
console.log(`\nall ${PROBES.length} probes passed`)
console.log(`probe suite: ${seconds}s`)
