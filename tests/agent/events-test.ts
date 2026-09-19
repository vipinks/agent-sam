/**
 * Verifies the workspace-change notifications coming out of main — no Electron, no real shell.
 *
 * The sink is a fake window collector, so what is asserted is exactly what a window would receive.
 * The procedure records are invoked the way the router invokes them, so the tested path is the
 * shipped handler body rather than a copy of it.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyWorkspaceChanged, setWorkspaceChangeSink, type WorkspaceChanged } from '../../conveyor/events'
import { workspaceModule } from '../../conveyor/modules/workspace'
import { runCommand, terminalModule } from '../../conveyor/modules/terminal'
import { executeTool } from '../../conveyor/modules/agent'

const results: string[] = []

/** Collect everything main would push to the windows. */
class Sink {
  received: WorkspaceChanged[] = []

  install() {
    setWorkspaceChangeSink((payload) => this.received.push(payload))
  }

  get written() {
    return this.received.filter((e) => e.kind === 'written')
  }

  get exited() {
    return this.received.filter((e) => e.kind === 'command-exited')
  }
}

/** A fake child process whose output is queued, so it behaves like a pipe rather than a burst. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  private queued: Array<() => void> = []
  private scheduled = false

  private enqueue(fn: () => void) {
    this.queued.push(fn)
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      for (const deliver of this.queued.splice(0)) deliver()
    })
  }

  kill() {
    this.killed = true
    // A real kill still leads to a close event, which is what ends the read loop.
    this.enqueue(() => this.emit('close', null))
    return true
  }

  out(text: string) {
    this.enqueue(() => this.stdout.emit('data', Buffer.from(text)))
  }

  close(code: number | null) {
    this.enqueue(() => this.emit('close', code))
  }
}

const abortSignal = () => new AbortController()

async function drain(iter: AsyncGenerator<string, void, undefined>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

// ---------------------------------------------------------------- writeFile

async function writeFileEmitsOnce() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    // The command handler is invoked directly, exactly as the router does.
    const record = workspaceModule.record.writeFile as unknown as {
      resolver: (opts: { input: unknown }) => Promise<{ path: string }>
    }
    const result = await record.resolver({
      input: { path: 'new_fibonacci.py', content: 'print(1)\n', rootPath: root },
    })

    assert.equal(sink.written.length, 1, `expected exactly one written event, got ${sink.written.length}`)
    assert.equal(sink.exited.length, 0, 'a write is not a command exit')
    // The path is absolute, which is what the renderer compares its open file against.
    assert.equal(sink.written[0].path, result.path)
    assert.ok(sink.written[0].path?.startsWith(root), 'the path must be the file on disk')
    assert.ok(sink.written[0].path?.endsWith('new_fibonacci.py'))

    results.push('writeFile emits exactly one written event, carrying the absolute path')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function aRefusedWriteEmitsNothing() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const record = workspaceModule.record.writeFile as unknown as {
      resolver: (opts: { input: unknown }) => Promise<unknown>
    }
    await assert.rejects(
      record.resolver({ input: { path: '../../escaped.txt', content: 'x', rootPath: root } }),
      (e: { code?: string }) => e.code === 'PATH_TRAVERSAL'
    )
    // Nothing was written, so nothing must be announced — a stale-refetch for a refused write would
    // be a wasted read, and worse, it would suggest the write happened.
    assert.equal(sink.received.length, 0, `a refused write must not emit, got ${JSON.stringify(sink.received)}`)

    results.push('a refused write emits nothing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function theAgentWriteIsAnnounced() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    // The reported bug: the agent's write_file tool is a different code path from the renderer's
    // command, and it is the one that left the explorer stale.
    const outcome = await executeTool(
      'write_file',
      JSON.stringify({ path: 'agent_write.py', content: 'x = 1\n' }),
      root,
      abortSignal().signal
    )

    assert.equal(outcome.ok, true, `the tool should succeed: ${outcome.output}`)
    assert.equal(sink.written.length, 1, 'the agent’s write must announce itself too')
    assert.ok(sink.written[0].path?.endsWith('agent_write.py'))

    results.push("the agent's write_file announces its write through the same sink")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- terminal

async function commandExitEmitsOnce() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const child = new FakeChild()
    const spawnImpl = (() => {
      child.out('ok\n')
      child.close(0)
      return child
    }) as never

    const chunks = await drain(
      runCommand({ command: 'echo ok', cwd: root, signal: abortSignal().signal, spawnImpl })
    )

    assert.ok(chunks.some((c) => c.includes('EXIT_CODE:0')), 'the run should report its code')
    assert.equal(sink.exited.length, 1, `expected exactly one command-exited, got ${sink.exited.length}`)
    assert.equal(sink.written.length, 0, 'a command is not a file write')

    results.push('a successful command emits exactly one command-exited')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function nonZeroExitEmitsOnce() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const child = new FakeChild()
    const spawnImpl = (() => {
      // A failing command can still have written a file before it failed, so the notification has to
      // fire here as much as on success.
      child.close(1)
      return child
    }) as never

    await drain(runCommand({ command: 'false', cwd: root, signal: abortSignal().signal, spawnImpl }))
    assert.equal(sink.exited.length, 1, 'a non-zero exit must still announce once')

    results.push('a non-zero exit emits exactly one command-exited')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function abortEmitsOnce() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const child = new FakeChild()
    const controller = abortSignal()
    const spawnImpl = (() => child) as never

    const iter = runCommand({ command: 'sleep 100', cwd: root, signal: controller.signal, spawnImpl })
    const pump = drain(iter)
    // Abort while the command is running and silent, which is the case the wake-up exists for.
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    await pump

    assert.equal(sink.exited.length, 1, 'an aborted run must announce exactly once')

    results.push('an aborted run emits exactly one command-exited')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function spawnFailureEmitsOnce() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const child = new FakeChild()
    const spawnImpl = (() => {
      setImmediate(() => child.emit('error', new Error('ENOENT')))
      return child
    }) as never

    await assert.rejects(
      drain(runCommand({ command: 'nope', cwd: root, signal: abortSignal().signal, spawnImpl })),
      (e: { code?: string }) => e.code === 'SPAWN_FAILED'
    )
    // Emitted from `finally`, so even a run that threw has told the renderer to look again.
    assert.equal(sink.exited.length, 1, 'a failed spawn must announce once')

    results.push('a spawn failure emits exactly one command-exited')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function theAgentCommandIsAnnounced() {
  const sink = new Sink()
  sink.install()
  const root = mkdtempSync(join(tmpdir(), 'sam-events-'))
  try {
    const child = new FakeChild()
    const spawnImpl = (() => {
      child.out('done\n')
      child.close(0)
      return child
    }) as never

    // The agent's run_command routes through the terminal module, so it announces for free.
    const outcome = await executeTool(
      'run_command',
      JSON.stringify({ command: 'python new_fibonacci.py' }),
      root,
      abortSignal().signal,
      spawnImpl
    )

    assert.equal(outcome.ok, true, `the tool should succeed: ${outcome.output}`)
    assert.equal(sink.exited.length, 1, 'the agent’s command must announce its exit')

    results.push("the agent's run_command announces its exit through the same sink")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- the sink itself

function theSinkIsOptional() {
  // Before the router wires it (module load, or a test), notifying must be a no-op rather than a
  // crash — a change nobody is listening for cannot be allowed to break the write that caused it.
  setWorkspaceChangeSink(null)
  assert.doesNotThrow(() => notifyWorkspaceChanged({ kind: 'written', path: '/x' }))
  results.push('notifying before the sink exists is a safe no-op')
}

function theModuleDeclaresTheEvent() {
  const onChanged = workspaceModule.record.onChanged as { kind?: string } | undefined
  assert.ok(onChanged, 'workspace must declare the onChanged event')
  assert.equal(onChanged.kind, 'event', 'it must be an event, not a procedure')
  assert.ok(
    (terminalModule.record.execute as { kind?: string }).kind === 'stream',
    'terminal.execute stays a stream'
  )
  results.push('workspace declares onChanged as an event')
}

// ---------------------------------------------------------------- report

async function main() {
  await step('the module declares the event', theModuleDeclaresTheEvent)
  await step('the sink is optional', theSinkIsOptional)
  await step('writeFile emits once', writeFileEmitsOnce)
  await step('a refused write emits nothing', aRefusedWriteEmitsNothing)
  await step('the agent write is announced', theAgentWriteIsAnnounced)
  await step('command exit emits once', commandExitEmitsOnce)
  await step('non-zero exit emits once', nonZeroExitEmitsOnce)
  await step('abort emits once', abortEmitsOnce)
  await step('spawn failure emits once', spawnFailureEmitsOnce)
  await step('the agent command is announced', theAgentCommandIsAnnounced)

  console.log(`workspace events: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('EVENTS TEST FAILED:', err)
  process.exit(1)
})
