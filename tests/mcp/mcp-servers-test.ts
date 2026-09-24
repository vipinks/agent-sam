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
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
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
  setMcpServerAutoApprove,
  setMcpServerEnabled,
  setMcpServerSecret,
  setMcpServerTrust,
  startMcpServer,
  type McpCryptoPort,
  type McpEnv,
  type McpTrustRead,
} from '../../conveyor/modules/mcp'
import type { McpRuntime, McpStartRequest } from '../../conveyor/modules/mcp-runtime'
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
 *
 * The decrypt half mirrors what the real port does with the same base64, which is what lets a start be
 * driven end to end from here: a stored secret has to come back out as the plaintext a child would be
 * spawned with, and the only way to prove that outside Electron is to have a keychain that behaves
 * like one.
 */
const fakeCrypto: McpCryptoPort = {
  encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64'),
  decrypt: (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8').replace(/^enc:/, ''),
}

/** The other half of the port's contract: an encryption that cannot happen at all. */
const failingCrypto: McpCryptoPort = {
  encrypt: () => {
    throw new Error('no OS keychain is available')
  },
  decrypt: () => {
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
    ['autoApprove', { autoApprove: true }],
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

  // The flag, through the command rather than through a hand-edited file: same answer, which is what
  // makes the row's mismatch after a toggle something the existing rule produced rather than something
  // the screen decided. Turning it on changes what the server may do, so the grant it was given for the
  // old behaviour no longer describes it — and re-trusting is the one way back.
  await setMcpServerAutoApprove(env, { scope: 'project', rootPath: root, serverId: 'filesystem', value: true })
  assert.equal(
    (await listMcpServers(env, root)).project[0].trust,
    'mismatched',
    "flipping a server's own auto-approve moves the hash the grant was made against"
  )
  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })
  assert.equal(
    (await listMcpServers(env, root)).project[0].trust,
    'matched',
    'and one re-trust of the server the user just flagged puts the row back in order'
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

// ---------------------------------------------------------------- auto-approve flag

/**
 * The per-server flag: one field, and absent means off.
 *
 * A pair of properties, and they are the pair that makes a flag safe to add to files that already have
 * servers in them: reading a record that never had the key says off without writing the key, and writing
 * it is one field's worth of writing. The rest is the validator's own rule and the command's own rule —
 * a value that is present and not a boolean is that one record's error rather than a guess, and a flag
 * cannot be written against an id nothing answers for, because that would be a flag with no server
 * behind it.
 */
async function theAutoApproveFlagIsOneFieldAndAbsentMeansOff() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [
    // A record spelled the way a file written before the flag existed spells one: no key, and one key
    // this build knows nothing about.
    {
      id: 'legacy',
      transport: 'stdio',
      command: 'npx',
      args: [],
      cwd: null,
      env: {},
      secretEnv: {},
      enabled: true,
      somethingElse: 'kept',
    },
    serverRecord({ id: 'flagged', autoApprove: true }),
    serverRecord({ id: 'plain', enabled: false }),
  ])

  const listed = await listMcpServers(env, root)
  assert.deepEqual(
    listed.project.map((server) => [server.id, server.autoApprove]),
    [
      ['legacy', false],
      ['flagged', true],
      ['plain', false],
    ],
    'a record without the key reads as off, a flagged one reads as on, and the view always says one or the other'
  )
  assert.equal(listed.errors.length, 0, 'and none of them is an error')

  const afterRead = readJson(mcpProjectConfigPath(root)).servers as Array<Record<string, unknown>>
  assert.ok(
    !Object.prototype.hasOwnProperty.call(afterRead[0], 'autoApprove'),
    'reading a server does not write the key it read as absent: the file is untouched until a toggle writes it'
  )

  // A write to one record, and a write to the flag of another: neither may touch anything else.
  await setMcpServerEnabled(env, { scope: 'project', rootPath: root, serverId: 'plain', enabled: true })
  await setMcpServerAutoApprove(env, { scope: 'project', rootPath: root, serverId: 'flagged', value: false })

  const written = readJson(mcpProjectConfigPath(root)).servers as Array<Record<string, unknown>>
  assert.equal(written[1].autoApprove, false, 'switching the flag off writes the off the user chose')
  assert.equal(written[1].enabled, false, 'the record the flag was written to keeps its other fields')
  assert.equal(written[2].enabled, true, 'and the unrelated write is the only thing that changed on its record')
  assert.equal(written[0].somethingElse, 'kept', 'an unknown key survives every write, as it always has')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(written[0], 'autoApprove'),
    'and a record that never had the flag is never given one'
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(written[1], 'autoApprove'),
    true,
    'while the record the user toggled does hold the key, because that is what they decided'
  )

  await setMcpServerAutoApprove(env, { scope: 'project', rootPath: root, serverId: 'plain', value: true })
  assert.equal(
    (await listMcpServers(env, root)).project[2].autoApprove,
    true,
    'and flagging a server that had no key at all is written and read back'
  )

  await assert.rejects(
    () => setMcpServerAutoApprove(env, { scope: 'project', rootPath: root, serverId: 'nowhere', value: true }),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'a flag cannot be written against an id nothing in that scope answers for'
  )

  // A value that is there and not a boolean is refused rather than coerced: `"true"` is a guess, and a
  // guess here would turn a hand-edit into a server whose tools run without asking.
  writeProjectConfig(root, [serverRecord({ id: 'bad-flag', autoApprove: 'yes' }), serverRecord({ id: 'good' })])
  const invalid = await listMcpServers(env, root)
  assert.deepEqual(
    invalid.errors.map((error) => [error.id, error.code, error.scope]),
    [['bad-flag', MCP_CONFIG_INVALID, 'project']],
    "a present non-boolean flag is that one record's error, under the config code"
  )
  assert.deepEqual(
    invalid.project.map((server) => server.id),
    ['good'],
    'and the valid sibling still loads'
  )

  results.push(
    "the auto-approve flag is one optional field: absent reads as off, toggling writes it, and a bad value is one record's error"
  )
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

async function theListingCarriesThePlainEnvAndStillHidesTheSecrets() {
  const env = makeEnv()
  const root = makeRoot()
  const plainEnv = { GREETING: 'hello', LOG_LEVEL: 'debug' }
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', env: plainEnv })])
  await setMcpServerSecret(env, {
    scope: 'project',
    rootPath: root,
    serverId: 'filesystem',
    name: 'API_TOKEN',
    value: 'secret-value',
  })

  const listing = await listMcpServers(env, root)
  assert.deepEqual(
    listing.project[0].env,
    plainEnv,
    'the non-secret env travels with the server, keys and values: it is configuration, and a UI has to prefill it'
  )
  assert.deepEqual(
    listing.project[0].secrets,
    [{ name: 'API_TOKEN', set: true }],
    'while a secret is still a name and a flag, and nothing else'
  )

  const payload = JSON.stringify(listing)
  assert.ok(payload.includes('debug'), 'the plain value is on the wire')
  assert.ok(!payload.includes('secret-value'), 'and no secret plaintext is')
  assert.ok(!payload.includes(fakeCrypto.encrypt('secret-value')), 'nor its ciphertext')
  assert.ok(!payload.includes('secretEnv'), 'nor the secretEnv block itself: the raw record is not what travels')

  results.push('listServers carries the plain env and still carries no secret in either form')
}

// ---------------------------------------------------------------- the runtime hand-off

/**
 * A runtime that records what it was asked to start instead of starting it.
 *
 * Handing over a config, its decrypted secrets and the trust state read from the disk is the command's
 * whole job; whether a process then appears is the runtime's, and the runtime suite is where that is
 * proved. This is the seam that keeps the two halves separately accountable.
 */
function recordingRuntime(): { requests: McpStartRequest[]; start: McpRuntime['startServer'] } {
  const requests: McpStartRequest[] = []
  return {
    requests,
    start: async (request) => {
      requests.push(request)
      return [
        { name: 'echo', description: 'Answer with the text it was given.', inputSchema: { type: 'object' } },
      ] as Tool[]
    },
  }
}

async function aStartHandsTheRuntimeTheConfigItsSecretsAndItsTrust() {
  const env = makeEnv()
  const root = makeRoot()
  const plainEnv = { LOG_LEVEL: 'debug' }
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', args: ['-y', 'server-one'], env: plainEnv })])
  await setMcpServerSecret(env, {
    scope: 'project',
    rootPath: root,
    serverId: 'filesystem',
    name: 'API_TOKEN',
    value: 'token-plain',
  })
  await setMcpServerTrust(env, { rootPath: root, serverId: 'filesystem', trusted: true })

  const granted = recordingRuntime()
  const answer = await startMcpServer(env, { scope: 'project', rootPath: root, serverId: 'filesystem' }, granted.start)

  assert.equal(answer.id, 'filesystem', 'the command answers under the id it was asked for')
  assert.deepEqual(
    answer.tools.map((tool) => tool.name),
    ['echo'],
    'with the tools the runtime discovered'
  )
  assert.equal(granted.requests.length, 1, 'and the runtime was asked exactly once')

  const request = granted.requests[0]
  assert.equal(request.scope, 'project')
  assert.equal(request.trust, 'matched', 'a grant that matches on disk is the state the runtime is handed')
  assert.deepEqual(request.config.env, plainEnv, 'the plain env goes to the child as it was configured')
  assert.deepEqual(
    request.plaintextSecrets,
    { API_TOKEN: 'token-plain' },
    'and the secret arrives decrypted, not as the ciphertext the file holds'
  )
  assert.ok(
    !JSON.stringify(request).includes(fakeCrypto.encrypt('token-plain')),
    'so the ciphertext is not handed on at all'
  )

  // A config edited after the grant describes a different server, and the state read back says so — so
  // the start is refused by code, and the runtime is never asked to run it. The guard is the same one the
  // runtime applies, and it is applied here as well because this is where the config and the grant are
  // both in hand: a caller that could not spawn anything at all is the outcome a refusal should have.
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', args: ['-y', 'server-two'], env: plainEnv })])
  const edited = recordingRuntime()
  await assert.rejects(
    () => startMcpServer(env, { scope: 'project', rootPath: root, serverId: 'filesystem' }, edited.start),
    (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
    'a server edited since its grant is refused with MCP_TRUST_MISMATCH'
  )
  assert.deepEqual(edited.requests, [], 'and the runtime is handed nothing to run')

  // A server nobody has ever trusted is refused the same way, not merely counted as untrusted.
  writeProjectConfig(root, [serverRecord({ id: 'stranger' })])
  const stranger = recordingRuntime()
  await assert.rejects(
    () => startMcpServer(env, { scope: 'project', rootPath: root, serverId: 'stranger' }, stranger.start),
    (error: unknown) => codeOf(error) === MCP_TRUST_MISMATCH,
    'an absent grant is refused with the same code as a changed one'
  )
  assert.deepEqual(stranger.requests, [], 'and that start never reaches the runtime either')

  // The user scope states no trust at all, because trust does not govern it.
  writeUserConfig(env, [serverRecord({ id: 'user-fs' })])
  const user = recordingRuntime()
  await startMcpServer(env, { scope: 'user', rootPath: null, serverId: 'user-fs' }, user.start)
  assert.equal(user.requests[0].scope, 'user')
  assert.ok(!('trust' in user.requests[0]), 'a user start carries no trust field, because none applies to it')

  results.push('a start hands the runtime the config, its decrypted secrets and the trust state read from disk')
}

async function aSecretThatCannotBeDecryptedStopsTheStart() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem', secretEnv: { API_TOKEN: 'ciphertext-1' } })])

  const recorder = recordingRuntime()
  await assert.rejects(
    () =>
      startMcpServer(
        { appDataPath: env.appDataPath, crypto: failingCrypto },
        { scope: 'project', rootPath: root, serverId: 'filesystem' },
        recorder.start
      ),
    (error: unknown) => codeOf(error) === MCP_SECRET_CRYPTO_FAILED,
    'a secret that cannot be decrypted fails by code rather than running a server without its credentials'
  )
  assert.deepEqual(recorder.requests, [], 'and the runtime is never asked to run it')

  results.push('a secret that cannot be decrypted stops a start with MCP_SECRET_CRYPTO_FAILED')
}

async function aStartForAServerThatIsNotThereIsNotFound() {
  const env = makeEnv()
  const root = makeRoot()
  writeProjectConfig(root, [serverRecord({ id: 'filesystem' })])

  const recorder = recordingRuntime()
  await assert.rejects(
    () => startMcpServer(env, { scope: 'project', rootPath: root, serverId: 'ghost' }, recorder.start),
    (error: unknown) => codeOf(error) === MCP_SERVER_NOT_FOUND,
    'starting a server the file does not hold is not-found, not a spawn attempt'
  )
  assert.deepEqual(recorder.requests, [], 'and nothing is handed to the runtime')

  results.push('a start for a server that is not configured is refused by code, before the runtime is asked')
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
    await step('flag: one field, absent means off', theAutoApproveFlagIsOneFieldAndAbsentMeansOff)
    await step('secrets: crypto failure', anEncryptionFailureLeavesTheFileAlone)
    await step('commands: registered', theRegisteredCommandsReadTheScopesTheyAreToldTo)
    await step('listing: plain env, no secrets', theListingCarriesThePlainEnvAndStillHidesTheSecrets)
    await step('start: config, secrets, trust', aStartHandsTheRuntimeTheConfigItsSecretsAndItsTrust)
    await step('start: undecryptable secret', aSecretThatCannotBeDecryptedStopsTheStart)
    await step('start: unknown server', aStartForAServerThatIsNotThereIsNotFound)

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
