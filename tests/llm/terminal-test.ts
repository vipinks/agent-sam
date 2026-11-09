/**
 * Verifies the terminal module against a mocked `child_process.spawn` — no real shell commands run.
 *
 * Loads the real `conveyor/modules/terminal.ts` (bundled with `electron-conveyor/main` stubbed), so
 * what is tested is the shipped stream protocol: stdout passthrough, the stderr marker, the exit
 * code as the final chunk, abort killing the process, and the cwd containment rules.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import {
  killTreeByPlatform,
  resolveCwd,
  runCommand,
  shellFor,
  WEDGE_GUARD_MS,
  workspaceRootFromStoreFile,
} from '../../conveyor/modules/terminal'
import { EXIT_MARKER, STDERR_MARKER } from '../../conveyor/protocol/terminal'

const results: string[] = []

/** Let the real clocks and timers in the module move; the wedge's guarantee is about wall-clock. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Hold the event loop open while a run is expected to settle.
 *
 * The deadline timer inside `runCommand` is deliberately unref'd — a timed command must not be the
 * reason the app stays alive — and the fake child owns no real handle, so a suite parked before its
 * deadline would let the process exit before the deadline fired. The hold is the suite's handle on the
 * loop, not the module's; without it the later cases in this file never run at all.
 */
function holdLoop(ms: number): () => void {
  const timer = setTimeout(() => undefined, ms)
  return () => clearTimeout(timer)
}

// ---------------------------------------------------------------- a fake child process

/**
 * Stands in for a spawned ChildProcess.
 *
 * Output is queued and flushed on a macrotask rather than emitted synchronously. That matters: the
 * module's stream generator attaches its listeners on a microtask (the first `next()`), so a
 * synchronous emit would fire into the void and the generator would then wait forever. A real pipe
 * buffers, and this reproduces that instead of hiding the race.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  killSignals: string[] = []
  spawnArgs: { command: string; options: Record<string, unknown> } | null = null
  /** The pid a tree-kill would be asked for; a real process always has one. */
  pid = 4242
  /**
   * Whether the child ignores a stop.
   *
   * A real process can, and a grandchild holding the inherited pipes can keep `close` from ever
   * arriving even after its parent is gone. That is the shape the wedge guard exists for, so the double
   * has to be able to produce it.
   */
  ignoreKill = false

  private queued: Array<() => void> = []
  private drainScheduled = false

  /** Queue an event, then deliver queued events in order on the next macrotask. */
  private enqueue(fn: () => void) {
    this.queued.push(fn)
    if (this.drainScheduled) return
    this.drainScheduled = true
    setImmediate(() => {
      this.drainScheduled = false
      const batch = this.queued
      this.queued = []
      for (const deliver of batch) deliver()
    })
  }

  kill(signal?: string) {
    this.killed = true
    this.killSignals.push(signal ?? 'SIGTERM')
    // A real kill produces a close event with a signal-derived code — unless the process ignores it.
    if (!this.ignoreKill) this.enqueue(() => this.emit('close', null))
    return true
  }

  /** Emit stdout as it would arrive off a pipe. */
  out(text: string) {
    this.enqueue(() => this.stdout.emit('data', Buffer.from(text)))
  }

  err(text: string) {
    this.enqueue(() => this.stderr.emit('data', Buffer.from(text)))
  }

  close(code: number | null) {
    // Also queued, not emitted synchronously: Node guarantees `close` arrives after both pipes are
    // drained, so a fake that closes early would strand buffered output — a bug in the double, not
    // in the module.
    this.enqueue(() => this.emit('close', code))
  }
}

function spawnDouble(child: FakeChild) {
  const spawnImpl = ((command: string, options: Record<string, unknown>) => {
    child.spawnArgs = { command, options }
    return child
  }) as never
  return spawnImpl
}

async function collect(iter: AsyncGenerator<string, void, undefined>) {
  const out: string[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

// ---------------------------------------------------------------- shell selection

function shellSelection() {
  assert.equal(shellFor('win32'), 'powershell.exe')
  assert.equal(shellFor('linux'), '/bin/bash')
  assert.equal(shellFor('darwin'), '/bin/bash')
  results.push('shell follows the platform')
}

// ---------------------------------------------------------------- the stream protocol

async function stdoutAndExit() {
  const child = new FakeChild()
  const controller = new AbortController()

  const promise = collect(
    runCommand({
      command: 'echo hi',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )

  // Nothing has been emitted yet, so the generator must still be waiting rather than finishing.
  child.out('hello ')
  child.out('world\n')
  child.close(0)

  const chunks = await promise
  assert.deepEqual(chunks, ['hello ', 'world\n', `${EXIT_MARKER}0]`], `got ${JSON.stringify(chunks)}`)

  // The command is handed to the shell as a whole string with the shell and cwd set.
  assert.equal(child.spawnArgs?.command, 'echo hi')
  assert.equal(child.spawnArgs?.options.shell, '/bin/bash')
  assert.equal(child.spawnArgs?.options.cwd, process.cwd())

  results.push('stdout passes through and the exit code is the last chunk')
}

async function stderrIsMarked() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'x',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )

  child.out('normal\n')
  child.err('bad\n')
  child.err('worse\n')
  child.close(1)

  const chunks = await promise
  assert.deepEqual(chunks, ['normal\n', `${STDERR_MARKER}bad\n`, `${STDERR_MARKER}worse\n`, `${EXIT_MARKER}1]`])
  // The marker is a prefix, so the payload after it is the untouched stderr text.
  assert.equal(chunks[1].slice(STDERR_MARKER.length), 'bad\n')
  assert.equal(chunks[3], `${EXIT_MARKER}1]`)

  results.push('stderr is prefixed with the marker, code reported on exit')
}

async function interleavingIsPreserved() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'x',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )

  // A build tool that warns on stderr between stdout lines: order must survive, which is why both
  // streams share one queue.
  child.out('one\n')
  child.err('warn\n')
  child.out('two\n')
  child.close(0)

  const chunks = await promise
  assert.deepEqual(chunks, ['one\n', `${STDERR_MARKER}warn\n`, 'two\n', `${EXIT_MARKER}0]`])
  results.push('stdout and stderr keep their relative order')
}

async function nonZeroExit() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'false',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )
  child.close(130)
  const chunks = await promise
  assert.equal(chunks.at(-1), `${EXIT_MARKER}130]`, 'a signal-ish code must survive')
  results.push('a non-zero exit code is reported')
}

async function outputAfterCloseIsFlushed() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'x',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )
  // Data arriving in the same tick as close must not be dropped.
  child.out('tail\n')
  child.close(0)
  const chunks = await promise
  assert.deepEqual(chunks, ['tail\n', `${EXIT_MARKER}0]`])
  results.push('output emitted alongside close is flushed before the exit code')
}

// ---------------------------------------------------------------- cancellation

async function abortKillsTheChild() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'sleep 100',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )

  child.out('starting\n')
  controller.abort()

  // The await settling at all is the assertion: before the abort learned to wake the read loop,
  // this hung forever and node exited silently with no output. The kill alone was not enough.
  const chunks = await promise
  assert.equal(child.killed, true, 'abort must kill the process')
  assert.deepEqual(child.killSignals, ['SIGTERM'], 'the kill signal should be SIGTERM')
  // Output emitted before the abort is still delivered, rather than dropped on cancellation.
  assert.ok(chunks.includes('starting\n'), `expected the buffered output, got ${JSON.stringify(chunks)}`)
  assert.ok(chunks.at(-1)?.startsWith(EXIT_MARKER), `expected an exit marker, got ${JSON.stringify(chunks.at(-1))}`)
  results.push('aborting kills the child with SIGTERM, flushes buffered output, and still reports an exit')
}

async function deadlineKillsTheChild() {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'sleep 100',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      timeoutMs: 20,
      spawnImpl: spawnDouble(child),
    })
  )

  child.out('started\n')

  // The deadline ends the process the same way an abort does, but it is not a cancellation: the
  // caller has to be able to tell the model the tool failed because it ran too long.
  const release = holdLoop(2000)
  try {
    await assert.rejects(promise, (e: { code?: string }) => e.code === 'COMMAND_TIMED_OUT')
  } finally {
    release()
  }
  assert.equal(child.killed, true, 'the deadline must kill the process')
  assert.deepEqual(child.killSignals, ['SIGTERM'], 'the deadline kills with SIGTERM before escalating')
  results.push('a command that outlives its deadline is killed and reported as COMMAND_TIMED_OUT')
}

/**
 * The wedge guard: a deadline's failure is this process's to state, not the child's to allow.
 *
 * A child that ignores SIGTERM — and, in the reported case, a grandchild that inherited the pipes —
 * never emits `close`, so a run that waited on it would wait forever. The guard escalates once and
 * then settles the run anyway, which is the only way the coded failure is unconditional.
 */
async function theDeadlineSettlesWithoutClose() {
  const child = new FakeChild()
  child.ignoreKill = true
  const controller = new AbortController()
  const outcome: { code?: string } = {}
  const promise = collect(
    runCommand({
      command: 'sleep 100',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      timeoutMs: 20,
      spawnImpl: spawnDouble(child),
    })
  )
  // Attached rather than awaited: a promise that never settles must fail this assertion instead of
  // hanging the suite, so the observation window is the guard's own contract plus a margin.
  promise.catch((err: { code?: string }) => {
    outcome.code = err.code
  })
  child.out('started\n')

  await wait(WEDGE_GUARD_MS + 300)

  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'], 'the guard escalates to SIGKILL')
  assert.equal(outcome.code, 'COMMAND_TIMED_OUT', 'and fails the run even though close never arrives')
  results.push('a deadline escalates and settles as COMMAND_TIMED_OUT with no close from the child')
}

/**
 * On Windows the direct child is a shell, so a stop has to name the tree.
 *
 * Asserted at the seam the run uses: the pid handed to the tree-kill is the spawned process's, and the
 * run still ends as the timeout it was rather than merely ending.
 */
async function theDeadlineKillsTheTreeOnWindows() {
  const child = new FakeChild()
  const treeKills: Array<number | undefined> = []
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'sleep 100',
      cwd: process.cwd(),
      platform: 'win32',
      signal: controller.signal,
      timeoutMs: 20,
      spawnImpl: spawnDouble(child),
      killTreeImpl: (pid) => {
        treeKills.push(pid)
        // What a real `taskkill /T /F` produces: the shell and its children end, and close arrives.
        child.close(null)
      },
    })
  )

  // The deadline timer is unref'd in the product, so the suite holds the loop for it.
  const release = holdLoop(2000)
  try {
    await assert.rejects(promise, (e: { code?: string }) => e.code === 'COMMAND_TIMED_OUT')
  } finally {
    release()
  }
  assert.deepEqual(treeKills, [child.pid], 'win32 asks for the spawned tree, not just the shell')
  results.push('a deadline on win32 kills the spawned tree by pid')
}

async function abortKillsTheTreeOnWindows() {
  const child = new FakeChild()
  const treeKills: Array<number | undefined> = []
  const controller = new AbortController()
  const promise = collect(
    runCommand({
      command: 'sleep 100',
      cwd: process.cwd(),
      platform: 'win32',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
      killTreeImpl: (pid) => {
        treeKills.push(pid)
        child.close(null)
      },
    })
  )

  // Stop arrives while the command is in flight, as the button does — not before the run has spawned.
  child.out('starting\n')
  await wait(50)
  controller.abort()
  await promise
  assert.deepEqual(treeKills, [child.pid], 'Stop on win32 asks for the tree too')
  results.push('Stop on win32 kills the spawned tree by pid')
}

/**
 * The tree-kill request itself, read off the spawner it would use.
 *
 * No real taskkill runs: what is being proved is the request's shape — the platform tool, an argument
 * array, and never a shell — against an emitter that stands in for the spawned killer.
 */
function treeKillUsesTaskkill() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
  const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    const tree = new EventEmitter() as EventEmitter & { unref?: () => void }
    tree.unref = () => undefined
    return tree
  }) as never

  killTreeByPlatform(4242, 'win32', fakeSpawn)
  assert.deepEqual(
    calls,
    [
      {
        command: 'taskkill',
        args: ['/pid', '4242', '/T', '/F'],
        options: { stdio: 'ignore', shell: false, windowsHide: true },
      },
    ],
    'win32 ends the tree with the platform tool, as an argument array and never a shell'
  )

  killTreeByPlatform(4242, 'linux', fakeSpawn)
  killTreeByPlatform(undefined, 'win32', fakeSpawn)
  assert.equal(calls.length, 1, 'elsewhere, and without a pid, there is nothing to ask for')
  results.push('win32 tree-kill is taskkill /pid <pid> /T /F, never a shell')
}

async function abortBeforeStart() {
  const child = new FakeChild()
  const controller = new AbortController()
  controller.abort()
  const chunks = await collect(
    runCommand({
      command: 'x',
      cwd: process.cwd(),
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: spawnDouble(child),
    })
  )
  assert.deepEqual(chunks, [], 'an already-aborted signal should spawn nothing')
  assert.equal(child.spawnArgs, null, 'spawn must not be called')
  results.push('an already-aborted signal never spawns')
}

async function abandoningTheStreamKillsTheChild() {
  const child = new FakeChild()
  const controller = new AbortController()
  const iterator = runCommand({
    command: 'x',
    cwd: process.cwd(),
    platform: 'linux',
    signal: controller.signal,
    spawnImpl: spawnDouble(child),
  })

  // Walk one step so the generator is attached and parked, then cancel the way the UI does: the
  // Stop button aborts, which kills the process and ends the stream promptly. This is the path that
  // matters, because a parked `await` cannot be interrupted by abandoning the iterator alone.
  const first = iterator.next()
  controller.abort()
  // Awaited to let the abort settle before asserting; the value itself is not needed.
  await first
  assert.equal(child.killed, true, 'aborting must kill the process')
  assert.deepEqual(child.killSignals, ['SIGTERM'], 'the process should be terminated, not abandoned')

  // The generator resumes and finishes once the child closes.
  child.close(null)
  const after = await iterator.next()
  assert.equal(after.done, true, 'an aborted run should end the stream')

  results.push('aborting kills the process, and the stream ends once it closes')
}

// ---------------------------------------------------------------- spawn failure

async function spawnFailureIsTyped() {
  const child = new FakeChild()
  const controller = new AbortController()
  const iterator = runCommand({
    command: 'x',
    cwd: process.cwd(),
    platform: 'linux',
    signal: controller.signal,
    spawnImpl: spawnDouble(child),
  })
  const promise = collect(iterator)
  child.emit('error', new Error('ENOENT: shell not found'))

  await assert.rejects(promise, (e: { code?: string }) => e.code === 'SPAWN_FAILED')
  results.push('a spawn failure surfaces as SPAWN_FAILED')
}

// ---------------------------------------------------------------- cwd containment

function cwdContainment() {
  const root = process.cwd()
  const nested = resolveCwd(root, root)
  assert.equal(nested, root, 'the workspace root is allowed')

  // A subdirectory is allowed.
  const sub = resolveCwd(`${root}`, root)
  assert.equal(sub, root)

  // Outside the workspace is refused.
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/tmp'
  assert.throws(
    () => resolveCwd(outside, root),
    (e: { code?: string }) => e.code === 'CWD_OUTSIDE_WORKSPACE',
    'a directory outside the workspace must be refused'
  )

  // A sibling whose name merely starts with the root's name must not slip through the prefix check.
  assert.throws(
    () => resolveCwd(`${root}-elsewhere`, root),
    (e: { code?: string }) => e.code === 'CWD_OUTSIDE_WORKSPACE' || e.code === 'CWD_NOT_FOUND'
  )

  // A missing directory is reported as such.
  assert.throws(
    () => resolveCwd(`${root}-does-not-exist-12345`, root),
    (e: { code?: string }) => e.code === 'CWD_NOT_FOUND'
  )

  // An empty cwd is a distinct failure.
  assert.throws(
    () => resolveCwd('   ', root),
    (e: { code?: string }) => e.code === 'CWD_REQUIRED'
  )

  // With no workspace open, containment cannot be checked, so any existing directory is allowed.
  assert.equal(resolveCwd(root, null), root)

  results.push('cwd is confined to the workspace, with distinct codes per failure')
}

function storeFileFallback() {
  // A userData dir with no store file means no folder is open — not a crash.
  assert.equal(workspaceRootFromStoreFile(`${process.cwd()}-no-such-dir`), null)
  results.push('a missing workspace store file means no folder open')
}

// ---------------------------------------------------------------- report

async function main() {
  // Each step is announced before it runs: if one hangs, the last line printed names it rather
  // than leaving a silent exit with no clue which case stalled.
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('shell selection', shellSelection)
  await step('stdout + exit code', stdoutAndExit)
  await step('stderr marker', stderrIsMarked)
  await step('interleaving', interleavingIsPreserved)
  await step('non-zero exit', nonZeroExit)
  await step('output flushed after close', outputAfterCloseIsFlushed)
  await step('abort kills the child', abortKillsTheChild)
  await step('deadline kills the child', deadlineKillsTheChild)
  await step('deadline settles without close', theDeadlineSettlesWithoutClose)
  await step('deadline kills the tree on win32', theDeadlineKillsTheTreeOnWindows)
  await step('abort kills the tree on win32', abortKillsTheTreeOnWindows)
  await step('tree-kill uses taskkill', treeKillUsesTaskkill)
  await step('abort before start', abortBeforeStart)
  await step('abort ends the stream and kills the child', abandoningTheStreamKillsTheChild)
  await step('spawn failure is typed', spawnFailureIsTyped)
  await step('cwd containment', cwdContainment)
  await step('store file fallback', storeFileFallback)

  console.log('terminal module: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('TERMINAL TEST FAILED:', err)
  process.exit(1)
})
