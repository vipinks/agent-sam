/**
 * The update rule, against real files: one stored server is changed in place without becoming a new one.
 *
 * The properties here are the ones a file can prove: an unknown key survives, a field the record never
 * had stays absent, a project grant is gone after the change, the running process is stopped before a
 * byte moves, and a corrupt file is never written at all. The validation cases drive the same record
 * rule the add path uses, including the secret-name rule an environment variable must satisfy.
 *
 * The runtime is injected exactly as it is for a start: this suite can prove *when* a stop happened
 * without spawning anything, and the command's own path is exercised separately through the registry.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  listMcpServers,
  mcpModule,
  mcpProjectConfigPath,
  mcpTrustFilePath,
  mcpUserConfigPath,
  readMcpTrustFile,
  setMcpServerTrust,
  updateMcpServer,
  type McpEnv,
} from '../../conveyor/modules/mcp'
import {
  MCP_CONFIG_INVALID,
  MCP_SERVER_NOT_FOUND,
  MCP_SERVER_NOT_RUNNING,
  readMcpTrustEntry,
  type McpServerPatch,
} from '../../conveyor/protocol/mcp'

const results: string[] = []
const dirs: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeEnv(): McpEnv {
  return {
    appDataPath: makeDir('sam-mcp-update-appdata-'),
    crypto: {
      encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64'),
      decrypt: (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8').replace(/^enc:/, ''),
    },
  }
}

function makeRoot(): string {
  const root = makeDir('sam-mcp-update-root-')
  mkdirSync(join(root, '.sam'), { recursive: true })
  return root
}

function serverRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    cwd: null,
    env: {},
    secretEnv: {},
    enabled: false,
    ...over,
  }
}

function writeProjectConfig(root: string, servers: unknown[], extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.sam'), { recursive: true })
  writeFileSync(mcpProjectConfigPath(root), JSON.stringify({ version: 1, ...extra, servers }, null, 2), 'utf8')
}

function writeUserConfig(env: McpEnv, servers: unknown[]): void {
  const path = mcpUserConfigPath(env.appDataPath)
  mkdirSync(join(env.appDataPath, 'era', 'settings'), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, servers }, null, 2), 'utf8')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function serversIn(path: string): Array<Record<string, unknown>> {
  return readJson(path).servers as Array<Record<string, unknown>>
}

function codeOf(error: unknown): string {
  if (!(error instanceof ConveyorError)) throw new Error(`expected a ConveyorError, got ${String(error)}`)
  return error.code
}

function notRunning(): Promise<void> {
  return Promise.reject(new ConveyorError(MCP_SERVER_NOT_RUNNING, 'the recorder has no running process'))
}

async function update(
  env: McpEnv,
  root: string,
  patch: McpServerPatch,
  stop: (serverId: string) => Promise<void> = notRunning
): Promise<{ id: string }> {
  return updateMcpServer(env, { scope: 'project', rootPath: root, serverId: 'filesystem', patch }, stop)
}

async function anUpdatePreservesTheRawRecordAndUnknownKeys() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(
    root,
    [
      {
        id: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['server-one'],
        env: { LOG_LEVEL: 'info' },
        secretEnv: { API_TOKEN: 'ciphertext-kept' },
        enabled: true,
        note: 'keep me',
      },
      serverRecord({ id: 'memory', note: 'untouched' }),
    ],
    { comment: 'hand-written' }
  )

  await update(env, root, { command: 'node', args: ['server-two'], env: { LOG_LEVEL: 'debug' } })

  const file = readJson(mcpProjectConfigPath(root))
  assert.equal(file.comment, 'hand-written', 'an unknown top-level key survives the update')
  const servers = file.servers as Array<Record<string, unknown>>
  assert.equal(servers[0].command, 'node', 'the changed command is stored')
  assert.deepEqual(servers[0].args, ['server-two'], 'and the changed arguments')
  assert.deepEqual(servers[0].env, { LOG_LEVEL: 'debug' }, 'and the changed environment')
  assert.equal(servers[0].note, 'keep me', 'while the unknown key on the same record stays')
  assert.equal(servers[0].secretEnv && (servers[0].secretEnv as Record<string, string>).API_TOKEN, 'ciphertext-kept')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(servers[0], 'cwd'),
    'a field the record never had is not invented by an update'
  )
  assert.ok(!Object.prototype.hasOwnProperty.call(servers[0], 'autoApprove'), 'and neither is the optional flag')
  assert.deepEqual(servers[1], serverRecord({ id: 'memory', note: 'untouched' }), 'the other record is untouched')

  results.push('an update writes the patched fields, keeps unknown keys, and never invents absent ones')
}

async function anUpdateInvalidatesProjectTrust() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])
  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })

  const before = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  assert.ok(readMcpTrustEntry((before.roots[root] ?? {}).filesystem), 'the grant is there before the update')

  await update(env, root, { command: 'node' })

  const after = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  assert.equal((after.roots[root] ?? {}).filesystem, undefined, 'the grant for this root and id is gone')
  assert.equal((await listMcpServers(env, root)).project[0].trust, 'absent', 'so the next read reports it absent')

  results.push('a successful project update invalidates the trust record for that root and id')
}

async function theRunningServerIsStoppedBeforeTheWrite() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', command: 'npx' })])

  let commandSeenByStop: unknown = null
  let stoppedId: string | null = null
  await update(env, root, { command: 'node' }, async (serverId) => {
    stoppedId = serverId
    const file = readJson(mcpProjectConfigPath(root))
    commandSeenByStop = (file.servers as Array<Record<string, unknown>>)[0].command
  })

  assert.equal(stoppedId, 'filesystem', 'the running server named by the update is the one stopped')
  assert.equal(commandSeenByStop, 'npx', 'the stop happened while the old command was still on disk')
  assert.equal(serversIn(mcpProjectConfigPath(root))[0].command, 'node', 'and the write followed it')

  results.push('a running server is stopped before the config write lands')
}

async function anUnknownIdIsNotFoundAndChangesNothing() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])
  const before = readFileSync(mcpProjectConfigPath(root), 'utf8')
  let stopped = false

  await assert.rejects(
    () =>
      updateMcpServer(
        env,
        { scope: 'project', rootPath: root, serverId: 'ghost', patch: { command: 'node' } },
        async () => {
          stopped = true
        }
      ),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'an unknown id is MCP_SERVER_NOT_FOUND'
  )
  assert.equal(stopped, false, 'nothing is stopped for an id that does not exist')
  assert.equal(readFileSync(mcpProjectConfigPath(root), 'utf8'), before, 'and nothing is written')

  results.push('an update for an unknown id is not-found and touches neither the runtime nor the file')
}

async function fieldsAreRefusedByTheSameRuleAsAdd() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])

  const cases: Array<[string, Record<string, unknown>]> = [
    ['blank command', { command: '   ' }],
    ['non-string command', { command: 42 }],
    ['non-string argument', { args: ['ok', 42] }],
    ['non-string cwd', { cwd: 42 }],
    ['non-string env value', { env: { LOG_LEVEL: 42 } }],
    ['non-boolean auto-approve', { autoApprove: 'yes' }],
  ]

  for (const [name, patch] of cases) {
    const before = readFileSync(mcpProjectConfigPath(root), 'utf8')
    let stopped = false
    await assert.rejects(
      () =>
        update(env, root, patch as McpServerPatch, async () => {
          stopped = true
        }),
      (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
      `${name} is refused by the config code`
    )
    assert.equal(stopped, false, `${name} does not stop a server before it is refused`)
    assert.equal(readFileSync(mcpProjectConfigPath(root), 'utf8'), before, `${name} writes nothing`)
  }

  results.push('a patch is refused by the same field rules as add, before the runtime or the file is touched')
}

async function aSecretNameMustBeAnEnvironmentName() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', secretEnv: { 'API-TOKEN': 'ciphertext' } })])
  const before = readFileSync(mcpProjectConfigPath(root), 'utf8')

  await assert.rejects(
    () => update(env, root, { command: 'node' }),
    (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
    'a stored secret name that could not be an environment variable is refused'
  )
  assert.equal(readFileSync(mcpProjectConfigPath(root), 'utf8'), before, 'and the record is left alone')

  results.push('an update refuses a stored secret name that is not a usable environment name')
}

async function aCorruptConfigIsNeverClobbered() {
  const env = makeEnv()
  const root = makeRoot()
  const path = mcpProjectConfigPath(root)
  const broken = '{ "version": 1, "servers": ['
  writeFileSync(path, broken, 'utf8')
  let stopped = false

  await assert.rejects(
    () =>
      update(env, root, { command: 'node' }, async () => {
        stopped = true
      }),
    (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
    'a corrupt config is still a whole-file failure'
  )
  assert.equal(stopped, false, 'and the runtime is not touched on the way to a refused write')
  assert.equal(readFileSync(path, 'utf8'), broken, 'while the file remains byte for byte as it was')

  results.push('a corrupt config keeps its whole-file failure semantics and is never overwritten')
}

async function aUserServerUpdatesWithoutATrustGate() {
  const env = makeEnv()
  writeUserConfig(env, [serverRecord({ id: 'filesystem' })])
  let stopped = false

  await updateMcpServer(
    env,
    { scope: 'user', rootPath: null, serverId: 'filesystem', patch: { command: 'node' } },
    async () => {
      stopped = true
    }
  )

  assert.equal(stopped, true, 'the user server is stopped like any other running server')
  assert.equal((await listMcpServers(env, null)).user[0].command, 'node', 'and the update lands')
  assert.deepEqual((await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))).roots, {}, 'with no trust file written')

  results.push('a user-scope update runs without a trust record and still stops before the write')
}

function member(name: string): { kind?: string; resolver: (opts: { input: unknown }) => Promise<unknown> } {
  const record = mcpModule.record as unknown as Record<
    string,
    { kind?: string; resolver?: (opts: { input: unknown }) => Promise<unknown> } | undefined
  >
  const found = record[name]
  if (!found?.resolver) throw new Error(`${name} is not registered as a callable member`)
  return found as { kind?: string; resolver: (opts: { input: unknown }) => Promise<unknown> }
}

async function theCommandIsRegisteredAndReadsItsPatch() {
  const appData = process.env.SAM_TEST_USER_DATA
  assert.ok(appData, 'the suite runs with a private app data directory')
  const env: McpEnv = {
    appDataPath: appData,
    crypto: {
      encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64'),
      decrypt: (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8').replace(/^enc:/, ''),
    },
  }
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'command-server' })])

  const updateServer = member('updateServer')
  assert.equal(updateServer.kind, 'command', 'the update is a command: it changes the file')
  const answer = (await updateServer.resolver({
    input: {
      scope: 'project',
      rootPath: root,
      serverId: 'command-server',
      patch: { command: 'node', autoApprove: true },
    },
  })) as { id: string }

  assert.equal(answer.id, 'command-server')
  const stored = serversIn(mcpProjectConfigPath(root))[0]
  assert.equal(stored.command, 'node')
  assert.equal(stored.autoApprove, true)
  const listed = (await listMcpServers(env, root)).project[0]
  assert.equal(listed.command, 'node', 'the command reads the same private app-data view the suite does')
  assert.equal(listed.autoApprove, true)

  results.push('mcp.updateServer is registered as a command and writes the patch it is handed')
}

async function aStopFailureOtherThanNotRunningAbortsTheWrite() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', command: 'npx' })])
  const before = readFileSync(mcpProjectConfigPath(root), 'utf8')

  await assert.rejects(
    () =>
      update(env, root, { command: 'node' }, async () => {
        throw new ConveyorError('MCP_SPAWN_FAILED', 'the process could not be stopped')
      }),
    (error: unknown) => codeOf(error) === 'MCP_SPAWN_FAILED',
    'a stop that fails for another reason is not swallowed'
  )
  assert.equal(readFileSync(mcpProjectConfigPath(root), 'utf8'), before, 'and the write never lands')

  results.push('a stop failure other than MCP_SERVER_NOT_RUNNING aborts the update before the write')
}

async function main() {
  try {
    await step('update: raw record + unknown keys', anUpdatePreservesTheRawRecordAndUnknownKeys)
    await step('update: trust invalidation', anUpdateInvalidatesProjectTrust)
    await step('update: stop before write', theRunningServerIsStoppedBeforeTheWrite)
    await step('update: not found', anUnknownIdIsNotFoundAndChangesNothing)
    await step('update: per-field refusals', fieldsAreRefusedByTheSameRuleAsAdd)
    await step('update: secret-name rule', aSecretNameMustBeAnEnvironmentName)
    await step('update: corrupt config', aCorruptConfigIsNeverClobbered)
    await step('update: user scope', aUserServerUpdatesWithoutATrustGate)
    await step('update: command', theCommandIsRegisteredAndReadsItsPatch)
    await step('update: stop failure', aStopFailureOtherThanNotRunningAbortsTheWrite)

    console.log(`mcp server update: ${results.length} passed`)
    for (const result of results) console.log(`  pass: ${result}`)
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error('MCP SERVER UPDATE TEST FAILED:', error)
  process.exit(1)
})
