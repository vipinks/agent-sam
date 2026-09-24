/**
 * The rules for MCP stdio servers: what a config file may contain, what a server id may be, the hash
 * that says a project server is still the one that was trusted, and the budgets and the redaction rule
 * the runtime runs on.
 *
 * Nothing here touches the disk or Electron. The files these rules describe are read and written by
 * `conveyor/modules/mcp.ts`, and every decision below is exercised directly by the node suites — the
 * same split, and for the same reason, as `protocol/skills.ts` against `modules/skills.ts`: the rules
 * are what a later turn's runtime and trust guard branch on, so they have to be provable without a
 * config file or an Electron app in the way.
 *
 * Two shapes are worth naming apart. A *record* is one server exactly as the file holds it, unknown
 * keys included. A *config* is what that record means once the rules below have been applied. Keeping
 * both is what lets a write put back every key this phase does not own — and never add a default the
 * file did not have.
 */
import { createHash } from 'crypto'
import { MAX_MCP_SERVER_ID_CHARS, isSafeMcpSecretKey, isSafeMcpServerId } from './mcp-ids'

/**
 * The two naming rules live in a module of their own — `protocol/mcp-ids.ts` — because this file hashes
 * with `crypto`, a main-process module, while the settings dialog applies those rules before it sends
 * anything. Re-exported here so this module stays the one place a reader looks for what a config file
 * may contain.
 */
export { MAX_MCP_SERVER_ID_CHARS, isSafeMcpSecretKey, isSafeMcpServerId }

/** The only transport this phase speaks. Any other value is a per-server config error, never a fallback. */
export const MCP_TRANSPORT_STDIO = 'stdio'

/**
 * The version a config file this app creates is written with.
 *
 * Read back and left alone rather than imposed: a file that carries a version this build does not know
 * is not silently relabelled, and a file that carries none is not given one — the only key a write
 * owns is `servers`.
 */
export const MCP_CONFIG_VERSION = 1

/**
 * The codes this phase raises. A caller branches on one of these, never on a message: the message is
 * for the person reading it, and the code is the contract.
 *
 * The first block is what reading and writing a config file can raise. The second is what running a
 * server can, and each one of those is a statement about a *process*: whether it could be started at
 * all, whether it answered in time, whether what it said was usable, and whether it is still there to
 * be asked.
 *
 * `MCP_CONFIG_INVALID` covers both a whole file this build cannot use and one record inside it that
 * fails the rules — the entry carries the scope either way, and `id` tells the two apart when a record
 * is what failed.
 */
export const MCP_CONFIG_INVALID = 'MCP_CONFIG_INVALID'
export const MCP_SERVER_DUPLICATE = 'MCP_SERVER_DUPLICATE'
export const MCP_SERVER_NOT_FOUND = 'MCP_SERVER_NOT_FOUND'
export const MCP_SECRET_CRYPTO_FAILED = 'MCP_SECRET_CRYPTO_FAILED'
export const MCP_TRUST_MISMATCH = 'MCP_TRUST_MISMATCH'

export const MCP_SPAWN_FAILED = 'MCP_SPAWN_FAILED'
export const MCP_START_TIMEOUT = 'MCP_START_TIMEOUT'
export const MCP_PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR'
export const MCP_SERVER_NOT_RUNNING = 'MCP_SERVER_NOT_RUNNING'
export const MCP_TOOL_ERROR = 'MCP_TOOL_ERROR'

export type McpErrorCode =
  | typeof MCP_CONFIG_INVALID
  | typeof MCP_SERVER_DUPLICATE
  | typeof MCP_SERVER_NOT_FOUND
  | typeof MCP_SECRET_CRYPTO_FAILED
  | typeof MCP_TRUST_MISMATCH
  | typeof MCP_SPAWN_FAILED
  | typeof MCP_START_TIMEOUT
  | typeof MCP_PROTOCOL_ERROR
  | typeof MCP_SERVER_NOT_RUNNING
  | typeof MCP_TOOL_ERROR

/**
 * The two budgets a running server is held to.
 *
 * Stated here rather than in the runtime because a timeout is a product decision, not an
 * implementation detail: ten seconds is about how long a person will wait for a server to say hello,
 * and thirty is about how long a tool call may take before the model should be told it did not finish.
 *
 * Both are enforced through the SDK's own request timeout, which raises its failure as a
 * `RequestTimeout` *code* — and a code is what the runtime branches on. Injectable, so a suite proving
 * a ten-second timeout does not take ten seconds; not configurable, because nothing outside a suite has
 * a reason to change them.
 */
export const MCP_START_TIMEOUT_MS = 10_000
export const MCP_CALL_TIMEOUT_MS = 30_000

/**
 * How many stderr lines are kept per server.
 *
 * A line count rather than a byte budget, because stderr is read by a person: two hundred lines is a
 * stack trace and the run-up to it, and the oldest line past the bound is the one that has stopped
 * being worth the memory. This is only about how many lines survive — what is *in* them is the rule
 * below.
 */
export const MCP_STDERR_MAX_LINES = 200

/** What a secret value becomes in a log line. */
export const MCP_REDACTED = '[REDACTED]'

/**
 * Replace every occurrence of every secret value with `MCP_REDACTED`.
 *
 * Longest value first, so a value that contains another cannot be left half-replaced: given `abc` and
 * `abc123`, replacing the short one first would leave `[REDACTED]123` behind — a partial secret, in a
 * log file, which is exactly what this function exists to prevent.
 *
 * Empty values are dropped rather than replaced. An empty string matches everywhere, so honouring one
 * would turn the whole log into a single `[REDACTED]` and destroy the diagnostics the buffer is for.
 * There are no bytes behind it to leak either: an empty ciphertext is what a hand-edit that erased a
 * value leaves behind.
 *
 * Every non-empty value is replaced, however short, and that is deliberate: a secret is secret, and the
 * alternative — a length threshold — is a rule that leaks the one thing it was written to protect.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter((secret) => secret !== ''))].sort((a, b) => b.length - a.length)
  let redacted = text
  for (const value of values) redacted = redacted.split(value).join(MCP_REDACTED)
  return redacted
}

/** Which of the two config files a record came from. */
export type McpScope = 'user' | 'project'

/** The three answers a trust comparison can give. */
export type McpTrustState = 'matched' | 'mismatched' | 'absent'

/** One server exactly as its file holds it — unknown keys and all, for the write that puts them back. */
export type McpServerRaw = Record<string, unknown>

/**
 * What one record means.
 *
 * `env` is plain configuration and `secretEnv` is ciphertext, both keyed by name. Neither is ever
 * handed to the renderer: a listing carries the *names* of the secrets with a flag.
 */
export interface McpServerConfig {
  id: string
  transport: typeof MCP_TRANSPORT_STDIO
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
  secretEnv: Record<string, string>
  enabled: boolean
}

/** A record that passed the rules: the raw object to write back, and its normalized meaning. */
export interface McpServerEntry {
  raw: McpServerRaw
  config: McpServerConfig
}

/** One thing wrong with one record. `id` is null when the record claimed no usable id at all. */
export interface McpServerConfigError {
  scope: McpScope
  id: string | null
  code: McpErrorCode
  message: string
}

/** A config file, read: what loaded, what did not, and the document itself for the next write. */
export interface McpConfigParse {
  /**
   * The parsed document as written, or null when there is nothing usable to write back to. Kept so a
   * write can preserve every top-level key this phase does not own.
   */
  document: Record<string, unknown> | null
  entries: McpServerEntry[]
  errors: McpServerConfigError[]
  /** Non-null when the file as a whole could not be used, in which case `entries` is empty. */
  failure: McpServerConfigError | null
}

/** A plain object, as opposed to an array, null, or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string map, or null when what is there is not one. Absent and null both read as empty. */
function readStringMap(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null
    out[key] = entry
  }
  return out
}

/** One failure entry, in the shape every error in this module is reported with. */
function failureFor(scope: McpScope, id: string | null, message: string): McpServerConfigError {
  return { scope, id, code: MCP_CONFIG_INVALID, message }
}

/**
 * Apply the rules to one record.
 *
 * The raw object is returned untouched alongside the normalized meaning, which is the whole trick
 * behind whole-record preservation: `enabled` absent means `false` as a *meaning*, while the file keeps
 * not having the key, so a later write of some other field does not quietly add it.
 *
 * Absent optional fields are the only thing that is defaulted, and only in the meaning. A field that is
 * *there* and wrong is refused rather than repaired: a config that says `transport: "sse"` is a config
 * this build would have to pretend about, and pretending is how a server runs differently from what the
 * file says.
 */
export function validateMcpServerRecord(
  raw: unknown,
  scope: McpScope,
  index: number
): { ok: true; entry: McpServerEntry } | { ok: false; error: McpServerConfigError } {
  const where = `Server #${index + 1}`
  if (!isPlainObject(raw)) {
    return { ok: false, error: failureFor(scope, null, `${where} in this file is not an object.`) }
  }

  const rawId = raw.id
  const claimed = typeof rawId === 'string' ? rawId : null
  if (!isSafeMcpServerId(rawId)) {
    return {
      ok: false,
      error: failureFor(
        scope,
        claimed,
        `${where} has the id ${JSON.stringify(rawId ?? null)}, which is not a usable server id: use lower-case letters, digits, dots, dashes or underscores, and never a path.`
      ),
    }
  }

  if (raw.transport !== MCP_TRANSPORT_STDIO) {
    return {
      ok: false,
      error: failureFor(
        scope,
        rawId,
        `${where} (${rawId}) names the transport ${JSON.stringify(raw.transport ?? null)}: this build only runs stdio servers.`
      ),
    }
  }

  const command = raw.command
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      ok: false,
      error: failureFor(scope, rawId, `${where} (${rawId}) has no command to run.`),
    }
  }

  const argsValue = raw.args
  const args = argsValue === undefined || argsValue === null ? [] : argsValue
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return {
      ok: false,
      error: failureFor(scope, rawId, `${where} (${rawId}) has arguments that are not a list of strings.`),
    }
  }

  // Absent and null both mean "run it in the workspace": the difference between them is spelling, not
  // meaning, and a file that writes either must load the same way.
  const cwdValue = raw.cwd
  const cwd = cwdValue ?? null
  if (cwd !== null && typeof cwd !== 'string') {
    return {
      ok: false,
      error: failureFor(scope, rawId, `${where} (${rawId}) has a working directory that is not a string.`),
    }
  }

  const env = readStringMap(raw.env)
  if (env === null) {
    return {
      ok: false,
      error: failureFor(scope, rawId, `${where} (${rawId}) has an env block that is not a map of strings.`),
    }
  }

  const secretEnv = readStringMap(raw.secretEnv)
  if (secretEnv === null) {
    return {
      ok: false,
      error: failureFor(
        scope,
        rawId,
        `${where} (${rawId}) has a secretEnv block that is not a map of encrypted strings.`
      ),
    }
  }

  const enabledValue = raw.enabled
  const enabled = enabledValue === undefined ? false : enabledValue
  if (typeof enabled !== 'boolean') {
    return {
      ok: false,
      error: failureFor(scope, rawId, `${where} (${rawId}) has an enabled flag that is not true or false.`),
    }
  }

  return {
    ok: true,
    entry: {
      raw,
      config: {
        id: rawId,
        transport: MCP_TRANSPORT_STDIO,
        command,
        args: [...args],
        cwd,
        env,
        secretEnv,
        enabled,
      },
    },
  }
}

/**
 * Read one config file from its text.
 *
 * Two levels of failure, and they are kept apart because they mean different things to a person. A file
 * that is not JSON, or not a config file at all, is one failure about the file — `failure`, carrying the
 * scope it was read from, with nothing loaded. One record that breaks the rules is one *error entry*,
 * and its valid siblings still load: a hand-edited file with one bad row in it is a file whose other
 * servers are perfectly usable, and refusing all of them would be punishing the wrong thing.
 *
 * A file that declares no `servers` is an empty list rather than a failure. Most of the time it is a
 * file the user created and has not filled in yet.
 */
export function parseMcpConfigText(text: string, scope: McpScope): McpConfigParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      document: null,
      entries: [],
      errors: [],
      failure: failureFor(scope, null, 'This config file is not valid JSON, so none of its servers were loaded.'),
    }
  }

  if (!isPlainObject(parsed)) {
    return {
      document: null,
      entries: [],
      errors: [],
      failure: failureFor(scope, null, 'This config file is not a config object, so none of its servers were loaded.'),
    }
  }

  const serversValue = parsed.servers
  if (serversValue === undefined || serversValue === null) {
    return { document: parsed, entries: [], errors: [], failure: null }
  }

  if (!Array.isArray(serversValue)) {
    return {
      document: null,
      entries: [],
      errors: [],
      failure: failureFor(scope, null, 'This config file has a "servers" value that is not a list.'),
    }
  }

  const entries: McpServerEntry[] = []
  const errors: McpServerConfigError[] = []
  const seen = new Set<string>()

  for (const [index, raw] of serversValue.entries()) {
    const checked = validateMcpServerRecord(raw, scope, index)
    if (!checked.ok) {
      errors.push(checked.error)
      continue
    }

    // One id names one server. Every command here refuses a duplicate, so a file with two of them was
    // written by hand — and loading both would leave which one answers for the id up to the reader.
    if (seen.has(checked.entry.config.id)) {
      errors.push(
        failureFor(
          scope,
          checked.entry.config.id,
          `A second server named "${checked.entry.config.id}" was skipped: one id names one server.`
        )
      )
      continue
    }

    seen.add(checked.entry.config.id)
    entries.push(checked.entry)
  }

  return { document: parsed, entries, errors, failure: null }
}

/**
 * Canonical JSON: every object's keys sorted, recursively, with no whitespace.
 *
 * This is what makes a hash stable across the way a file happens to be saved. Two files that say the
 * same thing produce the same bytes here, so reordering a map with an editor — which is not a change to
 * what will be run — cannot invalidate trust.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  // Not reachable from parsed JSON; normalized rather than thrown so a hand-built object cannot crash a
  // trust comparison.
  return 'null'
}

/**
 * The hash trust is granted against: sha256 over the canonical form of exactly the five fields that
 * decide what will be executed.
 *
 * `enabled` is deliberately not among them. Switching a server on is a statement about whether it may
 * run now, not about what it would run, so it must not invalidate a grant the user already made. That
 * is also why the hash is taken over the *normalized* config: `args` absent and `args: []` mean the same
 * thing, and a file that spells one of them must not look different from a file that spells the other.
 */
export function hashMcpServerConfig(config: McpServerConfig): string {
  const trustFields = {
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    secretEnv: config.secretEnv,
  }
  return createHash('sha256').update(canonicalJson(trustFields), 'utf8').digest('hex')
}

/** One trust record: the hash that was granted, and when. */
export interface McpTrustEntry {
  configHash: string
  trustedAt: string
}

/**
 * A trust record read back from a file, or null when what is stored is not one.
 *
 * A record missing either field is not a weaker record, it is not a record: refusing it here is what
 * makes a hand-edited trust file fail closed rather than compare equal to something.
 */
export function readMcpTrustEntry(value: unknown): McpTrustEntry | null {
  if (!isPlainObject(value)) return null
  const configHash = value.configHash
  const trustedAt = value.trustedAt
  if (typeof configHash !== 'string' || typeof trustedAt !== 'string') return null
  return { configHash, trustedAt }
}

/**
 * Whether a server is the one that was trusted.
 *
 * Three answers rather than a boolean, because the renderer has to say different things: `absent` is a
 * server nobody has trusted yet, `mismatched` is one whose command, arguments, directory or environment
 * changed since it was — and `matched` is the only state that may run.
 */
export function compareMcpTrust(config: McpServerConfig, entry: unknown): McpTrustState {
  const record = readMcpTrustEntry(entry)
  if (record === null) return 'absent'
  return record.configHash === hashMcpServerConfig(config) ? 'matched' : 'mismatched'
}

/**
 * Whether a project server may run, and what to say when it may not.
 *
 * The judgment is here, and only here, because two places have to reach the same answer — the trust
 * guard a config-layer caller uses, and the runtime that must not spawn without one — and the two are in
 * modules that cannot import each other. A single rule both of them read is what keeps "matched" from
 * meaning one thing in one of them and something else in the other. `null` means yes.
 *
 * `absent` is not a lesser refusal than `mismatched`: nobody ever granted this server anything, which is
 * the same fact to the process that was about to start — this is not the thing that was trusted.
 */
export function mcpTrustRefusal(
  serverId: string,
  state: McpTrustState
): { code: typeof MCP_TRUST_MISMATCH; message: string } | null {
  if (state === 'matched') return null
  return {
    code: MCP_TRUST_MISMATCH,
    message:
      state === 'absent'
        ? `The project server "${serverId}" has not been trusted, so it will not be started.`
        : `The project server "${serverId}" changed since it was trusted, so it will not be started.`,
  }
}

/**
 * A record's secrets as the renderer may see them.
 *
 * Names, and whether a value is stored — never the value, in either form. An empty string counts as not
 * set, because a ciphertext that is empty is what a hand-edit that erased a value leaves behind, and
 * showing that as "set" would be the one reading the user cannot act on.
 */
export function secretEnvListing(config: McpServerConfig): Array<{ name: string; set: boolean }> {
  return Object.keys(config.secretEnv).map((name) => ({ name, set: config.secretEnv[name] !== '' }))
}
