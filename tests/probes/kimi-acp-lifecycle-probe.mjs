/**
 * Phase 72 Turn 2, the live probe: does the installed `kimi acp` refuse a second prompt, and on which shape?
 *
 * Run with: node tests/probes/kimi-acp-lifecycle-probe.mjs A B C
 *
 * Three arms, because the code reading says one thing and the failure report says another, and only a live
 * child can decide between them:
 *
 * - A  one child, one session: initialize -> session/new -> session/prompt(alpha) -> session/prompt(beta) on
 *      the *same* session id. This is the shape a client that reuses a session has.
 * - B  one child, two sessions: initialize -> session/new -> prompt(alpha) -> a fresh session/new -> prompt(beta).
 *      This is the shape the decision rule calls "a fresh session per turn on a persistent child".
 * - C  a fresh child and a fresh session per turn, which is what `runAcpTurn` actually does today: it builds a
 *      client (and therefore a child) per call and closes it in `finally`, killing the child between turns.
 *
 * Every frame in both directions is recorded verbatim — requests, responses including their error objects, and
 * notifications — and each prompt's streamed answer is printed in full, so the two answers can be read side by
 * side rather than summarised. Nothing here imports the app: the point is to observe the CLI, not to agree with
 * our own client about what it said.
 *
 * A permission question is answered with the first `allow*` option the agent offered, or `cancelled` when it
 * offered none, so a probe run cannot hang on a question nobody is there to answer.
 */
import { spawn } from 'node:child_process'

const KIMI = process.env.KIMI_BIN || 'kimi'
const CWD = process.env.PROBE_CWD || process.cwd()
const CALL_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120_000)
const START = Date.now()
const records = []

function record(kind, payload) {
  const line = JSON.stringify({ t: Date.now() - START, kind, ...payload })
  records.push(line)
  process.stdout.write(line + '\n')
}

function openChild(label) {
  const child = spawn(KIMI, ['acp'], { cwd: CWD, shell: false, windowsHide: true })
  const state = { label, child, buffer: '', nextId: 1, waiting: new Map(), sessionId: null, text: '' }

  child.stdout.on('data', (chunk) => {
    state.buffer += String(chunk)
    let index = state.buffer.indexOf('\n')
    while (index !== -1) {
      const line = state.buffer.slice(0, index)
      state.buffer = state.buffer.slice(index + 1)
      if (line.trim() !== '') handleLine(state, line)
      index = state.buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => record('agent-stderr', { child: label, text: String(chunk) }))
  child.on('error', (error) => record('child-error', { child: label, message: String(error) }))
  child.on('close', (code, signal) => record('child-close', { child: label, code, signal }))

  function handleLine(peer, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      record('agent-nonjson', { child: peer.label, line })
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      record('response', { child: peer.label, message })
      const settle = peer.waiting.get(message.id)
      if (settle) {
        peer.waiting.delete(message.id)
        settle(message)
      }
      return
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      record('agent-request', { child: peer.label, message })
      const options = message?.params?.options ?? []
      const allow = options.find((option) => String(option.kind).startsWith('allow'))
      const result = allow
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } }
      peer.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
      return
    }
    record('notification', { child: peer.label, message })
    const update = message?.params?.update
    if (message.method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk') {
      const text = update?.content?.text
      if (typeof text === 'string') peer.text += text
    }
  }

  function call(peer, method, params) {
    const id = peer.nextId
    peer.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.waiting.delete(id)
        reject(new Error(`timeout after ${CALL_TIMEOUT_MS}ms on ${method}`))
      }, CALL_TIMEOUT_MS)
      peer.waiting.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      const request = { jsonrpc: '2.0', id, method, params }
      record('request', { child: peer.label, message: request })
      peer.child.stdin.write(JSON.stringify(request) + '\n')
    })
  }

  return { state, call, close: () => child.kill() }
}

function said(response) {
  if (response?.error !== undefined) return `ERROR code=${response.error.code} message=${response.error.message}`
  return `OK stopReason=${response?.result?.stopReason ?? ''}`
}

async function handshake(peer) {
  const init = await peer.call(peer.state, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  const created = await peer.call(peer.state, 'session/new', { cwd: CWD, mcpServers: [] })
  peer.state.sessionId = created?.result?.sessionId ?? null
  return { init, created }
}

async function say(peer, text) {
  peer.state.text = ''
  const answer = await peer.call(peer.state, 'session/prompt', {
    sessionId: peer.state.sessionId,
    prompt: [{ type: 'text', text }],
  })
  return { answer, said: said(answer), streamed: peer.state.text }
}

async function armA() {
  record('arm', { arm: 'A', note: 'one child, one session, two prompts on the same session id' })
  const peer = openChild('A')
  try {
    const { init, created } = await handshake(peer)
    record('A-handshake', { initialize: said(init), newSession: said(created), sessionId: peer.state.sessionId })
    const first = await say(peer, 'Reply with exactly one word: alpha')
    record('A-prompt-1', { said: first.said, text: first.streamed, response: first.answer })
    const second = await say(peer, 'Reply with exactly one word: beta')
    record('A-prompt-2', { said: second.said, text: second.streamed, response: second.answer })
  } catch (error) {
    record('A-threw', { message: String(error) })
  } finally {
    peer.close()
  }
}

async function armB() {
  record('arm', { arm: 'B', note: 'one child, a fresh session/new before the second prompt' })
  const peer = openChild('B')
  try {
    const { init, created } = await handshake(peer)
    record('B-handshake', { initialize: said(init), newSession: said(created), sessionId: peer.state.sessionId })
    const first = await say(peer, 'Reply with exactly one word: alpha')
    record('B-prompt-1', { said: first.said, text: first.streamed, response: first.answer })
    const again = await peer.call(peer.state, 'session/new', { cwd: CWD, mcpServers: [] })
    record('B-second-newSession', { said: said(again), sessionId: again?.result?.sessionId ?? null })
    peer.state.sessionId = again?.result?.sessionId ?? null
    const second = await say(peer, 'Reply with exactly one word: beta')
    record('B-prompt-2', { said: second.said, text: second.streamed, response: second.answer })
  } catch (error) {
    record('B-threw', { message: String(error) })
  } finally {
    peer.close()
  }
}

async function armC() {
  record('arm', { arm: 'C', note: 'a fresh child and a fresh session per turn, which is what runAcpTurn does' })
  const first = openChild('C1')
  try {
    const { init, created } = await handshake(first)
    record('C-turn-1-handshake', {
      initialize: said(init),
      newSession: said(created),
      sessionId: first.state.sessionId,
    })
    const answer = await say(first, 'Reply with exactly one word: alpha')
    record('C-prompt-1', { said: answer.said, text: answer.streamed, response: answer.answer })
  } catch (error) {
    record('C-turn-1-threw', { message: String(error) })
  } finally {
    // The turn's own `finally`: close the client, which kills the child.
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  const second = openChild('C2')
  try {
    const { init, created } = await handshake(second)
    record('C-turn-2-handshake', {
      initialize: said(init),
      newSession: said(created),
      sessionId: second.state.sessionId,
    })
    const answer = await say(second, 'Reply with exactly one word: beta')
    record('C-prompt-2', { said: answer.said, text: answer.streamed, response: answer.answer })
  } catch (error) {
    record('C-turn-2-threw', { message: String(error) })
  } finally {
    second.close()
  }
}

const arms = process.argv.slice(2)
const watchdog = setTimeout(() => {
  record('watchdog', { note: 'the probe exceeded its budget and stopped itself' })
  process.exit(1)
}, 600_000)
watchdog.unref?.()

const run = async () => {
  for (const arm of arms) {
    if (arm === 'A') await armA()
    if (arm === 'B') await armB()
    if (arm === 'C') await armC()
  }
  record('probe-done', { seconds: Math.round((Date.now() - START) / 1000) })
  process.exit(0)
}

void run().catch((error) => {
  record('probe-failed', { message: String(error) })
  process.exit(1)
})
