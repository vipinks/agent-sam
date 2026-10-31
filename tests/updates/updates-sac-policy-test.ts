/**
 * The Smart App Control probe: how it asks Windows, what its answers mean, and how every failure reads.
 *
 * The update flow installs silently. A machine whose app-control policy is enforcing accepts the download and
 * then blocks the installer, which is a failure the user sees only after the app has quit. This suite pins the
 * one read that lets the ready card warn before that happens.
 *
 * The child process is a double, because the real `reg` query depends on the machine the suite happens to run
 * on. What the double records is the seam that matters: the exact command, the arguments as an array, and
 * `shell: false`. The mapping and every fail-open path are driven through that same seam, so a read that could
 * not be performed is proven to become `unknown` rather than an error that could reach the updater.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { readSacPolicyState, SAC_POLICY_REG_ARGS, SAC_POLICY_TIMEOUT_MS } from '../../conveyor/modules/updates'

type Spawn = typeof import('node:child_process').spawn

const results: string[] = []

interface SpawnCall {
  command: string
  args: readonly string[]
  options: SpawnOptionsWithoutStdio | undefined
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: () => void }
  kill: () => void
}

interface FakeRegOptions {
  output?: string
  exitCode?: number
  emitError?: boolean
  silent?: boolean
}

/**
 * One `reg` child, with the event order a real child produces when it has something to say.
 *
 * The events are deferred a microtask: the reader attaches its listeners after `spawn` returns, so emitting
 * synchronously would test a child nobody was listening to rather than the one the reader wires.
 */
function fakeReg(options: FakeRegOptions = {}): {
  spawn: (
    command: string,
    args: readonly string[],
    options?: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams
  calls: SpawnCall[]
  killed: () => boolean
} {
  const calls: SpawnCall[] = []
  let killed = false

  return {
    calls,
    killed: () => killed,
    spawn: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions })
      const child = new EventEmitter() as FakeChild
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
      child.kill = () => {
        killed = true
      }

      queueMicrotask(() => {
        if (options.silent) return
        if (options.emitError) {
          child.emit('error', new Error('reg could not start'))
          return
        }
        if (options.output) child.stdout.emit('data', Buffer.from(options.output, 'utf8'))
        child.emit('close', options.exitCode ?? 0)
      })

      return child as unknown as ChildProcessWithoutNullStreams
    },
  }
}

/** A registry dump shaped like `reg query` produces for one value. */
function regOutput(value: string): string {
  return [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy',
    `    VerifiedAndReputablePolicyState    REG_DWORD    ${value}`,
    '',
  ].join('\r\n')
}

/** The command and arguments the probe is required to use, stated here rather than derived from the code. */
const EXPECTED_ARGS = [
  'query',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy',
  '/v',
  'VerifiedAndReputablePolicyState',
]

async function theProbeSpawnsRegWithAnArgumentArrayAndNoShell() {
  const fake = fakeReg({ output: regOutput('0x1') })
  const state = await readSacPolicyState({
    platform: 'win32',
    spawn: fake.spawn as unknown as Spawn,
  })

  assert.equal(state, 'enforcing')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].command, 'reg')
  assert.deepEqual(fake.calls[0].args, EXPECTED_ARGS)
  assert.deepEqual([...SAC_POLICY_REG_ARGS], EXPECTED_ARGS)
  assert.equal(fake.calls[0].options?.shell, false, 'a shell would let the registry path become a command')
  assert.equal(fake.calls[0].options?.windowsHide, true, 'the probe must not flash a console window')
  assert.equal(SAC_POLICY_TIMEOUT_MS, 3_000, 'the read is bounded at roughly three seconds')

  results.push('the probe runs `reg query` from an argument array with shell disabled and a three-second bound')
}

async function theProbeMapsTheDocumentedPolicyValues() {
  const cases = [
    { output: regOutput('0x1'), expected: 'enforcing', label: '1 is enforcement' },
    { output: regOutput('0x0'), expected: 'off', label: '0 is off' },
    { output: regOutput('0x2'), expected: 'eval', label: '2 is evaluation' },
    { output: regOutput('0x3'), expected: 'unknown', label: 'an undeclared value is unknown' },
    {
      output: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n',
      expected: 'unknown',
      label: 'an absent value is unknown',
    },
    { output: 'the value is not a REG_DWORD\r\n', expected: 'unknown', label: 'a malformed dump is unknown' },
  ] as const

  for (const item of cases) {
    const fake = fakeReg({ output: item.output })
    const state = await readSacPolicyState({
      platform: 'win32',
      spawn: fake.spawn as unknown as Spawn,
    })
    assert.equal(state, item.expected, item.label)
  }

  results.push('1 maps to enforcing, 0 to off, 2 to eval, and absent or malformed values to unknown')
}

async function aSpawnErrorFailsOpen() {
  const fake = fakeReg({ emitError: true })
  const state = await readSacPolicyState({
    platform: 'win32',
    spawn: fake.spawn as unknown as Spawn,
  })

  assert.equal(state, 'unknown')
  results.push('a spawn error reads as unknown, so the update flow is never blocked or altered')
}

async function aTimeoutFailsOpenAndKillsTheChild() {
  const fake = fakeReg({ silent: true })
  const state = await readSacPolicyState({
    platform: 'win32',
    spawn: fake.spawn as unknown as Spawn,
    timeoutMs: 10,
  })

  assert.equal(state, 'unknown')
  assert.equal(fake.killed(), true, 'the bounded read stops the child it started')
  results.push('a timeout reads as unknown and kills the child')
}

async function nonWindowsReadsNothing() {
  let spawned = false
  const state = await readSacPolicyState({
    platform: 'linux',
    spawn: (() => {
      spawned = true
      throw new Error('reg must not be spawned on a non-Windows platform')
    }) as unknown as Spawn,
  })

  assert.equal(state, 'unknown')
  assert.equal(spawned, false, 'only Windows has this registry key')
  results.push('a non-Windows launch skips the probe entirely')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('spawn', theProbeSpawnsRegWithAnArgumentArrayAndNoShell)
  await step('mapping', theProbeMapsTheDocumentedPolicyValues)
  await step('spawn error', aSpawnErrorFailsOpen)
  await step('timeout', aTimeoutFailsOpenAndKillsTheChild)
  await step('platform', nonWindowsReadsNothing)

  console.log('update SAC policy: ' + results.length + ' passed')
  for (const result of results) console.log('  pass: ' + result)
}

main().catch((error) => {
  console.error('UPDATE SAC POLICY TEST FAILED:', error)
  process.exit(1)
})
