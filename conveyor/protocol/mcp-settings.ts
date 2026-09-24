import type { McpScope, McpTrustState } from './mcp'

/**
 * The two types these rules are stated in, re-exported as types.
 *
 * `export type` is erased, so a consumer of these rules — the settings section, or a suite — needs no
 * second import from `protocol/mcp`, and no part of that module reaches its bundle.
 */
export type { McpScope, McpTrustState }

/**
 * The MCP settings surface's derivation rules: what is running, what a trust state reads as, and whether
 * a start is permitted.
 *
 * A module of its own rather than three more exports in `protocol/mcp.ts`, and the reason is the
 * import graph: that file hashes with `crypto`, which is a *main-process* module, and the renderer
 * reads these three rules. Splitting them keeps the renderer's bundle free of a node builtin it can
 * never call — the same discipline by which a renderer file imports only `type McpConsent` from
 * `protocol/mcp-tools`. The types still come from `protocol/mcp`, as types: the import is erased, so
 * nothing here pulls that module in.
 *
 * Pure either way, and for the same reason `protocol/mcp.ts` is: a rule a screen branches on is a rule
 * a suite has to be able to reach without a screen. The derivations take the reads' own shapes — the
 * tool list structurally, so this file needs no SDK type either.
 */

/** One tool as `mcp.listRunningTools` tags it. Only the tag is read here, so only it is typed. */
export interface McpRunningToolRef {
  serverId: string
}

/** One server that is running, and how many tools it is offering. */
export interface McpRunningServer {
  serverId: string
  toolCount: number
}

/**
 * The running set, derived from the live tool list.
 *
 * Grouped by server and counted, sorted by id, so two reads of the same registry produce the same
 * answer: a reader comparing what a row says before and after a refresh is comparing two derivations,
 * and the order tools happen to arrive in is not part of what is running.
 *
 * A server that offers no tools is not in the set, and that is the honest reading rather than a gap:
 * main's answer to "is it running" for this feature *is* the tools, so a server with none is
 * indistinguishable from one that is not there — and a row that said "running, with nothing" would be
 * claiming a process the derivation cannot see.
 */
export function deriveRunningServers(tools: readonly McpRunningToolRef[]): McpRunningServer[] {
  const counts = new Map<string, number>()
  for (const { serverId } of tools) counts.set(serverId, (counts.get(serverId) ?? 0) + 1)
  return [...counts.entries()]
    .map(([serverId, toolCount]) => ({ serverId, toolCount }))
    .sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0))
}

/** What a project server's trust state reads as, and what a row offers because of it. */
export interface McpTrustPresentation {
  /** The state in words. Names the difference, because the two refusals are repaired differently. */
  label: string
  /** The button beside it: the grant that fixes this state, or the revoke a matched one offers. */
  action: 'trust' | 'retrust' | 'revoke'
  /** The label on that button, as the row shows it. */
  actionLabel: string
  /** Whether trust alone permits a start. A row's Start control reads this and nothing else. */
  startAllowed: boolean
}

/**
 * A trust state as a person reads it.
 *
 * Three sentences rather than one with a variable in it, because the three are three different
 * situations: never trusted, trusted and changed since, and trusted as it stands. `mismatched` names
 * that the *config changed* rather than that trust is missing, which is the whole reason the state is
 * not a boolean — the repair is a re-grant rather than a first grant, and the button says so.
 */
export function trustPresentation(state: McpTrustState): McpTrustPresentation {
  switch (state) {
    case 'matched':
      return { label: 'Trusted', action: 'revoke', actionLabel: 'Revoke', startAllowed: true }
    case 'mismatched':
      return {
        label: 'Changed since it was trusted',
        action: 'retrust',
        actionLabel: 'Re-trust',
        startAllowed: false,
      }
    case 'absent':
      return { label: 'Not trusted yet', action: 'trust', actionLabel: 'Trust', startAllowed: false }
  }
}

/**
 * Whether a Start is permitted: the flag, plus trust for the scope trust governs.
 *
 * The same judgment main makes before it spawns, stated here so the screen and the guard cannot
 * disagree — the section disables a button on exactly the condition the spawn would refuse. Project
 * scope needs both, and trust is not consulted for a user server at all: the user file is the user's
 * own, nobody else can put a command in it, and a trust state passed for one anyway is ignored rather
 * than honoured.
 */
export function canStartServer(input: { scope: McpScope; enabled: boolean; trust: McpTrustState | null }): boolean {
  if (!input.enabled) return false
  if (input.scope === 'user') return true
  return input.trust === 'matched'
}
