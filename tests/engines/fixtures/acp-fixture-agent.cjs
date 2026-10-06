/**
 * A tiny ACP agent as a child process: the smallest stdio peer the ACP client suites can spawn.
 *
 * The client speaks to this instead of to a real engine, because a suite must not need a vendor CLI
 * installed, a login, or a particular agent's behaviour to prove that a handshake completes, that a
 * tool call reaches the client, that a permission request is put to the user and answered, and that
 * the event stream is parsed in the order the agent wrote it.
 *
 * What it speaks is the protocol's framing and nothing else — one JSON-RPC 2.0 message per line, the
 * same stdio convention the MCP fixture uses — with no SDK and no dependency, so the fixture cannot
 * disagree with the client about a library while agreeing with it about the wire.
 *
 * The modes, chosen by the first argument, are the ways an agent can be wrong that the client has to
 * survive:
 *
 * - normal       handshake, open a session, dispatch a tool call, ask permission, finish the turn.
 * - refuse       answer `initialize` with a JSON-RPC error, so the handshake fails rather than hangs.
 * - silent       accept the connection and never answer `initialize`, which is what a start budget is for.
 * - no-consent   dispatch a tool call and never ask permission, so the client's answer path stays idle.
 * - garbage      write a line that is not JSON before the handshake, so the framer has to refuse it
 *                rather than treat it as a message.
 * - stale-session answers the *first* prompt on a session and refuses every later one with a JSON-RPC
 *                error of its own, which is the shape a session that was closed and then reused gets.
 *                It exists so the client's refusal path can be stated as an assertion: what the child
 *                said, and what of it survives into the wrapper's own code.
 * - grandchild   an ordinary turn that also starts a child of its own and streams that child's pid, so
 *                `close()` can be proved to end the *tree* rather than one process. A vendor CLI is
 *                reached through a shim that starts the real binary, which is the measured shape this
 *                mode stands in for.
 * - stalled      answer `initialize`, then never answer `session/new`: an engine whose stateful calls go
 *                unanswered without ever closing, which is what the call budget is for.
 * - grandchild-stalled  start the child of its own first, then stall the prompt, so a cancel can be proved
 *                to end the tree rather than the process it was pointed at.
 * - die          exit mid-turn, after the handshake, without answering the prompt, so the client's
 *                close-event path is stated as an assertion rather than inferred.
 */

const { spawn } = require('node:child_process')

const mode = process.argv[2] || 'normal'

/** One JSON-RPC message per line, which is the protocol's stdio framing. */
function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function success(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function failure(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params })
}

/** The update the protocol calls a tool call: what is about to run, before anyone is asked. */
function toolCallUpdate(sessionId, status) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status },
  })
}

const SESSION_ID = 'fixture-session-1'

/**
 * A child of this process, kept alive until something ends it.
 *
 * The stand-in for the real binary behind a vendor shim: it shares nothing with the parent, so a kill that
 * reaches only the parent leaves this running — which is the leak the tree kill exists for, observed rather
 * than described.
 *
 * `detached` is the whole of the modelling, and it was measured rather than assumed: an ordinary child of a
 * killed parent on this platform dies with it, so a fixture that spawned one plainly would prove nothing about
 * a tree. The live shape is the detached one — the probe recorded the shim's real `tools\opencode.exe acp`
 * still running, and still holding its port, after `child.kill()` had been sent to the shim. stdio is ignored,
 * so it holds nothing of the suite's open and the suite can end it by pid alone.
 */
function startGrandchild() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  })
}

/** The sessions this process has already answered a prompt on, for the mode above. */
const usedSessions = new Set()

/** The permission request the client has to route to the shield, and whose answer it must send back. */
let askPermission = null

/** Ask, and remember the resolver: the client's answer is what finishes the turn. */
function requestPermission() {
  return new Promise((resolve) => {
    askPermission = resolve
    write({
      jsonrpc: '2.0',
      id: 900,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'call-1', title: 'Write notes.md', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
  })
}

async function handle(message) {
  if (message.method === 'session/cancel') {
    notify('session/update', { sessionId: SESSION_ID, update: { sessionUpdate: 'cancelled' } })
    return
  }

  if (message.method === 'initialize') {
    if (mode === 'refuse') {
      failure(message.id, -32603, 'the fixture refused the handshake')
      return
    }
    success(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'fixture-agent', version: '0.0.1' },
    })
    return
  }

  if (message.method === 'session/new') {
    // A stateful call that is never answered and never refused: the process stays alive and silent, which
    // is the shape a turn hangs in. Nothing closes, so nothing the client waits on ever settles.
    if (mode === 'stalled') return
    success(message.id, { sessionId: SESSION_ID })
    return
  }

  if (message.method === 'session/prompt') {
    if (mode === 'die') {
      // A process that ends mid-turn: the client's close event is the only thing that can end this turn.
      process.exit(2)
    }

    if (mode === 'grandchild' || mode === 'grandchild-stalled') {
      const grandchild = startGrandchild()
      notify('session/update', {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'grandchild:' + grandchild.pid },
        },
      })
      // A parent that ends without its own child is exactly the shape `close()` has to end the tree for.
      if (mode === 'grandchild-stalled') return
      success(message.id, { stopReason: 'end_turn' })
      return
    }
    // A session this peer has already answered on is refused with an error of its own rather than answered
    // twice. Real engines do exactly this — a session id they do not know, or one that has been closed,
    // comes back as a JSON-RPC error — and that refusal is the one the client has to keep legible.
    if (mode === 'stale-session') {
      const asked = message.params && message.params.sessionId
      if (asked !== SESSION_ID || usedSessions.has(asked)) {
        failure(message.id, -32002, 'Session not found')
        return
      }
      usedSessions.add(asked)
      notify('session/update', {
        sessionId: SESSION_ID,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'said:' + asked } },
      })
      success(message.id, { stopReason: 'end_turn' })
      return
    }

    // The tool call is announced before anyone is asked about it, which is the order the client's own
    // event stream has to preserve: consent is per call, and a card drawn before the call it belongs to
    // would be a question about nothing.
    notify('session/update', {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Write notes.md',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'notes.md' },
      },
    })

    let answer = 'no-consent'
    if (mode !== 'no-consent') {
      answer = await requestPermission()
    }

    const approved = typeof answer === 'string' && answer.startsWith('allow')
    toolCallUpdate(SESSION_ID, approved ? 'completed' : 'failed')
    notify('session/update', {
      sessionId: SESSION_ID,
      update: {
        // The answer travels back in the prose, so the suite can prove the *chosen option* reached the
        // agent rather than merely that some response did.
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `answered:${answer}` },
      },
    })
    success(message.id, { stopReason: 'end_turn' })
    return
  }

  // The answer to our own permission request: a response, not a request — its id is ours.
  if (message.id === 900 && message.result) {
    const outcome = message.result.outcome
    const optionId = outcome && outcome.outcome === 'selected' ? outcome.optionId : 'unknown'
    if (askPermission) {
      askPermission(optionId)
      askPermission = null
    }
    return
  }

  if (message.id !== undefined) {
    failure(message.id, -32601, `no such method: ${message.method}`)
  }
}

if (mode === 'garbage') {
  // A line the framer must refuse. Written before the handshake, so a client that swallowed it as a
  // message would be answering something that was never a message.
  process.stdout.write('this is not json\n')
}

if (mode === 'silent') {
  // Never answer anything. stdin stays open, so the process stays alive the way a stuck agent does.
  process.stdin.resume()
} else {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') void handle(JSON.parse(line))
      index = buffer.indexOf('\n')
    }
  })
}
