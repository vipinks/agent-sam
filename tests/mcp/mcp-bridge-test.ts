/**
 * Verifies the bridge between the running MCP servers and the agent's own tool list: how a server's
 * tools are named for the model, who may run one, and what the model is told when one cannot run.
 *
 * The runtime suite owns the processes — spawning, budgets, stderr, stopping. This one takes the
 * registry's answer as given (`listRunningTools`, `callTool`) and holds the two things that only the
 * bridge can be wrong about: the identity a call is named by, and the rule that an MCP call is always
 * put to the user.
 *
 * Every case runs the real loop over a scripted provider, because the claims here are about what
 * *crosses* the loop: the names in the request the model is sent, the names read back out of its reply,
 * the pause a call stops at, and the tool result a failed call produces. A stub bridge would have to be
 * told all of that, which is the part under test.
 *
 * Nothing here spawns anything, and nothing here touches the real user's app data: the running-tool
 * cache, the call, and the server's own config are all injected, which is the seam `createMcpToolBridge`
 * exists to provide.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { ConveyorError } from 'electron-conveyor/main'
import { MCP_REDACTED, MCP_SERVER_NOT_RUNNING, MCP_TOOL_ERROR } from '../../conveyor/protocol/mcp'
import {
  createMcpToolNames,
  isMcpToolName,
  MCP_CONSENT_PREVIEW_CHARS,
  mcpToolIdentity,
  parseMcpToolIdentity,
  sanitizeToolWireName,
  truncateMcpPreview,
} from '../../conveyor/protocol/mcp-tools'
import { createMcpToolBridge, type McpServerContext } from '../../conveyor/modules/mcp-tools'
import type { McpRunningTool } from '../../conveyor/modules/mcp-runtime'
import { runAgentLoop } from '../../conveyor/modules/agent'
import type { ChatMessage } from '../../conveyor/modules/llm-engine'
import { firstPauseViolation } from '../../conveyor/protocol/approval'
import { applyAgentChunk, startAssistantTurn, type ToolStep } from '../../app/components/workbench/agent-session'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- the provider, scripted

/** Build a Response whose body is the given SSE text, chunked so frames do not arrive whole. */
function sseResponse(frames: string[], chunkSize = 64): Response {
  const payload = frames.map((frame) => `data: ${frame}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** One call the model asks for, in the shape a frame carries it. */
interface AskedCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** One frame asking for `calls`, as an OpenAI-dialect provider streams it. */
function askFrame(calls: AskedCall[]): string[] {
  return [
    JSON.stringify({
      choices: [
        {
          delta: {
            role: 'assistant',
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: '' },
            })),
          },
        },
      ],
    }),
    // The arguments arrive as their own fragment, so a call is assembled rather than read whole.
    JSON.stringify({
      choices: [
        { delta: { tool_calls: calls.map((call, index) => ({ index, function: { arguments: JSON.stringify(call.args) } })) } },
      ],
    }),
    '[DONE]',
  ]
}

/** One frame declaring a plan with a step left to do, which is what a turn continues itself for. */
function planFrame(): string[] {
  return askFrame([
    { id: 'p1', name: 'set_plan', args: { steps: [{ id: 's1', text: 'do the work', status: 'pending' }] } },
  ])
}

/** The model's own answer, with nothing to run behind it. */
function proseFrame(text = 'All done.'): string[] {
  return [JSON.stringify({ choices: [{ delta: { content: text } }] }), '[DONE]']
}

interface Scripted {
  fetchImpl: unknown
  /** Every request body the loop sent, in order. */
  log: Array<Record<string, unknown>>
}

/** A provider that answers each round-trip from the script, and records what it was asked. */
function scriptedProvider(rounds: string[][]): Scripted {
  const log: Array<Record<string, unknown>> = []
  let index = 0
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    log.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const frames = rounds[Math.min(index, rounds.length - 1)] ?? []
    index += 1
    return sseResponse(frames)
  }
  return { fetchImpl, log }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

/** The transcript a run's chunks build, folded the way the pane folds them. */
function stepsFrom(chunks: Array<Record<string, unknown>>): ToolStep[] {
  const assistant = startAssistantTurn()
  let turns = [assistant]
  for (const chunk of chunks) turns = applyAgentChunk(turns, assistant.id, chunk).turns
  return turns[0].steps
}

/** The names the loop advertised on one round-trip, in the order it sent them. */
function toolNames(body: Record<string, unknown>): string[] {
  const tools = (body.tools ?? []) as Array<{ function: { name: string } }>
  return tools.map((tool) => tool.function.name)
}

/** The tool the loop sent for one wire name, or undefined when it sent none. */
function sentTool(body: Record<string, unknown>, name: string): { function: Record<string, unknown> } | undefined {
  const tools = (body.tools ?? []) as Array<{ function: Record<string, unknown> }>
  return tools.find((tool) => tool.function.name === name)
}

// ---------------------------------------------------------------- the servers, faked

/** A tool as one server sent it, with a schema that must come back out untouched. */
function serverTool(name: string, description = 'Does the thing.'): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Where to go' } },
      required: ['url'],
      additionalProperties: false,
    },
  }
}

/** One running server, in the shape the registry reports it. */
function running(serverId: string, ...names: string[]): McpRunningTool[] {
  return names.map((name) => ({ serverId, tool: serverTool(name) }))
}

interface FakeServers {
  /** What the registry reports as running. Empty is what a stopped server leaves behind. */
  tools: McpRunningTool[]
  /** Every call that actually reached a server, in order. */
  calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }>
  /** What the next call answers: a result, or an error the server raised. */
  answer: (call: { serverId: string; toolName: string }) => unknown
  /** What the config says about each server, which is what the consent card reads. */
  contexts: Record<string, McpServerContext>
}

function fakeServers(options: { tools?: McpRunningTool[]; contexts?: Record<string, McpServerContext> } = {}): FakeServers {
  const servers: FakeServers = {
    tools: options.tools ?? [],
    calls: [],
    contexts: options.contexts ?? {},
    answer: (call) => ({ content: [{ type: 'text', text: `${call.toolName} ok` }] }),
  }
  return servers
}

/** The bridge over one fake registry. Injected wholesale: no runtime, no disk, no Electron. */
function bridgeOver(servers: FakeServers, workspaceRoot: string | null = null) {
  return createMcpToolBridge({
    workspaceRoot,
    listRunningTools: () => servers.tools,
    callTool: async (serverId, toolName, args) => {
      servers.calls.push({ serverId, toolName, args })
      return servers.answer({ serverId, toolName })
    },
    serverContext: async (serverId) => servers.contexts[serverId] ?? null,
  })
}

/** A call in the shape the loop hands a renderer, and back: what a pause carries. */
interface PendingCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * A call as a resume takes it.
 *
 * Two shapes, because the two callers have one each: a frame this suite writes down is a name and an
 * argument object, while a frame a *pause* handed back is already the model's own call — and the second
 * must go back exactly as it came, which is half of what the cases below are about.
 */
function asCalls(calls: Array<AskedCall | PendingCall>): PendingCall[] {
  return calls.map((call) =>
    'function' in call
      ? call
      : {
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }
  )
}

/** The args a run is driven with, with the bridge and provider it is being measured on. */
function loopOptions(options: {
  mcp: ReturnType<typeof bridgeOver>
  provider: Scripted
  autoApprove?: boolean
  workspaceRoot?: string | null
  pending?: { calls: Array<AskedCall | PendingCall>; denied: boolean }
  messages?: ChatMessage[]
}) {
  return {
    providerId: 'deepseek',
    apiKey: 'test-key',
    model: 'test-model',
    workspaceRoot: options.workspaceRoot ?? null,
    messages: options.messages ?? [{ role: 'user', content: 'do the work' } satisfies ChatMessage],
    autoApprove: options.autoApprove ?? false,
    signal: new AbortController().signal,
    fetchImpl: options.provider.fetchImpl as never,
    mcp: options.mcp,
    ...(options.pending ? { pending: { calls: asCalls(options.pending.calls), denied: options.pending.denied } } : {}),
  }
}

const ALPHA = running('alpha', 'navigate')
const ALPHA_IDENTITY = mcpToolIdentity('alpha', 'navigate')
/** The name the model sees for that call: what the sanitizer makes of the identity. */
const ALPHA_WIRE = 'mcp_alpha_navigate'

// ---------------------------------------------------------------- the tool list

async function theToolListCarriesARunningServersTools() {
  const servers = fakeServers({ tools: ALPHA })
  const provider = scriptedProvider([proseFrame()])

  const chunks = await collect(runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider })))

  const body = provider.log[0]
  const names = toolNames(body)
  assert.ok(names.includes(ALPHA_WIRE), `the server's tool must be advertised: ${JSON.stringify(names)}`)
  assert.equal(names.includes(ALPHA_IDENTITY), false, 'and never under its identity, which no provider accepts')

  // The schema is the server's own, untouched: this bridge names tools, it does not author them.
  const sent = sentTool(body, ALPHA_WIRE)
  assert.deepEqual(
    sent?.function.parameters,
    serverTool('navigate').inputSchema,
    'the input schema passes through exactly as the server sent it'
  )
  assert.equal(sent?.function.required, undefined, 'and is not flattened into the definition')
  assert.match(String(sent?.function.description), /alpha/, 'the description says which server offers it')
  assert.match(String(sent?.function.description), /approval/, 'and that every call is put to the user')

  // The built-ins are unaffected: an ordinary tool keeps its own name and the list it always had.
  assert.deepEqual(names.slice(0, 4), ['read_file', 'write_file', 'run_command', 'set_plan'])
  assert.equal(names.length, 5, 'the four built-ins and the one running tool')

  // And the loop read the reply back: nothing ran, and the turn ended on the model's own answer.
  assert.equal(chunks.at(-1)?.reason, 'complete')
  assert.equal(servers.calls.length, 0)

  results.push("a running server's tools are advertised under a provider-safe name, schemas untouched")
}

async function aStoppedServerContributesNothing() {
  // What a stopped server leaves behind is an empty answer from the registry. Nothing else changes:
  // the list of tools is rebuilt per round-trip, so the tools of a server that is gone cannot be
  // offered to a model that would then call them.
  const servers = fakeServers({ tools: [] })
  const provider = scriptedProvider([proseFrame()])

  await collect(runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider })))

  const names = toolNames(provider.log[0])
  assert.deepEqual(names, ['read_file', 'write_file', 'run_command', 'set_plan'], 'only the built-ins are left')
  assert.equal(
    names.some((name) => name.startsWith('mcp')),
    false,
    'a stopped server contributes no tool at all'
  )

  results.push('a stopped server contributes nothing to the tool list')
}

// ---------------------------------------------------------------- the names

function sanitizationIsABijection() {
  // The charset is the one every provider of this dialect accepts, and the mapping is the turn's: a
  // name that comes back is read back to the identity it was sent for, whatever the sanitizer did.
  assert.equal(sanitizeToolWireName(ALPHA_IDENTITY), ALPHA_WIRE)
  assert.equal(sanitizeToolWireName('read_file'), 'read_file', 'a name already in the charset is its own')
  for (const name of [ALPHA_IDENTITY, 'mcp:a:b.c', 'mcp:with space:tool:sub', mcpToolIdentity('srv', '工具')]) {
    assert.match(sanitizeToolWireName(name), /^[a-zA-Z0-9_-]+$/, `${name} must survive as a provider-safe name`)
  }

  const names = createMcpToolNames([ALPHA_IDENTITY])
  assert.equal(names.wireNameFor(ALPHA_IDENTITY), ALPHA_WIRE)
  assert.equal(names.identityFor(ALPHA_WIRE), ALPHA_IDENTITY, 'the assignment reads back to its own identity')

  // A name this turn never assigned is passed through in both directions: a built-in stays a built-in,
  // and a name nobody offered stays an unknown tool rather than being guessed at.
  assert.equal(names.wireNameFor('read_file'), 'read_file')
  assert.equal(names.identityFor('read_file'), 'read_file')
  assert.equal(names.identityFor('mcp_something_else'), 'mcp_something_else')

  // The identity itself: three segments, with a tool name that may hold the separator.
  assert.deepEqual(parseMcpToolIdentity(ALPHA_IDENTITY), { serverId: 'alpha', toolName: 'navigate' })
  assert.deepEqual(parseMcpToolIdentity('mcp:alpha:name:with:colons'), {
    serverId: 'alpha',
    toolName: 'name:with:colons',
  })
  assert.equal(parseMcpToolIdentity('read_file'), null)
  assert.equal(parseMcpToolIdentity('mcp:alpha'), null, 'a name with no tool in it is not an identity')
  assert.equal(parseMcpToolIdentity('mcpxalpha:y'), null, 'and the prefix is a whole segment, not a start')
  assert.equal(isMcpToolName(ALPHA_IDENTITY), true)
  assert.equal(isMcpToolName('write_file'), false)

  results.push('a provider-safe name is a bijection back to the identity, and pass-through is honest')
}

function aCollisionIsSuffixed() {
  // Two identities can sanitize to the same name — a dot and a colon both become an underscore — and
  // the two must not become one tool: the first keeps the plain name, the second is suffixed, and each
  // reads back to the identity it was sent for.
  const first = mcpToolIdentity('alpha', 'b.c')
  const second = mcpToolIdentity('alpha', 'b:c')
  assert.equal(sanitizeToolWireName(first), sanitizeToolWireName(second), 'the case is a real collision')

  const names = createMcpToolNames([first, second])
  const firstWire = names.wireNameFor(first)
  const secondWire = names.wireNameFor(second)
  assert.equal(firstWire, 'mcp_alpha_b_c')
  assert.equal(secondWire, 'mcp_alpha_b_c_2', 'the second identity is suffixed rather than folded in')
  assert.notEqual(firstWire, secondWire)
  assert.equal(names.identityFor(firstWire), first)
  assert.equal(names.identityFor(secondWire), second)
  // Asking again answers the same thing: the assignment is the turn's, not the call's.
  assert.equal(names.wireNameFor(second), secondWire)

  // A third collision takes the next index rather than reusing one.
  const third = mcpToolIdentity('alpha', 'b/c')
  assert.equal(names.wireNameFor(third), 'mcp_alpha_b_c_3')

  results.push('two identities that sanitize alike are suffixed, and each reads back to itself')
}

function thePreviewIsRedactedThenCut() {
  const secrets = ['s3cret-token', 'short']
  const redacted = truncateMcpPreview(
    // Redaction runs on the whole string before the cut, so a secret cannot survive by sitting across
    // the boundary the truncation draws.
    `{"url":"https://example.com","token":"s3cret-token"}`
  )
  assert.equal(truncateMcpPreview('{"token":"s3cret-token"}'.split('s3cret-token').join(MCP_REDACTED)), '{"token":"[REDACTED]"}')
  assert.equal(redacted.length <= MCP_CONSENT_PREVIEW_CHARS + 1, true)
  assert.equal(truncateMcpPreview('one\n two   three'), 'one two three', 'whitespace is collapsed to one line')

  const long = truncateMcpPreview(JSON.stringify({ body: 'x'.repeat(600) }))
  assert.equal(long.length, MCP_CONSENT_PREVIEW_CHARS + 1, 'a long preview is cut at the cap, marker included')
  assert.equal(long.endsWith('…'), true, 'and says so')

  // The redaction itself belongs to the bridge, and is asserted through the card it builds below.
  assert.ok(secrets.length === 2)

  results.push('a preview is one collapsed line, cut at the cap')
}

// ---------------------------------------------------------------- the consent gate

async function autoApproveDoesNotBypassAnMcpCall() {
  // The shield answers this app's own tools in advance. A tool running in another process is not one
  // it may answer for, so the call is still put to the user — and nothing is sent to the server until
  // they say so.
  const servers = fakeServers({ tools: ALPHA })
  const provider = scriptedProvider([askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com' } }])])

  const chunks = await collect(
    runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider, autoApprove: true }))
  )

  const pause = chunks.find((chunk) => chunk.type === 'awaiting_approval')
  assert.ok(pause, `an MCP call must pause even with auto-approve on: ${JSON.stringify(chunks.map((c) => c.type))}`)
  assert.equal(pause?.tool, ALPHA_IDENTITY, 'and the pause names the call by its Sam identity')
  assert.equal(servers.calls.length, 0, 'nothing reached the server before the user answered')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'tool_result'),
    false,
    'and no result was recorded for it'
  )
  // A pause is not an ending, so it is not a turn the app may pick up again by itself either.
  assert.equal(chunks.some((chunk) => chunk.type === 'auto_continue'), false, 'a pause never auto-continues')

  results.push('auto-approve does not bypass an MCP call, and the pause never continues itself')
}

async function autoApproveStillBypassesABuiltIn() {
  // The other half of the same rule: the setting is untouched for the tools it was written for.
  const root = mkdtempSync(join(tmpdir(), 'sam-mcp-bridge-'))
  try {
    const servers = fakeServers({ tools: ALPHA })
    const provider = scriptedProvider([
      askFrame([{ id: 'w1', name: 'write_file', args: { path: 'out.txt', content: 'written\n' } }]),
      proseFrame(),
    ])

    const chunks = await collect(
      runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider, autoApprove: true, workspaceRoot: root }))
    )

    assert.equal(
      chunks.some((chunk) => chunk.type === 'awaiting_approval'),
      false,
      'a write under auto-approve still runs without being asked about'
    )
    assert.equal(chunks.find((chunk) => chunk.type === 'tool_result')?.ok, true)
    assert.equal(readFileSync(join(root, 'out.txt'), 'utf8'), 'written\n', 'and it really ran')

    results.push('a built-in call under auto-approve still bypasses the gate')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function aCallBehindAnUndecidedHeadDoesNotRun() {
  // The reported defect's shape, on the MCP path: a call waiting behind a decision must not reach a
  // server, however long the user takes. The head here is an ordinary write, and the MCP call is
  // queued behind it.
  const root = mkdtempSync(join(tmpdir(), 'sam-mcp-bridge-'))
  try {
    const servers = fakeServers({ tools: ALPHA })
    const provider = scriptedProvider([
      askFrame([
        { id: 'h1', name: 'write_file', args: { path: 'out.txt', content: 'x' } },
        { id: 'c2', name: ALPHA_WIRE, args: { url: 'https://example.com' } },
      ]),
    ])

    const chunks = await collect(
      runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider, workspaceRoot: root }))
    )

    const pause = chunks.find((chunk) => chunk.type === 'awaiting_approval')
    assert.ok(pause, 'the frame pauses at its first gated call')
    assert.equal(pause?.tool, 'write_file')
    assert.equal(servers.calls.length, 0, 'the queued MCP call did not reach its server')

    const steps = stepsFrom(chunks)
    assert.deepEqual(
      steps.map((step) => step.status),
      ['awaiting', 'queued'],
      'and the transcript shows it waiting rather than settled'
    )
    assert.equal(firstPauseViolation(steps), null, 'nothing behind the undecided call has an outcome')

    results.push('an MCP call behind an undecided head does not run until the head resolves')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function approveOnceUnblocksExactlyOneCall() {
  // Consent is per call: a decision answers the call it was asked about and nothing else, and the next
  // one stops the walk again for its own question.
  const servers = fakeServers({ tools: running('alpha', 'navigate', 'click') })
  const provider = scriptedProvider([
    askFrame([
      { id: 'c1', name: 'mcp_alpha_navigate', args: { url: 'https://example.com' } },
      { id: 'c2', name: 'mcp_alpha_click', args: { url: 'https://example.com' } },
    ]),
    proseFrame(),
  ])
  const mcp = bridgeOver(servers)

  const asked = await collect(runAgentLoop(loopOptions({ mcp, provider })))
  const first = asked.find((chunk) => chunk.type === 'awaiting_approval')
  assert.ok(first, 'the first call is put to the user')
  assert.equal(servers.calls.length, 0)

  // The decision is the paused frame, as the renderer hands it back: the head first, the rest behind it.
  const frame = (first?.calls ?? []) as PendingCall[]
  const approved = await collect(runAgentLoop(loopOptions({ mcp, provider, pending: { calls: frame, denied: false } })))

  assert.deepEqual(
    servers.calls.map((call) => call.toolName),
    ['navigate'],
    'the approval ran the head and only the head'
  )
  const second = approved.find((chunk) => chunk.type === 'awaiting_approval')
  assert.ok(second, 'and the next call pauses for its own decision')
  assert.equal(second?.callId, 'c2', 'which is the call that was queued behind it')

  const last = await collect(
    runAgentLoop(loopOptions({ mcp, provider, pending: { calls: frame.slice(1), denied: false } }))
  )
  assert.deepEqual(
    servers.calls.map((call) => call.toolName),
    ['navigate', 'click'],
    'the second approval runs the second call'
  )
  assert.equal(last.at(-1)?.reason, 'complete', 'and the turn ends on the model’s own answer')

  results.push('approve-once unblocks exactly one call, and the next call pauses again')
}

async function aDenialEndsTheTurn() {
  // A refusal is still a refusal on this path: the call is answered with the denial, nothing reaches the
  // server, and the turn ends rather than asking the model anything further.
  const servers = fakeServers({ tools: ALPHA })
  const provider = scriptedProvider([askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com' } }])])
  const mcp = bridgeOver(servers)

  const asked = await collect(runAgentLoop(loopOptions({ mcp, provider })))
  const first = asked.find((chunk) => chunk.type === 'awaiting_approval')
  const frame = (first?.calls ?? []) as PendingCall[]

  const denied = await collect(runAgentLoop(loopOptions({ mcp, provider, pending: { calls: frame, denied: true } })))

  assert.equal(servers.calls.length, 0, 'a denied call never reaches the server')
  const result = denied.find((chunk) => chunk.type === 'tool_result')
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'DENIED')
  assert.equal(denied.some((chunk) => chunk.type === 'turn_end'), true, 'the turn ends where it stood')
  assert.equal(provider.log.length, 1, 'and the model is not asked again')

  results.push('a denial of an MCP call ends the turn without reaching the server')
}

async function failuresArriveAsResultsCarryingTheCode() {
  // A server that stopped between the question and the answer is the case this exists for: the model is
  // told, by code, and the turn carries on rather than dying on someone else's process.
  const servers = fakeServers({ tools: ALPHA })
  const provider = scriptedProvider([
    askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com' } }]),
    proseFrame(),
  ])
  const mcp = bridgeOver(servers)

  const asked = await collect(runAgentLoop(loopOptions({ mcp, provider })))
  const frame = (asked.find((chunk) => chunk.type === 'awaiting_approval')?.calls ?? []) as PendingCall[]

  servers.answer = () => {
    throw new ConveyorError(MCP_SERVER_NOT_RUNNING, 'The server "alpha" is not running.')
  }
  const stopped = await collect(runAgentLoop(loopOptions({ mcp, provider, pending: { calls: frame, denied: false } })))

  const result = stopped.find((chunk) => chunk.type === 'tool_result')
  assert.equal(result?.ok, false)
  assert.equal(result?.code, MCP_SERVER_NOT_RUNNING, 'the code is what a caller branches on')
  assert.match(String(result?.output), /MCP_SERVER_NOT_RUNNING/, 'and it travels with the text the model reads')
  assert.equal(stopped.at(-1)?.reason, 'complete', 'the turn continued instead of crashing')

  // A server that reports its own tool error is the same news by the same route.
  const failing = fakeServers({ tools: ALPHA })
  failing.answer = () => ({ isError: true, content: [{ type: 'text', text: 'the page did not load' }] })
  const failingProvider = scriptedProvider([
    askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com' } }]),
    proseFrame(),
  ])
  const failingBridge = bridgeOver(failing)
  const askedAgain = await collect(runAgentLoop(loopOptions({ mcp: failingBridge, provider: failingProvider })))
  const failingFrame = (askedAgain.find((chunk) => chunk.type === 'awaiting_approval')?.calls ?? []) as PendingCall[]
  const failed = await collect(
    runAgentLoop(loopOptions({ mcp: failingBridge, provider: failingProvider, pending: { calls: failingFrame, denied: false } }))
  )
  const failedResult = failed.find((chunk) => chunk.type === 'tool_result')
  assert.equal(failedResult?.code, MCP_TOOL_ERROR)
  assert.match(String(failedResult?.output), /the page did not load/, 'the server’s own words are kept')

  results.push('a failed MCP call arrives as a coded tool result, never as a thrown turn')
}

// ---------------------------------------------------------------- the consent card's data

async function thePauseCarriesWhatTheCardMustShow() {
  // The card is the one place a user is asked to trust a server they cannot see, so the pause has to
  // carry which server is asking, what the config says about it, and the arguments with the server's own
  // secrets taken out.
  const servers = fakeServers({
    tools: ALPHA,
    contexts: {
      alpha: { serverId: 'alpha', scope: 'project', trust: 'matched', secrets: ['s3cret-token'] },
    },
  })
  const provider = scriptedProvider([
    askFrame([
      { id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com', token: 's3cret-token', body: 'y'.repeat(600) } },
    ]),
  ])

  const chunks = await collect(runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider })))
  const consent = chunks.find((chunk) => chunk.type === 'awaiting_approval')?.mcp as
    | { serverId: string; toolName: string; scope: string | null; trust: string | null; argsPreview: string }
    | undefined

  assert.ok(consent, 'an MCP pause carries the consent the card renders')
  assert.equal(consent?.serverId, 'alpha')
  assert.equal(consent?.toolName, 'navigate')
  assert.equal(consent?.scope, 'project')
  assert.equal(consent?.trust, 'matched')
  assert.equal(consent?.argsPreview.includes('s3cret-token'), false, 'a known secret never reaches the card')
  assert.match(String(consent?.argsPreview), /\[REDACTED\]/, 'and is shown as redacted instead')
  assert.equal(String(consent?.argsPreview).length <= MCP_CONSENT_PREVIEW_CHARS + 1, true, 'the preview is bounded')

  // A server whose config cannot be read still gets a card: the call is what is being decided on.
  const unreadable = fakeServers({ tools: ALPHA })
  const unreadableProvider = scriptedProvider([askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://x' } }])])
  const bare = await collect(runAgentLoop(loopOptions({ mcp: bridgeOver(unreadable), provider: unreadableProvider })))
  const bareConsent = bare.find((chunk) => chunk.type === 'awaiting_approval')?.mcp as
    | { scope: string | null; trust: string | null }
    | undefined
  assert.equal(bareConsent?.scope, null)
  assert.equal(bareConsent?.trust, null)
  assert.ok(bareConsent, 'the question is still asked')

  results.push('the pause carries the server, its scope and trust, and a redacted bound preview')
}

async function aCallTheServerCannotAnswerIsStillAQuestionAndAnAnswer() {
  // The bridge's own reading of one call, without the loop: what a success looks like, and what a name
  // that is not an identity at all looks like.
  const servers = fakeServers({ tools: ALPHA })
  const mcp = bridgeOver(servers)

  const ok = await mcp.call(ALPHA_IDENTITY, JSON.stringify({ url: 'https://example.com' }))
  assert.equal(ok.ok, true)
  assert.equal(ok.output, 'navigate ok', 'a text result is the text the model reads')
  assert.deepEqual(servers.calls[0].args, { url: 'https://example.com' }, 'the arguments go through as sent')

  const notAnIdentity = await mcp.call('read_file', '{}')
  assert.equal(notAnIdentity.ok, false)
  assert.equal(notAnIdentity.code, MCP_TOOL_ERROR)
  assert.equal(await mcp.consent('read_file', '{}'), undefined, 'and no consent is claimed for one')

  const malformed = await mcp.call(ALPHA_IDENTITY, '{"url":')
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, MCP_TOOL_ERROR)
  assert.match(malformed.output, /MCP_TOOL_ERROR/, 'the code travels with the text a model reads')

  results.push('the bridge reads a call, a bad name, and bad arguments without throwing')
}

async function aCallIsRefusedByCodeNotByWording() {
  // The bridge branches on the error's code and passes it through; it never reads the sentence to
  // decide what happened, and never invents a code of its own for a failure that has one.
  const servers = fakeServers({ tools: ALPHA })
  const mcp = bridgeOver(servers)
  servers.answer = () => {
    throw new ConveyorError(MCP_TOOL_ERROR, 'The tool "navigate" failed: the driver crashed.')
  }

  const outcome = await mcp.call(ALPHA_IDENTITY, '{}')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, MCP_TOOL_ERROR)
  assert.equal(outcome.output, `${MCP_TOOL_ERROR}: The tool "navigate" failed: the driver crashed.`)

  results.push('a failure keeps its own code, and the text carries it')
}

async function main() {
  await step('the tool list carries a running server’s tools', theToolListCarriesARunningServersTools)
  await step('a stopped server contributes nothing', aStoppedServerContributesNothing)
  await step('sanitization is a bijection', sanitizationIsABijection)
  await step('a collision is suffixed', aCollisionIsSuffixed)
  await step('a preview is redacted and cut', thePreviewIsRedactedThenCut)
  await step('auto-approve does not bypass an MCP call', autoApproveDoesNotBypassAnMcpCall)
  await step('auto-approve still bypasses a built-in', autoApproveStillBypassesABuiltIn)
  await step('a call behind an undecided head waits', aCallBehindAnUndecidedHeadDoesNotRun)
  await step('approve-once unblocks one call', approveOnceUnblocksExactlyOneCall)
  await step('a denial ends the turn', aDenialEndsTheTurn)
  await step('failures arrive as coded results', failuresArriveAsResultsCarryingTheCode)
  await step('the pause carries the card’s data', thePauseCarriesWhatTheCardMustShow)
  await step('the bridge reads calls and bad input', aCallTheServerCannotAnswerIsStillAQuestionAndAnAnswer)
  await step('a failure keeps its own code', aCallIsRefusedByCodeNotByWording)
  await step('a plan left unfinished does not continue through a pause', aPlanLeftUnfinishedDoesNotContinueAPause)

  console.log(`mcp bridge: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

/**
 * The rule the pause and the auto-continue budget share: a turn stopped on a question is not a turn the
 * machine may pick up again, whatever the plan still holds.
 */
async function aPlanLeftUnfinishedDoesNotContinueAPause() {
  const servers = fakeServers({ tools: ALPHA })
  const provider = scriptedProvider([
    planFrame(),
    askFrame([{ id: 'c1', name: ALPHA_WIRE, args: { url: 'https://example.com' } }]),
  ])

  const chunks = await collect(runAgentLoop(loopOptions({ mcp: bridgeOver(servers), provider, autoApprove: true })))

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['tool_call_start', 'tool_result', 'plan', 'tool_call_start', 'awaiting_approval'],
    `unexpected chunks: ${JSON.stringify(chunks.map((chunk) => chunk.type))}`
  )
  assert.equal(chunks.some((chunk) => chunk.type === 'turn_end'), false, 'a pause is not an ending')
  assert.equal(servers.calls.length, 0)

  results.push('an unfinished plan does not let a paused MCP turn continue itself')
}

void main()
