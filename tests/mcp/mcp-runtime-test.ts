/**
 * Verifies the MCP stdio runtime: spawning a server, discovering its tools, calling one, reading its
 * stderr, and stopping it — against a real child process, never a mock of one.
 *
 * A mock would have to be told every property this suite is here to hold: that a project server is
 * refused before anything is spawned, that a handshake which never finishes is abandoned with the
 * process, that a secret a server prints to stderr is not kept, that a stopped server's process is
 * really gone. Each of those is a statement about a process the OS can see, and about bytes on a pipe.
 * So the suite spawns `tests/mcp/fixtures/mcp-stdio-fixture.cjs` — a tiny node script speaking minimal
 * MCP JSON-RPC — and asks the OS what happened, rather than asking a stand-in what it was told.
 *
 * Nothing here reaches the network, and nothing here touches the real user's app data: every process
 * this suite starts is its own, and every one is stopped before the suite exits, including when an
 * assertion fails part-way.
 *
 * The budgets are injected small where a case is *about* a budget — a suite proving a ten-second
 * timeout must not take ten seconds — and left at their real values everywhere else, so the defaults
 * are what the ordinary cases run on.
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { ConveyorError } from 'electron-conveyor/main'
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_PROTOCOL_ERROR,
  MCP_REDACTED,
  MCP_SERVER_NOT_RUNNING,
  MCP_SPAWN_FAILED,
  MCP_START_TIMEOUT,
  MCP_START_TIMEOUT_MS,
  MCP_STDERR_MAX_LINES,
  MCP_TOOL_ERROR,
  MCP_TRUST_MISMATCH,
  type McpServerConfig,
} from '../../conveyor/protocol/mcp'
import {
  createMcpRuntime,
  stdioMcpConnection,
  type McpConnection,
  type McpRuntime,
  type McpRuntimeDeps,
  type McpSpawnSpec,
  type McpStartRequest,
} from '../../conveyor/modules/mcp-runtime'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// `npm run test:node` is the only supported way to run a suite, and it runs from the repository root.
// The path is resolved from there rather than from the bundle esbuild writes, which is one directory
// deeper — a resolution this suite would otherwise not notice was wrong until it spawned nothing.
const FIXTURE = join(process.cwd(), 'tests', 'mcp', 'fixtures', 'mcp-stdio-fixture.cjs')
if (!existsSync(FIXTURE)) {
  throw new Error(`the stdio fixture is missing at ${FIXTURE}: run the suites from the repository root`)
}

/** Every server this suite started, so a failed assertion cannot leave a process behind. */
const live: Array<{ runtime: McpRuntime; serverId: string }> = []

function makeRuntime(deps?: McpRuntimeDeps): McpRuntime {
  return createMcpRuntime(deps)
}

/** Start one server and remember it for the teardown, whatever happens next. */
async function start(runtime: McpRuntime, request: McpStartRequest): Promise<Tool[]> {
  const tools = await runtime.startServer(request)
  live.push({ runtime, serverId: request.config.id })
  return tools
}

/** One server, in the shape `startServer` is handed: the fixture, run by this same node. */
function fixtureConfig(id: string, mode = 'normal', over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, mode],
    cwd: null,
    env: {},
    secretEnv: {},
    enabled: true,
    ...over,
  }
}

/** A user-scope start: authored by the user, and not gated by trust. */
function userStart(config: McpServerConfig, plaintextSecrets: Record<string, string> = {}): McpStartRequest {
  return { config, plaintextSecrets, scope: 'user' }
}

/** A project-scope start, which states the trust state the guard reads. */
function projectStart(config: McpServerConfig, trust: 'matched' | 'mismatched' | 'absent'): McpStartRequest {
  return { config, plaintextSecrets: {}, scope: 'project', trust }
}

/** The code that was thrown. Never a message: a branch on wording is the defect these suites guard. */
function codeOf(error: unknown): string {
  if (!(error instanceof ConveyorError)) {
    throw new Error(`expected a ConveyorError, got ${String(error)}`)
  }
  return error.code
}

/** The payload a failure carries: where a distinction a caller may branch on is allowed to live. */
function issuesOf(error: unknown): Record<string, unknown> {
  return (error as { issues?: Record<string, unknown> }).issues ?? {}
}

/**
 * Poll until `probe` is truthy, or fail saying what never happened.
 *
 * Polling rather than sleeping, because the facts these cases wait for are side effects on other file
 * descriptors — a pid appearing, a process leaving, stderr arriving — and a fixed sleep is a race with
 * whatever machine the suite happens to run on.
 */
async function until(probe: () => unknown, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Whether the OS still has this pid.
 *
 * Signal 0 is a liveness *check*: nothing is sent, and the call reports only whether the process is
 * there. It is the one honest way to assert that a stop took the process with it — the runtime's own
 * registry is the thing the suite is holding to account, so it cannot also be the evidence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- budgets

async function theRuntimeRunsOnTheDocumentedBudgets() {
  const runtime = makeRuntime()

  assert.equal(MCP_START_TIMEOUT_MS, 10_000, 'a start gets ten seconds')
  assert.equal(runtime.startTimeoutMs, MCP_START_TIMEOUT_MS, 'and the runtime uses it')
  assert.equal(MCP_CALL_TIMEOUT_MS, 30_000, 'a call gets thirty')
  assert.equal(runtime.callTimeoutMs, MCP_CALL_TIMEOUT_MS, 'and the runtime uses that too')
  assert.equal(MCP_STDERR_MAX_LINES, 200, 'the log keeps two hundred lines')
  assert.equal(runtime.stderrMaxLines, MCP_STDERR_MAX_LINES, 'and the runtime keeps exactly that many')

  results.push('the runtime runs on the documented budgets: 10s to start, 30s to call, 200 log lines')
}

// ---------------------------------------------------------------- starting

async function aStartedServerIsRegisteredWithTheToolsItListed() {
  const runtime = makeRuntime()
  const tools = await start(runtime, userStart(fixtureConfig('fixture')))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['echo', 'slow', 'boom'],
    'a start answers with the tools the server listed'
  )
  assert.equal(
    tools[0].description,
    'Answer with the text it was given.',
    'in the raw shape the server sent, not a summary this app invented'
  )
  assert.deepEqual(
    tools[0].inputSchema,
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    'and the input schema comes with them'
  )
  assert.deepEqual(
    runtime.listRunningTools().map((entry) => [entry.serverId, entry.tool.name]),
    [
      ['fixture', 'echo'],
      ['fixture', 'slow'],
      ['fixture', 'boom'],
    ],
    'the registry holds them, each tagged with its server'
  )
  assert.ok((runtime.pidOf('fixture') ?? 0) > 0, 'a running server has a process behind it')

  await runtime.stopServer('fixture')
  results.push('a start spawns the process, discovers its tools, and registers them under the server id')
}

async function aPaginatedToolListIsFollowedToItsEnd() {
  const runtime = makeRuntime()
  const tools = await start(runtime, userStart(fixtureConfig('paged', 'paged')))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['echo', 'slow', 'boom'],
    'a list the server split across two pages arrives whole'
  )

  await runtime.stopServer('paged')
  results.push('tool discovery follows the cursor, so a paginated list is never silently short')
}

async function aToolListThatCannotBeFinishedIsAProtocolError() {
  const runtime = makeRuntime()

  await assert.rejects(
    () => runtime.startServer(userStart(fixtureConfig('loop', 'cursor-loop'))),
    (error: unknown) => codeOf(error) === MCP_PROTOCOL_ERROR,
    'a server that offers the same cursor forever stops the start rather than truncating the list'
  )
  assert.deepEqual(runtime.listRunningTools(), [], 'and nothing is registered from a list that could not be finished')

  results.push('a tool list whose cursor never advances is MCP_PROTOCOL_ERROR, not a quietly short list')
}

async function aHandshakeThisClientCannotUseIsAProtocolError() {
  const runtime = makeRuntime()

  await assert.rejects(
    () => runtime.startServer(userStart(fixtureConfig('bad', 'bad-version'))),
    (error: unknown) => codeOf(error) === MCP_PROTOCOL_ERROR,
    'a server offering a protocol version no client supports cannot be used'
  )
  assert.deepEqual(runtime.listRunningTools(), [], 'and nothing is registered')

  results.push('a handshake this client cannot use is MCP_PROTOCOL_ERROR')
}

async function anUnusableCommandIsASpawnFailure() {
  const runtime = makeRuntime()

  await assert.rejects(
    () => runtime.startServer(userStart(fixtureConfig('ghost', 'normal', { command: 'sam-ai-no-such-command-4b1c' }))),
    (error: unknown) => codeOf(error) === MCP_SPAWN_FAILED,
    'a command that is not there fails MCP_SPAWN_FAILED'
  )
  assert.deepEqual(runtime.listRunningTools(), [], 'and leaves no entry behind')

  results.push('a command that cannot be spawned is MCP_SPAWN_FAILED rather than a protocol error')
}

async function aHandshakeThatNeverAnswersTimesOutAndLeavesNoProcess() {
  // The real spawn, wrapped: this case needs the pid of a server that will never be registered.
  const slot: { value: McpConnection | null } = { value: null }
  const spawnedPid = (): number => slot.value?.pid ?? 0

  const runtime = makeRuntime({
    startTimeoutMs: 400,
    createConnection: (spec) => {
      slot.value = stdioMcpConnection(spec)
      return slot.value
    },
  })

  const started = runtime.startServer(userStart(fixtureConfig('hang', 'hang')))
  await until(() => spawnedPid() > 0, 'the hung server to be spawned')
  const pid = spawnedPid()

  await assert.rejects(
    () => started,
    (error: unknown) =>
      codeOf(error) === MCP_START_TIMEOUT && issuesOf(error).reason === 'timeout' && issuesOf(error).timeoutMs === 400,
    'a handshake that does not finish inside the start budget fails MCP_START_TIMEOUT, with the reason in the payload'
  )

  assert.deepEqual(runtime.listRunningTools(), [], 'nothing is registered')
  await until(() => !isProcessAlive(pid), 'the hung process to be gone')
  results.push('a start that outlives its budget fails MCP_START_TIMEOUT and takes the process with it')
}

// ---------------------------------------------------------------- trust

async function aMismatchedGrantRefusesTheStartBeforeAnythingIsSpawned() {
  const spawned: McpSpawnSpec[] = []
  const runtime = makeRuntime({
    createConnection: (spec) => {
      spawned.push(spec)
      throw new Error('nothing may be spawned for a server that is not trusted')
    },
  })

  const config = fixtureConfig('project-fixture')
  await assert.rejects(
    () => runtime.startServer(projectStart(config, 'mismatched')),
    (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
    'a config that changed since it was trusted is refused by code'
  )

  assert.deepEqual(spawned, [], 'and no transport was ever built: the guard runs before the spawn, not after it')
  assert.deepEqual(runtime.listRunningTools(), [], 'so nothing is registered either')

  results.push('a mismatched grant refuses a project start with MCP_TRUST_MISMATCH and builds no transport')
}

async function anAbsentGrantRefusesTheStartToo() {
  const spawned: McpSpawnSpec[] = []
  const runtime = makeRuntime({
    createConnection: (spec) => {
      spawned.push(spec)
      throw new Error('nothing may be spawned for a server nobody trusted')
    },
  })

  const config = fixtureConfig('project-fixture')
  await assert.rejects(
    () => runtime.startServer(projectStart(config, 'absent')),
    (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
    'a project server nobody has trusted is refused, and by the same code as one that changed'
  )
  assert.deepEqual(spawned, [], 'with no process constructed for it')
  assert.deepEqual(runtime.listRunningTools(), [])

  results.push('an absent grant refuses a project start with MCP_TRUST_MISMATCH as well')
}

async function theUserScopeIsNotGatedByTrust() {
  const runtime = makeRuntime()

  const userTools = await start(runtime, userStart(fixtureConfig('user-fixture')))
  assert.deepEqual(
    userTools.map((tool) => tool.name),
    ['echo', 'slow', 'boom'],
    'a user server starts with no trust record in existence anywhere'
  )
  await runtime.stopServer('user-fixture')

  const matchedTools = await start(runtime, projectStart(fixtureConfig('trusted-fixture'), 'matched'))
  assert.equal(matchedTools.length, 3, 'and a project server starts once its grant matches')

  await runtime.stopServer('trusted-fixture')
  results.push('trust governs the project scope only: a user start skips the check, a matched grant passes it')
}

// ---------------------------------------------------------------- calling and stopping

async function aCallIsForwardedAndARemovedServerRefusesOne() {
  const runtime = makeRuntime()
  await start(runtime, userStart(fixtureConfig('fixture')))

  const result = (await runtime.callTool('fixture', 'echo', { text: 'hello' })) as {
    content: Array<{ text: string }>
  }
  assert.equal(result.content[0].text, 'echo:hello', 'the call reaches the server and its result comes back whole')

  await runtime.stopServer('fixture')
  await assert.rejects(
    () => runtime.callTool('fixture', 'echo', { text: 'hello' }),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_RUNNING,
    'a server that is not running refuses a call by code'
  )

  results.push(
    'a tool call is forwarded to the running client, and a stopped server refuses with MCP_SERVER_NOT_RUNNING'
  )
}

async function aFailedCallIsReportedWithItsReason() {
  const runtime = makeRuntime({ callTimeoutMs: 400 })
  await start(runtime, userStart(fixtureConfig('fixture')))

  await assert.rejects(
    () => runtime.callTool('fixture', 'boom', {}),
    (error: unknown) => codeOf(error) === MCP_TOOL_ERROR && issuesOf(error).reason === 'failed',
    'a tool that answers with an error is MCP_TOOL_ERROR, with the reason in the payload'
  )
  await assert.rejects(
    () => runtime.callTool('fixture', 'slow', {}),
    (error: unknown) =>
      codeOf(error) === MCP_TOOL_ERROR && issuesOf(error).reason === 'timeout' && issuesOf(error).timeoutMs === 400,
    'and a call that outlives its budget is the same code with reason timeout: the distinction a caller branches on is in the payload, never in the message'
  )

  await runtime.stopServer('fixture')
  results.push('a failed tool call is MCP_TOOL_ERROR, and the timeout distinction is carried in the error payload')
}

async function stoppingTakesTheEntryAndTheProcess() {
  const runtime = makeRuntime()
  await start(runtime, userStart(fixtureConfig('fixture')))

  const pid = runtime.pidOf('fixture')
  assert.ok(pid !== null && pid > 0, 'a running server reports the process it owns')

  await runtime.stopServer('fixture')
  assert.equal(runtime.pidOf('fixture'), null, 'the registry entry is gone')
  assert.deepEqual(runtime.listRunningTools(), [], 'and its tools with it')
  await until(() => !isProcessAlive(pid), 'the process to be gone')
  await assert.rejects(
    () => runtime.stopServer('fixture'),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_RUNNING,
    'and stopping what is not running says so by code'
  )

  results.push('stopping a server removes its entry and terminates its process')
}

// ---------------------------------------------------------------- stderr

async function theLogKeepsTheNewestLinesAndDropsTheOldest() {
  const runtime = makeRuntime({ stderrMaxLines: 3 })
  await start(runtime, userStart(fixtureConfig('fixture', 'evict')))

  await until(() => runtime.readServerLogs('fixture').at(-1) === 'line 6', 'the whole of stderr to arrive')
  assert.deepEqual(
    runtime.readServerLogs('fixture'),
    ['line 4', 'line 5', 'line 6'],
    'six lines written, the newest three kept and the oldest three evicted'
  )

  await runtime.stopServer('fixture')
  results.push('the stderr ring buffer evicts its oldest lines beyond the bound')
}

async function aSecretOnStderrIsRedactedBeforeItIsStored() {
  const runtime = makeRuntime()
  const token = 'sam-token-9f13'
  const longer = `${token}-longer`

  await start(runtime, userStart(fixtureConfig('fixture', 'noisy'), { FIXTURE_TOKEN: token, FIXTURE_OTHER: longer }))
  await until(() => runtime.readServerLogs('fixture').length === 2, 'both lines to arrive')

  const logs = runtime.readServerLogs('fixture')
  assert.deepEqual(
    logs,
    [`auth a=${MCP_REDACTED} b=${MCP_REDACTED}`, 'boot ok'],
    'the line carrying the secrets is redacted, and the plain line beside it is left alone'
  )

  const stored = logs.join('\n')
  assert.ok(!stored.includes(token), 'no plaintext secret survives anywhere the reader can see')
  assert.ok(
    !stored.includes(longer.slice(token.length)),
    'not even the tail of the longer value: a value containing another is replaced whole, never half'
  )

  await runtime.stopServer('fixture')
  results.push('a plaintext secret a server prints reaches the reader as [REDACTED] and is never stored')
}

// ---------------------------------------------------------------- many servers

async function toolsFromEveryRunningServerAreTaggedWithTheirServer() {
  const runtime = makeRuntime()
  await start(runtime, userStart(fixtureConfig('one')))
  await start(runtime, userStart(fixtureConfig('two')))

  assert.deepEqual(
    runtime.listRunningTools().map((entry) => [entry.serverId, entry.tool.name]),
    [
      ['one', 'echo'],
      ['one', 'slow'],
      ['one', 'boom'],
      ['two', 'echo'],
      ['two', 'slow'],
      ['two', 'boom'],
    ],
    'both servers tools, each tagged with the server they came from'
  )

  // A second start of a running server is a restart: the tools belong to the config that was just
  // validated, so the previous entry — and its process — go with it rather than accumulating.
  await start(runtime, userStart(fixtureConfig('one')))
  assert.equal(
    runtime.listRunningTools().filter((entry) => entry.serverId === 'one').length,
    3,
    'a restart replaces the entry it replaces rather than duplicating it'
  )

  await runtime.stopServer('one')
  await runtime.stopServer('two')
  results.push('listRunningTools aggregates every running server, each tool tagged with its serverId')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('budgets: documented defaults', theRuntimeRunsOnTheDocumentedBudgets)
    await step('start: spawn, discover, register', aStartedServerIsRegisteredWithTheToolsItListed)
    await step('start: paginated tool list', aPaginatedToolListIsFollowedToItsEnd)
    await step('start: cursor that never advances', aToolListThatCannotBeFinishedIsAProtocolError)
    await step('start: unusable handshake', aHandshakeThisClientCannotUseIsAProtocolError)
    await step('start: unusable command', anUnusableCommandIsASpawnFailure)
    await step('start: hang past the budget', aHandshakeThatNeverAnswersTimesOutAndLeavesNoProcess)
    await step('trust: mismatched grant', aMismatchedGrantRefusesTheStartBeforeAnythingIsSpawned)
    await step('trust: absent grant', anAbsentGrantRefusesTheStartToo)
    await step('trust: user scope and a matched grant', theUserScopeIsNotGatedByTrust)
    await step('call: forwarded, then refused', aCallIsForwardedAndARemovedServerRefusesOne)
    await step('call: failure reasons', aFailedCallIsReportedWithItsReason)
    await step('stop: entry and process', stoppingTakesTheEntryAndTheProcess)
    await step('stderr: eviction', theLogKeepsTheNewestLinesAndDropsTheOldest)
    await step('stderr: redaction', aSecretOnStderrIsRedactedBeforeItIsStored)
    await step('registry: many servers', toolsFromEveryRunningServerAreTaggedWithTheirServer)

    console.log(`mcp runtime: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    // Whatever the outcome: nothing this suite started outlives it.
    for (const entry of live) {
      try {
        await entry.runtime.stopServer(entry.serverId)
      } catch {
        // Already stopped by the case itself, which is the ordinary case.
      }
    }
  }
}

void main().catch((err) => {
  console.error('MCP RUNTIME TEST FAILED:', err)
  process.exit(1)
})
