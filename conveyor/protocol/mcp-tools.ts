/**
 * How a running server's tools are named, and how a name that comes back is read again.
 *
 * Three facts live here, and they are one fact seen from three sides: a tool offered by a server is
 * called `mcp:<serverId>:<toolName>` inside this app, because two servers may offer a tool of the same
 * name and the user is deciding on *one* of them; a provider's function-name charset has no colons in
 * it, so what goes on the wire is a sanitized form; and the reply arrives under that wire form, so the
 * turn keeps the mapping that reads it back.
 *
 * The mapping is the turn's rather than the identity's, because a sanitized name is not always unique:
 * `mcp:a:b.c` and `mcp:a:b:c` both collapse to `mcp_a_b_c`, and two tools that must not become one are
 * told apart by an index suffix assigned in the order the turn met them. That is why this is a small
 * mutable object rather than two pure functions — an assignment has to be remembered to stay injective.
 *
 * Free of module imports, like `protocol/approval.ts` and for the same reason: the renderer holds these
 * shapes in its own types and must not drag a main-only module across the boundary to do it.
 */
import type { McpScope, McpTrustState } from './mcp'

/** What a Sam-internal MCP tool name starts with, as a whole segment. */
export const MCP_TOOL_PREFIX = 'mcp'

/** What separates the three segments of an identity. */
const MCP_IDENTITY_SEPARATOR = ':'

/**
 * The longest arguments preview a consent card carries, in characters.
 *
 * Long enough for a call's real arguments, short enough that a server taking a whole document as one
 * argument cannot push the question off the screen: the user is deciding on the call, and the call is
 * what fits.
 */
export const MCP_CONSENT_PREVIEW_CHARS = 240

/** One server's tool, as this app names it. */
export interface McpToolIdentity {
  serverId: string
  toolName: string
}

/**
 * The identity of one tool: `mcp:<serverId>:<toolName>`.
 *
 * The server id never holds the separator — the config layer's own id rule forbids it — so the first
 * separator after the prefix ends the server and everything after it is the tool's own name, colons
 * included. That is what keeps a server free to offer a tool called `fs:read`.
 */
export function mcpToolIdentity(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${MCP_IDENTITY_SEPARATOR}${serverId}${MCP_IDENTITY_SEPARATOR}${toolName}`
}

/** The server and tool an identity names, or null when the string is not one. */
export function parseMcpToolIdentity(name: string): McpToolIdentity | null {
  const parts = name.split(MCP_IDENTITY_SEPARATOR)
  if (parts.length < 3) return null
  if (parts[0] !== MCP_TOOL_PREFIX) return null

  const serverId = parts[1]
  const toolName = parts.slice(2).join(MCP_IDENTITY_SEPARATOR)
  if (!serverId || !toolName) return null
  return { serverId, toolName }
}

/** Whether a tool name is an MCP one. The rule the consent gate and the call router both ask. */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolIdentity(name) !== null
}

/**
 * One identity, as a provider's function-name charset allows it.
 *
 * Every run of forbidden characters becomes a single underscore rather than one per character, so the
 * result stays as close to the identity as the charset permits: `mcp:a:b.c` is `mcp_a_b_c` and not
 * `mcp_a_b_c` with a hole in it where the separator was. The charset is the intersection every provider
 * of this dialect accepts — letters, digits, underscore and hyphen — which is also why a name that is
 * already in it is returned untouched.
 */
export function sanitizeToolWireName(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return replaced === '' ? '_' : replaced
}

/**
 * The names one turn is using.
 *
 * Both directions are asked through these two methods rather than by handing out the maps, because the
 * assignment is the thing that must not be bypassed: a caller that wrote into a map directly could put
 * two identities on one name, and the defect that produces — a call running against the wrong server —
 * is silent until it is a data-loss report.
 */
export interface McpToolNames {
  /**
   * The wire name for one tool, assigning one the first time it is asked.
   *
   * A name that is not an identity is returned unchanged: the built-in tools are already valid wire
   * names, and rewriting them would be this module renaming tools it does not own.
   */
  wireNameFor(name: string): string
  /**
   * The identity a wire name means.
   *
   * A name this turn never assigned is returned unchanged, which is what leaves an unknown tool an
   * unknown tool: guessing at one would be inventing a call the model did not make.
   */
  identityFor(name: string): string
}

/** The names one turn is using, with `identities` assigned up front in the order given. */
export function createMcpToolNames(identities: readonly string[] = []): McpToolNames {
  const wire = new Map<string, string>()
  const identity = new Map<string, string>()

  function assign(name: string): string {
    const existing = wire.get(name)
    if (existing) return existing

    const base = sanitizeToolWireName(name)
    let candidate = base
    // Suffixed rather than folded in: a collision means two servers, or two tools of one server, whose
    // identities differ only in the characters the charset forbids. Sharing a name would make one of
    // them unreachable, and choosing which by anything but the turn's own order would not be stable.
    for (let index = 2; identity.has(candidate); index += 1) candidate = `${base}_${index}`

    wire.set(name, candidate)
    identity.set(candidate, name)
    return candidate
  }

  for (const name of identities) assign(name)

  return {
    wireNameFor: (name) => (isMcpToolName(name) ? assign(name) : name),
    identityFor: (name) => identity.get(name) ?? name,
  }
}

/**
 * One line of a call's arguments, as a consent card can show them.
 *
 * Collapsed to a single line before it is cut, because the card has one line's worth of room and a
 * multi-line JSON blob would push the Approve button off the screen instead of informing the decision.
 * The cut is a plain prefix with a marker, and it happens after redaction rather than before — see the
 * bridge, which is the side that knows this server's secrets.
 */
export function truncateMcpPreview(text: string, limit: number = MCP_CONSENT_PREVIEW_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}…`
}

/**
 * What the user is shown about the server they are being asked to trust.
 *
 * The scope and the trust state are the config layer's own vocabulary, not a rendering of it: a card
 * that said "trusted" where the config said `absent` would be a card that lies about the one thing it
 * exists to report.
 *
 * Both are nullable, and that is a real state rather than a defensive one — a running server's config is
 * read when the card is built, and between the start and the question the file can be edited away. The
 * call is still ours to ask about, so the card says what it knows and no more.
 */
export interface McpConsent {
  serverId: string
  toolName: string
  scope: McpScope | null
  trust: McpTrustState | null
  /** The arguments, one line, secrets redacted and cut to a readable length. */
  argsPreview: string
}
