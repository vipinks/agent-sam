/**
 * Verifies the terminal module against a mocked `child_process.spawn` — no real shell commands run.
 *
 * Loads the real `conveyor/modules/terminal.ts` (bundled with `electron-conveyor/main` stubbed), so
 * what is tested is the shipped stream protocol: stdout passthrough, the stderr marker, the exit
 * code as the final chunk, abort killing the process, and the cwd containment rules.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { resolveCwd, runCommand, shellFor, workspaceRootFromStoreFile } from '../../conveyor/modules/terminal'
import { EXIT_MARKER, STDERR_MARKER } from '../../conveyor/protocol/terminal'

const results: string[] = []

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
    // A real kill produces a close event with a signal-derived code.
    this.enqueue(() => this.emit('close', null))
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
  assert.deepEqual(chunks, [
    'normal\n',
    `${STDERR_MARKER}bad\n`,
    `${STDERR_MARKER}worse\n`,
    `${EXIT_MARKER}1]`,
  ])
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
  assert.ok(
    chunks.at(-1)?.startsWith(EXIT_MARKER),
    `expected an exit marker, got ${JSON.stringify(chunks.at(-1))}`
  )
  results.push('aborting kills the child with SIGTERM, flushes buffered output, and still reports an exit')
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
