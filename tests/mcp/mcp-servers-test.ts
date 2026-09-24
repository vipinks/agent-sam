/**
 * Verifies the MCP server conveyor against real files in temp directories: the two scopes, per-server
 * error isolation, trust, and secret storage.
 *
 * Against the disk rather than a mock, because that is where the properties live. That a broken file is
 * refused instead of overwritten, that an unknown key somebody hand-wrote survives every write, and
 * that a secret reaches the file as ciphertext and never comes back out are all statements about bytes
 * on a disk — a mock would have to be told each of them, which is the same as not testing them.
 *
 * Every fixture is written under the OS temp directory. Nothing here creates `.sam/mcp.json` or a
 * settings file inside the repository, and each case gets its own root and app-data directory so no
 * case can read another's state.
 *
 * No electron in the read/write body: each function takes the paths it uses. Only the last case calls
 * the registered commands, which do read electron — the shared stub points that at this suite's private
 * app data directory, and it reports no OS keychain, which is how the real port's failure path is
 * exercised here.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  addMcpServer,
  assertMcpTrustMatched,
  clearMcpServerSecret,
  listMcpServers,
  mcpModule,
  mcpProjectConfigPath,
  mcpTrustFilePath,
  mcpUserConfigPath,
  readMcpConfigFile,
  readMcpTrustFile,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpServerSecret,
  setMcpServerTrust,
  type McpCryptoPort,
  type McpEnv,
  type McpTrustRead,
} from '../../conveyor/modules/mcp'
import {
  MCP_CONFIG_INVALID,
  MCP_SECRET_CRYPTO_FAILED,
  MCP_SERVER_DUPLICATE,
  MCP_SERVER_NOT_FOUND,
  MCP_TRUST_MISMATCH,
  readMcpTrustEntry,
} from '../../conveyor/protocol/mcp'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const dirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * Stands in for `safeStorage`: a real encoding of a real plaintext, so a case can prove that neither
 * the plaintext nor the ciphertext appears in what a listing carries, and that the ciphertext is what
 * the file holds.
 */
const fakeCrypto: McpCryptoPort = {
  encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64'),
}

/** The other half of the port's contract: an encryption that cannot happen at all. */
const failingCrypto: McpCryptoPort = {
  encrypt: () => {
    throw new Error('no OS keychain is available')
  },
}

function makeEnv(): McpEnv {
  return { appDataPath: makeDir('sam-mcp-appdata-'), crypto: fakeCrypto }
}

/** A project root, looked up the way the app looks it up: `<root>/.sam/mcp.json`. */
function makeRoot(): string {
  const root = makeDir('sam-mcp-root-')
  mkdirSync(join(root, '.sam'), { recursive: true })
  return root
}

/** One record, in the shape the design's example uses, with whatever the case cares about changed. */
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

/** What one file holds, read back as JSON: the assertion is about bytes, so it is read as bytes. */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** The code that was thrown. Never a message: a branch on wording is the defect these suites guard. */
function codeOf(error: unknown): string {
  if (!(error instanceof ConveyorError)) {
    throw new Error(`expected a ConveyorError, got ${String(error)}`)
  }
  return error.code
}

// ---------------------------------------------------------------- reading

async function aMissingFileIsAnEmptyList() {
  const env = makeEnv()
  const root = makeRoot()

  const read = await readMcpConfigFile(mcpProjectConfigPath(root), 'project')
  assert.equal(read.failure, null, 'no config file is not a failure')
  assert.deepEqual(read.entries, [], 'it is nothing to load')
  assert.deepEqual(read.errors, [], 'and nothing to report')
  assert.equal(read.document, null, 'with no document behind it')

  const listing = await listMcpServers(env, root)
  assert.deepEqual(listing, { user: [], project: [], errors: [] }, 'so both scopes are simply empty')

  const trust = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  assert.deepEqual(trust.roots, {}, 'and a missing trust file is no trust, which fails closed')

  results.push('a missing config file is an empty server list, and a missing trust file is no trust')
}

async function aBrokenFileIsRefusedAndNeverRewritten() {
  const env = makeEnv()
  const root = makeRoot()
  const path = mcpProjectConfigPath(root)
  const broken = '{ "version": 1, "servers": ['
  writeFileSync(path, broken, 'utf8')

  const read = await readMcpConfigFile(path, 'project')
  assert.equal(read.failure?.code, MCP_CONFIG_INVALID, 'unparseable JSON is a whole-file failure')
  assert.equal(read.failure?.scope, 'project', 'and it carries the scope it was read from')
  assert.deepEqual(read.entries, [], 'nothing is loaded out of it')

  await assert.rejects(
    () => addMcpServer(env, { scope: 'project', rootPath: root, server: { id: 'other', command: 'npx' } }),
    (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
    'a write refuses rather than replacing a file it could not read'
  )
  assert.equal(readFileSync(path, 'utf8'), broken, 'so the file is left byte for byte as it was')

  const listing = await listMcpServers(env, root)
  assert.deepEqual(
    listing.errors.map((error) => [error.scope, error.code]),
    [['project', MCP_CONFIG_INVALID]],
    'and the listing reports the file itself, with its scope'
  )

  results.push('a corrupt config is a scoped whole-file failure, and no write ever clobbers it')
}

async function oneBadRecordDoesNotStopItsSiblings() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [
    serverRecord({ id: 'good-one' }),
    serverRecord({ id: 'FileSystem' }),
    serverRecord({ id: 'bad-transport', transport: 'sse' }),
    serverRecord({ id: 'good-two' }),
  ])

  const listing = await listMcpServers(env, root)

  assert.deepEqual(
    listing.errors.map((error) => [error.id, error.code, error.scope]),
    [
      ['FileSystem', MCP_CONFIG_INVALID, 'project'],
      ['bad-transport', MCP_CONFIG_INVALID, 'project'],
    ],
    'each invalid record is its own error entry, by id, code and scope — and the file still loads'
  )

  results.push('an invalid record is isolated as a per-server error; its valid siblings still load')
}

// ---------------------------------------------------------------- scopes

async function theTwoScopesAreSeparate() {
  const env = makeEnv()
  const root = makeRoot()
  assert.equal(
    mcpUserConfigPath(env.appDataPath),
    join(env.appDataPath, 'era', 'settings', 'mcp-servers.json'),
    'the user scope is %APPDATA%\\era\\settings\\mcp-servers.json'
  )
  assert.equal(
    mcpProjectConfigPath(root),
    join(root, '.sam', 'mcp.json'),
    'and the project scope is <root>/.sam/mcp.json'
  )
  assert.equal(
    mcpTrustFilePath(env.appDataPath),
    join(env.appDataPath, 'era', 'settings', 'mcp-trust.json'),
    'trust records live beside the user config, not in the project'
  )

  writeUserConfig(env, [serverRecord({ id: 'user-one' })])
  writeProjectConfig(root, [serverRecord({ id: 'project-one' })])

  const both = await listMcpServers(env, root)
  assert.deepEqual(
    both.user.map((server) => server.id),
    ['user-one']
  )
  assert.deepEqual(
    both.project.map((server) => server.id),
    ['project-one']
  )
  assert.equal(both.user[0].trust, null, 'a user server is Boss-authored and carries no trust record')
  assert.equal(both.project[0].trust, 'absent', 'a project server nobody has trusted is absent')

  const noRoot = await listMcpServers(env, null)
  assert.deepEqual(
    noRoot.user.map((server) => server.id),
    ['user-one'],
    'the user scope is still read'
  )
  assert.deepEqual(noRoot.project, [], 'with no folder open there are no project servers')
  assert.deepEqual(noRoot.errors, [], 'and no project file is read, so nothing is reported for one')

  await assert.rejects(
    () => addMcpServer(env, { scope: 'project', rootPath: null, server: { id: 'ghost', command: 'npx' } }),
    (error: unknown) => codeOf(error) === 'NO_WORKSPACE',
    'writing to the project scope without an open folder is refused'
  )

  // And the two files never bleed into each other: a user-scope write leaves the project file alone.
  await addMcpServer(env, { scope: 'user', rootPath: null, server: { id: 'user-two', command: 'npx' } })
  const after = await listMcpServers(env, root)
  assert.deepEqual(
    after.user.map((server) => server.id),
    ['user-one', 'user-two']
  )
  assert.deepEqual(
    after.project.map((server) => server.id),
    ['project-one']
  )

  results.push('user and project scopes stay separate, and no root yields only the user servers')
}

// ---------------------------------------------------------------- writing

async function addingAServerRefusesADuplicateIdAndKeepsUnknownKeys() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', note: 'keep me' })], { comment: 'hand-written' })

  await assert.rejects(
    () => addMcpServer(env, { scope: 'project', rootPath: root, server: { id: 'filesystem', command: 'npx' } }),
    (error: unknown) => codeOf(error) === MCP_SERVER_DUPLICATE,
    'a duplicate id is refused by code'
  )
  assert.equal(
    (readJson(mcpProjectConfigPath(root)).servers as unknown[]).length,
    1,
    'and the refused add wrote nothing'
  )

  await assert.rejects(
    () => addMcpServer(env, { scope: 'project', rootPath: root, server: { id: '../escape', command: 'npx' } }),
    (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
    'an id that is not a slug is refused as a config error, not written as a path'
  )

  await addMcpServer(env, {
    scope: 'project',
    rootPath: root,
    server: { id: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  })

  const raw = readJson(mcpProjectConfigPath(root))
  assert.equal(raw.version, 1, 'the version the file carried is left alone')
  assert.equal(raw.comment, 'hand-written', 'an unknown top-level key survives the write')
  const servers = raw.servers as Array<Record<string, unknown>>
  assert.deepEqual(
    servers.map((server) => server.id),
    ['filesystem', 'memory']
  )
  assert.equal(servers[0].note, 'keep me', 'an unknown per-server key survives it too')
  assert.equal(servers[1].transport, 'stdio', 'a new record is written as a stdio server')
  assert.equal(servers[1].enabled, false, 'and starts switched off')
  assert.deepEqual(servers[1].args, ['-y', '@modelcontextprotocol/server-memory'])

  const written = await listMcpServers(env, root)
  assert.deepEqual(
    written.project.map((server) => server.id),
    ['filesystem', 'memory']
  )

  results.push('a duplicate id is refused by code, and unknown keys survive an add')
}

async function togglingEnabledNeitherInvalidatesTrustNorLosesKeys() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', note: 'keep me' })])
  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })
  const granted = trustRecord(await readMcpTrustFile(mcpTrustFilePath(env.appDataPath)), root, 'filesystem')

  await setMcpServerEnabled(env, { scope: 'project', rootPath: root, serverId: 'filesystem', enabled: true })

  const listing = await listMcpServers(env, root)
  assert.equal(listing.project[0].enabled, true, 'the flag the command was asked for is the flag stored')
  assert.equal(listing.project[0].trust, 'matched', 'switching a server on does not invalidate trust')

  const after = trustRecord(await readMcpTrustFile(mcpTrustFilePath(env.appDataPath)), root, 'filesystem')
  assert.deepEqual(after, granted, 'and the trust record itself is untouched, hash and timestamp alike')

  const servers = readJson(mcpProjectConfigPath(root)).servers as Array<Record<string, unknown>>
  assert.equal(servers[0].note, 'keep me', 'the unknown key on the record is still there')
  assert.equal(servers[0].enabled, true)

  await assert.rejects(
    () => setMcpServerEnabled(env, { scope: 'project', rootPath: root, serverId: 'gone', enabled: true }),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'a server that is not there is refused by code'
  )

  results.push('setEnabled writes the flag and nothing else — trust and unknown keys both survive')
}

async function removingAServerRemovesItsTrustRecord() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' }), serverRecord({ id: 'memory' })])
  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })
  await setMcpServerTrust(env, { rootPath: root, serverId: 'memory', trusted: true })

  await assert.rejects(
    () => removeMcpServer(env, { scope: 'project', rootPath: root, serverId: 'gone' }),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'removing a server that is not there is refused by code'
  )

  await removeMcpServer(env, { scope: 'project', rootPath: root, serverId: 'filesystem' })

  assert.deepEqual(
    (readJson(mcpProjectConfigPath(root)).servers as Array<Record<string, unknown>>).map((server) => server.id),
    ['memory'],
    'the record is gone from the file'
  )

  const trust = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  const forRoot = trust.roots[root] ?? {}
  assert.deepEqual(Object.keys(forRoot), ['memory'], 'and its trust record went with it')
  assert.equal(
    (await listMcpServers(env, root)).project[0].id,
    'memory',
    'the surviving server is still listed and still trusted'
  )
  assert.equal((await listMcpServers(env, root)).project[0].trust, 'matched')

  results.push('removing a server clears the trust record for that root and id, and reports a missing id')
}

// ---------------------------------------------------------------- trust

/** One trust record from a trust file, as the protocol reads it. */
function trustRecord(trust: McpTrustRead, root: string, id: string): unknown {
  return readMcpTrustEntry((trust.roots[root] ?? {})[id])
}

async function aGrantedTrustSurvivesTheFlagButNotAChange() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])

  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })
  assert.equal((await listMcpServers(env, root)).project[0].trust, 'matched', 'a fresh grant compares matched')

  const edits: Array<[string, Record<string, unknown>]> = [
    ['command', { command: 'node' }],
    ['args', { args: ['-y', 'another-package'] }],
    ['cwd', { cwd: 'C:\\work' }],
    ['env', { env: { PATH: '/other/bin' } }],
    ['secretEnv', { secretEnv: { TOKEN: 'AQAB' } }],
  ]

  for (const [field, change] of edits) {
    writeProjectConfig(root, [serverRecord({ ...change, id: 'filesystem' })])
    const state = (await listMcpServers(env, root)).project[0].trust
    assert.equal(state, 'mismatched', `editing ${field} invalidates the grant`)
    assert.throws(
      () => assertMcpTrustMatched('filesystem', state),
      (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
      `and the runtime guard refuses it with the mismatch code (${field})`
    )
  }

  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])
  assert.equal(
    (await listMcpServers(env, root)).project[0].trust,
    'matched',
    'putting the record back the way it was trusted restores the match: the hash is over content'
  )

  await setMcpServerEnabled(env, { scope: 'project', rootPath: root, serverId: 'filesystem', enabled: true })
  assert.equal(
    (await listMcpServers(env, root)).project[0].trust,
    'matched',
    'and the enabled toggle is still not part of it'
  )

  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: false })
  const revoked = (await listMcpServers(env, root)).project[0].trust
  assert.equal(revoked, 'absent', 'revoking leaves nothing to compare against')
  assert.throws(
    () => assertMcpTrustMatched('filesystem', revoked),
    (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
    'and a server that was never trusted is refused with the same code'
  )
  assert.doesNotThrow(() => assertMcpTrustMatched('filesystem', 'matched'), 'only a match passes the guard')

  writeUserConfig(env, [serverRecord({ id: 'user-only' })])
  await assert.rejects(
    () => setMcpServerTrust(env, { rootPath: root, serverId: 'user-only', trusted: true }),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'a user-scope server cannot be trusted: trust governs the project scope only'
  )

  results.push('trust is invalidated by every runnable change, survived by the enabled flag, and guarded by code')
}

// ---------------------------------------------------------------- secrets

async function aSecretIsStoredAsCiphertextAndNeverListedBack() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])
  const plaintext = 'super-secret-token-value'

  await setMcpServerSecret(env, {
    scope: 'project',
    rootPath: root,
    serverId: 'filesystem',
    name: 'API_TOKEN',
    value: plaintext,
  })

  const listing = await listMcpServers(env, root)
  const ciphertext = fakeCrypto.encrypt(plaintext)
  assert.deepEqual(
    listing.project[0].secrets,
    [{ name: 'API_TOKEN', set: true }],
    'a secret is listed as a name with a flag'
  )

  const payload = JSON.stringify(listing)
  assert.ok(!payload.includes(plaintext), 'the plaintext is nowhere in what the renderer receives')
  assert.ok(!payload.includes(ciphertext), 'and neither is the ciphertext')

  const stored = readFileSync(mcpProjectConfigPath(root), 'utf8')
  assert.ok(stored.includes(ciphertext), 'the file holds the ciphertext')
  assert.ok(!stored.includes(plaintext), 'and never the plaintext')

  await clearMcpServerSecret(env, {
    scope: 'project',
    rootPath: root,
    serverId: 'filesystem',
    name: 'API_TOKEN',
  })
  const cleared = await listMcpServers(env, root)
  assert.deepEqual(cleared.project[0].secrets, [], 'clearing removes the marker')
  assert.ok(!readFileSync(mcpProjectConfigPath(root), 'utf8').includes(ciphertext), 'and the stored value')

  // Clearing what was never set is not an error: the state the user asked for is the state they get.
  await clearMcpServerSecret(env, {
    scope: 'project',
    rootPath: root,
    serverId: 'filesystem',
    name: 'NEVER_SET',
  })

  await assert.rejects(
    () =>
      setMcpServerSecret(env, {
        scope: 'project',
        rootPath: root,
        serverId: 'filesystem',
        name: 'API-TOKEN',
        value: plaintext,
      }),
    (error: unknown) => codeOf(error) === MCP_CONFIG_INVALID,
    'a name that could not become an environment variable is refused'
  )

  results.push('setSecret stores ciphertext, listServers shows a name and a flag, clearSecret removes it')
}

async function anEncryptionFailureLeavesTheFileAlone() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])
  const before = readFileSync(mcpProjectConfigPath(root), 'utf8')

  await assert.rejects(
    () =>
      setMcpServerSecret(
        { appDataPath: env.appDataPath, crypto: failingCrypto },
        { scope: 'project', rootPath: root, serverId: 'filesystem', name: 'API_TOKEN', value: 'x' }
      ),
    (error: unknown) => codeOf(error) === MCP_SECRET_CRYPTO_FAILED,
    'an encryption that cannot happen is reported by its own code'
  )
  assert.equal(
    readFileSync(mcpProjectConfigPath(root), 'utf8'),
    before,
    'and nothing is written when a secret cannot be encrypted'
  )

  results.push('an encryption failure raises MCP_SECRET_CRYPTO_FAILED and leaves the file untouched')
}

// ---------------------------------------------------------------- the registered commands

/** One registered member, reached the way the suites reach the others. */
function member(name: string): { kind?: string; resolver: (opts: { input: unknown }) => Promise<unknown> } {
  const record = mcpModule.record as unknown as Record<
    string,
    { kind?: string; resolver?: (opts: { input: unknown }) => Promise<unknown> } | undefined
  >
  const found = record[name]
  if (!found?.resolver) throw new Error(`${name} is not registered as a callable member`)
  return found as { kind?: string; resolver: (opts: { input: unknown }) => Promise<unknown> }
}

async function theRegisteredCommandsReadTheScopesTheyAreToldTo() {
  // The user scope resolves through `app.getPath('appData')`, which the shared electron stub points at
  // this suite's private app data directory — never at the real user's settings.
  const appData = process.env.SAM_TEST_USER_DATA
  assert.ok(appData, 'the suite runs with a private app data directory')
  const env: McpEnv = { appDataPath: appData, crypto: fakeCrypto }
  writeUserConfig(env, [serverRecord({ id: 'user-fs' })])

  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'project-fs' })])

  const listServers = member('listServers')
  assert.equal(listServers.kind, 'query', 'the listing is a query: it reads and changes nothing')
  assert.ok((listServers as { input?: unknown }).input !== undefined, 'and it takes an input object')

  const result = (await listServers.resolver({ input: { rootPath: root } })) as {
    user: Array<{ id: string }>
    project: Array<{ id: string }>
    errors: unknown[]
  }
  assert.deepEqual(
    result.user.map((server) => server.id),
    ['user-fs']
  )
  assert.deepEqual(
    result.project.map((server) => server.id),
    ['project-fs']
  )
  assert.deepEqual(result.errors, [])

  const add = member('addServer')
  assert.equal(add.kind, 'command')
  await add.resolver({
    input: { scope: 'project', rootPath: root, server: { id: 'added-by-command', command: 'npx' } },
  })
  const again = (await listServers.resolver({ input: { rootPath: root } })) as {
    project: Array<{ id: string; enabled: boolean }>
  }
  assert.deepEqual(
    again.project.map((server) => server.id),
    ['project-fs', 'added-by-command'],
    'the command wrote the record the listing then reads'
  )
  assert.equal(again.project[1].enabled, false, 'switched off until the user turns it on')

  // The registered commands are wired to the real `safeStorage` port, and the shared electron stub
  // reports no keychain, so this is the real port's failure path rather than a stand-in's.
  await assert.rejects(
    () =>
      member('setSecret').resolver({
        input: { scope: 'project', rootPath: root, serverId: 'project-fs', name: 'API_TOKEN', value: 'x' },
      }),
    (error: unknown) => codeOf(error) === MCP_SECRET_CRYPTO_FAILED,
    'with no OS keychain, a secret cannot be stored, and the command says so by code'
  )

  results.push('the registered commands read input scopes and refuse to store a secret without a keychain')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('read: missing file', aMissingFileIsAnEmptyList)
    await step('read: corrupt file', aBrokenFileIsRefusedAndNeverRewritten)
    await step('read: per-server isolation', oneBadRecordDoesNotStopItsSiblings)
    await step('scopes: separate', theTwoScopesAreSeparate)
    await step('write: add + duplicate', addingAServerRefusesADuplicateIdAndKeepsUnknownKeys)
    await step('write: setEnabled', togglingEnabledNeitherInvalidatesTrustNorLosesKeys)
    await step('write: remove + trust', removingAServerRemovesItsTrustRecord)
    await step('trust: lifecycle', aGrantedTrustSurvivesTheFlagButNotAChange)
    await step('secrets: set, list, clear', aSecretIsStoredAsCiphertextAndNeverListedBack)
    await step('secrets: crypto failure', anEncryptionFailureLeavesTheFileAlone)
    await step('commands: registered', theRegisteredCommandsReadTheScopesTheyAreToldTo)

    console.log(`mcp servers: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('MCP SERVERS TEST FAILED:', err)
  process.exit(1)
})
