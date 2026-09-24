/**
 * A tiny MCP server as a child process: the smallest stdio peer the runtime suites can spawn.
 *
 * The runtime speaks to this instead of to a real MCP server, because a suite must not need the
 * network, a package download, or a particular server's behaviour to prove that a process starts,
 * answers, hangs, or dies. What it speaks is the protocol's stdio framing — one JSON-RPC message per
 * line — and nothing else: no SDK, no dependencies, so the fixture cannot disagree with the client
 * about a library while agreeing with it about the wire.
 *
 * The modes, chosen by the first argument, are the ways a server can be *wrong* that the runtime has to
 * survive:
 *
 * - normal       initialize, list the tools, answer a call. The happy path.
 * - hang         accept the connection and never answer initialize — what MCP_START_TIMEOUT is for.
 *                stdin stays open, so the process stays alive the way a hung server does.
 * - bad-version  answer initialize with a protocol version no client supports, so what the server
 *                offered is a handshake this client cannot use.
 * - noisy        write to stderr before answering: one line carrying the secrets it was handed, one
 *                plain line — so a suite can prove the first is redacted and the second is not.
 * - evict        write more stderr lines than the reader keeps, so the bound is exercised by real
 *                output rather than by a stand-in for it.
 * - paged        split the tool list across two pages, so discovery has to follow the cursor the first
 *                page offered to arrive whole.
 * - cursor-loop  list one tool and offer the same cursor again, forever: a server whose pagination
 *                cannot be finished.
 *
 * The plaintext secrets reach the child the way a real server receives them — as environment
 * variables — which is what makes the redaction assertions end-to-end: the value has to have been
 * delivered, printed, and then withheld by the reader.
 */
'use strict'

const mode = process.argv[2] || 'normal'

const TOOLS = [
  {
    name: 'echo',
    description: 'Answer with the text it was given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'slow',
    description: 'Never answer, so a call to it outlives any sane call timeout.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'boom',
    description: 'Fail with a JSON-RPC error.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function note(text) {
  process.stderr.write(`${text}\n`)
}

/** What a server says about how it was configured, before it starts answering. */
function announce() {
  if (mode === 'noisy') {
    note(`auth a=${process.env.FIXTURE_TOKEN || 'unset'} b=${process.env.FIXTURE_OTHER || 'unset'}`)
    note('boot ok')
  }
  if (mode === 'evict') {
    for (let index = 1; index <= 6; index += 1) note(`line ${index}`)
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    if (mode === 'hang') return
    announce()
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        // Echoing the client's own version is the only choice that is always supported; `bad-version`
        // names one that never was.
        protocolVersion: mode === 'bad-version' ? '1999-01-01' : message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'sam-ai-fixture', version: '1.0.0' },
      },
    })
    return
  }

  if (message.method === 'notifications/initialized') return

  if (message.method === 'tools/list') {
    const cursor = message.params && message.params.cursor
    if (mode === 'cursor-loop') {
      write({ jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[0]], nextCursor: 'more' } })
      return
    }
    if (mode === 'paged') {
      // Two pages: the second is reachable only through the cursor the first one returned.
      write(
        cursor
          ? { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[1], TOOLS[2]] } }
          : { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[0]], nextCursor: 'page-2' } }
      )
      return
    }
    write({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }

  if (message.method === 'tools/call') {
    const name = message.params && message.params.name
    if (name === 'slow') {
      // Deliberately silent: the request is accepted and never answered, which is what a hung server
      // does. No timer stands in for it — one would need the process to stay alive to fire, and the
      // hang this reproduces is precisely the absence of an answer.
      return
    }
    if (name === 'boom') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'the fixture refused' } })
      return
    }
    const args = (message.params && message.params.arguments) || {}
    write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${args.text || ''}` }] } })
    return
  }

  if (message.id !== undefined) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no such method: ${message.method}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') handle(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})
