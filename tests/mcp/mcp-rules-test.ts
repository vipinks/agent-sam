/**
 * Verifies the MCP stdio config rules: what a config file may contain, what a server id may be, and
 * what a trust hash actually covers.
 *
 * Pure by construction — the file these rules describe is read and written by `modules/mcp.ts`, and
 * nothing here touches the disk. That is the point: the rules are what a later turn's runtime and the
 * trust guard branch on, so they have to be provable without a config file or an Electron app in the
 * way. Same split, and same reason, as `protocol/skills.ts` against `modules/skills.ts`.
 *
 * The codes are asserted rather than the wording, because the code is the contract.
 */
import { strict as assert } from 'node:assert'
import {
  canonicalJson,
  compareMcpTrust,
  hashMcpServerConfig,
  isSafeMcpSecretKey,
  isSafeMcpServerId,
  MAX_MCP_SERVER_ID_CHARS,
  MCP_CONFIG_INVALID,
  MCP_TRANSPORT_STDIO,
  parseMcpConfigText,
  secretEnvListing,
  validateMcpServerRecord,
  type McpConfigParse,
  type McpServerConfig,
} from '../../conveyor/protocol/mcp'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

/** The record the design's own example uses, so the fixtures read like the file they stand for. */
const BASE_SERVER: Record<string, unknown> = {
  id: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  cwd: null,
  env: { PATH: '/usr/bin' },
  secretEnv: { TOKEN: 'AQAA' },
  enabled: false,
}

/** A whole config file holding one record. */
function textWith(server: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, servers: [server] })
}

/** Parse a file that is expected to be well-formed, so a broken fixture fails loudly here. */
function parseOk(text: string): McpConfigParse {
  const parsed = parseMcpConfigText(text, 'project')
  if (parsed.failure) throw new Error(`fixture did not parse: ${parsed.failure.message}`)
  return parsed
}

/** The normalized meaning of one record, through the real parser rather than a reimplementation. */
function configOf(server: Record<string, unknown>): McpServerConfig {
  const parsed = parseOk(textWith(server))
  if (parsed.entries.length !== 1) throw new Error(`fixture parsed to ${parsed.entries.length} servers`)
  return parsed.entries[0].config
}

// ---------------------------------------------------------------- the file

function aValidFileParses() {
  const parsed = parseMcpConfigText(textWith({ ...BASE_SERVER, note: 'hand-written' }), 'project')

  assert.equal(parsed.failure, null, 'a well-formed file is not a failure')
  assert.deepEqual(parsed.errors, [], 'and has nothing to report per server')
  assert.deepEqual(
    parsed.entries.map((entry) => entry.config.id),
    ['filesystem']
  )

  const entry = parsed.entries[0]
  assert.equal(entry.config.transport, MCP_TRANSPORT_STDIO)
  assert.equal(entry.config.command, 'npx')
  assert.deepEqual(entry.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '.'])
  assert.equal(entry.config.cwd, null)
  assert.deepEqual(entry.config.env, { PATH: '/usr/bin' })
  assert.deepEqual(entry.config.secretEnv, { TOKEN: 'AQAA' })
  assert.equal(entry.config.enabled, false)

  // Unknown keys survive the parse on both levels, which is what lets every write put them back.
  assert.equal(parsed.document?.comment, undefined)
  assert.equal(entry.raw.note, 'hand-written')
  assert.equal(
    (
      parseMcpConfigText(JSON.stringify({ version: 1, comment: 'keep me', servers: [] }), 'project').document as Record<
        string,
        unknown
      >
    ).comment,
    'keep me'
  )

  // Absent optional fields are normalized in the meaning only: the raw record keeps exactly what the
  // file wrote, so a write can never add a default that was absent.
  const bare = parseOk(textWith({ id: 'bare', transport: 'stdio', command: 'npx' })).entries[0]
  assert.deepEqual(bare.config, {
    id: 'bare',
    transport: MCP_TRANSPORT_STDIO,
    command: 'npx',
    args: [],
    cwd: null,
    env: {},
    secretEnv: {},
    enabled: false,
    autoApprove: false,
  })
  assert.deepEqual(
    Object.keys(bare.raw).sort(),
    ['command', 'id', 'transport'],
    'and the raw record is left as the file wrote it'
  )

  results.push('a well-formed config parses into normalized meaning while the raw record is preserved')
}

function anUnparseableFileIsAWholeFileFailure() {
  const parsed = parseMcpConfigText('{ "version": 1, "servers": [', 'project')

  assert.deepEqual(parsed.entries, [], 'nothing loads from a file that is not JSON')
  assert.equal(parsed.failure?.code, MCP_CONFIG_INVALID, 'the failure carries the config code')
  assert.equal(parsed.failure?.scope, 'project', 'and the scope it was read from')
  assert.equal(parsed.document, null, 'with no document to write back')

  const array = parseMcpConfigText('[]', 'user')
  assert.equal(array.failure?.code, MCP_CONFIG_INVALID, 'a JSON array is not a config file either')
  assert.equal(array.failure?.scope, 'user')

  const notAList = parseMcpConfigText('{"version":1,"servers":{}}', 'project')
  assert.equal(notAList.failure?.code, MCP_CONFIG_INVALID, 'and neither is a servers key that is not a list')

  const noServers = parseMcpConfigText('{"version":1}', 'project')
  assert.equal(noServers.failure, null, 'a file that declares no servers is an empty list, not a failure')
  assert.deepEqual(noServers.entries, [])

  results.push('unparseable JSON is a whole-file failure carrying its scope; an empty file is not')
}

function oneBadRecordDoesNotStopItsSiblings() {
  const parsed = parseMcpConfigText(
    JSON.stringify({
      version: 1,
      servers: [
        { ...BASE_SERVER, id: 'good-one' },
        { ...BASE_SERVER, id: 'FileSystem' },
        { ...BASE_SERVER, id: '../escape' },
        { ...BASE_SERVER, id: 'bad-transport', transport: 'sse' },
        { ...BASE_SERVER, id: 'no-command', command: '   ' },
        { ...BASE_SERVER, id: 'bad-env', env: { PATH: 3 } },
        'not an object',
        { ...BASE_SERVER, id: 'good-two' },
      ],
    }),
    'project'
  )

  assert.equal(parsed.failure, null, 'a file with bad records in it still loads')
  assert.deepEqual(
    parsed.entries.map((entry) => entry.config.id),
    ['good-one', 'good-two'],
    'the valid records load around the invalid ones'
  )
  assert.deepEqual(
    parsed.errors.map((error) => error.id),
    ['FileSystem', '../escape', 'bad-transport', 'no-command', 'bad-env', null],
    'each invalid record is reported by the id it claimed, in file order — null when it claimed none'
  )
  assert.deepEqual(
    parsed.errors.map((error) => error.code),
    [
      MCP_CONFIG_INVALID,
      MCP_CONFIG_INVALID,
      MCP_CONFIG_INVALID,
      MCP_CONFIG_INVALID,
      MCP_CONFIG_INVALID,
      MCP_CONFIG_INVALID,
    ],
    'and all of them are per-server config errors, never a whole-file failure'
  )
  assert.deepEqual(
    parsed.errors.map((error) => error.scope),
    ['project', 'project', 'project', 'project', 'project', 'project']
  )

  const duplicated = parseMcpConfigText(
    JSON.stringify({
      version: 1,
      servers: [
        { ...BASE_SERVER, id: 'twice' },
        { ...BASE_SERVER, id: 'twice' },
      ],
    }),
    'project'
  )
  assert.deepEqual(
    duplicated.entries.map((entry) => entry.config.id),
    ['twice'],
    'one id names one server, so a hand-written duplicate is reported rather than loaded twice'
  )
  assert.equal(duplicated.errors[0]?.code, MCP_CONFIG_INVALID)

  results.push('an invalid record is isolated as its own error while its valid siblings load')
}

// ---------------------------------------------------------------- ids

function theIdRuleRefusesWhatCouldBecomeAPath() {
  for (const id of ['filesystem', 'fs.server', 'my-server_2', 'a', '0-files']) {
    assert.equal(isSafeMcpServerId(id), true, `${id} is a usable id`)
  }

  for (const id of [
    'FileSystem',
    '../escape',
    'a/b',
    'a\\b',
    'C:\\x',
    '.hidden',
    'has space',
    '',
    '-lead',
    'x'.repeat(MAX_MCP_SERVER_ID_CHARS + 1),
  ]) {
    assert.equal(isSafeMcpServerId(id), false, `${JSON.stringify(id)} is not a usable id`)
  }

  assert.equal(isSafeMcpServerId(undefined), false)
  assert.equal(isSafeMcpServerId(7), false)

  // The id is a key and a label, never a path segment: a record with a path in its id is refused
  // rather than joined to anything.
  const checked = validateMcpServerRecord({ ...BASE_SERVER, id: '../../etc/passwd' }, 'user', 0)
  assert.equal(checked.ok, false)
  assert.equal(checked.ok === false ? checked.error.code : null, MCP_CONFIG_INVALID)

  results.push('the id rule is a lowercase slug and refuses every path-shaped or uppercase id')
}

function theSecretKeyRuleMatchesWhatCanBecomeAnEnvironmentVariable() {
  for (const name of ['TOKEN', 'API_TOKEN', '_private', 'a1']) {
    assert.equal(isSafeMcpSecretKey(name), true, `${name} is a usable secret name`)
  }
  for (const name of ['A-B', '1TOKEN', '', 'A B', 'A=B', 'TOKEN;rm']) {
    assert.equal(isSafeMcpSecretKey(name), false, `${JSON.stringify(name)} is not a usable secret name`)
  }

  results.push('a secret name has to be an environment name, because that is what it becomes')
}

// ---------------------------------------------------------------- trust

function theHashIgnoresKeyOrderAndTheEnabledFlag() {
  // The same record written with its maps in the opposite order: the hash is over meaning, not
  // spelling, so a re-saved file does not invalidate trust.
  const one = configOf({ ...BASE_SERVER, env: { PATH: '/usr/bin', HOME: '/home/u' } })
  const two = configOf({ ...BASE_SERVER, env: { HOME: '/home/u', PATH: '/usr/bin' } })
  assert.equal(hashMcpServerConfig(one), hashMcpServerConfig(two), 'key order in the file does not move the hash')

  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
    'canonical JSON sorts every object recursively'
  )
  assert.equal(canonicalJson([1, 'x', null]), '[1,"x",null]')

  const off = configOf({ ...BASE_SERVER, enabled: false })
  const on = configOf({ ...BASE_SERVER, enabled: true })
  assert.equal(off.enabled, false)
  assert.equal(on.enabled, true)
  assert.equal(
    hashMcpServerConfig(off),
    hashMcpServerConfig(on),
    'switching a server on or off is not a change to what it runs'
  )

  // The hash is over exactly the fields that decide what will be executed, and the flag is one of them
  // because it decides whether the call is put to the user at all.
  assert.equal(
    hashMcpServerConfig(off),
    hashMcpServerConfig(configOf({ ...BASE_SERVER, enabled: true, note: 'hand-written' })),
    'and an unknown key is not part of it either'
  )

  assert.notEqual(
    hashMcpServerConfig(off),
    hashMcpServerConfig(configOf({ ...BASE_SERVER, autoApprove: true })),
    'while the per-server auto-approve flag is: it changes what the grant permits, not just when it runs'
  )

  results.push('the trust hash is canonical, and the enabled flag is not part of it')
}

function everyRunnableFieldIsCoveredByTheHash() {
  const base = hashMcpServerConfig(configOf(BASE_SERVER))

  const changes: Array<[string, Record<string, unknown>]> = [
    ['command', { command: 'node' }],
    ['args', { args: ['-y', 'another-package'] }],
    ['cwd', { cwd: 'C:\\work' }],
    ['env', { env: { PATH: '/other/bin' } }],
    ['secretEnv', { secretEnv: { TOKEN: 'AQAB' } }],
    ['autoApprove', { autoApprove: true }],
  ]

  for (const [what, change] of changes) {
    assert.notEqual(
      hashMcpServerConfig(configOf({ ...BASE_SERVER, ...change })),
      base,
      `changing ${what} invalidates the hash`
    )
  }

  results.push('command, args, cwd, env, secretEnv and autoApprove each move the hash; nothing else does')
}

function theTrustComparisonHasThreeAnswers() {
  const config = configOf(BASE_SERVER)
  const hash = hashMcpServerConfig(config)
  const trustedAt = '2026-09-24T00:00:00.000Z'

  assert.equal(compareMcpTrust(config, { configHash: hash, trustedAt }), 'matched', 'the recorded hash matches')
  assert.equal(
    compareMcpTrust(config, { configHash: hash, trustedAt: '2026-01-01T00:00:00.000Z' }),
    'matched',
    'when it was trusted is a diary entry, not part of the comparison'
  )
  // A hash that differs in exactly one character, and cannot accidentally equal the real one.
  const otherHash = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`
  assert.equal(
    compareMcpTrust(config, { configHash: otherHash, trustedAt }),
    'mismatched',
    'a different hash is a mismatch'
  )
  assert.equal(compareMcpTrust(config, null), 'absent', 'no record is absent')
  assert.equal(compareMcpTrust(config, undefined), 'absent')
  assert.equal(compareMcpTrust(config, { configHash: 3 }), 'absent', 'and a record that is not one is absent')
  assert.equal(compareMcpTrust(config, 'nonsense'), 'absent')

  results.push('the trust comparison answers matched, mismatched or absent, and fails closed on nonsense')
}

// ---------------------------------------------------------------- secrets

function aSecretIsListedByNameAndNeverByValue() {
  const config = configOf({ ...BASE_SERVER, secretEnv: { TOKEN: 'AQAA', EMPTY: '' } })
  const listed = secretEnvListing(config)

  assert.deepEqual(listed, [
    { name: 'TOKEN', set: true },
    { name: 'EMPTY', set: false },
  ])

  const payload = JSON.stringify(listed)
  assert.ok(payload.includes('TOKEN'), 'the name is carried, which is what makes the flag actionable')
  assert.ok(!payload.includes('AQAA'), 'and no value under it: not the ciphertext, and not any plaintext')

  results.push('a secret is exposed as a name with a flag: no plaintext and no ciphertext')
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('file: valid', aValidFileParses)
  await step('file: unparseable', anUnparseableFileIsAWholeFileFailure)
  await step('file: per-server isolation', oneBadRecordDoesNotStopItsSiblings)
  await step('id: slug rule', theIdRuleRefusesWhatCouldBecomeAPath)
  await step('id: secret names', theSecretKeyRuleMatchesWhatCanBecomeAnEnvironmentVariable)
  await step('hash: canonical form', theHashIgnoresKeyOrderAndTheEnabledFlag)
  await step('hash: coverage', everyRunnableFieldIsCoveredByTheHash)
  await step('trust: comparison', theTrustComparisonHasThreeAnswers)
  await step('secrets: listing', aSecretIsListedByNameAndNeverByValue)

  console.log(`mcp rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('MCP RULES TEST FAILED:', err)
  process.exit(1)
})
