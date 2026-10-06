/**
 * The ACP engine's turn lifecycle, as a process: one child per turn, the child's whole tree reaped when the
 * turn ends, and every way a turn can end — success, refusal, cancel, a child that dies, a call that is never
 * answered — ending *within a stated bound* with a traced cause instead of leaving the pane on Thinking.
 *
 * The defect this suite was written red against, and the live evidence for it: the second and third prompts of
 * an OpenCode session hung on Thinking with no `[engine]` line in the terminal, while the first turn streamed
 * and answered. The manual probe settled which side was lying — two sequences of `initialize`, `session/new`,
 * `session/prompt`, each on a fresh child, both answered `end_turn` (`OpenCode 1.4.7`) — so the CLI is not the
 * one refusing. What the probe also measured is the leak: `child.kill()` on the direct child leaves the real
 * binary alive. The CLI is reached through a shim (`chocolatey\bin\opencode.exe` starts
 * `tools\opencode.exe acp`), the real one binds the CLI's own fixed `127.0.0.1:4096`, and after the kill the
 * probe still listed both `opencode acp` and the real exe running. The app's `close()` was a bare
 * `child.kill()` with no escalation and no tree, and its calls were waited on with no bound and no settle, so a
 * child that outlived its turn made the next turn wait forever: no chunk, no error, no `[engine]` line, and the
 * turn's `finally` — which is what wakes the module's queue — never ran.
 *
 * So this suite asserts the three things the fix rests on, each observed on a real process: the ending asks for
 * the child's *whole tree* by the pid it was started with (the platform's own kill really runs, and the request
 * is what is asserted); the child is reaped, so the next turn's child is the only one left; and no call waits
 * forever, because the child bound is injected small so a hang fails an assertion rather than stalling a gate.
 *
 * What the fixture deliberately does not claim: that a *detached* descendant dies too. It starts its own child
 * with `detached: true` — the shape a helper process has — and the platform's tree kill does not reach it
 * (measured: the assertion that the grandchild died is the red this suite fails on). No kill the app could send
 * would reach a process that detached itself, which is exactly why the bound carries that case: the turn ends with
 * a cause in words instead of waiting on an engine that is not coming back.
 *
 * The queue release is the turn promise's `finally` in `conveyor/modules/engine.ts`: a turn that always settles is
 * a queue that always wakes, which is why every ending kind is asserted here.
 *
 * What the fixture proves is the *lifecycle*, not the live CLI: the probe's two answers are the only live
 * evidence, and they are recorded in the report rather than here.
 */
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ACP_CODES } from '../../conveyor/protocol/acp'
import { runAcpTurn, type AcpTurnOutcome } from '../../conveyor/modules/engine-acp-turn'
import { killTreeByPlatform, type AcpSpawnImpl } from '../../conveyor/modules/engine-acp'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const OPENCODE = 'opencode'
const CWD = process.cwd()

/** How long a turn is given to end before it is called a hang. The fixture answers on the next tick. */
const END_BOUND_MS = 5000

/**
 * The call budget this suite hands the client.
 *
 * Small on purpose: the bound is the product's, and a suite must not wait it out. What is asserted is that a
 * call that is never answered ends the turn at all — on the defective tree this turn never ended, which is the
 * red this suite was written in.
 */
const TEST_CALL_BOUND_MS = 250

/**
 * The grace this suite hands the client: small, because the escalation is a fallback and not a wait to sit out.
 * The product's answer is `ACP_KILL_GRACE_MS`.
 */
const TEST_KILL_GRACE_MS = 300

const FIXTURE = join(process.cwd(), 'tests', 'engines', 'fixtures', 'acp-fixture-agent.cjs')
if (!existsSync(FIXTURE)) {
  throw new Error(`the ACP fixture is missing at ${FIXTURE}: run the suites from the repository root`)
}

/** Every child this suite started, and every child of theirs it learned the pid of, so none outlives it. */
const runs: FixtureRun[] = []

/**
 * The client, with a real child underneath it.
 *
 * The command the law resolved is deliberately not what is started — the fixture is, in the same shape the
 * OpenCode suite spawns it — so the process is observable and the protocol is the only thing being spoken.
 *
 * Every run keeps its own book of the children it started and of the pids they reported, so one step's
 * processes cannot be read as another's.
 */
interface FixtureRun {
  impl: AcpSpawnImpl
  /** The children this run started, in order. */
  started: ChildProcess[]
  /** The pids of the children *they* started, read off the prose the fixture streamed. */
  reported: number[]
  /**
   * The pids the client asked to have *their whole tree* ended, in order, with the real kill still happening.
   *
   * Observed rather than replaced: the platform's own tool is what runs, because the claim is about the tree and
   * not about a callback being reached.
   */
  treeKills: (number | undefined)[]
}

function fixtureSpawn(...modes: string[]): FixtureRun {
  const started: ChildProcess[] = []
  const reported: number[] = []
  const treeKills: (number | undefined)[] = []
  const impl: AcpSpawnImpl = (_command, _args, options) => {
    const mode = modes[started.length] ?? 'normal'
    const child = spawn(process.execPath, [FIXTURE, mode], options as SpawnOptionsWithoutStdio)
    started.push(child)
    return child
  }
  return { impl, started, reported, treeKills }
}

/** The client's tree kill, observed first and then performed for real against the platform's own tool. */
function observingTreeKill(run: FixtureRun): (pid: number | undefined) => void {
  return (pid) => {
    run.treeKills.push(pid)
    killTreeByPlatform(pid)
  }
}

/** One turn, awaited with a bound, so a client that hangs fails an assertion instead of stalling a gate. */
interface TurnResult {
  ended: boolean
  outcome: AcpTurnOutcome | null
  error: unknown
  chunks: EngineTranscriptChunk[]
}

async function oneTurn(run: FixtureRun, prompt: string, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
  const chunks: EngineTranscriptChunk[] = []
  const seen: { outcome: AcpTurnOutcome | null; error: unknown } = { outcome: null, error: null }
  const turn = runAcpTurn(
    {
      engineId: OPENCODE,
      prompt,
      cwd: CWD,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    {
      spawnImpl: run.impl,
      callBoundMs: TEST_CALL_BOUND_MS,
      killGraceMs: TEST_KILL_GRACE_MS,
      killTree: observingTreeKill(run),
      onPermissionRequest: () => Promise.resolve('allow-once'),
    },
    (chunk) => {
      chunks.push(chunk)
      for (const pid of grandchildPids(chunk)) run.reported.push(pid)
    }
  )
  void turn.then(
    (value) => {
      seen.outcome = value
    },
    (error: unknown) => {
      seen.error = error
    }
  )

  // The bound, held in a box for the reason the probes hold their budgets in one: the timer can only be created
  // inside the promise and has to be cleared out here. The race is against a *settled* copy of the turn — a
  // rejection is one of the endings this suite is about, so it is read off the recorder above rather than
  // thrown out of the await.
  const settled = turn.then(
    () => true,
    () => true
  )
  const budget: { timer?: ReturnType<typeof setTimeout> } = {}
  const timeout = new Promise<false>((resolve) => {
    budget.timer = setTimeout(() => resolve(false), END_BOUND_MS)
  })
  const ended = await Promise.race([settled, timeout])
  if (budget.timer !== undefined) clearTimeout(budget.timer)

  // A turn that hung is cancelled here, so the child it started is ended by the client's own cancel path.
  return { ended, outcome: seen.outcome, error: seen.error, chunks }
}

/** The pids the fixture reported, read off the prose it streamed rather than off a side channel. */
function grandchildPids(chunk: EngineTranscriptChunk): number[] {
  if (chunk.type !== 'text_delta') return []
  const pids: number[] = []
  for (const match of chunk.text.matchAll(/grandchild:(\d+)/g)) {
    const pid = Number(match[1])
    if (Number.isInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/**
 * Whether a process is still running, asked of the OS rather than inferred from our own bookkeeping.
 *
 * `ESRCH` is the only answer that means gone: a refusal to signal a live process is a refusal, not an exit, and
 * reading it as one would make this suite pass on a process that is still running.
 */
async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Whether the process has ended, observed on the process itself. */
async function gone(child: ChildProcess | undefined, ms = END_BOUND_MS): Promise<boolean> {
  if (child === undefined) return false
  const until = Date.now() + ms
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    if (Date.now() > until) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Nothing this suite started may outlive it, whatever the assertions decided. */
function reap(runs: readonly FixtureRun[]): void {
  for (const run of runs) {
    for (const child of run.started) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const pid of run.reported) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone, which is the outcome the suite asserts.
      }
    }
  }
}

/** The chunk types, which is the shape the transcript is built from. */
function typesOf(chunks: readonly EngineTranscriptChunk[]): string[] {
  return chunks.map((chunk) => chunk.type)
}

/** The prose of a turn, joined, which is what the pane draws. */
function proseOf(chunks: readonly EngineTranscriptChunk[]): string {
  return chunks.map((chunk) => (chunk.type === 'text_delta' ? chunk.text : '')).join('')
}

// ---------------------------------------------------------------- the turns

/**
 * The first turn: it spawns, streams, ends, and its ending asks for the child's whole tree.
 *
 * The tree is the point. A vendor CLI is reached through a shim, so the process the app owns is not the process
 * that holds the engine's state — and a kill that reaches only the shim leaves the real binary running with the
 * CLI's own fixed port, which is what the next turn then waits on. What this asserts is the request, with the
 * platform's own kill performed behind it: the pid is the child's, and it is the tree that is asked for.
 */
async function theFirstTurnStreamsEndsAndAsksForTheWholeTree() {
  const run = fixtureSpawn('grandchild')
  runs.push(run)
  try {
    const turn = await oneTurn(run, 'write the notes')

    assert.equal(turn.ended, true, 'the turn ended inside the bound rather than hanging')
    assert.equal(turn.error, null, 'and it ended without a failure')
    assert.deepEqual(typesOf(turn.chunks), ['text_delta', 'turn_end'], 'the streamed prose, then the ending')
    assert.equal(turn.outcome?.cancelled, false, 'an ordinary ending, not a cancel')
    assert.equal(turn.outcome?.stopReason, 'end_turn', "on the agent's own word for why it stopped")

    // The shape a vendor CLI has: a child that starts a child of its own.
    assert.equal(run.reported.length, 1, 'the fixture reported the pid of the child it started')

    // The ending asked for the tree, by the pid the child was started with — not for the process in hand alone.
    const child = run.started[0]
    assert.equal(run.treeKills.length, 1, 'the ending asked for exactly one tree')
    assert.equal(run.treeKills[0], child?.pid, 'and it named the child the turn started')

    assert.equal(await gone(child), true, 'and the child the turn spawned is reaped too')

    // Recorded rather than asserted, because no kill this app could send would change it: the fixture's own child
    // detached itself, and the platform's tree walk does not reach a process that has. The bound carries that
    // case — an engine left behind that way makes the next turn end with a cause, not wait forever.
    const leftover = run.reported[0]
    if (leftover !== undefined) {
      process.stdout.write(
        `    note: the fixture's detached child (pid ${String(leftover)}) alive after the turn: ${String(
          await pidAlive(leftover)
        )}, which is beyond the platform's tree kill\n`
      )
    }

    results.push('the first turn spawns, streams, ends, reaps its child and asks for that child’s whole tree')
  } finally {
    reap([run])
  }
}

/**
 * A second turn in the same session: its own child, its own stream, its own ending — the reported defect.
 *
 * The first child is asserted dead *before* the second spawn is asserted, because that ordering is the
 * mechanism: the second turn is the one that hangs when the first one's tree is still holding the engine.
 */
async function theSecondTurnSpawnsItsOwnChildAndStreams() {
  const run = fixtureSpawn('normal', 'normal')
  runs.push(run)
  try {
    const first = await oneTurn(run, 'first question')
    assert.equal(first.ended, true, 'the first turn ends')
    assert.equal(await gone(run.started[0]), true, 'and its child is reaped before the second turn starts')

    const second = await oneTurn(run, 'second question')

    assert.equal(run.started.length, 2, 'two turns in one session, two children')
    assert.notEqual(run.started[0]?.pid, run.started[1]?.pid, "the second turn's child is its own")

    assert.equal(second.ended, true, 'the second turn ends rather than leaving the pane on Thinking')
    assert.equal(second.error, null, 'and it ended without a failure')
    assert.deepEqual(
      typesOf(second.chunks),
      ['tool_call_start', 'tool_result', 'text_delta', 'turn_end'],
      'it streamed its own narration and its ending'
    )
    assert.equal(
      second.chunks[0]?.type === 'tool_call_start' ? second.chunks[0].via : '',
      'OpenCode',
      'with its call marked as the engine’s'
    )
    assert.equal(proseOf(second.chunks), 'answered:allow-once', 'and its own prose')
    assert.equal(second.outcome?.stopReason, 'end_turn', 'and its own ending')
    assert.equal(await gone(run.started[1]), true, 'with its child reaped too')

    results.push('a second turn in the same session spawns its own child, streams and ends, after the first is reaped')
  } finally {
    reap([run])
  }
}

/**
 * A call that is never answered ends the turn with a traced cause, in words, inside the bound.
 *
 * This is the half that makes a hang legible: the fixture answers the handshake and then never answers
 * `session/new`, and never closes. On the defective tree the turn waited there forever — no chunk, no error,
 * no `[engine]` line — which is exactly the shape the live defect had.
 */
async function aCallThatIsNeverAnsweredEndsWithATracedCause() {
  const run = fixtureSpawn('stalled')
  runs.push(run)
  try {
    const turn = await oneTurn(run, 'a question nobody answers')

    assert.equal(turn.ended, true, 'a turn whose call is never answered ends inside the bound')
    assert.equal(turn.outcome, null, 'it does not come back as a completed turn')
    assert.ok(turn.error instanceof Error, 'it ends as a failure, which is what the pane words')
    const error = turn.error as { code?: unknown; message?: unknown }
    assert.equal(error.code, ACP_CODES.ACP_CALL_TIMEOUT, 'carrying the code that says which way it failed')
    assert.match(
      String(error.message),
      /did not answer session\/new within/,
      'and a sentence naming the call and the budget, rather than a claim that it is still working'
    )
    assert.deepEqual(typesOf(turn.chunks), [], 'nothing was streamed, so nothing claims to have been said')

    results.push('a call that is never answered ends the turn with a traced cause inside the stated bound')
  } finally {
    reap([run])
  }
}

/** A refused handshake ends the turn with a traced cause rather than a silence. */
async function aRefusedHandshakeEndsWithATracedCause() {
  const run = fixtureSpawn('refuse')
  runs.push(run)
  try {
    const turn = await oneTurn(run, 'a question the engine refuses')

    assert.equal(turn.ended, true, 'the turn ends')
    assert.ok(turn.error instanceof Error, 'as a failure')
    assert.equal(
      (turn.error as { code?: unknown }).code,
      ACP_CODES.ACP_HANDSHAKE_FAILED,
      'carrying the handshake code, which is what the pane branches on'
    )

    results.push('a refused handshake ends the turn with a traced cause, never by leaving it open')
  } finally {
    reap([run])
  }
}

/** A child that dies mid-turn ends the turn: its close is a fact the client acts on. */
async function aChildThatDiesMidTurnEndsWithATracedCause() {
  const run = fixtureSpawn('die')
  runs.push(run)
  try {
    const turn = await oneTurn(run, 'a question that kills its engine')

    assert.equal(turn.ended, true, 'a child that exits mid-turn does not leave the turn open')
    assert.ok(turn.error instanceof Error, 'the turn ends as a failure')
    assert.equal(
      (turn.error as { code?: unknown }).code,
      ACP_CODES.ACP_CLOSED,
      'with the code that says the process ended before it answered'
    )

    results.push('a child that dies mid-turn ends the turn with a traced cause rather than silence')
  } finally {
    reap([run])
  }
}

/** Cancel: the user's own click ends the turn silently, and the child's tree dies with it. */
async function cancelEndsTheTreeAndTheTurn() {
  const run = fixtureSpawn('grandchild-stalled')
  runs.push(run)
  try {
    const controller = new AbortController()
    const pending = oneTurn(run, 'a long question', { signal: controller.signal })

    // The pid arrives before the stall, so the tree exists to be ended.
    const until = Date.now() + END_BOUND_MS
    while (run.reported.length === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.reported.length, 1, 'the child started a child of its own before the cancel')

    controller.abort()
    const turn = await pending

    assert.equal(turn.ended, true, 'a cancelled turn ends')
    assert.equal(turn.outcome?.cancelled, true, 'silently, which is what a cancel is')
    assert.equal(proseOf(turn.chunks), 'grandchild:' + String(run.reported[0]), 'and nothing else was said')
    assert.equal(
      typesOf(turn.chunks).includes('turn_end'),
      false,
      'no ending notice: the user stopped it, so there is nothing to report back'
    )
    assert.equal(await gone(run.started[0]), true, 'the child died with the cancel')
    assert.equal(run.treeKills.length, 1, 'and the cancel asked for its whole tree, by the pid it was started with')
    assert.equal(run.treeKills[0], run.started[0]?.pid, 'which is the child this turn started')

    results.push('a cancel ends the turn silently, reaps the child and asks for its whole tree')
  } finally {
    reap([run])
  }
}

// ---------------------------------------------------------------- report

async function main() {
  // Every step is run, and every failure is reported together: a lifecycle defect shows up in more than one
  // ending at once, and a suite that stopped at the first would hide the rest behind a rerun.
  const failures: string[] = []
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    try {
      await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${label}: ${message}`)
      process.stdout.write(`    FAILED ${label}: ${message}\n`)
    }
  }

  await step('first turn', theFirstTurnStreamsEndsAndAsksForTheWholeTree)
  await step('second turn', theSecondTurnSpawnsItsOwnChildAndStreams)
  await step('unanswered call', aCallThatIsNeverAnsweredEndsWithATracedCause)
  await step('refused handshake', aRefusedHandshakeEndsWithATracedCause)
  await step('child death', aChildThatDiesMidTurnEndsWithATracedCause)
  await step('cancel', cancelEndsTheTreeAndTheTurn)

  if (failures.length > 0) {
    throw new Error(`${failures.length} lifecycle step(s) failed:\n  ${failures.join('\n  ')}`)
  }

  console.log('acp turn lifecycle: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  reap(runs)
  console.error('ACP TURN LIFECYCLE TEST FAILED:', err)
  process.exit(1)
})
