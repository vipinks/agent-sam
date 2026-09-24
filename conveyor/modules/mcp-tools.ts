/**
 * The bridge between the agent's tool list and the servers that are running.
 *
 * `modules/mcp-runtime.ts` owns the processes; this is the one place that turns the registry's answer
 * into something a model turn can use. Three jobs, and each exists because the thing behind it is not
 * this app's:
 *
 * - The tool list: a running server's tools, named by identity, with the server's own input schema
 *   passed through untouched. Nothing here authors a schema, and nothing here caches one — the runtime's
 *   discovery already is the cache, and a second copy could disagree with it.
 * - The call: one identity resolved to a server and a tool, sent, and turned into an outcome. A failure
 *   is *data* — a code, and text the model can read — because the alternative is a turn that dies
 *   because someone else's process did, taking the user's conversation with it.
 * - The consent: what the user is shown before any of that happens. The scope and trust state come from
 *   the config layer rather than from the caller, and the arguments are redacted against the secrets that
 *   server was started with, so a card cannot be made to show a credential by a model that asked nicely.
 *
 * Every dependency is injectable, and that is not only for the suites: the runtime and the config layer
 * are read through functions, so nothing here constructs a process or opens a file at import time.
 */
import { ConveyorError } from 'electron-conveyor/main'
import { MCP_TOOL_ERROR, redactSecrets } from '../protocol/mcp'
import { mcpToolIdentity, parseMcpToolIdentity, truncateMcpPreview, type McpConsent } from '../protocol/mcp-tools'
import type { McpRunningTool } from './mcp-runtime'
import { getMcpRuntime } from './mcp-runtime'
import { readMcpServerCallContext, type McpServerCallContext } from './mcp'
import type { ToolDefinition } from './llm-engine'

/** The scope, trust and secret values of one configured server. See `readMcpServerCallContext`. */
export type McpServerContext = McpServerCallContext

/**
 * What one MCP call produced, in the shape the loop hands the model.
 *
 * Structurally the loop's own `ToolOutcome`, and deliberately its own type rather than an import of it:
 * the loop is the caller, and a bridge that depended on its caller's type would be a module that cannot
 * be read on its own.
 */
export interface McpCallOutcome {
  ok: boolean
  /** A stable code, present on every failure. What a UI branches on, never the sentence. */
  code?: string
  /** Text for the model. On failure this carries the code, so the model can say what went wrong. */
  output: string
}

/** What the agent loop may ask of the running servers. */
export interface McpToolBridge {
  /** Every tool every running server offers, named by identity, in a stable order. */
  toolDefinitions(): ToolDefinition[]
  /** Run one call. A server that is gone, refuses, or errors comes back as an outcome, never a throw. */
  call(identity: string, argsJson: string): Promise<McpCallOutcome>
  /** What the consent card must show for one call, or undefined when the name is not an identity. */
  consent(identity: string, argsJson: string): Promise<McpConsent | undefined>
  /**
   * Whether the server behind one call was flagged to run its tools without asking.
   *
   * Asked before a call is made, and answered from the config as it stands then, because this is the one
   * thing that decides whether the loop stops in front of the call. `false` for a name that is not an
   * identity, and for a server the config can no longer be read for: a server this app can say nothing
   * about is not a server it may stop asking about.
   */
  autoApproves(identity: string): Promise<boolean>
}

/** What a bridge is built from. Every member has a real default; a suite replaces what it measures. */
export interface McpToolBridgeOptions {
  /** The folder the turn is running in: what decides a project server's trust, and nothing else. */
  workspaceRoot?: string | null
  listRunningTools?: () => McpRunningTool[]
  callTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>
  serverContext?: (serverId: string) => Promise<McpServerContext | null>
}

/**
 * One running server's tool, as the model is offered it.
 *
 * The name is the identity, because this app's names are the loop's business — the wire form is decided
 * per turn by `protocol/mcp-tools.ts`, where the mapping that reads the reply back lives. The schema is
 * the server's own object, passed through by reference: re-authoring one would be this app answering for
 * a tool it does not implement.
 */
function toolDefinitionFor(entry: McpRunningTool): ToolDefinition {
  const offered = `Offered by the MCP server "${entry.serverId}" as "${entry.tool.name}". Every call is put to the user for approval before it runs.`
  return {
    type: 'function',
    function: {
      name: mcpToolIdentity(entry.serverId, entry.tool.name),
      description: entry.tool.description ? `${entry.tool.description}\n\n${offered}` : offered,
      parameters: (entry.tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  }
}

/**
 * The text of one server's answer.
 *
 * A tool result is a list of content parts, and every part is either text the model should read or
 * something this app cannot render as prose — an image, an embedded resource. The unreadable ones are
 * passed through as JSON rather than dropped: a model told there was a part it cannot see can say so,
 * and a model told nothing would report success on a call whose result never arrived.
 */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(result)
    } catch {
      return String(result)
    }
  }

  return content
    .map((part) => {
      const typed = part as { type?: unknown; text?: unknown }
      return typed?.type === 'text' ? String(typed.text ?? '') : JSON.stringify(part)
    })
    .join('\n')
}

/** The failure the model reads: the code name first, then what the server or the runtime said. */
function failure(code: string, message: string): McpCallOutcome {
  return { ok: false, code, output: `${code}: ${message}` }
}

/** The arguments of one call, read back from the model's own JSON. */
function readArgs(
  argsJson: string
): { ok: true; args: Record<string, unknown> } | { ok: false; outcome: McpCallOutcome } {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson || '{}')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      outcome: failure(MCP_TOOL_ERROR, `The arguments were not valid JSON (${reason}). Send a single JSON object.`),
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, outcome: failure(MCP_TOOL_ERROR, 'The arguments were not a JSON object.') }
  }

  return { ok: true, args: parsed as Record<string, unknown> }
}

export function createMcpToolBridge(options: McpToolBridgeOptions = {}): McpToolBridge {
  const listRunningTools = options.listRunningTools ?? ((): McpRunningTool[] => getMcpRuntime().listRunningTools())
  const callTool =
    options.callTool ??
    ((serverId: string, toolName: string, args: Record<string, unknown>) =>
      getMcpRuntime().callTool(serverId, toolName, args))
  const readContext =
    options.serverContext ?? ((serverId: string) => readMcpServerCallContext(options.workspaceRoot ?? null, serverId))

  async function contextOf(serverId: string): Promise<McpServerContext | null> {
    try {
      return await readContext(serverId)
    } catch {
      // A config that cannot be read is not a reason to refuse the question: the call is what the user
      // is deciding on, and the card says what it can about the server. The alternative is a pause the
      // user cannot answer, which is worse than a pause that knows less.
      return null
    }
  }

  return {
    /**
     * Sorted by identity, so the list a model is offered does not depend on the order the user happened
     * to start their servers in: the same running set must produce the same request, or a resumed turn
     * would ask the same question with the tools written down differently.
     */
    toolDefinitions(): ToolDefinition[] {
      return listRunningTools()
        .map((entry) => ({ entry, identity: mcpToolIdentity(entry.serverId, entry.tool.name) }))
        .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
        .map((item) => toolDefinitionFor(item.entry))
    },

    async call(identity: string, argsJson: string): Promise<McpCallOutcome> {
      const target = parseMcpToolIdentity(identity)
      if (!target) return failure(MCP_TOOL_ERROR, `'${identity}' is not a running server's tool.`)

      const read = readArgs(argsJson)
      if (!read.ok) return read.outcome

      let result: unknown
      try {
        result = await callTool(target.serverId, target.toolName, read.args)
      } catch (error) {
        // The runtime's failures — a server that is gone, a call that ran out of its deadline, a server
        // that answered with an error — all arrive as a typed error carrying a code. The code is passed
        // through as it stands: this side has no better answer than the layer that knows what happened.
        if (error instanceof ConveyorError) return failure(error.code, error.message)
        const reason = error instanceof Error ? error.message : String(error)
        return failure(MCP_TOOL_ERROR, `The call to "${target.toolName}" failed: ${reason}`)
      }

      const text = resultText(result)
      // A tool that reports its own failure is a failed call: the server said so in the result rather
      // than by raising, which is the one thing a tool result can mean besides an answer.
      const isError = (result as { isError?: unknown })?.isError === true
      return isError ? failure(MCP_TOOL_ERROR, text) : { ok: true, output: text }
    },

    async consent(identity: string, argsJson: string): Promise<McpConsent | undefined> {
      const target = parseMcpToolIdentity(identity)
      if (!target) return undefined

      const context = await contextOf(target.serverId)
      return {
        serverId: target.serverId,
        toolName: target.toolName,
        scope: context?.scope ?? null,
        trust: context?.trust ?? null,
        // Redacted as a whole string before it is cut: a secret that happened to sit across the cut
        // would otherwise survive as its own first half.
        argsPreview: truncateMcpPreview(redactSecrets(argsJson || '{}', context?.secrets ?? [])),
      }
    },

    async autoApproves(identity: string): Promise<boolean> {
      const target = parseMcpToolIdentity(identity)
      if (!target) return false

      // Through the same read the consent card uses, and through its own failure rule: a config that
      // cannot be read yields no context, and no context is not a flag. The call is then put to the user
      // exactly as an unflagged server's would be — which is the answer that fails closed.
      const context = await contextOf(target.serverId)
      return context?.autoApprove === true
    },
  }
}
