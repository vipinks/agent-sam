/**
 * Phase 73 Turn 2, the live probe: is the installed `opencode acp` healthy, and does a second sequence —
 * a fresh child with the same three calls — answer?
 *
 * Run with: node tests/probes/opencode-acp-lifecycle-probe.mjs
 *
 * Two sequences, each a fresh child: initialize -> session/new -> session/prompt. Between them the child is
 * killed the way the app kills it (`child.kill()`, which is `engine-acp.ts`'s `close()`), and what the OS
 * still holds afterwards is recorded — every `opencode.exe` with its parent and its command line, and the
 * listening sockets — because the defect report says the second turn neither answers nor errors.
 *
 * Every frame in both directions is recorded verbatim, and each prompt's streamed answer is printed in full,
 * so the two answers can be read side by side rather than summarised. Nothing here imports the app: the point
 * is to observe the CLI, not to agree with our own client about what it said.
 *
 * A permission question is answered with the first `allow*` option the agent offered, or `cancelled` when it
 * offered none, so a probe run cannot hang on a question nobody is there to answer.
 */
import { spawn, execFileSync } from 'node:child_process'

const BIN = process.env.PROBE_BIN || 'opencode'
const CWD = process.env.PROBE_CWD || process.cwd()
const CALL_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 60_000)
const START = Date.now()

function record(kind, payload) {
  process.stdout.write(JSON.stringify({ t: Date.now() - START, kind, ...payload }) + '\n')
}

/** Every `opencode.exe` the machine is running, with the parent and the command line that says what it is. */
function processes() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'opencode.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8' }
    )
    const parsed = JSON.parse(out.trim() === '' ? '[]' : out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    return [{ error: String(error) }]
  }
}

/** The listening sockets, because the CLI's `acp` subcommand listens on one. */
function listeners() {
  try {
    return execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('LISTENING'))
      .map((line) => line.trim())
  } catch {
    return []
  }
}

function openChild(label) {
  const child = spawn(BIN, ['acp'], { cwd: CWD, shell: false, windowsHide: true })
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

  return { state, call, kill: () => child.kill() }
}

function said(response) {
  if (response?.error !== undefined) return `ERROR code=${response.error.code} message=${response.error.message}`
  return `OK stopReason=${response?.result?.stopReason ?? ''}`
}

async function sequence(label, prompt) {
  record('sequence-start', { label, prompt })
  record('procs-before', { label, procs: processes() })
  const peer = openChild(label)
  record('procs-spawned', { label, procs: processes() })
  const result = { label, init: null, session: null, prompt: null, answer: null, error: null }
  try {
    const init = await peer.call(peer.state, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    result.init = said(init)
    record(`${label}-initialize`, { said: result.init, response: init })

    const created = await peer.call(peer.state, 'session/new', { cwd: CWD, mcpServers: [] })
    peer.state.sessionId = created?.result?.sessionId ?? null
    result.session = said(created)
    record(`${label}-new-session`, { said: result.session, sessionId: peer.state.sessionId, response: created })

    const answer = await peer.call(peer.state, 'session/prompt', {
      sessionId: peer.state.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    result.prompt = said(answer)
    result.answer = peer.state.text
    record(`${label}-prompt`, { said: result.prompt, text: peer.state.text, response: answer })
  } catch (error) {
    result.error = String(error)
    record(`${label}-threw`, { message: String(error) })
  }
  return result
}

const watchdog = setTimeout(() => {
  record('watchdog', { note: 'the probe exceeded its budget and stopped itself' })
  process.exit(1)
}, 300_000)
watchdog.unref?.()

const run = async () => {
  const first = await sequence('seq-1', 'Reply with exactly one word: alpha')
  record('procs-after-seq-1', { procs: processes() })
  record('listeners-after-seq-1', { listeners: listeners() })

  // The app's own ending: `engine-acp.ts`'s `close()` is `child.kill()` on the direct child.
  record('kill-seq-1', { note: 'child.kill() on the direct child, as engine-acp close() does' })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  record('procs-after-kill', { procs: processes() })
  record('listeners-after-kill', { listeners: listeners() })

  const second = await sequence('seq-2', 'Reply with exactly one word: beta')
  record('procs-after-seq-2', { procs: processes() })
  record('listeners-after-seq-2', { listeners: listeners() })

  record('probe-done', {
    seconds: Math.round((Date.now() - START) / 1000),
    seq1: { init: first.init, session: first.session, prompt: first.prompt, answer: first.answer, error: first.error },
    seq2: {
      init: second.init,
      session: second.session,
      prompt: second.prompt,
      answer: second.answer,
      error: second.error,
    },
  })
  process.exit(0)
}

void run().catch((error) => {
  record('probe-failed', { message: String(error) })
  process.exit(1)
})
