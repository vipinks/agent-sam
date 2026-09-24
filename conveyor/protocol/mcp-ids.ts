/**
 * The two naming rules a server config is held to, on their own.
 *
 * A module of their own rather than two exports in `protocol/mcp.ts`, and the reason is the import
 * graph: that file hashes with `crypto`, a main-process module, while the settings dialog applies
 * these rules *before* it sends anything — an id that could never be a server id should be refused
 * where it was typed rather than by main. Keeping them here means the renderer can apply the same
 * single definition without pulling a node builtin into its bundle. `protocol/mcp.ts` re-exports them,
 * so every existing importer still names them in one place.
 */

/** How long a server id may be. The same budget a skill id gets: it is a key, not prose. */
export const MAX_MCP_SERVER_ID_CHARS = 64

/**
 * What a server id may be.
 *
 * The lower-case slug rule: the same discipline as a skill id, deliberately stricter. Lower case only,
 * so `FileSystem` and `filesystem` cannot be two ids a case-insensitive filesystem — or a human eye —
 * would run together. No separator, no leading dot, no `..`, which is what makes an id safe as a map
 * key and as a label, and guarantees it can never become a path segment.
 */
const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function isSafeMcpServerId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_MCP_SERVER_ID_CHARS) return false
  return MCP_SERVER_ID_PATTERN.test(value)
}

/**
 * What a secret may be named.
 *
 * A `secretEnv` entry becomes an environment variable on the child process, so a name that could not
 * be one is a secret that could never be delivered. Refused at the boundary rather than stored now and
 * quietly dropped at the spawn.
 */
const MCP_SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isSafeMcpSecretKey(value: unknown): value is string {
  return typeof value === 'string' && MCP_SECRET_KEY_PATTERN.test(value)
}
