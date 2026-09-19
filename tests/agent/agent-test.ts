/**
 * Verifies the ReAct loop and the filesystem tools against a mocked provider — no network, no keys.
 *
 * The mocked SSE is the part that matters: a tool call arrives as fragments spread across frames, so
 * this proves the loop accumulates an id, a name, and JSON arguments split mid-token, executes the
 * tool for real against a temp workspace, feeds the result back, and then finishes on the model's
 * prose. Also covers the consent gate and the path containment rules.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool, needsApproval, runAgentLoop, TOOL_DEFINITIONS } from '../../conveyor/modules/agent'
import { resolveWorkspacePath } from '../../conveyor/modules/workspace-paths'

const results: string[] = []

/** Build a Response whose body is the given SSE text, chunked however the caller likes. */
function sseResponse(frames: string[], chunkSize = 64): Response {
  const payload = frames.map((f) => `data: ${f}\n\n`).join('')
  const bytes = new TextEncoder().encode(payload)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Deliberately split mid-frame: SSE handling must cope with frames arriving in pieces.
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** A provider that answers the first request with a tool call and the second with prose. */
function twoRoundFetch(log: unknown[]): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push({ call, body: JSON.parse(String(init.body)) })

    if (call === 1) {
      return sseResponse([
        // The id and name arrive first, with the arguments still empty.
        JSON.stringify({
          choices: [
            {
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } },
                ],
              },
            },
          ],
        }),
        // A fragment that itself splits the JSON mid-string.
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }),
        '[DONE]',
      ])
    }

    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'The file says ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'hello.' } }] }),
      '[DONE]',
    ])
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of iter) out.push(chunk as Record<string, unknown>)
  return out
}

// ---------------------------------------------------------------- the loop

async function reactLoop() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'hello\n', 'utf8')
    const log: unknown[] = []

    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'read a.txt' }],
        // Reads are safe, so no gate is involved here.
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: twoRoundFetch(log) as never,
      })
    )

    const types = chunks.map((c) => c.type)
    assert.deepEqual(
      types,
      ['tool_call_start', 'tool_result', 'text_delta', 'text_delta', 'done'],
      `unexpected chunk sequence: ${JSON.stringify(types)}`
    )

    // The tool call was assembled from fragments rather than read whole from one frame.
    const start = chunks[0]
    assert.equal(start.tool, 'read_file')
    assert.deepEqual(start.args, { path: 'a.txt' })
    assert.equal(start.callId, 'call_1')

    // The tool really ran: this is the file's content, from disk.
    const result = chunks[1]
    assert.equal(result.ok, true)
    assert.equal(result.output, 'hello\n')

    // The prose came through, and the run ended on its own rather than looping.
    assert.equal(chunks.at(-1)?.reason, 'complete')
    assert.equal(log.length, 2, 'exactly two round-trips: the tool request and the answer')

    // Both requests advertised the tools; the second carried the tool result back.
    const second = log[1] as { body: { messages: Array<Record<string, unknown>>; tools?: unknown[] } }
    assert.ok(Array.isArray(second.body.tools) && second.body.tools.length === 3, 'tools were advertised')
    const assistantTurn = second.body.messages.find((m) => m.role === 'assistant' && m.tool_calls)
    assert.ok(assistantTurn, 'the assistant tool-call turn was replayed back to the provider')
    const toolTurn = second.body.messages.find((m) => m.role === 'tool')
    assert.ok(toolTurn, 'the tool result was replayed as a tool turn')
    assert.equal(toolTurn?.tool_call_id, 'call_1', 'the tool turn must answer the right call')
    assert.equal(toolTurn?.content, 'hello\n')

    results.push('a fragmented tool_call is assembled, executed, and fed back before the answer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function writeThenRead() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // write_file through the tool, including a directory that does not exist yet.
    const written = await executeTool(
      'write_file',
      JSON.stringify({ path: 'nested/deep/out.txt', content: 'written by the agent' }),
      root,
      new AbortController().signal
    )
    assert.equal(written.ok, true, `write failed: ${written.output}`)
    assert.equal(readFileSync(join(root, 'nested', 'deep', 'out.txt'), 'utf8'), 'written by the agent')

    results.push('write_file creates intermediate directories and writes the content')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runCommandTool() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // A mocked spawn, so nothing is executed: this checks that the tool routes through the terminal
    // module and collects stdout *and* stderr, not that a shell works.
    const { EventEmitter } = await import('node:events')
    // `EventEmitter` is a value; the instance type comes from `typeof` it, since the import is a
    // binding rather than a type.
    type Emitter = InstanceType<typeof EventEmitter>
    const child = new EventEmitter() as Emitter & {
      stdout: Emitter
      stderr: Emitter
      killed: boolean
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      return true
    }
    const spawnImpl = (() => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('out\n'))
        child.stderr.emit('data', Buffer.from('warn\n'))
        child.emit('close', 0)
      })
      return child
    }) as never

    const outcome = await executeTool(
      'run_command',
      JSON.stringify({ command: 'echo out' }),
      root,
      new AbortController().signal,
      spawnImpl
    )

    assert.equal(outcome.ok, true, `command failed: ${outcome.output}`)
    assert.ok(outcome.output.includes('out\n'), 'stdout should be in the result')
    assert.ok(outcome.output.includes('warn\n'), 'stderr should be in the result')
    // The wire markers are the terminal's protocol, not the model's business: the result the model
    // receives carries the exit code as prose and no markers at all.
    assert.ok(
      outcome.output.includes('Command succeeded (exit code 0)'),
      `the exit code should be reported: ${JSON.stringify(outcome.output)}`
    )
    assert.ok(!outcome.output.includes('EXIT_CODE'), 'the exit marker must not reach the model')
    assert.ok(!outcome.output.includes('[STDERR]'), 'the stderr marker must be stripped for the model')

    results.push('run_command runs through the terminal module and reports stdout, stderr, and exit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- consent

function approvalRules() {
  assert.equal(needsApproval('read_file'), false, 'reading is safe and must not need approval')
  assert.equal(needsApproval('write_file'), true, 'writing changes the user’s files')
  assert.equal(needsApproval('run_command'), true, 'commands can do anything')
  assert.equal(needsApproval('something_new'), true, 'an unknown tool must ask rather than assume')
  results.push('only read_file is pre-approved; an unknown tool asks')
}

async function pausesForApproval() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    const log: unknown[] = []
    // A write, which needs consent, with auto-approve off.
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'write a file' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: singleToolCallFetch('write_file', { path: 'x.txt', content: 'hi' }, log) as never,
      })
    )

    const types = chunks.map((c) => c.type)
    assert.deepEqual(types, ['tool_call_start', 'awaiting_approval'], `unexpected: ${JSON.stringify(types)}`)

    const pause = chunks[1]
    assert.equal(pause.callId, 'call_1')
    assert.equal(pause.tool, 'write_file')

    // The history handed over ends with the assistant turn that asked for the call, so resuming can
    // append the result without reconstructing anything.
    const messages = pause.messages as Array<Record<string, unknown>>
    const last = messages.at(-1)
    assert.equal(last?.role, 'assistant', 'the pause must hand over the assistant turn')
    assert.ok(Array.isArray(last?.tool_calls), 'and that turn must carry the call it wants approved')

    // Nothing was written: the pause came before execution, which is the whole point.
    assert.throws(() => readFileSync(join(root, 'x.txt'), 'utf8'), 'the file must not exist yet')

    results.push('a write with auto-approve off pauses before touching the disk, handing over history')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function gatedWriteCarriesItsDiff() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // The baseline is a real file on disk, and the proposed content changes one of its lines: the
    // card must show that, not merely which file it touches.
    writeFileSync(join(root, 'x.txt'), 'alpha\nbeta\n', 'utf8')
    const log: unknown[] = []
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'edit x.txt' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: singleToolCallFetch('write_file', { path: 'x.txt', content: 'alpha\nBETA\n' }, log) as never,
      })
    )

    const pause = chunks.find((c) => c.type === 'awaiting_approval')
    assert.ok(pause, 'the write must gate')
    const diff = pause.diff as { lines: Array<{ kind: string; text: string }>; added: number; removed: number }
    assert.ok(diff, 'a gated write must carry the change it would make')
    assert.equal(diff.removed, 1, `expected one removal: ${JSON.stringify(diff.lines)}`)
    assert.equal(diff.added, 1, `expected one addition: ${JSON.stringify(diff.lines)}`)
    assert.deepEqual(
      diff.lines.filter((line) => line.kind !== 'context'),
      [
        { kind: 'removed', text: 'beta' },
        { kind: 'added', text: 'BETA' },
      ],
      'the diff must name the changed line'
    )

    // A command is a consent prompt with no change to preview: the field is about what is being
    // asked for, so it must not appear where there is nothing to show.
    const commandChunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'run something' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: singleToolCallFetch('run_command', { command: 'echo hi' }, log) as never,
      })
    )
    const commandPause = commandChunks.find((c) => c.type === 'awaiting_approval')
    assert.ok(commandPause, 'the command must gate')
    assert.equal(commandPause.diff, undefined, 'only a write has a change to preview')

    results.push('a gated write carries a diff of the change, computed in main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A provider that asks for one named tool call on the first request, then falls silent. */
function singleToolCallFetch(name: string, args: unknown, log: unknown[]) {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push({ call, body: JSON.parse(String(init.body)) })
    return sseResponse([
      JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
              ],
            },
          },
        ],
      }),
      '[DONE]',
    ])
  }
}

async function resumeAfterApproval() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    const log: unknown[] = []
    const history = [
      { role: 'user' as const, content: 'write a file' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'write_file', arguments: '{"path":"x.txt","content":"hi"}' },
          },
        ],
      },
    ]

    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: history,
        autoApprove: false,
        signal: new AbortController().signal,
        steps: 1,
        pending: { calls: [history[1]!.tool_calls![0]!], denied: false },
        // Answers the follow-up request with prose, ending the run.
        fetchImpl: textOnlyFetch('Written.', log) as never,
      })
    )

    const types = chunks.map((c) => c.type)
    assert.deepEqual(types, ['tool_result', 'text_delta', 'done'], `unexpected: ${JSON.stringify(types)}`)
    assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'hi', 'approving must actually run the tool')

    // The regression guard: the provider must receive exactly one assistant turn for this call.
    // Rebuilding it on resume would duplicate the turn and orphan the call's results.
    const body = (log[0] as { body: { messages: Array<Record<string, unknown>> } }).body
    const assistantTurns = body.messages.filter((m) => m.role === 'assistant' && m.tool_calls)
    assert.equal(assistantTurns.length, 1, `expected one assistant tool turn, got ${assistantTurns.length}`)
    // And every call in that turn has exactly one result.
    const toolTurns = body.messages.filter((m) => m.role === 'tool')
    assert.equal(toolTurns.length, 1, 'expected exactly one tool result')
    assert.equal(toolTurns[0].tool_call_id, 'call_1')

    results.push('resuming after approval runs the tool without duplicating the assistant turn')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function resumeAfterDenial() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    const log: unknown[] = []
    const call = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' },
    }

    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [
          { role: 'user', content: 'delete everything' },
          { role: 'assistant', content: '', tool_calls: [call] },
        ],
        autoApprove: false,
        signal: new AbortController().signal,
        steps: 1,
        pending: { calls: [call], denied: true },
        fetchImpl: textOnlyFetch('I will not.', log) as never,
      })
    )

    const result = chunks.find((c) => c.type === 'tool_result')
    assert.ok(result, 'a denial must still produce a tool result')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DENIED')
    // The refusal is phrased so the model explains itself rather than retrying the same call.
    assert.ok(String(result.output).includes('denied'), 'the model must be told it was refused')
    assert.ok(String(result.output).includes('Do not retry'), 'and told not to retry')

    // The denial is replayed to the provider as the tool's result, not dropped.
    const body = (log[0] as { body: { messages: Array<Record<string, unknown>> } }).body
    const toolTurn = body.messages.find((m) => m.role === 'tool')
    assert.ok(toolTurn, 'the denial must be fed back so the model can explain it')
    assert.deepEqual(
      chunks.map((c) => c.type),
      ['tool_result', 'text_delta', 'done']
    )

    results.push('a denied call is fed back as its result, so the model can explain the failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A provider that answers with prose only. */
function textOnlyFetch(text: string, log: unknown[]) {
  return async (_url: string, init: RequestInit) => {
    log.push({ body: JSON.parse(String(init.body)) })
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: text } }] }), '[DONE]'])
  }
}

async function stepBudgetStopsTheLoop() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // A provider that asks for a tool forever: without a budget this never ends.
    let call = 0
    const alwaysToolFetch = async () => {
      call += 1
      return sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${call}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
        }),
        '[DONE]',
      ])
    }
    writeFileSync(join(root, 'a.txt'), 'x')

    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'loop' }],
        autoApprove: true,
        signal: new AbortController().signal,
        fetchImpl: alwaysToolFetch as never,
      })
    )

    const last = chunks.at(-1)
    assert.equal(last?.type, 'done')
    assert.equal(last?.reason, 'max_steps', 'the loop must stop at the budget rather than run forever')
    assert.equal(last?.steps, 10, 'the budget is ten steps')

    results.push('a model that asks for tools forever is stopped by the step budget')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- containment

function pathTraversalBlocked() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // The documented attack.
    assert.throws(
      () => resolveWorkspacePath(root, '../../etc/passwd'),
      (e: { code?: string }) => e.code === 'PATH_TRAVERSAL',
      'a climbing relative path must be refused'
    )

    // An absolute path outside the workspace.
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd'
    assert.throws(
      () => resolveWorkspacePath(root, outside),
      (e: { code?: string }) => e.code === 'PATH_TRAVERSAL',
      'an absolute path outside the workspace must be refused'
    )

    // A sibling whose name merely starts with the root's name must not pass a prefix check.
    assert.throws(
      () => resolveWorkspacePath(root, `../${''}${root.split(/[\\/]/).pop()}-elsewhere/x.txt`),
      (e: { code?: string }) => e.code === 'PATH_TRAVERSAL'
    )

    // A null byte would truncate the path at the OS boundary.
    assert.throws(
      () => resolveWorkspacePath(root, 'a\u0000/../b'),
      (e: { code?: string }) => e.code === 'INVALID_PATH'
    )

    // No workspace open is its own failure, not a traversal.
    assert.throws(
      () => resolveWorkspacePath(null, 'a.txt'),
      (e: { code?: string }) => e.code === 'NO_WORKSPACE'
    )

    // Inside the workspace — including a path that does not exist yet — is allowed.
    assert.equal(resolveWorkspacePath(root, 'nested/new.txt'), join(root, 'nested', 'new.txt'))
    assert.equal(resolveWorkspacePath(root, 'inside/../still-inside.txt'), join(root, 'still-inside.txt'))

    results.push('traversal, absolute escapes, prefix lookalikes, and null bytes are all refused')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function symlinkEscapeBlocked() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  const outside = mkdtempSync(join(tmpdir(), 'sam-outside-'))
  try {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'not yours')

    // A link inside the workspace pointing out of it. The string looks contained; only following the
    // link reveals that it is not, which is why the lexical check alone is not enough.
    //
    // On Windows a directory symlink needs developer mode or admin rights, so the fallback is a
    // junction: same escape, no privilege required. Without that, this case — the one the lexical
    // check cannot catch — would silently never run.
    const linkPath = join(root, 'escape')
    try {
      symlinkSync(outside, linkPath, 'dir')
    } catch {
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, outside], { stdio: 'ignore' })
      } catch {
        results.push('symlink escape check SKIPPED (no link creation permitted here)')
        return
      }
    }

    assert.throws(
      () => resolveWorkspacePath(root, 'escape/secret.txt'),
      (e: { code?: string }) => e.code === 'PATH_TRAVERSAL',
      'a symlinked route out of the workspace must be refused'
    )

    results.push('a symlink pointing outside the workspace cannot be used as a side door')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

async function traversalRefusedThroughTheTool() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // The check must hold on the tool path too, not only when called directly.
    const outcome = await executeTool(
      'write_file',
      JSON.stringify({ path: '../../escaped.txt', content: 'pwned' }),
      root,
      new AbortController().signal
    )
    assert.equal(outcome.ok, false, 'the tool must refuse the write')
    assert.equal(outcome.code, 'PATH_TRAVERSAL')
    // A refusal is returned, not thrown, so the model can be told and can recover.
    assert.ok(outcome.output.includes('outside the open folder'))

    results.push('write_file refuses traversal through the tool path as well')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function badArgumentsAreReported() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    const signal = new AbortController().signal
    // Malformed JSON.
    const bad = await executeTool('read_file', '{not json', root, signal)
    assert.equal(bad.code, 'BAD_TOOL_ARGS')

    // Valid JSON, wrong shape.
    const wrong = await executeTool('read_file', JSON.stringify({ file: 'a.txt' }), root, signal)
    assert.equal(wrong.code, 'INVALID_TOOL_ARGS')

    // A tool that does not exist.
    const unknown = await executeTool('delete_everything', '{}', root, signal)
    assert.equal(unknown.code, 'UNKNOWN_TOOL')

    // All three are reported back rather than thrown, so the loop survives them.
    results.push('malformed, mis-shaped, and unknown tool arguments are reported, not thrown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function toolDefinitionsAreWellFormed() {
  const names = TOOL_DEFINITIONS.map((t) => t.function.name)
  assert.deepEqual(names, ['read_file', 'write_file', 'run_command'])
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function')
    assert.ok(tool.function.description.length > 10, `${tool.function.name} needs a real description`)
    assert.equal((tool.function.parameters as { type?: string }).type, 'object')
    assert.ok((tool.function.parameters as { properties?: unknown }).properties, 'parameters must be described')
  }
  results.push('the three tool schemas are OpenAI-shaped and fully described')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('tool definitions', toolDefinitionsAreWellFormed)
  await step('consent rules', approvalRules)
  await step('ReAct loop with a mocked provider', reactLoop)
  await step('write_file tool', writeThenRead)
  await step('run_command tool', runCommandTool)
  await step('pauses for approval', pausesForApproval)
  await step('gated write diff', gatedWriteCarriesItsDiff)
  await step('resumes after approval', resumeAfterApproval)
  await step('resumes after denial', resumeAfterDenial)
  await step('step budget', stepBudgetStopsTheLoop)
  await step('path traversal', pathTraversalBlocked)
  await step('symlink escape', symlinkEscapeBlocked)
  await step('traversal through the tool', traversalRefusedThroughTheTool)
  await step('bad tool arguments', badArgumentsAreReported)

  console.log('agent loop: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('AGENT TEST FAILED:', err)
  process.exit(1)
})
