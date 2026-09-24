/**
 * MCP server configuration, trust, and secret storage, on the disk.
 *
 * The rules live in `conveyor/protocol/mcp.ts`; this file is the part that touches the filesystem and
 * Electron. Two config files, one trust file, and seven commands — and no runtime: nothing here starts
 * a process or exposes a tool. That is the point of this phase, and the reason every function below
 * takes its paths as arguments: the node suites drive the real decisions against seeded temp
 * directories instead of a reimplementation that could pass while the shipped code disagrees.
 *
 * The two scopes, and the difference between them:
 *
 * - user:    `%APPDATA%\era\settings\mcp-servers.json` — written by the user, available in every
 *            project, and gated by `enabled` plus a manual start (a later turn).
 * - project: `<root>/.sam/mcp.json` — travels with the repository, and is additionally gated by trust,
 *            because a file that arrived with a checkout is not something the user authored.
 *
 * Trust records live in `%APPDATA%\era\settings\mcp-trust.json`, keyed by root path and then by server
 * id. A grant is a sha256 over the five fields that decide what will run (see `protocol/mcp.ts`), so a
 * hand-edit to a trusted project server invalidates the grant and a toggle of `enabled` does not.
 *
 * Secrets. `mcp.setSecret` encrypts through the same `safeStorage` path provider API keys already use
 * and stores only the ciphertext, in the record's `secretEnv`. No command ever returns a plaintext or a
 * ciphertext: a listing carries the secret's *name* with a `set` flag, which is everything a UI needs to
 * show and nothing an attacker can use. Encryption is injected as `McpCryptoPort` for the suites; the
 * module member wires the real one in.
 *
 * Write semantics are whole-record preservation. Every write reads the file first and writes back the
 * same document with only the `servers` list replaced, and each record as it was written plus the one
 * field that changed. Unknown top-level keys and unknown per-server keys therefore survive, and a file
 * that never had `args` does not acquire one. A file that cannot be parsed is never overwritten at all:
 * refusing is what keeps a hand-broken config from losing every server the user typed into it.
 */
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, command } from '../init'
import {
  compareMcpTrust,
  hashMcpServerConfig,
  isSafeMcpSecretKey,
  MCP_CONFIG_INVALID,
  MCP_CONFIG_VERSION,
  MCP_SECRET_CRYPTO_FAILED,
  MCP_SERVER_DUPLICATE,
  MCP_SERVER_NOT_FOUND,
  MCP_TRANSPORT_STDIO,
  MCP_TRUST_MISMATCH,
  parseMcpConfigText,
  secretEnvListing,
  validateMcpServerRecord,
  type McpConfigParse,
  type McpScope,
  type McpServerConfigError,
  type McpServerEntry,
  type McpServerRaw,
  type McpTrustState,
} from '../protocol/mcp'

/** The `%APPDATA%` folder this app owns, the same one the user's skills live under. */
export const USER_SETTINGS_FOLDER = 'era'

/** The folder and file a project's MCP config lives in: `<root>/.sam/mcp.json`. */
export const PROJECT_CONFIG_FOLDER = '.sam'
export const PROJECT_CONFIG_FILE = 'mcp.json'

/** Where the user-scope files sit inside `%APPDATA%\era`. */
export const USER_CONFIG_FILE = ['settings', 'mcp-servers.json'] as const
export const USER_TRUST_FILE = ['settings', 'mcp-trust.json'] as const

/** The user-scope server list: `%APPDATA%\era\settings\mcp-servers.json`. */
export function mcpUserConfigPath(appDataPath: string): string {
  return join(appDataPath, USER_SETTINGS_FOLDER, ...USER_CONFIG_FILE)
}

/** The trust records: `%APPDATA%\era\settings\mcp-trust.json`, beside the user config. */
export function mcpTrustFilePath(appDataPath: string): string {
  return join(appDataPath, USER_SETTINGS_FOLDER, ...USER_TRUST_FILE)
}

/** The project-scope server list: `<root>/.sam/mcp.json`. */
export function mcpProjectConfigPath(rootPath: string): string {
  return join(rootPath, PROJECT_CONFIG_FOLDER, PROJECT_CONFIG_FILE)
}

/**
 * How a secret is encrypted.
 *
 * A port rather than a direct call, for the same reason the paths are arguments: the suites have to be
 * able to store a secret and prove that what comes back out is a name and a flag. `setSecret` treats a
 * throw from it as the only failure it can have — there is no keychain, or the keychain refused — and
 * reports both as `MCP_SECRET_CRYPTO_FAILED`, because from the caller's side they are one fact: this
 * secret could not be stored.
 */
export interface McpCryptoPort {
  /** Encrypt one plaintext, returning the ciphertext to store. Throws when it cannot. */
  encrypt(plaintext: string): string
}

/** Where the user-level files live, and how a secret is encrypted. */
export interface McpEnv {
  appDataPath: string
  crypto: McpCryptoPort
}

/** The real port: `safeStorage`, encoded exactly as provider API keys already are. */
const safeStoragePort: McpCryptoPort = {
  encrypt(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('No OS keychain is available.')
    }
    return safeStorage.encryptString(plaintext).toString('base64')
  },
}

/** The `code` of a thrown node filesystem error, or `UNKNOWN` for anything else. */
function nodeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code)
  return 'UNKNOWN'
}

/** The two codes that mean "there is nothing at this path", as opposed to "this path could not be used". */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Read one config file.
 *
 * A missing file is an empty server list, not an error: most workspaces have no project config, and a
 * fresh install has no user one, so reporting either would put a red mark on a page whose content is
 * simply "nothing configured yet". A file that is *there* and unusable is the opposite case, and it is
 * reported — as a whole-file failure carrying its scope, which is what tells the user which of the two
 * files to go and fix.
 */
export async function readMcpConfigFile(path: string, scope: McpScope): Promise<McpConfigParse> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (MISSING_CODES.has(nodeErrorCode(error))) {
      return { document: null, entries: [], errors: [], failure: null }
    }
    return {
      document: null,
      entries: [],
      errors: [],
      failure: {
        scope,
        id: null,
        code: MCP_CONFIG_INVALID,
        message: `This config file could not be read (${nodeErrorCode(error)}).`,
      },
    }
  }

  return parseMcpConfigText(text, scope)
}

/** The trust file as read: the document, and the roots map on its own. */
export interface McpTrustRead {
  /** The parsed document, kept so a write preserves every key this phase does not own. */
  document: Record<string, unknown> | null
  /** Root path → server id → an entry as written, unvalidated: `compareMcpTrust` reads each one. */
  roots: Record<string, Record<string, unknown>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the trust records.
 *
 * Anything unreadable — no file, broken JSON, a `roots` that is not an object — reads as *no trust*.
 * That is the failing-closed direction rather than the failing-open one: with no trust record every
 * project server compares `absent`, and nothing that was not explicitly granted can be mistaken for
 * something that was.
 */
export async function readMcpTrustFile(path: string): Promise<McpTrustRead> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { document: null, roots: {} }
  }

  if (!isPlainObject(parsed)) return { document: null, roots: {} }

  const rootsValue = parsed.roots
  if (!isPlainObject(rootsValue)) return { document: parsed, roots: {} }

  const roots: Record<string, Record<string, unknown>> = {}
  for (const [rootPath, entries] of Object.entries(rootsValue)) {
    if (!isPlainObject(entries)) continue
    roots[rootPath] = entries
  }
  return { document: parsed, roots }
}

/**
 * Write a config file back, changing nothing but the `servers` list.
 *
 * The document is spread rather than rebuilt, so every key the user or a future version put in the file
 * comes back unchanged. `version` is added only when there was no file, which is the one case where
 * there are no existing keys to preserve.
 */
async function writeConfigFile(
  path: string,
  document: Record<string, unknown> | null,
  servers: McpServerRaw[]
): Promise<void> {
  const next = document === null ? { version: MCP_CONFIG_VERSION, servers } : { ...document, servers }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
}

/** Write the trust file back, the same way: `roots` replaced, everything else preserved. */
async function writeTrustFile(
  path: string,
  document: Record<string, unknown> | null,
  roots: Record<string, Record<string, unknown>>
): Promise<void> {
  const next = document === null ? { roots } : { ...document, roots }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
}

/** The path one scope's server list lives at. */
function configPathFor(env: McpEnv, scope: McpScope, rootPath: string | null): string {
  if (scope === 'user') return mcpUserConfigPath(env.appDataPath)
  if (!rootPath) {
    throw new ConveyorError('NO_WORKSPACE', 'Open a folder before configuring its project MCP servers.')
  }
  return mcpProjectConfigPath(rootPath)
}

/**
 * A config file read on the way to a write.
 *
 * A file that cannot be parsed stops the write by name. Rewriting it from an empty list would silently
 * delete every server in it, which is the one outcome worse than refusing to save.
 */
async function loadForWrite(path: string, scope: McpScope): Promise<McpConfigParse> {
  const loaded = await readMcpConfigFile(path, scope)
  if (loaded.failure) throw new ConveyorError(loaded.failure.code, loaded.failure.message)
  return loaded
}

/** One server as the renderer may see it: enough to draw a row, and no secret value in any form. */
export interface McpServerListing {
  id: string
  transport: typeof MCP_TRANSPORT_STDIO
  command: string
  args: string[]
  cwd: string | null
  enabled: boolean
  scope: McpScope
  /** Null for a user server: trust governs the project scope only. */
  trust: McpTrustState | null
  /** The names of the secrets this server holds, and whether each one has a value. Never the value. */
  secrets: Array<{ name: string; set: boolean }>
}

/** Both scopes, plus everything either file refused to load. */
export interface McpServerListingResult {
  user: McpServerListing[]
  project: McpServerListing[]
  errors: McpServerConfigError[]
}

function toListing(entry: McpServerEntry, scope: McpScope, trust: McpTrustState | null): McpServerListing {
  return {
    id: entry.config.id,
    transport: entry.config.transport,
    command: entry.config.command,
    args: [...entry.config.args],
    cwd: entry.config.cwd,
    enabled: entry.config.enabled,
    scope,
    trust,
    secrets: secretEnvListing(entry.config),
  }
}

/**
 * Both scopes, as one read.
 *
 * `rootPath` is null when no folder is open, and that is not a degraded read: user servers are the
 * user's and are listed regardless, while there is no project server list to read at all — so no
 * project file is opened and nothing is reported about one.
 *
 * `env` (the plaintext, non-secret environment) is deliberately not carried. It is not a secret on disk,
 * but it is not this phase's business on the wire either: what a UI needs in order to *act* on a server
 * is its command, its id, whether it is enabled, how its trust stands, and which secrets it holds.
 */
export async function listMcpServers(env: McpEnv, rootPath: string | null): Promise<McpServerListingResult> {
  const user = await readMcpConfigFile(mcpUserConfigPath(env.appDataPath), 'user')
  const project = rootPath ? await readMcpConfigFile(mcpProjectConfigPath(rootPath), 'project') : null

  // The trust file is read only when there is a project scope to compare against, and each record is
  // looked up by the root path exactly as the caller passes it — the same string the workspace was
  // opened with, so a grant made in a session is the grant found in it.
  const trustRoot = rootPath ? ((await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))).roots[rootPath] ?? {}) : {}

  const errors: McpServerConfigError[] = []
  if (user.failure) errors.push(user.failure)
  errors.push(...user.errors)
  if (project) {
    if (project.failure) errors.push(project.failure)
    errors.push(...project.errors)
  }

  return {
    user: user.entries.map((entry) => toListing(entry, 'user', null)),
    project: (project?.entries ?? []).map((entry) =>
      toListing(entry, 'project', compareMcpTrust(entry.config, trustRoot[entry.config.id]))
    ),
    errors,
  }
}

/** What a caller may hand `addServer`: no secrets, which arrive through `setSecret` and nowhere else. */
export interface McpServerInput {
  id: string
  transport?: string
  command: string
  args?: string[]
  cwd?: string | null
  env?: Record<string, string>
  enabled?: boolean
}

/**
 * The record a newly added server is written as.
 *
 * Built from the request and then put through the same validator the file is read with, so an id rule or
 * a transport rule cannot be enforced in one place and not the other. Absent fields get their documented
 * defaults here — a record is being *created*, so there is no earlier spelling to preserve — and
 * `secretEnv` starts empty because no plaintext secret is ever accepted at this boundary.
 */
function newServerRecord(server: McpServerInput, scope: McpScope): McpServerEntry {
  const candidate: McpServerRaw = {
    id: server.id,
    transport: server.transport ?? MCP_TRANSPORT_STDIO,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? null,
    env: server.env ?? {},
    secretEnv: {},
    enabled: server.enabled ?? false,
  }

  const checked = validateMcpServerRecord(candidate, scope, 0)
  if (!checked.ok) throw new ConveyorError(checked.error.code, checked.error.message)
  return checked.entry
}

/** Where a server id sits in a loaded file, or -1. */
function indexOfId(entries: McpServerEntry[], serverId: string): number {
  return entries.findIndex((entry) => entry.config.id === serverId)
}

/** One server's record, or the not-found failure naming the scope it was looked for in. */
function requireEntry(entries: McpServerEntry[], scope: McpScope, serverId: string): McpServerEntry {
  const index = indexOfId(entries, serverId)
  if (index === -1) {
    throw new ConveyorError(MCP_SERVER_NOT_FOUND, `There is no ${scope}-scope server named "${serverId}".`)
  }
  return entries[index]
}

/** Add one server to a scope's list. */
export async function addMcpServer(
  env: McpEnv,
  input: { scope: McpScope; rootPath: string | null; server: McpServerInput }
): Promise<{ id: string }> {
  const path = configPathFor(env, input.scope, input.rootPath)
  const loaded = await loadForWrite(path, input.scope)
  const entry = newServerRecord(input.server, input.scope)

  if (indexOfId(loaded.entries, entry.config.id) !== -1) {
    throw new ConveyorError(
      MCP_SERVER_DUPLICATE,
      `A ${input.scope}-scope server named "${entry.config.id}" already exists.`
    )
  }

  await writeConfigFile(path, loaded.document, [...loaded.entries.map((existing) => existing.raw), entry.raw])
  return { id: entry.config.id }
}

/** Remove one server, and any trust record that named it. */
export async function removeMcpServer(
  env: McpEnv,
  input: { scope: McpScope; rootPath: string | null; serverId: string }
): Promise<{ id: string }> {
  const path = configPathFor(env, input.scope, input.rootPath)
  const loaded = await loadForWrite(path, input.scope)
  requireEntry(loaded.entries, input.scope, input.serverId)

  await writeConfigFile(
    path,
    loaded.document,
    loaded.entries.filter((entry) => entry.config.id !== input.serverId).map((entry) => entry.raw)
  )

  // Revoked rather than left behind: a stale grant with the same id would come back to life the moment
  // the id is used again, which would be a trust decision the user never made.
  if (input.scope === 'project' && input.rootPath) {
    await clearMcpTrustRecord(env, input.rootPath, input.serverId)
  }

  return { id: input.serverId }
}

/** Switch one server on or off. Deliberately nothing else: trust is not touched. */
export async function setMcpServerEnabled(
  env: McpEnv,
  input: { scope: McpScope; rootPath: string | null; serverId: string; enabled: boolean }
): Promise<{ id: string; enabled: boolean }> {
  const path = configPathFor(env, input.scope, input.rootPath)
  const loaded = await loadForWrite(path, input.scope)
  requireEntry(loaded.entries, input.scope, input.serverId)

  await writeConfigFile(
    path,
    loaded.document,
    loaded.entries.map((entry) =>
      entry.config.id === input.serverId ? { ...entry.raw, enabled: input.enabled } : entry.raw
    )
  )

  return { id: input.serverId, enabled: input.enabled }
}

/**
 * Delete one trust record.
 *
 * Deliberately not gated on the server still existing: revoking is exactly what has to happen when it no
 * longer does. A root left with no records goes with them, so a folder the user has finished with does
 * not linger in the trust file.
 */
async function clearMcpTrustRecord(env: McpEnv, rootPath: string, serverId: string): Promise<void> {
  const trust = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  const forRoot = trust.roots[rootPath] ?? {}
  if (!(serverId in forRoot)) return

  const roots: Record<string, Record<string, unknown>> = { ...trust.roots }
  const remaining: Record<string, unknown> = { ...forRoot }
  delete remaining[serverId]

  if (Object.keys(remaining).length === 0) delete roots[rootPath]
  else roots[rootPath] = remaining

  await writeTrustFile(mcpTrustFilePath(env.appDataPath), trust.document, roots)
}

/**
 * Grant or revoke trust for one project server.
 *
 * Granting hashes the server as it is *now*, from the project config on disk, rather than trusting a
 * hash the caller sends: the whole point of the record is that it was computed from the file the user
 * looked at. Either direction requires the server to be in the project config, which is what keeps trust
 * to the scope it governs.
 */
export async function setMcpServerTrust(
  env: McpEnv,
  input: { rootPath: string; serverId: string; trusted: boolean }
): Promise<{ id: string; trusted: boolean; configHash: string | null }> {
  const loaded = await readMcpConfigFile(mcpProjectConfigPath(input.rootPath), 'project')
  if (loaded.failure) throw new ConveyorError(loaded.failure.code, loaded.failure.message)
  const entry = requireEntry(loaded.entries, 'project', input.serverId)

  if (!input.trusted) {
    await clearMcpTrustRecord(env, input.rootPath, input.serverId)
    return { id: input.serverId, trusted: false, configHash: null }
  }

  const trust = await readMcpTrustFile(mcpTrustFilePath(env.appDataPath))
  const roots: Record<string, Record<string, unknown>> = { ...trust.roots }
  const forRoot: Record<string, unknown> = { ...(roots[input.rootPath] ?? {}) }
  const configHash = hashMcpServerConfig(entry.config)

  forRoot[input.serverId] = { configHash, trustedAt: new Date().toISOString() }
  roots[input.rootPath] = forRoot

  await writeTrustFile(mcpTrustFilePath(env.appDataPath), trust.document, roots)
  return { id: input.serverId, trusted: true, configHash }
}

/**
 * The guard a caller uses before it runs a project server.
 *
 * A later turn's runtime is the consumer; the code is defined and tested here so that the runtime cannot
 * invent its own reading of the three states. Only `matched` passes. `absent` is not a lesser failure
 * than `mismatched` — it means nobody ever granted this server anything — and both are the same fact to
 * the process that was about to start: this is not the thing that was trusted.
 */
export function assertMcpTrustMatched(serverId: string, state: McpTrustState): void {
  if (state === 'matched') return
  throw new ConveyorError(
    MCP_TRUST_MISMATCH,
    state === 'absent'
      ? `The project server "${serverId}" has not been trusted, so it will not be started.`
      : `The project server "${serverId}" changed since it was trusted, so it will not be started.`
  )
}

/**
 * Store one encrypted secret on a server.
 *
 * Encryption happens before anything is read for writing, so a keychain that refuses leaves the file
 * exactly as it was rather than a record that half-changed. The ciphertext is the only thing written:
 * the plaintext is used here, inside one call, and goes nowhere else.
 */
export async function setMcpServerSecret(
  env: McpEnv,
  input: { scope: McpScope; rootPath: string | null; serverId: string; name: string; value: string }
): Promise<{ id: string; name: string }> {
  if (!isSafeMcpSecretKey(input.name)) {
    throw new ConveyorError(
      MCP_CONFIG_INVALID,
      `"${input.name}" is not a usable secret name: it becomes an environment variable, so it must start with a letter or underscore and hold only letters, digits and underscores.`
    )
  }

  const path = configPathFor(env, input.scope, input.rootPath)
  const loaded = await loadForWrite(path, input.scope)
  const entry = requireEntry(loaded.entries, input.scope, input.serverId)

  let ciphertext: string
  try {
    ciphertext = env.crypto.encrypt(input.value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConveyorError(
      MCP_SECRET_CRYPTO_FAILED,
      `The secret could not be encrypted, so nothing was stored. ${reason}`
    )
  }
  if (ciphertext === '') {
    throw new ConveyorError(MCP_SECRET_CRYPTO_FAILED, 'The encrypted secret came back empty, so nothing was stored.')
  }

  const secretEnv = { ...entry.config.secretEnv, [input.name]: ciphertext }
  await writeConfigFile(
    path,
    loaded.document,
    loaded.entries.map((record) => (record.config.id === input.serverId ? { ...record.raw, secretEnv } : record.raw))
  )

  return { id: input.serverId, name: input.name }
}

/**
 * Forget one secret.
 *
 * Clearing a name that was never set is not an error: the user asked for a state, and that state is
 * already true. Nothing is written in that case either, so a no-op click cannot rewrite a file.
 */
export async function clearMcpServerSecret(
  env: McpEnv,
  input: { scope: McpScope; rootPath: string | null; serverId: string; name: string }
): Promise<{ id: string; name: string }> {
  const path = configPathFor(env, input.scope, input.rootPath)
  const loaded = await loadForWrite(path, input.scope)
  const entry = requireEntry(loaded.entries, input.scope, input.serverId)

  if (!(input.name in entry.config.secretEnv)) return { id: input.serverId, name: input.name }

  const secretEnv: Record<string, string> = { ...entry.config.secretEnv }
  delete secretEnv[input.name]

  await writeConfigFile(
    path,
    loaded.document,
    loaded.entries.map((record) => (record.config.id === input.serverId ? { ...record.raw, secretEnv } : record.raw))
  )

  return { id: input.serverId, name: input.name }
}

/** The environment the registered commands run with: the real app data folder and the real keychain. */
function mcpEnv(): McpEnv {
  return {
    // `%APPDATA%`, not `userData`: the same folder the user's skills live in, so the requirement's own
    // path holds across every build and every reinstall.
    appDataPath: app.getPath('appData'),
    crypto: safeStoragePort,
  }
}

const scopeSchema = z.enum(['user', 'project'])
const rootPathSchema = z.string().min(1).nullable().optional()
const serverIdSchema = z.string().min(1)

/**
 * A server as a caller may describe one.
 *
 * Unknown keys are stripped rather than written: this is a request, not a file. The keys the *file*
 * already holds are what the preservation law protects, and those come back through the spread in every
 * write below. `secretEnv` is not accepted here at all, which is why the schema drops it — a secret
 * arrives as a plaintext through `setSecret`, is encrypted there, and is never a field a caller fills in.
 */
const serverInputSchema = z.object({
  id: serverIdSchema,
  transport: z.string().optional(),
  command: z.string().min(1, 'A command is required'),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
})

/**
 * The MCP configuration surface: configuration, trust and secrets — and no runtime.
 *
 * Every command here is main-process and code-branched, and none of them starts a process, opens a
 * socket, or exposes a tool. Reading a record is a query; anything that writes is a command. The scope
 * and the root path come from the caller, the app data folder from main, and the renderer therefore
 * cannot point a write at a directory it named.
 */
export const mcpModule = defineModule({
  /** Both scopes as one read: user servers, project servers with their trust state, and config errors. */
  listServers: query(z.object({ rootPath: rootPathSchema }), async ({ input }) => {
    return listMcpServers(mcpEnv(), input.rootPath ?? null)
  }),

  /** Add one server to a scope. A duplicate id in that scope is refused rather than overwritten. */
  addServer: command(
    z.object({ scope: scopeSchema, rootPath: rootPathSchema, server: serverInputSchema }),
    async ({ input }) => {
      return addMcpServer(mcpEnv(), {
        scope: input.scope,
        rootPath: input.rootPath ?? null,
        server: input.server,
      })
    }
  ),

  /** Remove one server, together with any trust record that named it. */
  removeServer: command(
    z.object({ scope: scopeSchema, rootPath: rootPathSchema, serverId: serverIdSchema }),
    async ({ input }) => {
      return removeMcpServer(mcpEnv(), {
        scope: input.scope,
        rootPath: input.rootPath ?? null,
        serverId: input.serverId,
      })
    }
  ),

  /** Switch one server on or off. Trust is not touched: the flag is not part of what trust covers. */
  setEnabled: command(
    z.object({ scope: scopeSchema, rootPath: rootPathSchema, serverId: serverIdSchema, enabled: z.boolean() }),
    async ({ input }) => {
      return setMcpServerEnabled(mcpEnv(), {
        scope: input.scope,
        rootPath: input.rootPath ?? null,
        serverId: input.serverId,
        enabled: input.enabled,
      })
    }
  ),

  /** Grant or revoke trust for a project server. Granting hashes the config as it is on disk. */
  setTrust: command(
    z.object({ rootPath: z.string().min(1), serverId: serverIdSchema, trusted: z.boolean() }),
    async ({ input }) => {
      return setMcpServerTrust(mcpEnv(), {
        rootPath: input.rootPath,
        serverId: input.serverId,
        trusted: input.trusted,
      })
    }
  ),

  /** Encrypt one secret and store only the ciphertext on the server record. */
  setSecret: command(
    z.object({
      scope: scopeSchema,
      rootPath: rootPathSchema,
      serverId: serverIdSchema,
      name: z.string().min(1),
      value: z.string(),
    }),
    async ({ input }) => {
      return setMcpServerSecret(mcpEnv(), {
        scope: input.scope,
        rootPath: input.rootPath ?? null,
        serverId: input.serverId,
        name: input.name,
        value: input.value,
      })
    }
  ),

  /** Forget one secret. A name that was never set is not an error. */
  clearSecret: command(
    z.object({ scope: scopeSchema, rootPath: rootPathSchema, serverId: serverIdSchema, name: z.string().min(1) }),
    async ({ input }) => {
      return clearMcpServerSecret(mcpEnv(), {
        scope: input.scope,
        rootPath: input.rootPath ?? null,
        serverId: input.serverId,
        name: input.name,
      })
    }
  ),
})
