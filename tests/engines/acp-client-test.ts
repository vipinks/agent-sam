/**
 * Verifies the ACP client against a real fixture agent: the handshake, opening a session, dispatching
 * a tool call, receiving a `session/request_permission` and sending the chosen option back, and parsing
 * the event stream in the order the agent wrote it.
 *
 * The peer is `tests/engines/fixtures/acp-fixture-agent.cjs` — a tiny node script speaking the protocol
 * over stdio — spawned for real, because the claims here are about bytes on a pipe and a process the OS
 * can see: that our request reaches it, that its notification reaches the event sink before the question
 * it is about, that the answer we send is the option the user picked, and that closing really ends the
 * process. A stand-in would have to be told every one of those, and would then be a claim about the
 * stand-in.
 *
 * The framing is the protocol's own: one JSON-RPC 2.0 message per line. Nothing here is a message
 * string read back out of an error — the refusals are asserted by code, because the code is what the
 * caller branches on.
 *
 * Nothing here touches the network, a vendor CLI, or the user's app data: every process this suite
 * starts is its own, and every one is stopped before the suite exits, including when an assertion fails
 * part-way.
 */
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  ACP_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  acpOptionApproves,
  acpPermissionRequest,
  parseAcpChunk,
  type AcpEvent,
  type AcpPermissionRequest,
} from '../../conveyor/protocol/acp'
import { createAcpClient, type AcpClient, type AcpSpawnImpl } from '../../conveyor/modules/engine-acp'

const results: string[] = []

// `npm run test:node` is the only supported way to run a suite, and it runs from the repository root.
// The path is resolved from there rather than from the bundle esbuild writes, which is one directory
// deeper — a resolution this suite would otherwise not notice was wrong until it spawned nothing.
const FIXTURE = join(process.cwd(), 'tests', 'engines', 'fixtures', 'acp-fixture-agent.cjs')
if (!existsSync(FIXTURE)) {
  throw new Error(`the ACP fixture is missing at ${FIXTURE}: run the suites from the repository root`)
}

/** Every process this suite started, so each one can be proved gone and none is left running. */
const children: ChildProcessWithoutNullStreams[] = []

/**
 * The spawn the client is given, recording the child.
 *
 * The recording is what lets the last step ask the OS whether the process ended, rather than asking the
 * client whether it thinks it did.
 */
const recordingSpawn: AcpSpawnImpl = (command, args, options) => {
  const child = spawn(command, args as string[], options as SpawnOptionsWithoutStdio)
  children.push(child)
  return child
}

/** One fixture agent, wired to the callbacks a case cares about. */
function fixture(
  mode: string,
  hooks: {
    onEvent?: (event: AcpEvent) => void
    onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string>
    onMalformedLine?: (line: string) => void
  } = {}
): AcpClient {
  return createAcpClient({
    spawn: { command: process.execPath, args: [FIXTURE, mode] },
    spawnImpl: recordingSpawn,
    onEvent: hooks.onEvent,
    // A case that never expects a question still has to answer one rather than hang: the fixture asks
    // whenever it is not in `no-consent` mode.
    onPermissionRequest: hooks.onPermissionRequest ?? (() => Promise.resolve('allow-once')),
    onMalformedLine: hooks.onMalformedLine,
  })
}

/** Resolve once the child has exited, or reject if it outlives the budget. */
function waitForExit(child: ChildProcessWithoutNullStreams, budgetMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the child outlived the budget')), budgetMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// ---------------------------------------------------------------- the handshake

/** The handshake completes, and what it carried is the protocol's own version and capabilities. */
async function theClientHandshakesWithTheFixtureAgent() {
  const seen: unknown[] = []
  const client = createAcpClient({
    spawn: { command: process.execPath, args: [FIXTURE, 'normal'] },
    spawnImpl: recordingSpawn,
    onEvent: (event) => seen.push(event),
    onPermissionRequest: () => Promise.resolve('allow-once'),
  })

  const handshake = await client.initialize()
  assert.equal(handshake.protocolVersion, ACP_PROTOCOL_VERSION, 'the agent answered the version we speak')
  assert.equal(handshake.agentName, 'fixture-agent', 'and named itself, which is what a surface prints')
  assert.equal(handshake.refused, false, 'a completed handshake is not a refused one')

  assert.equal(seen.length, 0, 'the handshake itself produced no event: nothing has been asked for yet')
  client.close()
  await waitForExit(children[children.length - 1])

  results.push('the handshake completes against a real ACP peer, and carries the protocol version')
}

/**
 * A handshake the agent refuses is a coded refusal rather than a hang or a sentence.
 *
 * This is the case the client must not turn into a timeout: the agent answered, and the answer was no.
 */
async function aRefusedHandshakeIsACodedRefusal() {
  const client = fixture('refuse')

  let thrown: unknown = null
  try {
    await client.initialize()
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ConveyorError, 'the refusal is a ConveyorError, not a bare Error')
  assert.equal((thrown as ConveyorError).code, ACP_CODES.ACP_HANDSHAKE_FAILED, 'and its code is the handshake code')
  assert.notEqual(
    (thrown as ConveyorError).code,
    (thrown as ConveyorError).message,
    'the code is not the message: nothing may branch on a sentence'
  )

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('a refused handshake fails with the handshake code, never with a message to read')
}

// ---------------------------------------------------------------- the session and the tool call

/**
 * Opening a session answers with the agent's session id, which every later call is addressed by.
 */
async function theSessionIsOpenedAndItsIdHeld() {
  const client = fixture('normal')
  await client.initialize()
  const sessionId = await client.newSession()

  assert.equal(sessionId, 'fixture-session-1', 'the session id is the agent’s answer, not one we invented')
  assert.equal(client.sessionId, sessionId, 'and the client holds it, so a prompt needs no second argument')

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('the session is opened and its id held, so a prompt is addressed without re-sending it')
}

/**
 * The whole turn: a tool call is dispatched, the consent question arrives before the answer, and the
 * option the user chose is the option the agent receives.
 *
 * The order is the claim that matters most: the tool call is announced *before* the question is put,
 * which is what makes the card a question about a call the transcript already carries.
 */
async function theToolCallIsDispatchedAndTheConsentAnswerReturns() {
  const events: AcpEvent[] = []
  const requests: AcpPermissionRequest[] = []
  const client = fixture('normal', {
    onEvent: (event) => events.push(event),
    onPermissionRequest: (request) => {
      requests.push(request)
      return Promise.resolve('allow-once')
    },
  })

  await client.initialize()
  await client.newSession()
  const finished = await client.prompt('write notes.md')

  assert.equal(finished.stopReason, 'end_turn', 'the turn ended by the agent’s own word for it')

  assert.equal(requests.length, 1, 'exactly one consent question was put')
  const request = requests[0]
  assert.equal(request.requestId, '900', 'the question is identified by the id the agent used')
  assert.equal(request.sessionId, 'fixture-session-1', 'against the session it belongs to')
  assert.equal(request.toolCallId, 'call-1', 'and the call it is about')
  assert.equal(request.title, 'Write notes.md', 'with the title a card reads')
  assert.deepEqual(
    request.options.map((option) => option.optionId),
    ['allow-once', 'reject-once'],
    'and the options the agent offered, in its order'
  )

  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_call', 'tool_call_update', 'message_chunk'],
    'the tool call is announced first, then its outcome, then the prose'
  )
  const announced = events[0]
  assert.equal(
    announced.type === 'tool_call' ? announced.toolCallId : '',
    'call-1',
    'the announced call is the asked-about one'
  )
  assert.equal(
    events[2].type === 'message_chunk' ? events[2].text : '',
    'answered:allow-once',
    'and the agent received the option the user chose, not merely some response'
  )

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('a tool call is dispatched, the question arrives before the answer, and the chosen option returns')
}

/**
 * A denial reaches the agent as its own option, and the option kinds are what say which is which.
 *
 * The client never guesses: `acpOptionApproves` is the only place the meaning of an option is decided,
 * and it is decided from the kind the agent declared.
 */
async function aDenialIsTheAgentsOwnOption() {
  const events: AcpEvent[] = []
  const client = fixture('normal', {
    onEvent: (event) => events.push(event),
    onPermissionRequest: (request) => {
      const reject = request.options.find((option) => option.kind === 'reject_once')
      assert.ok(reject, 'the fixture offered a rejecting option')
      assert.equal(acpOptionApproves(request.options[0]), true, 'an allow_once option approves')
      assert.equal(acpOptionApproves(reject), false, 'and a reject_once option does not')
      return Promise.resolve(reject.optionId)
    },
  })

  await client.initialize()
  await client.newSession()
  await client.prompt('write notes.md')

  const update = events.find((event) => event.type === 'tool_call_update')
  assert.ok(update && update.type === 'tool_call_update', 'the call reached an outcome')
  assert.equal(update.status, 'failed', 'a denied call is the failed one')
  assert.equal(
    events[2].type === 'message_chunk' ? events[2].text : '',
    'answered:reject-once',
    'and the agent was told so in its own vocabulary'
  )

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('a denial travels as the agent’s own rejecting option, and the call is reported failed')
}

/**
 * An agent that never asks produces no question, which is the ordinary case for a turn that runs
 * nothing gated — and the client must not invent one.
 */
async function aTurnWithNoQuestionAsksNothing() {
  const events: AcpEvent[] = []
  let asked = 0
  const client = fixture('no-consent', {
    onEvent: (event) => events.push(event),
    onPermissionRequest: () => {
      asked += 1
      return Promise.resolve('allow-once')
    },
  })

  await client.initialize()
  await client.newSession()
  await client.prompt('say hello')

  assert.equal(asked, 0, 'nothing was put to the user')
  assert.equal(
    events[2].type === 'message_chunk' ? events[2].text : '',
    'answered:no-consent',
    'and the agent’s own outcome travelled back whole'
  )

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('a turn that asks nothing puts nothing to the user, and its stream is still parsed')
}

// ---------------------------------------------------------------- the framing

/**
 * A line that is not JSON is reported as malformed rather than swallowed as a message — and the stream
 * recovers, because one bad line on a pipe is not the end of the conversation.
 */
async function aMalformedLineIsRefusedAndTheStreamRecovers() {
  const malformed: string[] = []
  const client = fixture('garbage', { onMalformedLine: (line) => malformed.push(line) })

  const handshake = await client.initialize()

  assert.deepEqual(malformed, ['this is not json'], 'the line was reported, not parsed into a message')
  assert.equal(handshake.protocolVersion, ACP_PROTOCOL_VERSION, 'and the handshake that followed still completed')

  client.close()
  await waitForExit(children[children.length - 1])

  results.push('a malformed line is reported as malformed, and the stream recovers after it')
}

/**
 * The framer is a rule, and it is asserted as one: a chunk may split a message, a chunk may carry
 * several, and what is left over is handed back rather than dropped.
 */
function theFramerSplitsMessagesOnNewlines() {
  const first = parseAcpChunk('', '{"a":1}\n{"b":')
  assert.deepEqual(first.messages, [{ a: 1 }], 'the complete line became one message')
  assert.equal(first.rest, '{"b":', 'and the incomplete one is held back')
  assert.deepEqual(first.malformed, [], 'nothing was malformed')

  const second = parseAcpChunk(first.rest, '2}\n\n{"c":3}\n')
  assert.deepEqual(second.messages, [{ b: 2 }, { c: 3 }], 'the held-back line completed, and the blank one was skipped')
  assert.equal(second.rest, '', 'with nothing left over')

  const broken = parseAcpChunk('', 'nope\n{"d":4}\n')
  assert.deepEqual(broken.messages, [{ d: 4 }], 'a bad line does not take the good one after it with it')
  assert.deepEqual(broken.malformed, ['nope'], 'and it is reported as the malformed line it was')

  results.push('the framer splits on newlines, holds a split message, and reports a bad line')
}

// ---------------------------------------------------------------- shutdown

/**
 * Closing ends the process, and the client refuses further work rather than writing into a dead pipe.
 *
 * The OS is the judge: the exit event is awaited, so a `close()` that only forgot its child would fail
 * here rather than leak a process per session.
 */
async function closingEndsTheProcessAndTheClient() {
  const client = fixture('normal')
  await client.initialize()

  const child = children[children.length - 1]
  assert.ok(child.pid, 'the fixture really is a process')

  client.close()
  await waitForExit(child)
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'the process ended')

  let thrown: unknown = null
  try {
    await client.prompt('anyone there?')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof ConveyorError, 'a closed client refuses with a ConveyorError')
  assert.equal((thrown as ConveyorError).code, ACP_CODES.ACP_CLOSED, 'and its code says the client is closed')

  results.push('closing ends the process, and a closed client refuses further work by code')
}

// ---------------------------------------------------------------- purity

/**
 * The protocol module declares no imports, which is what keeps it usable from both sides.
 *
 * Read rather than inferred: an import of a process, a store or a component would be a second input,
 * and the framing would then depend on something other than the bytes it was handed.
 */
function theProtocolModuleHoldsNoSecondInput() {
  const path = join(process.cwd(), 'conveyor', 'protocol', 'acp.ts')
  assert.ok(existsSync(path), `the protocol module is where this suite reads it: ${path}`)
  const imports = readFileSync(path, 'utf8').match(/^\s*import\b/gm) ?? []

  assert.equal(imports.length, 0, `the protocol module declares no imports, found ${imports.length}`)
  assert.equal(
    ACP_METHODS.requestPermission,
    'session/request_permission',
    'and the method it routes is the protocol’s'
  )
  assert.ok(
    acpPermissionRequest({ jsonrpc: '2.0', method: 'session/update', params: {} }) === null,
    'a notification that is not a permission request is not read as one'
  )

  results.push('the protocol module declares no imports, so framing depends on bytes and nothing else')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  try {
    await step('handshake', theClientHandshakesWithTheFixtureAgent)
    await step('refused handshake', aRefusedHandshakeIsACodedRefusal)
    await step('session', theSessionIsOpenedAndItsIdHeld)
    await step('tool call + consent', theToolCallIsDispatchedAndTheConsentAnswerReturns)
    await step('denial', aDenialIsTheAgentsOwnOption)
    await step('no question', aTurnWithNoQuestionAsksNothing)
    await step('framing', aMalformedLineIsRefusedAndTheStreamRecovers)
    await step('framer rule', theFramerSplitsMessagesOnNewlines)
    await step('shutdown', closingEndsTheProcessAndTheClient)
    await step('purity', theProtocolModuleHoldsNoSecondInput)
  } finally {
    // Every child is killed here as well as in the case that started it, so a failing assertion cannot
    // leave a fixture agent running: a suite that leaked a process would be a suite that hangs the gate.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }

  console.log('acp client: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('ACP CLIENT TEST FAILED:', err)
  process.exit(1)
})
