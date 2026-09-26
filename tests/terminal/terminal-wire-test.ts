/**
 * Verifies the PTY's wire: what main pushes to a window when a shell produces output.
 *
 * Turn 1 landed the registry with no wire at all — spawn, write, resize, kill, read, list, and a
 * renderer that could only catch up by re-reading a transcript. This suite is the claim about the wire
 * that replaces that: a chunk leaves the pty and reaches the sink byte-identical, once, in arrival
 * order. The renderer writes what it is handed straight into xterm, so any reframing here would be a
 * corruption the renderer could not undo — which is why the framing is asserted rather than assumed.
 *
 * What the *transcript* keeps is a different rule and stays a different rule: whole lines, bounded,
 * with the unterminated tail reported as the last line. That is `terminal-pty-test.ts`'s subject; the
 * case here exists only to pin that the transcript's framing does not reach the wire.
 *
 * Also here: the keying rule. Two roots can have two living shells, and one root's output arriving
 * into the other's terminal is the one failure this wire can cause that the renderer cannot detect.
 */
import { strict as assert } from 'node:assert'
import {
  TERMINAL_NOT_FOUND,
  isTerminalEventFor,
  terminalDataFor,
  terminalExitFor,
} from '../../conveyor/protocol/terminal-pty'
import { createTerminalRegistry, type PtyProcess, type TerminalDeps } from '../../conveyor/modules/terminal-pty'

const results: string[] = []

// ---------------------------------------------------------------- a fake pty process

/**
 * Stands in for a `node-pty` session, recording what it was asked to do and letting a case drive
 * output and an exit back through the module's own handlers.
 *
 * A copy of `terminal-pty-test.ts`'s fake rather than a shared import, because a suite is a script
 * esbuild bundles on its own: a suite importing another suite would run it twice.
 */
class FakePty implements PtyProcess {
  readonly pid: number
  written: string[] = []

  private readonly dataListeners: Array<(data: string) => void> = []
  private readonly exitListeners: Array<(event: { exitCode: number }) => void> = []

  constructor(pid: number) {
    this.pid = pid
  }

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(listener)
    return { dispose: () => {} }
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose: () => void } {
    this.exitListeners.push(listener)
    return { dispose: () => {} }
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(): void {}

  kill(): void {}

  /** Output as it would arrive from the shell. */
  out(text: string): void {
    for (const listener of this.dataListeners) listener(text)
  }

  /** The shell ending, as `exit` at its prompt would. */
  ends(code = 0): void {
    for (const listener of this.exitListeners) listener({ exitCode: code })
  }
}

/** One payload as the wire would carry it, plus the sink that collected it. */
interface Collected {
  data: Array<{ rootPath: string; chunk: string }>
  exit: Array<{ rootPath: string; exitCode: number }>
}

/** A registry whose spawner hands back fake PTYs, plus the payloads its sink collected. */
function harness(overrides: Partial<TerminalDeps> = {}) {
  const spawned: FakePty[] = []
  const collected: Collected = { data: [], exit: [] }

  const registry = createTerminalRegistry({
    spawnPty: () => {
      const pty = new FakePty(1000 + spawned.length)
      spawned.push(pty)
      return pty
    },
    shellExists: () => true,
    platform: 'linux',
    env: { SHELL: '/bin/bash' },
    onOutput: (rootPath, chunk) => collected.data.push(terminalDataFor(rootPath, chunk)),
    onExit: (rootPath, exitCode) => collected.exit.push(terminalExitFor(rootPath, exitCode)),
    ...overrides,
  })

  return { registry, spawned, collected }
}

/** The code a call was refused with, or null when it was not refused at all. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code ?? null
  }
  return null
}

// ---------------------------------------------------------------- the payload's shape

/**
 * The two payloads, built by the rules main uses rather than by a literal in a test.
 *
 * `rootPath` is the root the shell belongs to, exactly as it was opened — not lower-cased, and not
 * resolved again: the renderer compares it with the root it is showing, and the comparison is where
 * case stops mattering.
 */
function payloadShape() {
  assert.deepEqual(terminalDataFor('/work/notes', 'hi\r\n'), { rootPath: '/work/notes', chunk: 'hi\r\n' })
  assert.deepEqual(terminalExitFor('/work/notes', 3), { rootPath: '/work/notes', exitCode: 3 })

  results.push('a data payload names its root and carries the chunk verbatim; an exit payload names its root and code')
}

// ---------------------------------------------------------------- the keying rule

/**
 * Which root a pushed payload belongs to.
 *
 * The comparison is the app's own (`sameRoot`), so a folder reached two ways — one window opening
 * `C:\work`, another `c:\Work` — is one root, exactly as it is one shell in the registry.
 *
 * The negative case is the one that matters: a payload for another root must be refused, because the
 * renderer's only other defence against writing the wrong shell's output into the wrong terminal is
 * that it never occurs to it to check.
 */
function keying() {
  assert.equal(isTerminalEventFor({ rootPath: '/work/notes' }, '/work/notes'), true, 'the same root matches')
  assert.equal(isTerminalEventFor({ rootPath: 'C:\\Work\\Notes' }, 'c:\\work\\notes'), true, 'case does not matter')
  assert.equal(isTerminalEventFor({ rootPath: '/work/notes' }, '/work/other'), false, 'another root is refused')
  assert.equal(
    isTerminalEventFor({ rootPath: '/work/notes' }, '/work/notes/deeper'),
    false,
    'a child folder is another root, not the same one'
  )

  results.push('a payload matches its own root, whatever the case, and no other')
}

// ---------------------------------------------------------------- the chunk survives

/**
 * A chunk is opaque.
 *
 * The one thing this wire can do that the renderer cannot repair is change a byte. So the chunk that
 * goes in is the chunk that comes out, for the shapes a shell actually emits: a CRLF line ending, an
 * ANSI colour sequence, a bare carriage return (a progress bar redrawing itself), a lone newline, a
 * partial line with no terminator, and the empty string.
 */
async function chunkIsOpaque() {
  const { registry, spawned, collected } = harness()
  await registry.create('/work/notes')

  const chunks = ['ready\r\n', '\u001b[31mred\u001b[0m', '\r', '\n', 'C:\\work\\notes> ', '', 'ünïcøde ✓ 日本語\n']

  for (const chunk of chunks) spawned[0].out(chunk)

  assert.deepEqual(
    collected.data.map((payload) => payload.chunk),
    chunks,
    'every chunk reaches the sink exactly as the shell emitted it'
  )
  assert.deepEqual(
    collected.data.map((payload) => payload.rootPath),
    chunks.map(() => '/work/notes'),
    'every chunk names the root it came from'
  )

  results.push('a chunk reaches the wire byte-identical, including escape sequences and bare carriage returns')
}

/**
 * Order is the only structure the wire has.
 *
 * There is no sequence number and no reassembly, because none is needed: the event channel is a
 * direct `webContents.send` per payload, so payloads arrive in the order they were emitted. What a
 * reader may therefore rely on is exactly two things — no loss and no reordering — and this is where
 * both are pinned, by writing three chunks and checking that the renderer's own concatenation
 * reproduces the shell's output character for character.
 */
async function orderIsPreserved() {
  const { registry, spawned, collected } = harness()
  await registry.create('/work/notes')

  const parts = ['$ npm test\n', '\u001b[32mok\u001b[0m 12 passing\n', '\r\n$ ']
  for (const part of parts) spawned[0].out(part)

  assert.equal(collected.data.length, parts.length, 'one payload per chunk, with nothing merged or dropped')
  assert.equal(
    collected.data.map((payload) => payload.chunk).join(''),
    parts.join(''),
    'the renderer putting the chunks back together gets exactly what the shell wrote'
  )

  results.push('chunks arrive once each, in order, and concatenate back to the shell’s own output')
}

/**
 * The transcript's framing is not the wire's.
 *
 * The registry keeps whole lines, which means it splits a chunk on its line breaks and holds the tail
 * back. That is a rule about what is *retained*, and it must not become a rule about what is *sent*:
 * a shell emitting four lines in one chunk must produce one payload carrying all four, or a renderer
 * would receive a redraw as four separate writes and could interleave its own between them.
 */
async function transcriptFramingStaysOffTheWire() {
  const { registry, spawned, collected } = harness()
  await registry.create('/work/notes')

  const burst = 'one\ntwo\nthree\nfour-partial'
  spawned[0].out(burst)

  assert.equal(collected.data.length, 1, 'one chunk is one payload, however many lines it contains')
  assert.equal(collected.data[0]?.chunk, burst, 'the payload is the whole chunk, unsplit')

  // And the transcript did frame it — four lines, the last one the unterminated tail — so the two
  // rules are demonstrably different rules rather than one rule stated twice.
  assert.deepEqual(registry.read('/work/notes').lines, ['one', 'two', 'three', 'four-partial'])

  results.push('the transcript keeps whole lines while the wire keeps the chunk whole')
}

// ---------------------------------------------------------------- the shell ending

/**
 * A shell ending is pushed, not polled.
 *
 * Reading the transcript is how a renderer catches up on output; it cannot report an exit, because a
 * forgotten session has no transcript to read — the read is refused with `TERMINAL_NOT_FOUND`, which
 * is the same refusal a root with no shell at all gets. So the exit is a payload, carrying the code
 * the pty reported, and emitted before the session is dropped rather than after.
 */
async function exitIsPushed() {
  const { registry, spawned, collected } = harness()
  await registry.create('/work/notes')

  spawned[0].out('\r\n$ exit\r\n')
  spawned[0].ends(3)

  assert.deepEqual(collected.exit, [{ rootPath: '/work/notes', exitCode: 3 }], 'the code the shell exited with')
  assert.equal(collected.data.length, 1, 'the output before the exit is pushed as output')
  assert.equal(
    codeOf(() => registry.read('/work/notes')),
    TERMINAL_NOT_FOUND,
    'an exited shell is forgotten'
  )

  // The other half of "forgotten": the next create spawns rather than answering with the dead one.
  await registry.create('/work/notes')
  assert.equal(spawned.length, 2, 'the root can be opened again after its shell ends')

  results.push('a shell ending pushes its code, and the root is openable again afterwards')
}

/**
 * A shell that ends by itself and a shell killed on purpose are both an exit.
 *
 * The distinction is the user's, not this layer's: `exit` at a prompt and a folder being forgotten
 * both end the same process, and a pane showing either has to stop claiming a live shell. Asserted
 * here because the temptation is to report only the polite path.
 */
async function deliberateKillIsAlsoAnExit() {
  const { registry, spawned, collected } = harness()
  await registry.create('/work/notes')

  registry.kill('/work/notes')
  // A real pty raises its exit on kill; the fake is asked to, so the handler is driven the way the
  // OS would drive it rather than assumed not to run.
  spawned[0].ends(0)

  assert.deepEqual(collected.exit, [{ rootPath: '/work/notes', exitCode: 0 }], 'a killed shell still reports its exit')
  assert.equal(
    codeOf(() => registry.read('/work/notes')),
    TERMINAL_NOT_FOUND
  )

  results.push('a deliberately killed shell reports an exit like any other')
}

// ---------------------------------------------------------------- no listener, no break

/**
 * The wire is optional.
 *
 * `ptySessions` is built at module load, before the router exists to create the emitter, so for a
 * moment — and in every suite that drives the registry directly — there is no sink. A shell must
 * still work then: the alternative is a terminal that cannot be opened because nothing was listening
 * for its output, which is a change nobody asked for breaking the thing that caused it.
 */
async function noSinkIsNotABreak() {
  const { registry, spawned } = harness({ onOutput: undefined, onExit: undefined })

  await registry.create('/work/notes')
  registry.write('/work/notes', 'ls\n')
  registry.resize('/work/notes', 100, 30)
  spawned[0].out('no one is listening\n')
  spawned[0].ends(0)

  assert.deepEqual(spawned[0].written, ['ls\n'], 'the shell was still driven')
  assert.equal(
    codeOf(() => registry.read('/work/notes')),
    TERMINAL_NOT_FOUND,
    'and the exit was still handled'
  )

  results.push('a registry with no sink spawns, writes and reaps exactly as one with a sink')
}

// ---------------------------------------------------------------- report

async function main() {
  // Each step is announced before it runs: if one hangs, the last line printed names it rather than
  // leaving a silent exit with no clue which case stalled.
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('payload shape', payloadShape)
  await step('keying', keying)
  await step('chunk opacity', chunkIsOpaque)
  await step('order', orderIsPreserved)
  await step('transcript framing', transcriptFramingStaysOffTheWire)
  await step('exit', exitIsPushed)
  await step('deliberate kill', deliberateKillIsAlsoAnExit)
  await step('no sink', noSinkIsNotABreak)

  console.log('terminal wire: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('TERMINAL WIRE TEST FAILED:', err)
  process.exit(1)
})
