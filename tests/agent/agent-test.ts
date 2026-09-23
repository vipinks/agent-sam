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
import { firstPauseViolation } from '../../conveyor/protocol/approval'
import { applyAgentChunk, startAssistantTurn, type ToolStep } from '../../app/components/workbench/agent-session'
import {
  AGENT_SYSTEM_PROMPT,
  agentSystemPrompt,
  PLAN_DISCIPLINE_NOTE,
  POWERSHELL_SHELL_NOTE,
} from '../../conveyor/protocol/context'
import { MAX_FILE_BYTES } from '../../conveyor/modules/workspace'
import { resolveWorkspacePath } from '../../conveyor/modules/workspace-paths'

const results: string[] = []

/**
 * The agent's standing instruction as this machine's platform composes it.
 *
 * The prompt is platform-detected — a Windows machine's terminal is PowerShell — so the assertions
 * below compare against what a send from *this* host must carry rather than against the base line,
 * which is the whole prompt only off win32. The base constant is still asserted where it is the
 * subject; the win32 composition has its own suite below.
 */
const HOST_AGENT_PROMPT = agentSystemPrompt(process.platform)

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

/**
 * The transcript a run's chunks build, folded exactly the way the pane folds them.
 *
 * Folding rather than reading main's internals is the point of the post-condition below: what has to
 * hold is what the user is shown, and the panel builds that by handing each chunk to this reducer.
 */
function stepsFrom(chunks: Array<Record<string, unknown>>): ToolStep[] {
  const assistant = startAssistantTurn()
  let turns = [assistant]
  for (const chunk of chunks) turns = applyAgentChunk(turns, assistant.id, chunk).turns
  return turns[0].steps
}

/**
 * The pause invariant, as a post-condition of every scenario that stops for a decision.
 *
 * While any call is undecided, no call behind it may carry a recorded outcome. Stated here as a
 * property of the chunks a scenario yielded, so it is checked against every paused shape the suite
 * builds — including the ones whose subject is something else entirely.
 */
function assertPauseInvariant(chunks: Array<Record<string, unknown>>, where: string): void {
  const violation = firstPauseViolation(stepsFrom(chunks))
  assert.equal(
    violation,
    null,
    `${where}: a call behind an undecided one recorded an outcome: ${JSON.stringify(violation)}`
  )
}

/**
 * A provider that asks for several calls in one assistant turn, then answers with prose.
 *
 * The frame is the unit that matters here: several calls arrive together and are walked together, so
 * a suite about their order needs to be able to write one down.
 */
function frameFetch(calls: Array<{ id: string; name: string; args: unknown }>, log: unknown[]) {
  let call = 0
  return async (_url: string, init: RequestInit) => {
    call += 1
    log.push({ call, body: JSON.parse(String(init.body)) })

    if (call > 1) {
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'All three done.' } }] }), '[DONE]'])
    }

    return sseResponse([
      JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: calls.map((entry, index) => ({
                index,
                id: entry.id,
                type: 'function',
                function: { name: entry.name, arguments: JSON.stringify(entry.args) },
              })),
            },
          },
        ],
      }),
      '[DONE]',
    ])
  }
}

/** The tool results in a chunk list, in the order the loop yielded them. */
function resultsOf(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks.filter((chunk) => chunk.type === 'tool_result')
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
      ['tool_call_start', 'tool_result', 'text_delta', 'text_delta', 'turn_end', 'done'],
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
    assert.ok(Array.isArray(second.body.tools) && second.body.tools.length === 4, 'tools were advertised')
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
    // And the turn the pane would render from this stream is clean, which is the invariant stated where
    // a paused scenario ends rather than only where it is the subject.
    assertPauseInvariant(chunks, 'a write waiting for consent')

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
    assertPauseInvariant(chunks, 'a write waiting for consent, carrying its diff')
    assertPauseInvariant(commandChunks, 'a command waiting for consent')

    results.push('a gated write carries a diff of the change, computed in main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A spawn that runs nothing and records every command it was asked to run. */
async function terminalStub(stdout: string) {
  const { EventEmitter } = await import('node:events')
  type Emitter = InstanceType<typeof EventEmitter>
  const runs: string[] = []
  const spawnImpl = ((command: string) => {
    runs.push(command)
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
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
    })
    return child
  }) as never
  return { spawnImpl, runs }
}

/**
 * The reported session, written down as a frame: six reads, a command that needs a decision, and two
 * more reads — all asked for in one assistant turn, with auto-approve off.
 *
 * Two things have to be true of it that were not. Nothing behind the command runs while it waits, and
 * the command is the only call the user is asked about; an approval then walks the frame in the order
 * the model wrote it, and a refusal ends the turn with the two reads never run at all.
 */
async function callsBehindADecisionWait() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n', 'utf8')
    writeFileSync(join(root, 'b.txt'), 'beta\n', 'utf8')

    const frame = [
      ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, index) => ({
        id,
        name: 'read_file',
        args: { path: index % 2 === 0 ? 'a.txt' : 'b.txt' },
      })),
      { id: 'c7', name: 'run_command', args: { command: 'echo hi' } },
      { id: 'r8', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'r9', name: 'read_file', args: { path: 'b.txt' } },
    ]
    const base = {
      providerId: 'deepseek',
      apiKey: 'test-key',
      model: 'test-model',
      workspaceRoot: root,
      autoApprove: false,
      signal: new AbortController().signal,
    }

    // The pause itself. The reads in front of the command ran, in the model's order, and they are the
    // only calls that carry an outcome.
    const log: unknown[] = []
    const terminal = await terminalStub('hi\n')
    // One provider for the whole scenario, as a real one is: a resumed run continues the same
    // conversation with the same model, so the mock's round-trip count has to span both streams.
    const fetchImpl = frameFetch(frame, log)
    const first = await collect(
      runAgentLoop({
        ...base,
        messages: [{ role: 'user', content: 'test it, then read both files' }],
        spawnImpl: terminal.spawnImpl,
        fetchImpl: fetchImpl as never,
      })
    )

    assert.deepEqual(
      resultsOf(first).map((chunk) => chunk.callId),
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
      'the calls in front of the gate run, and nothing else does'
    )

    const pause = first.at(-1) as Record<string, unknown>
    assert.equal(pause.type, 'awaiting_approval', `expected a pause, got ${JSON.stringify(first.map((c) => c.type))}`)
    assert.equal(pause.callId, 'c7', 'the command is what the user is asked about')
    assert.deepEqual(
      (pause.calls as Array<{ id: string }>).map((call) => call.id),
      ['c7', 'r8', 'r9'],
      'the queue is the frame from the command on, in the model’s own order'
    )
    for (const id of ['r8', 'r9']) {
      assert.ok(
        !first.some((chunk) => chunk.type === 'tool_result' && chunk.callId === id),
        `${id} must not run while c7 is undecided`
      )
    }
    assert.equal(terminal.runs.length, 0, 'the command must not have been spawned either')
    // The formal version of all of the above, checked against the transcript the pane would build.
    assertPauseInvariant(first, 'a frame paused at its command')

    // An approval resumes the walk where it stopped: the command runs, then the two reads in the
    // order the model wrote them, and the model is asked again only once the frame is settled.
    const approved = await collect(
      runAgentLoop({
        ...base,
        messages: pause.messages as never,
        steps: pause.steps as number,
        spawnImpl: terminal.spawnImpl,
        pending: { calls: pause.calls as never, denied: false },
        fetchImpl: fetchImpl as never,
      })
    )

    assert.deepEqual(
      resultsOf(approved).map((chunk) => chunk.callId),
      ['c7', 'r8', 'r9'],
      'approving runs the command and then the frame behind it, in order'
    )
    assert.deepEqual(terminal.runs, ['echo hi'], 'the command ran exactly once, and only once approved')
    assert.ok(String(resultsOf(approved)[1].output).includes('alpha'), 'the first read behind it really ran')
    assert.ok(String(resultsOf(approved)[2].output).includes('beta'), 'and so did the second')
    assert.equal(approved.at(-1)?.type, 'done', 'and the run finishes')
    assertPauseInvariant([...first, ...approved], 'a frame walked past its decision')

    // One request followed the pause, and it answers every call in the frame — the six that ran
    // before the gate and the three the decision released. The provider's contract is what makes
    // running the frame in order non-negotiable rather than merely tidy.
    assert.equal(log.length, 2, 'exactly one request follows the pause')
    const wire = (log.at(-1) as { body: { messages: Array<{ role: string; tool_call_id?: string }> } }).body
    assert.deepEqual(
      wire.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'c7', 'r8', 'r9'],
      'the model is asked again once the whole frame has an answer, in the order it was walked'
    )

    // A refusal ends the turn where it stands. The refused call is answered with the refusal, the two
    // reads are never run, and the model is not asked again — a turn that has ended asks nothing.
    const deniedLog: unknown[] = []
    const deniedTerminal = await terminalStub('hi\n')
    const deniedFetch = frameFetch(frame, deniedLog)
    const deniedFirst = await collect(
      runAgentLoop({
        ...base,
        messages: [{ role: 'user', content: 'test it, then read both files' }],
        spawnImpl: deniedTerminal.spawnImpl,
        fetchImpl: deniedFetch as never,
      })
    )
    const deniedPause = deniedFirst.at(-1) as Record<string, unknown>
    assert.equal(deniedPause.type, 'awaiting_approval', 'the same frame pauses the same way')

    const denied = await collect(
      runAgentLoop({
        ...base,
        messages: deniedPause.messages as never,
        steps: deniedPause.steps as number,
        spawnImpl: deniedTerminal.spawnImpl,
        pending: { calls: deniedPause.calls as never, denied: true },
        fetchImpl: deniedFetch as never,
      })
    )

    assert.deepEqual(
      denied.map((chunk) => chunk.type),
      ['tool_result', 'turn_end'],
      `a refusal ends the turn: ${JSON.stringify(denied.map((c) => c.type))}`
    )
    assert.equal(denied[0].code, 'DENIED', 'the refused call is answered with the refusal')
    assert.deepEqual(
      resultsOf(denied).map((chunk) => chunk.callId),
      ['c7'],
      'the two reads behind it are never run'
    )
    assert.equal(
      denied.some((chunk) => chunk.type === 'awaiting_approval'),
      false,
      'nothing behind a refusal is presented'
    )
    assert.equal(deniedTerminal.runs.length, 0, 'and nothing behind it is executed either')
    assert.equal(deniedLog.length, 1, 'the model is not asked again after a refusal')
    assertPauseInvariant([...deniedFirst, ...denied], 'a turn refused at its command')

    results.push('a frame waits at its decision, runs in order on approval, and stops on refusal')
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
    assert.deepEqual(types, ['tool_result', 'text_delta', 'turn_end', 'done'], `unexpected: ${JSON.stringify(types)}`)
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

    // A refusal ends the turn where it stands. The call is answered so the frame's record is complete,
    // and then the turn is over through the one ending every ending passes through: nothing is asked
    // of the model, because a turn that has ended asks nothing, and the refusal is the answer.
    assert.deepEqual(
      chunks.map((c) => c.type),
      ['tool_result', 'turn_end'],
      `a refusal ends the turn: ${JSON.stringify(chunks.map((c) => c.type))}`
    )
    assert.equal(log.length, 0, 'the model must not be asked again after a refusal')

    results.push('a denied call is recorded as refused and ends the turn where it stood')
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
  // Four, in the order the model reads them. `set_plan` is last because it is not an action: it is
  // listed here so the assertion keeps proving that every tool the loop recognises is advertised to
  // the model, and every tool advertised is one the loop recognises.
  assert.deepEqual(names, ['read_file', 'write_file', 'run_command', 'set_plan'])
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function')
    assert.ok(tool.function.description.length > 10, `${tool.function.name} needs a real description`)
    assert.equal((tool.function.parameters as { type?: string }).type, 'object')
    assert.ok((tool.function.parameters as { properties?: unknown }).properties, 'parameters must be described')
  }
  results.push('the four tool schemas are OpenAI-shaped and fully described')
}

// ---------------------------------------------------------------- project instructions

/** A provider that answers once with prose, logging what it was sent. */
function oneRoundFetch(log: unknown[]): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url: string, init: RequestInit) => {
    log.push({ body: JSON.parse(String(init.body)) })
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Understood.' } }] }), '[DONE]'])
  }
}

/**
 * The instructions reach the provider, at the head of the conversation.
 *
 * Asserted on the request body, because that is the only place the answer exists: the loop keeps the
 * transcript free of them by design, so nothing on the UI side could be inspected for this.
 */
async function instructionsReachTheProvider() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'AGENTS.md'), '# House rules\nAlways run the tests.', 'utf8')

    const log: unknown[] = []
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'hello' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    // The agent's own instruction leads, and the project's follows it: both are system messages, and
    // the project's text is the more specific of the two, so it sits closest to the conversation it
    // governs. Neither replaces the other — a workspace with instructions gets both.
    assert.equal(sent[0].role, 'system', 'the system messages arrive first')
    assert.equal(sent[0].content, HOST_AGENT_PROMPT, "the agent's own instruction leads")
    assert.equal(sent[1].role, 'system', 'the instructions arrive as a system message')
    assert.ok(sent[1].content.includes('House rules'), 'carrying the file text')
    assert.ok(/project instructions/i.test(sent[1].content), 'labelled as project instructions')
    // Before the conversation, not after it.
    assert.equal(sent[2].role, 'user', 'the system messages precede the first user turn')
    assert.equal(sent[2].content, 'hello')

    // And the renderer is told what was read, so the turn can record it. The name only: the text the
    // transcript deliberately does not keep must not be on the wire either.
    const announced = chunks.filter((c) => c.type === 'project_instructions')
    assert.equal(announced.length, 1, 'the record is announced exactly once')
    assert.equal(announced[0].file, 'AGENTS.md', 'as the file name, not a path')
    assert.equal(announced[0].truncated, false, 'with the cap reported')
    // Announced before anything the turn will show, so the turn it lands on is the one it describes.
    assert.ok(
      chunks.indexOf(announced[0]) < chunks.findIndex((c) => c.type === 'text_delta'),
      'before the first thing the turn shows'
    )
    results.push('the project instructions are injected as a leading system message, and announced once')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function noInstructionsMeansNoSystemMessage() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // No candidate file at all.
    const log: unknown[] = []
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'hello' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(log) as never,
      })
    )
    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    assert.deepEqual(
      sent.filter((m) => m.role === 'system').map((m) => m.content),
      [HOST_AGENT_PROMPT],
      'no instructions file means no instructions message, and nothing else is invented'
    )

    // And no folder open is the same outcome rather than an error.
    const noRoot: unknown[] = []
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: null,
        messages: [{ role: 'user', content: 'hello' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(noRoot) as never,
      })
    )
    const sentNoRoot = (noRoot[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    assert.deepEqual(
      sentNoRoot.filter((m) => m.role === 'system').map((m) => m.content),
      [HOST_AGENT_PROMPT],
      'no workspace, no instructions message'
    )
    results.push('a workspace with no instructions injects no instructions message')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function aResumeDoesNotInjectTheInstructionsTwice() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'AGENTS.md'), '# House rules', 'utf8')

    const log: unknown[] = []
    // A resumed run re-enters with the history the pause handed back — which already carries the
    // system message from the original send. Injection is refused on that fact, so the instructions
    // are not sent a second time and the budget is not spent twice.
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [
          // The head of the history the pause handed back, verbatim: the agent's instruction and the
          // project's, exactly as the original send wrote them.
          { role: 'system', content: HOST_AGENT_PROMPT },
          { role: 'system', content: 'The following are the project instructions…\n\n# House rules' },
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            ],
          },
        ],
        autoApprove: false,
        signal: new AbortController().signal,
        steps: 1,
        pending: {
          calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          denied: false,
        },
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    const systems = sent.filter((m) => m.role === 'system')
    assert.deepEqual(
      systems.map((m) => m.content),
      [HOST_AGENT_PROMPT, 'The following are the project instructions…\n\n# House rules'],
      'each system message is sent exactly once, so neither is duplicated on a resume'
    )
    // And nothing is announced either: the turn already carries the record from the original send, and
    // a second announcement would restate a file the transcript has already named.
    assert.equal(chunks.filter((c) => c.type === 'project_instructions').length, 0, 'a resumed run announces no record')
    results.push('a resumed run does not inject the project instructions a second time')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- the shell

/**
 * The platform-primed shell line, from the pure rule to the wire.
 *
 * Live use opens most Windows sessions with a bash-ism that fails before the model adapts, so the
 * standing instruction now says which shell the terminal is. That is a fact about the machine the
 * loop runs on, which is why the platform is an option here: the assertions below mean the same thing
 * on any host that runs the suite.
 */
async function windowsIsToldItsShell() {
  // The rule first. One line, on win32 only, and once — a prompt that said it twice would spend the
  // same budget twice on one sentence. The plan-discipline line is part of the same composed prompt
  // and is on every platform, so it is asserted beside the shell line rather than separately: what
  // matters here is that one message carries each of them exactly once.
  const win = agentSystemPrompt('win32')
  assert.ok(win.startsWith(AGENT_SYSTEM_PROMPT), 'the standing instruction still leads the prompt')
  assert.equal(win.split(POWERSHELL_SHELL_NOTE).length - 1, 1, 'the shell line appears exactly once on win32')
  assert.ok(/powershell/i.test(POWERSHELL_SHELL_NOTE), 'and names the shell the terminal actually is')
  assert.equal(
    win.split(PLAN_DISCIPLINE_NOTE).length - 1,
    1,
    'and the plan-discipline line appears exactly once, beside it'
  )
  assert.equal(
    agentSystemPrompt('linux'),
    `${AGENT_SYSTEM_PROMPT}\n${PLAN_DISCIPLINE_NOTE}`,
    'off win32 the prompt is the two platform-independent lines'
  )
  assert.equal(
    agentSystemPrompt('darwin'),
    agentSystemPrompt('linux'),
    'and on every other platform too — the shell line is the only platform-detected part'
  )

  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    // One send, on a platform pinned to win32.
    const log: unknown[] = []
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'hello' }],
        autoApprove: false,
        signal: new AbortController().signal,
        platform: 'win32',
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = systemMessages(log)
    assert.equal(sent.length, 1, 'the standing instruction is the only system message here')
    assert.equal(sent[0].split(POWERSHELL_SHELL_NOTE).length - 1, 1, 'the shell line reaches the provider exactly once')
    assert.equal(
      sent[0].split(PLAN_DISCIPLINE_NOTE).length - 1,
      1,
      'and the plan-discipline line does too, in the same message'
    )

    // And a resumed run re-enters with the history the pause handed back, which already carries the
    // composed prompt: the injection is refused on that fact, so the line is not sent a second time.
    const resumed: unknown[] = []
    const calls = [
      { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [
          { role: 'system', content: agentSystemPrompt('win32') },
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', tool_calls: calls },
        ],
        autoApprove: false,
        signal: new AbortController().signal,
        platform: 'win32',
        steps: 1,
        pending: { calls, denied: false },
        fetchImpl: oneRoundFetch(resumed) as never,
      })
    )

    const systems = systemMessages(resumed)
    assert.equal(systems.length, 1, 'a resumed run does not inject the standing instruction again')
    assert.equal(
      systems[0].split(POWERSHELL_SHELL_NOTE).length - 1,
      1,
      'so the shell line is on the wire exactly once across the pause'
    )
    results.push('win32 sends the PowerShell line once, and a resume does not send it again')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The system messages of the first request in a log, in order. */
function systemMessages(log: unknown[]): string[] {
  const body = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body
  return body.messages.filter((m) => m.role === 'system').map((m) => m.content)
}

// ---------------------------------------------------------------- mentions

/**
 * A send with two mentions: the payload carries the context section, and the skip is announced.
 *
 * Asserted on the request body, because that is the only place the answer exists — main reads the
 * files and appends the section, so nothing on the renderer side could be inspected for this. The
 * over-cap file is the interesting half: it must appear in the payload as a named skip rather than
 * being silently dropped, since a mention that vanished would read to the model as an empty file.
 */
async function mentionsReachTheProvider() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'small.ts'), 'export const small = 1\n', 'utf8')
    writeFileSync(join(root, 'huge.ts'), 'x'.repeat(MAX_FILE_BYTES + 1), 'utf8')

    const log: unknown[] = []
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'what does this do?' }],
        autoApprove: false,
        mentionPaths: ['small.ts', 'huge.ts'],
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    const user = sent.find((m) => m.role === 'user')
    assert.ok(user, 'the user message is sent')

    // The user's own words survive, with the section appended rather than replacing them.
    assert.ok(user.content.startsWith('what does this do?'), 'the message keeps what the user typed')
    assert.ok(user.content.includes('small.ts'), 'the attached file is named in the section')
    assert.ok(user.content.includes('export const small = 1'), 'and its content is carried')

    // The one that could not be included is named with its code, not dropped.
    assert.ok(user.content.includes('huge.ts'), 'the oversized file is named in the section')
    assert.ok(user.content.includes('CONTEXT_FILE_TOO_LARGE'), 'with the code that explains why')
    // And its content is absent: the cap is what this whole path exists for.
    assert.ok(!user.content.includes('x'.repeat(100)), 'no part of the oversized file is sent')

    // The skip is also announced to the renderer, carrying the code rather than a sentence.
    const notices = chunks.filter((c) => c.type === 'context_notice')
    assert.equal(notices.length, 1, 'exactly one skip is announced')
    assert.equal(notices[0].path, 'huge.ts', 'naming the file')
    assert.equal(notices[0].code, 'CONTEXT_FILE_TOO_LARGE', 'and its code')
    results.push('a send with two mentions carries the readable file and names the skipped one with its code')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function aSendWithNoMentionsIsUnchanged() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'small.ts'), 'export const small = 1\n', 'utf8')

    const log: unknown[] = []
    const chunks = await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [{ role: 'user', content: 'hello' }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    const user = sent.find((m) => m.role === 'user')
    assert.equal(user?.content, 'hello', 'with no mentions the message is sent exactly as typed')
    assert.ok(
      !sent.some((m) => m.content.includes('attached the following files')),
      'and no empty context section is appended'
    )
    assert.equal(chunks.filter((c) => c.type === 'context_notice').length, 0, 'and nothing is announced')
    results.push('a send with no mentions is byte-for-byte what it was before mentions existed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function aResumeDoesNotReReadTheMentions() {
  const root = mkdtempSync(join(tmpdir(), 'sam-agent-'))
  try {
    writeFileSync(join(root, 'small.ts'), 'export const small = 1\n', 'utf8')

    const log: unknown[] = []
    // The history the pause handed back already carries the section inside its user turn, because
    // that is the history the provider was sent. Appending again would duplicate every file.
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: root,
        messages: [
          {
            role: 'user',
            content: 'what does this do?\n\nThe user attached the following files\nexport const small = 1',
          },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"small.ts"}' } },
            ],
          },
        ],
        autoApprove: false,
        // Passed deliberately, to prove the resume path ignores it rather than re-reading.
        mentionPaths: ['small.ts'],
        steps: 1,
        pending: {
          calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"small.ts"}' } }],
          denied: false,
        },
        signal: new AbortController().signal,
        fetchImpl: oneRoundFetch(log) as never,
      })
    )

    const sent = (log[0] as { body: { messages: Array<{ role: string; content: string }> } }).body.messages
    const user = sent.find((m) => m.role === 'user')
    // The section the pause handed back is still there exactly once. A resume that re-read the
    // mentions would append a second copy, which is what this count catches.
    const occurrences = (user?.content.split('export const small = 1').length ?? 1) - 1
    assert.equal(occurrences, 1, 'the section survives the resume exactly once, not twice')
    results.push('a resumed run does not read the mentions again or duplicate the section')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- report

async function main() {
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }

  await step('tool definitions', toolDefinitionsAreWellFormed)
  await step('instructions reach the provider', instructionsReachTheProvider)
  await step('no instructions, no system message', noInstructionsMeansNoSystemMessage)
  await step('resume does not re-inject', aResumeDoesNotInjectTheInstructionsTwice)
  await step('win32 is told its shell', windowsIsToldItsShell)
  await step('consent rules', approvalRules)
  await step('ReAct loop with a mocked provider', reactLoop)
  await step('write_file tool', writeThenRead)
  await step('run_command tool', runCommandTool)
  await step('pauses for approval', pausesForApproval)
  await step('gated write diff', gatedWriteCarriesItsDiff)
  await step('calls behind a decision wait', callsBehindADecisionWait)
  await step('resumes after approval', resumeAfterApproval)
  await step('resumes after denial', resumeAfterDenial)
  await step('step budget', stepBudgetStopsTheLoop)
  await step('path traversal', pathTraversalBlocked)
  await step('symlink escape', symlinkEscapeBlocked)
  await step('traversal through the tool', traversalRefusedThroughTheTool)
  await step('bad tool arguments', badArgumentsAreReported)
  await step('mentions reach the provider', mentionsReachTheProvider)
  await step('no mentions, unchanged send', aSendWithNoMentionsIsUnchanged)
  await step('resume does not re-read mentions', aResumeDoesNotReReadTheMentions)

  console.log('agent loop: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('AGENT TEST FAILED:', err)
  process.exit(1)
})
