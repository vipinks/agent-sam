/**
 * Verifies the PTY foundation against a fake PTY process — no shell is ever spawned.
 *
 * Loads the real `conveyor/modules/terminal-pty.ts` (bundled with `electron-conveyor/main` and
 * `node-pty` stubbed/left external), so what is tested is the shipped session registry: one shell per
 * root, a reconnecting read, the buffer's wrap, the typed failures, and the shell preference order
 * that `protocol/terminal-pty.ts` decides.
 *
 * Every case injects its own spawner, because the thing under test is the bookkeeping around a PTY —
 * which shell was launched, what was written to it, whether a second create spawns a second shell —
 * and a real PTY would answer none of that from a test process.
 */
import { strict as assert } from 'node:assert'
import {
  TERMINAL_NOT_FOUND,
  TERMINAL_SPAWN_FAILED,
  appendLine,
  detectShell,
  DEFAULT_BUFFER_LINES,
} from '../../conveyor/protocol/terminal-pty'
import {
  createTerminalRegistry,
  killOnRootRemoval,
  type PtyProcess,
  type TerminalDeps,
} from '../../conveyor/modules/terminal-pty'

const results: string[] = []

// ---------------------------------------------------------------- a fake pty process

/**
 * Stands in for a `node-pty` session.
 *
 * Records what it was asked to do rather than doing it: a test asserts on the calls, and the
 * listeners are held so a case can drive output and an exit through the module's own handlers.
 */
class FakePty implements PtyProcess {
  readonly pid: number
  written: string[] = []
  resizes: Array<[number, number]> = []
  kills: string[] = []

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

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(signal?: string): void {
    this.kills.push(signal ?? 'SIGTERM')
  }

  /** Output as it would arrive from the shell. */
  out(text: string): void {
    for (const listener of this.dataListeners) listener(text)
  }

  /** The shell ending, as `exit` in the pane would. */
  exits(code = 0): void {
    for (const listener of this.exitListeners) listener({ exitCode: code })
  }
}

/** A registry whose spawner hands back fake PTYs, plus the fakes it handed back. */
function harness(overrides: Partial<TerminalDeps> = {}) {
  const spawned: FakePty[] = []
  const launches: Array<{ file: string; args: readonly string[]; cwd: string; cols: number; rows: number }> = []

  const registry = createTerminalRegistry({
    spawnPty: (file, args, options) => {
      launches.push({ file, args, cwd: options.cwd, cols: options.cols, rows: options.rows })
      const pty = new FakePty(1000 + spawned.length)
      spawned.push(pty)
      return pty
    },
    shellExists: () => true,
    platform: 'linux',
    env: { SHELL: '/bin/zsh' },
    ...overrides,
  })

  return { registry, spawned, launches }
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

// ---------------------------------------------------------------- shell detection

/**
 * The preference order, with absence driven by the injected predicate.
 *
 * Windows is decided without a probe in practice — both shells are bare names the OS loader
 * resolves — but the predicate is what makes the fallback testable, so it is exercised for both
 * platforms rather than assumed adequate on the one this machine happens to be.
 */
function shellDetection() {
  const nothingExists = () => false

  const win = detectShell('win32', {}, () => true)
  assert.equal(win.file, 'powershell.exe', 'Windows prefers PowerShell')
  assert.deepEqual(win.args, [])

  // PowerShell missing is the case that makes the second candidate real rather than decorative.
  const winFallback = detectShell('win32', {}, (file) => file === 'cmd.exe')
  assert.equal(winFallback.file, 'cmd.exe', 'a Windows machine without PowerShell falls back to cmd.exe')

  const unixOwn = detectShell('linux', { SHELL: '/usr/bin/fish' }, () => true)
  assert.equal(unixOwn.file, '/usr/bin/fish', "Unix prefers the user's own shell")

  const unixNoShell = detectShell('linux', {}, () => true)
  assert.equal(unixNoShell.file, '/bin/bash', 'with no $SHELL, Unix prefers bash')

  // A $SHELL naming something that is gone must not be launched: it is the one candidate the user
  // controls, so it is the one that goes missing.
  const unixStale = detectShell('linux', { SHELL: '/usr/bin/gone' }, (file) => file !== '/usr/bin/gone')
  assert.equal(unixStale.file, '/bin/bash', 'a $SHELL that is not there falls back to bash')

  // Nothing present at all still names a shell, and names the most conservative one: the failure
  // then comes from the spawn, reported as TERMINAL_SPAWN_FAILED, rather than from a guess here.
  const unixNothing = detectShell('linux', {}, nothingExists)
  assert.equal(unixNothing.file, '/bin/sh', 'with nothing present, the POSIX shell is named')
  assert.equal(detectShell('darwin', {}, nothingExists).file, '/bin/sh', 'macOS follows the Unix order')

  results.push('shell detection follows the platform preference order')
}

// ---------------------------------------------------------------- buffer retention

function bufferRetention() {
  assert.deepEqual(appendLine(['a'], 'b', 3), ['a', 'b'], 'a line is appended in order')

  // The wrap: at the cap nothing is lost from the tail, and the oldest line goes.
  assert.deepEqual(appendLine(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'], 'the buffer wraps at its cap')

  // Pinned without a wrap in it, because these two arithmetics differ: `slice(-0)` is `slice(0)`,
  // which would keep everything and make a cap of zero mean "unbounded".
  assert.deepEqual(appendLine(['a', 'b', 'c'], 'd', 0), [], 'a cap of zero retains nothing')

  assert.deepEqual(appendLine([], 'a', DEFAULT_BUFFER_LINES), ['a'])
  assert.equal(DEFAULT_BUFFER_LINES, 1000, 'the default retention is 1000 lines')

  results.push('the circular buffer appends and wraps at its cap')
}

// ---------------------------------------------------------------- create

async function createSpawnsASession() {
  const { registry, launches } = harness()

  const session = await registry.create('/work/sam')
  assert.equal(session.pid, 1000, 'create reports the new shell')
  assert.equal(session.cwd, '/work/sam', 'the shell starts in the root')
  assert.deepEqual(session.lines, [], 'a fresh session has nothing to reconnect to')
  assert.deepEqual(launches, [{ file: '/bin/zsh', args: [], cwd: '/work/sam', cols: 80, rows: 24 }])

  results.push('create spawns a shell in the root and returns its pid')
}

async function createReusesTheExistingSession() {
  const { registry, launches, spawned } = harness()

  const first = await registry.create('c:/work/sam')
  // Spelled with different case, because one folder reached by two spellings must not get two
  // shells — the same rule `protocol/recent-roots` compares roots with.
  const second = await registry.create('C:/WORK/SAM')

  assert.equal(second.pid, first.pid, 'the existing session is returned')
  assert.equal(launches.length, 1, 'nothing is spawned a second time')
  assert.equal(spawned.length, 1)

  results.push('create on an open root returns that session instead of respawning')
}

// ---------------------------------------------------------------- write, resize, read

async function writeReachesTheShell() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')

  registry.write('/work/sam', 'ls -la\r')
  assert.deepEqual(spawned[0].written, ['ls -la\r'], 'the bytes go to the shell stdin')

  results.push('write hands the data to the pty')
}

async function resizeReachesTheShell() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')

  registry.resize('/work/sam', 120, 40)
  registry.resize('/work/sam', 100, 30)
  assert.deepEqual(spawned[0].resizes, [
    [120, 40],
    [100, 30],
  ])

  results.push('resize resizes the pty')
}

async function readReturnsTheBuffer() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')

  spawned[0].out('hello\r\n')
  spawned[0].out('world\r\n$ ')
  const buffer = registry.read('/work/sam')

  // The last entry carries no newline: a PTY chunk is not a line, and the unterminated tail is the
  // prompt the pane must show again after a reconnect.
  assert.deepEqual(buffer.lines, ['hello', 'world', '$ '], 'complete lines and the pending prompt are retained')
  assert.equal(buffer.pid, spawned[0].pid)

  results.push('read returns the retained buffer for reconnection')
}

async function retentionIsBounded() {
  const { registry, spawned } = harness({ bufferLines: () => 3 })
  await registry.create('/work/sam')

  spawned[0].out('one\r\ntwo\r\nthree\r\nfour\r\n')
  assert.deepEqual(registry.read('/work/sam').lines, ['two', 'three', 'four'], 'only the last lines are kept')

  results.push('a session retains only its last N lines')
}

async function aScrollbackChangeGovernsTheNextSession() {
  // The standing scrollback limit, as Settings makes it: read at each session's creation rather
  // than captured once, so a preference changed while a shell is running governs the next one.
  let bound = 3
  const { registry, spawned } = harness({ bufferLines: () => bound })

  await registry.create('/work/sam')
  spawned[0].out('one\r\ntwo\r\nthree\r\nfour\r\n')
  assert.deepEqual(
    registry.read('/work/sam').lines,
    ['two', 'three', 'four'],
    'a session retains the bound it was created with'
  )

  // The user lowers the limit in Settings while this shell is still running.
  bound = 2
  assert.deepEqual(
    registry.read('/work/sam').lines,
    ['two', 'three', 'four'],
    'an existing buffer is not resized by the change'
  )

  spawned[0].out('five\r\n')
  assert.deepEqual(
    registry.read('/work/sam').lines,
    ['three', 'four', 'five'],
    'and it keeps wrapping at its own bound'
  )

  // The shell opened afterwards is the one the new limit applies to.
  await registry.create('/work/notes')
  spawned[1].out('a\r\nb\r\nc\r\n')
  assert.deepEqual(
    registry.read('/work/notes').lines,
    ['b', 'c'],
    'a session created after the change takes the new bound'
  )

  results.push('the scrollback bound is captured when a session is created')
}

// ---------------------------------------------------------------- kill

async function killEndsTheSession() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')

  registry.kill('/work/sam')
  assert.equal(spawned[0].kills.length, 1, 'the shell is killed')
  assert.deepEqual(registry.list(), [], 'the session is gone from the map')

  const code = codeOf(() => registry.read('/work/sam'))
  assert.equal(code, TERMINAL_NOT_FOUND, 'and reading it now says so')

  results.push('kill kills the shell and forgets the session')
}

async function anExitedShellIsForgotten() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')

  spawned[0].exits(0)
  assert.deepEqual(registry.list(), [], 'a shell that ended is not left recorded')

  // The reason it matters: a stale entry would make the next open return a dead pid forever.
  const again = await registry.create('/work/sam')
  assert.equal(spawned.length, 2, 'opening the folder again starts a new shell')
  assert.notEqual(again.pid, spawned[0].pid)

  results.push('a shell that exits is forgotten so the root can be opened again')
}

async function listReportsEverySession() {
  const { registry } = harness()
  await registry.create('/work/one')
  await registry.create('/work/two')

  assert.deepEqual(registry.list(), [
    { rootPath: '/work/one', pid: 1000, cwd: '/work/one' },
    { rootPath: '/work/two', pid: 1001, cwd: '/work/two' },
  ])

  results.push('list names every active session')
}

// ---------------------------------------------------------------- failures

async function unknownRootIsTyped() {
  const { registry } = harness()
  await registry.create('/work/sam')

  for (const [name, call] of [
    ['write', () => registry.write('/work/other', 'x')],
    ['resize', () => registry.resize('/work/other', 80, 24)],
    ['kill', () => registry.kill('/work/other')],
    ['read', () => registry.read('/work/other')],
  ] as const) {
    // Branched on the code, never the message: the renderer has to word this itself.
    assert.equal(codeOf(call), TERMINAL_NOT_FOUND, `${name} on an unknown root is refused by code`)
  }

  results.push('write, resize, kill and read on an unknown root raise TERMINAL_NOT_FOUND')
}

async function spawnFailureIsTyped() {
  const registry = createTerminalRegistry({
    spawnPty: () => {
      throw new Error('file not found')
    },
    shellExists: () => true,
    platform: 'win32',
    env: {},
  })

  await assert.rejects(
    () => registry.create('C:\\work'),
    (err: { code?: string }) => err.code === TERMINAL_SPAWN_FAILED
  )
  assert.deepEqual(registry.list(), [], 'a failed spawn leaves no session behind')

  results.push('a spawn that throws raises TERMINAL_SPAWN_FAILED')
}

async function aFailedSpawnDoesNotPoisonTheRoot() {
  let attempts = 0
  const registry = createTerminalRegistry({
    spawnPty: () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return new FakePty(7)
    },
    shellExists: () => true,
    platform: 'linux',
    env: {},
  })

  await assert.rejects(
    () => registry.create('/work/sam'),
    (err: { code?: string }) => err.code === TERMINAL_SPAWN_FAILED
  )
  const session = await registry.create('/work/sam')
  assert.equal(session.pid, 7, 'the next attempt is a fresh spawn, not a cached failure')

  results.push('a spawn failure can be retried')
}

// ---------------------------------------------------------------- lifecycle

async function killAllEndsEverySession() {
  const { registry, spawned } = harness()
  await registry.create('/work/one')
  await registry.create('/work/two')

  registry.killAll()
  assert.equal(spawned[0].kills.length, 1)
  assert.equal(spawned[1].kills.length, 1)
  assert.deepEqual(registry.list(), [])

  // The exit handler runs last, when nothing can react to a failure: a shell that refuses to die
  // must not take the other shells' cleanup with it.
  const stubborn = createTerminalRegistry({
    spawnPty: () => {
      const pty = new FakePty(9)
      pty.kill = () => {
        throw new Error('already gone')
      }
      return pty
    },
    shellExists: () => true,
    platform: 'linux',
    env: {},
  })
  await stubborn.create('/work/three')
  stubborn.killAll()

  results.push('killAll ends every session, and survives a kill that throws')
}

async function forgettingARootKillsItsTerminal() {
  const { registry, spawned } = harness()
  await registry.create('/work/sam')
  await registry.create('/work/notes')

  // A stand-in for the workspace store: the roots list an owner reports, and its subscribers.
  let roots: readonly string[] = ['/work/sam', '/work/notes']
  const listeners: Array<(next: readonly string[]) => void> = []
  const stop = killOnRootRemoval(
    registry,
    () => roots,
    (listener) => {
      listeners.push(listener)
      return () => {}
    }
  )

  // A root that stays is not touched — otherwise every unrelated change to the list would end
  // shells that were never forgotten.
  for (const listener of listeners) listener(['/work/sam', '/work/notes'])
  assert.equal(spawned[0].kills.length, 0, 'a root still offered keeps its shell')

  roots = ['/work/notes']
  for (const listener of listeners) listener(roots)

  assert.equal(spawned[0].kills.length, 1, 'the forgotten root loses its shell')
  assert.equal(spawned[1].kills.length, 0, 'the root that stayed does not')
  assert.deepEqual(registry.list(), [{ rootPath: '/work/notes', pid: 1001, cwd: '/work/notes' }])

  stop()

  results.push('a root that leaves the recents list loses its terminal')
}

// ---------------------------------------------------------------- report

async function main() {
  // Each step is announced before it runs: if one hangs, the last line printed names it rather
  // than leaving a silent exit with no clue which case stalled.
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('shell detection', shellDetection)
  await step('buffer retention', bufferRetention)
  await step('create', createSpawnsASession)
  await step('create reuses', createReusesTheExistingSession)
  await step('write', writeReachesTheShell)
  await step('resize', resizeReachesTheShell)
  await step('read', readReturnsTheBuffer)
  await step('bounded retention', retentionIsBounded)
  await step('scrollback bound', aScrollbackChangeGovernsTheNextSession)
  await step('kill', killEndsTheSession)
  await step('shell exit', anExitedShellIsForgotten)
  await step('list', listReportsEverySession)
  await step('unknown root', unknownRootIsTyped)
  await step('spawn failure', spawnFailureIsTyped)
  await step('spawn retry', aFailedSpawnDoesNotPoisonTheRoot)
  await step('kill all', killAllEndsEverySession)
  await step('forgotten root', forgettingARootKillsItsTerminal)

  console.log('terminal pty: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('TERMINAL PTY TEST FAILED:', err)
  process.exit(1)
})
