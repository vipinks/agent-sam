/**
 * The Codex child's lifecycle: one turn, one child, and that child's ending observed by the turn that owns it.
 *
 * This suite exists because the launch-config suite could not see the defect it is about. That suite hands the
 * client a *scripted* child — an object with a `stdout.on` and a `kill` — which answers when the case tells it
 * to and therefore behaves the same whatever the client hands it at spawn. A real `codex exec` is not like
 * that: with the prompt given as an argument and stdin a pipe, it appends stdin to the prompt and waits for
 * that pipe to end before printing anything. Measured against `codex-cli 0.160.1` on the machine this ran on:
 *
 *   - stdin a pipe, never ended: `Reading additional input from stdin...` on stderr, then *zero* events in 45
 *     seconds, the process still alive at 0 percent CPU;
 *   - stdin closed at spawn: `thread.started` at 1.2s, `turn.completed` at 10.2s, exit 0 at 12.4s.
 *
 * So the child this suite spawns is a real process (the fixture beside the capture), and it waits for its stdin
 * to end before it speaks, exactly as the CLI does. What is asserted, in order:
 *
 *   1. the client closes the child's stdin at spawn, so there is nothing for `codex exec` to wait on;
 *   2. the first turn streams, ends, and its child is reaped — the exit is observed, not merely hoped for;
 *   3. a second turn spawns its own child, streams from that child, and reaps it, leaving the first turn's
 *      child untouched;
 *   4. a child that exits without saying anything still ends its turn, with the cause the exit code implies,
 *      so a silent death can never leave the pane thinking;
 *   5. cancel kills the child — the signal is on the process, not on a stub — and ends the turn silently.
 *
 * What this proves is the lifecycle and the pipe semantics, not the live CLI: the fixture replays the captured
 * vocabulary, and the acceptance for the real thing is a person watching the installed binary — a second turn
 * streaming in one session, Stop killing the child, and no `codex.exe` left in Task Manager afterwards.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import {
  runCodexTurn,
  type CodexChild,
  type CodexSpawnImpl,
  type CodexTurnOutcome,
} from '../../conveyor/modules/engine-codex'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const CODEX = 'codex'
const FIXTURE = join(process.cwd(), 'tests', 'engines', 'fixtures', 'codex-exec-stdin-child.cjs')
const CWD = process.cwd()

/** How long a turn is given to end before it is called a hang. The fixture answers on the next tick of EOF. */
const END_BOUND_MS = 4000

/**
 * The client, with a real child underneath it.
 *
 * The binary the law resolved is deliberately not what is started: what this suite is about is the *pipe* the
 * client asks for, so the options the client hands the spawn are passed through verbatim and the process is the
 * fixture. A client that asks for a pipe therefore really gets one, and really hangs on it.
 */
interface FixtureRun {
  impl: CodexSpawnImpl
  /** The options of each spawn, in order, so the law about stdin is assertable. */
  options: Record<string, unknown>[]
  /** The process of each spawn, in order, so its ending is observable rather than inferred. */
  processes: ChildProcess[]
}

function fixtureSpawn(...modes: string[]): FixtureRun {
  const options: Record<string, unknown>[] = []
  const processes: ChildProcess[] = []

  const impl: CodexSpawnImpl = (_command, _args, spawnOptions) => {
    const mode = modes[options.length] ?? 'reply'
    options.push(spawnOptions as unknown as Record<string, unknown>)
    const child = spawn(process.execPath, [FIXTURE, mode], {
      shell: spawnOptions.shell,
      windowsHide: spawnOptions.windowsHide,
      ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
      // Absent stays absent: the point of a real child is that the default really is a pipe.
      ...(spawnOptions.stdio === undefined ? {} : { stdio: spawnOptions.stdio as StdioOptions }),
    })
    processes.push(child)
    return child as unknown as CodexChild
  }

  return { impl, options, processes }
}

/** One turn, awaited with a bound, so a client that hangs fails an assertion instead of stalling a gate. */
interface TurnResult {
  ended: boolean
  outcome: CodexTurnOutcome | null
  chunks: EngineTranscriptChunk[]
}

async function oneTurn(run: FixtureRun, prompt: string): Promise<TurnResult> {
  const chunks: EngineTranscriptChunk[] = []
  const controller = new AbortController()
  const seen: { outcome: CodexTurnOutcome | null } = { outcome: null }
  const turn = runCodexTurn(
    { engineId: CODEX, prompt, cwd: CWD, signal: controller.signal },
    { spawnImpl: run.impl },
    (chunk) => chunks.push(chunk)
  )
  void turn.then((value) => {
    seen.outcome = value
  })

  // The bound, held in a box for the reason the probe holds its own budget in one: the timer can only be
  // created inside the promise, and it has to be cleared out here.
  const budget: { timer?: ReturnType<typeof setTimeout> } = {}
  const timeout = new Promise<null>((resolve) => {
    budget.timer = setTimeout(() => resolve(null), END_BOUND_MS)
  })
  const ended = (await Promise.race([turn, timeout])) !== null
  if (budget.timer !== undefined) clearTimeout(budget.timer)

  // Whatever happened, this turn owns nothing that outlives it: a turn that hung is aborted here, and the
  // child behind it is killed by the client's own cancel path rather than by anything this suite does.
  if (!ended) controller.abort()
  return { ended, outcome: seen.outcome, chunks }
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
    for (const child of run.processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

/** The chunk types, which is the shape the transcript is built from. */
function typesOf(chunks: readonly EngineTranscriptChunk[]): string[] {
  return chunks.map((chunk) => chunk.type)
}

// ---------------------------------------------------------------- the turns

/** The first turn in a session: it spawns, streams, ends, and its child is reaped. */
async function theFirstTurnStreamsEndsAndReapsItsChild() {
  const run = fixtureSpawn('reply')
  try {
    const turn = await oneTurn(run, 'say pong')

    // The defect first, because this is what the pane shows: a child that waits on a stdin nobody closes says
    // nothing and never exits, so the turn never ends and Thinking stays on screen.
    assert.equal(turn.ended, true, 'the turn ended inside the bound rather than hanging')
    assert.deepEqual(typesOf(turn.chunks), ['text_delta', 'usage', 'turn_end'], 'the reply became the transcript')
    assert.equal(turn.chunks[0]?.type === 'text_delta' ? turn.chunks[0].text : '', 'pong')
    assert.equal(turn.outcome?.exitCode, 0, 'on the exit code the child ended on')
    assert.equal(turn.outcome?.cause, 'model_stop', 'which is the ordinary ending')

    // And its cause, which is the whole of the fix: the prompt travels as an argument, so the child must have
    // nothing on stdin to wait for.
    assert.equal(
      (run.options[0]?.stdio as StdioOptions | undefined)?.[0],
      'ignore',
      'the child is spawned with stdin closed, not a pipe'
    )
    assert.equal(run.options[0]?.shell, false, 'and still without a shell')

    const child = run.processes[0]
    assert.equal(await gone(child), true, 'and the child is reaped: its own exit was observed')
    assert.equal(child?.exitCode, 0, 'with the code it exited on, read off the process')
    assert.equal(child?.signalCode, null, 'not a signal: nothing had to kill it')

    results.push('the first turn spawns a child with stdin closed, streams, ends and reaps it')
  } finally {
    reap([run])
  }
}

/** A second turn in the same session: its own child, its own stdout, its own ending. */
async function theSecondTurnSpawnsItsOwnChild() {
  const run = fixtureSpawn('reply', 'reply')
  try {
    const first = await oneTurn(run, 'first question')
    assert.equal(first.ended, true, 'the first turn ends')
    assert.equal(await gone(run.processes[0]), true, 'and its child is reaped before the second turn starts')

    const second = await oneTurn(run, 'second question')

    assert.equal(run.processes.length, 2, 'two turns in one session, two children')
    assert.notEqual(run.processes[0]?.pid, run.processes[1]?.pid, "the second turn's child is its own")
    assert.equal(
      (run.options[1]?.stdio as StdioOptions | undefined)?.[0],
      'ignore',
      'spawned with stdin closed like the first'
    )

    assert.equal(second.ended, true, 'the second turn ends rather than hanging on thinking')
    assert.deepEqual(typesOf(second.chunks), ['text_delta', 'usage', 'turn_end'], 'and it read its own child')
    assert.equal(second.chunks[0]?.type === 'text_delta' ? second.chunks[0].text : '', 'pong')
    assert.equal(second.outcome?.cause, 'model_stop')
    assert.equal(await gone(run.processes[1]), true, 'with its child reaped too')

    results.push('a second turn in the same session spawns, streams, ends and reaps its own child')
  } finally {
    reap([run])
  }
}

/** A child that dies without a word still ends its turn, with the cause its exit code implies. */
async function aSilentChildEndsItsTurnWithATracedCause() {
  const ok = fixtureSpawn('silent-ok')
  const failed = fixtureSpawn('silent-fail')
  try {
    const clean = await oneTurn(ok, 'a question nobody answered')
    assert.equal(clean.ended, true, 'a child that exits with nothing said does not leave the turn thinking')
    assert.deepEqual(typesOf(clean.chunks), ['turn_end'], 'the ending is the whole of what it streams')
    assert.equal(clean.outcome?.exitCode, 0, 'read off the child')
    assert.equal(clean.outcome?.cause, 'empty_stop', 'and a clean exit with no answer is said out loud')

    const broken = await oneTurn(failed, 'a question that broke')
    assert.equal(broken.ended, true, 'a child that fails does not leave the turn thinking either')
    assert.deepEqual(typesOf(broken.chunks), ['turn_end'])
    assert.equal(broken.outcome?.exitCode, 3)
    assert.equal(broken.outcome?.cause, 'stream_error', 'which is a stream that stopped mid-sentence')
    assert.equal(
      broken.chunks[0]?.type === 'turn_end' ? broken.chunks[0].cause : '',
      'stream_error',
      'and the transcript is told the same thing the outcome is'
    )

    results.push('a child that exits in silence ends its turn with a traced cause, never by leaving it open')
  } finally {
    reap([ok, failed])
  }
}

/** Cancel: the signal lands on the process, and the turn ends without a notice for the user's own click. */
async function cancelKillsTheChildAndEndsTheTurn() {
  const run = fixtureSpawn('block')
  try {
    const chunks: EngineTranscriptChunk[] = []
    const controller = new AbortController()
    const turn = runCodexTurn(
      { engineId: CODEX, prompt: 'a long job', cwd: CWD, signal: controller.signal },
      { spawnImpl: run.impl },
      (chunk) => chunks.push(chunk)
    )

    const child = run.processes[0]
    assert.ok(child !== undefined, 'the turn spawned a child')
    assert.equal(await gone(child, 400), false, 'which is still running when the user stops the turn')

    controller.abort()
    const outcome = await turn

    assert.equal(outcome.cancelled, true, 'the turn reports that the user stopped it')
    // Nothing an answer is made of, which is what the user would read: the killed child's own exit does
    // reach the sink a moment later, and the caller's loop is already gone by then — the generator returns on
    // the abort — so asserting an empty sink would be asserting a race rather than a behavior.
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type !== 'turn_end'),
      [],
      'and draws nothing: the ending is the user own'
    )
    assert.equal(await gone(child), true, 'the child died with the cancel')
    assert.equal(child?.signalCode, 'SIGTERM', 'on the signal the spawn layer escalates from')

    results.push('cancel kills the running child and ends the turn without a notice')
  } finally {
    reap([run])
  }
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('first turn', theFirstTurnStreamsEndsAndReapsItsChild)
  await step('second turn', theSecondTurnSpawnsItsOwnChild)
  await step('silent child', aSilentChildEndsItsTurnWithATracedCause)
  await step('cancel', cancelKillsTheChildAndEndsTheTurn)

  console.log('codex child lifecycle: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('CODEX CHILD LIFECYCLE TEST FAILED:', err)
  process.exit(1)
})
