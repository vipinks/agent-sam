// Check 6, completed: run `pwd` through the terminal stream, in an opened workspace.
//
// Two false starts are recorded here because both looked like product failures and were not:
//
//   1. `HANDLER_ERROR: Open a folder before running commands — there is no working directory.` The
//      execute schema takes `cwd` and `workspaceRoot` as inputs (conveyor/modules/terminal.ts), and
//      resolves its working directory from them. Omitting them is a malformed request, not a broken
//      terminal.
//   2. Subscribing on the wrong channel returns zero chunks, which is indistinguishable from a command
//      that never ran. Main pushes on the stream id prefixed with `conveyor:stream:`, so the
//      subscription must name the same id the start call uses.
//
// Names are taken from source rather than guessed: the exit chunk is `[EXIT_CODE:n]`
// (conveyor/protocol/terminal.ts), and the shell comes from `shellFor()`.
import { writeFileSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 9333)
const OUT = process.argv[3] ?? '.preview/pwd-final.txt'
const WORKSPACE = process.argv[4] ?? process.cwd()

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log('no page target on port ' + PORT)
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

let id = 0
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mine = ++id
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === mine) {
        ws.removeEventListener('message', onMessage)
        resolve(msg)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mine, method, params }))
  })

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) {
    return { __error: JSON.stringify(res.result.exceptionDetails).slice(0, 400) }
  }
  return res.result?.result?.value
}

// The workspace path as a JS string literal, built once so no nested template interpolation is needed
// inside the evaluated source.
const wsLiteral = JSON.stringify(WORKSPACE)

const script = [
  '(async () => {',
  '  const c = window.conveyor;',
  '  const chunks = [];',
  "  const streamId = 'probe-pwd-' + Date.now();",
  "  const channel = 'conveyor:stream:' + streamId;",
  '  const unsub = c.subscribe(channel, (p) => chunks.push(p));',
  '  try {',
  "    await c.invoke('conveyor:stream:start', streamId, {",
  "      module: 'terminal', method: 'execute', streamId,",
  `      input: { command: 'pwd', cwd: ${wsLiteral}, workspaceRoot: ${wsLiteral} },`,
  '    });',
  '  } catch (e) {',
  '    return { startError: String(e && e.message) };',
  '  }',
  '  await new Promise((r) => setTimeout(r, 5000));',
  '  unsub();',
  '  return { count: chunks.length, text: JSON.stringify(chunks).slice(0, 900) };',
  '})()',
].join('\n')

let ok = false
let detail = ''
try {
  const result = await evaluate(script)
  const blob = JSON.stringify(result ?? {})
  const exitedZero = blob.includes('[EXIT_CODE:0]')
  const noRefusal = !blob.includes('HANDLER_ERROR') && !blob.includes('CWD_REQUIRED')
  const showsDirectory = /xampp|sam-ai|[A-Za-z]:\\\\[A-Za-z]/.test(blob)
  ok = Boolean(result) && !result.startError && noRefusal && exitedZero && showsDirectory
  detail = blob.slice(0, 600)
} catch (err) {
  detail = 'probe threw: ' + String(err && err.message)
}

const line = `${ok ? 'pass' : 'FAIL'} :: terminal runs pwd :: ${detail}`
writeFileSync(OUT, line + '\n')
console.log(line)
ws.close()
process.exit(ok ? 0 : 1)
