/**
 * The Codex turn when it does not finish: what the child said on stderr, what it exited on, and the one
 * chunk that carries both to the pane.
 *
 * The turn used to end a failed child with a bare `turn_end` and nothing else. The pane read that as an
 * ordinary stop, left an empty bubble saying `Thinking…`, and the only witness to the cause was a child
 * that had already been reaped. These cases state the three ways a turn fails before an answer — a
 * non-zero exit, a child that errors after it starts, and a spawn that never starts at all — and the
 * bounded tail that makes the failure legible.
 *
 * The four-line probe case is the baseline, and it is deliberately green on the tree before this change:
 * the JSONL vocabulary is the capture's and is not being extended. It exists here so a red run still
 * proves the mapper reads the probe's exact four lines as `ok` plus the usage triple.
 *
 * The clean exit is stated here as the neighbour of those three: a child that closes 0 without a word on
 * stdout did not fail, so its notice is an `empty_stop` with no code and no tail — the one ending in this
 * file that carries no failure, and the one a suite that read only failures would leave unproven.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_SPAWN_CODES } from '../../conveyor/protocol/engine'
import { runCodexTurn, type CodexChild, type CodexSpawnImpl } from '../../conveyor/modules/engine-codex'
import { mapCodexLine, type CodexUpdate } from '../../conveyor/protocol/codex-jsonl'
import { codexTranscriptChunks, type EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const CODEX = 'codex'
const CODEX_BINARY = 'C:/tools/codex.exe'
/** The bounds D1 names in the product: the last five lines, capped at 500 bytes. */
const TAIL_LINES = 5
const TAIL_BYTES = 500

/** The probe's exact four lines: a thread, a turn, one answer, and the usage the turn reported. */
const PROBE_LINES = [
  '{"type":"thread.started","thread_id":"thread-probe"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":41,"output_tokens":2,"cached_input_tokens":7}}',
]

interface ScriptedChild {
  child: CodexChild
  stderr: (text: string) => void
  close: (code: number | null) => void
  fail: (error: NodeJS.ErrnoException) => void
}

/**
 * A child whose three signals the case controls: stderr, an error after it started, and its exit.
 *
 * The error listener is real rather than absent because the turn installs one; a fake that only had
 * `close` would make the child-error path untestable.
 */
function scriptedChild(): ScriptedChild {
  const data: ((chunk: Buffer | string) => void)[] = []
  const stderr: ((chunk: Buffer | string) => void)[] = []
  const errors: ((error: NodeJS.ErrnoException) => void)[] = []
  const closes: ((code: number | null) => void)[] = []
  let exited = false

  const child: CodexChild = {
    stdout: { on: (_event, listener) => data.push(listener) },
    stderr: { on: (_event, listener) => stderr.push(listener) },
    on: ((event: string, listener: (payload: never) => void) => {
      if (event === 'error') errors.push(listener as (error: NodeJS.ErrnoException) => void)
      if (event === 'close') closes.push(listener as (code: number | null) => void)
    }) as CodexChild['on'],
    get killed() {
      return exited
    },
    get exitCode() {
      return exited ? 0 : null
    },
    kill: () => true,
  }

  return {
    child,
    stderr: (text) => {
      for (const listener of stderr) listener(text)
    },
    fail: (error) => {
      for (const listener of errors) listener(error)
    },
    close: (code) => {
      exited = true
      for (const listener of closes) listener(code)
    },
  }
}

function spawnOf(child: CodexChild): CodexSpawnImpl {
  return () => child
}

type FailureNotice = Extract<EngineTranscriptChunk, { type: 'turn_end_notice' }>

function noticeOf(chunks: readonly EngineTranscriptChunk[]): FailureNotice {
  const notice = chunks.find((chunk) => chunk.type === 'turn_end_notice' && chunk.failure !== undefined)
  assert.ok(notice, 'a failed turn emits a failure notice rather than silence')
  return notice as FailureNotice
}

function failureOf(chunks: readonly EngineTranscriptChunk[]): NonNullable<FailureNotice['failure']> {
  const failure = noticeOf(chunks).failure
  assert.ok(failure, 'the notice carries the code and the tail')
  return failure
}

// ---------------------------------------------------------------- baseline

/**
 * The probe's four lines, read through the shipped mapper: text `ok` and the usage triple.
 *
 * Green before the change and green after it. The parse vocabulary is not the subject of this phase; this
 * case is the control that keeps a red run from being read as a parse regression.
 */
function theProbeFourLinesStillReadAsOkAndUsage() {
  let threadId: string | null = null
  const updates: CodexUpdate[] = []
  for (const line of PROBE_LINES) {
    const mapped = mapCodexLine(line, threadId)
    threadId = mapped.threadId
    updates.push(...mapped.updates)
  }

  const chunks = codexTranscriptChunks(updates, CODEX)
  const text = chunks
    .filter((chunk) => chunk.type === 'text_delta')
    .map((chunk) => (chunk.type === 'text_delta' ? chunk.text : ''))
    .join('')
  assert.equal(text, 'ok', 'the probe answer is the text chunk')
  assert.equal(threadId, 'thread-probe', 'and the thread id travelled through the four lines')

  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.ok(usage, 'the turn-reported usage is the usage chunk')
  assert.deepEqual(
    usage.type === 'usage' ? { prompt: usage.prompt, completion: usage.completion, cached: usage.cached } : null,
    { prompt: 41, completion: 2, cached: 7 },
    'with all three counters intact'
  )

  console.log('baseline: the probe four lines still read as ok plus the usage triple')
  results.push('the probe four lines are the baseline: ok plus the usage triple, unchanged by this phase')
}

// ---------------------------------------------------------------- failures

/** A non-zero exit carries its code and the bounded stderr tail, on the failure chunk. */
async function aNonZeroExitCarriesItsCodeAndTail() {
  const script = scriptedChild()
  const chunks: EngineTranscriptChunk[] = []
  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a question', cwd: 'C:/work' },
    { spawnImpl: spawnOf(script.child), binaryOverride: CODEX_BINARY },
    (chunk) => chunks.push(chunk)
  )

  await new Promise((resolve) => setImmediate(resolve))
  script.stderr('line one\nline two\nline three\nline four\nline five\nline six\nline seven\n')
  script.close(3)
  const outcome = await turn

  const failure = failureOf(chunks)
  assert.equal(noticeOf(chunks).cause, 'stream_error', 'a dead child is a stream that stopped arriving')
  assert.equal(noticeOf(chunks).resumable, true, 'and the ending offers Continue')
  assert.equal(failure.exitCode, 3, 'the exit code is the chunk, not a sentence')
  assert.equal(failure.code, undefined, 'and a real exit is not given a spawn code it never had')
  assert.equal(failure.tail.includes('line three'), true, 'the tail is the last five lines')
  assert.equal(failure.tail.includes('line two'), false, 'and not the lines before them')
  assert.ok(Buffer.byteLength(failure.tail, 'utf8') <= TAIL_BYTES, 'within the byte bound')
  assert.equal(failure.tail.split('\n').length <= TAIL_LINES, true, 'and within the line bound')
  assert.equal(outcome.exitCode, 3, 'the outcome agrees with the chunk')
  assert.equal(outcome.cause, 'stream_error')

  // The engine log is the second witness: one bounded line, in userData, beside the updater's own log.
  const log = readFileSync(join(String(process.env.SAM_TEST_USER_DATA), 'logs', 'engine-codex.log'), 'utf8')
  assert.equal(log.includes('exit=3'), true, 'the log names the exit code')
  assert.equal(log.includes('line seven'), true, 'and carries the bounded tail')

  results.push('a non-zero Codex exit carries its exit code and bounded stderr tail on the failure chunk')
}

/** A child that errors after it starts is the same news, with the error's code rather than an exit. */
async function aChildErrorCarriesItsCodeAndTail() {
  const script = scriptedChild()
  const chunks: EngineTranscriptChunk[] = []
  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a question', cwd: 'C:/work' },
    { spawnImpl: spawnOf(script.child), binaryOverride: CODEX_BINARY },
    (chunk) => chunks.push(chunk)
  )

  await new Promise((resolve) => setImmediate(resolve))
  script.stderr('the child could not read its configuration\n')
  script.fail(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  const outcome = await turn

  const failure = failureOf(chunks)
  assert.equal(failure.exitCode, null, 'no exit happened')
  assert.equal(failure.code, 'EACCES', 'the error code is the code word')
  assert.equal(failure.tail.includes('could not read'), true, 'with what the child said')
  assert.equal(outcome.cause, 'stream_error')

  results.push('a child error after start carries its code word and tail, never a silent ending')
}

/** A spawn that never starts emits its own code chunk, not a rejected promise and not silence. */
async function aSynchronousSpawnFailureEmitsItsCode() {
  const chunks: EngineTranscriptChunk[] = []
  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a question', cwd: 'C:/work' },
    {
      spawnImpl: () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      },
      binaryOverride: CODEX_BINARY,
    },
    (chunk) => chunks.push(chunk)
  )
  const outcome = await turn

  const failure = failureOf(chunks)
  assert.equal(failure.exitCode, null, 'nothing started, so there is no exit')
  assert.equal(failure.code, 'ENOENT', 'the spawn error code is the code word')
  assert.equal(failure.tail, '', 'and a spawn that never ran has no stderr')
  assert.equal(outcome.cause, 'stream_error')

  results.push('a synchronous spawn failure is a coded failure chunk, not a rejected promise')
}

/**
 * The resolution refusal, as a chunk rather than a throw.
 *
 * The law's codes are the branch, and the one a settings file can produce is the one worth stating: a
 * binary that is not the engine's is refused before a child exists, and the user is owed that code.
 */
async function aResolutionRefusalEmitsItsConveyorErrorCode() {
  const chunks: EngineTranscriptChunk[] = []
  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a question', cwd: 'C:/work' },
    { binaryOverride: 'C:/elsewhere/git.exe' },
    (chunk) => chunks.push(chunk)
  )
  const outcome = await turn

  const failure = failureOf(chunks)
  assert.equal(failure.code, ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED, 'the law’s code is the code word')
  assert.equal(failure.exitCode, null)
  assert.equal(outcome.cause, 'stream_error')

  results.push('a refused resolution is a ConveyorError-coded failure chunk, never a message string')
}

// ---------------------------------------------------------------- the clean ending

/**
 * A clean exit with nothing on stdout is said out loud, and it is not a failure.
 *
 * This is the shape the defect left silent: no code, no tail, no error — the child simply said nothing
 * and closed on zero. The notice is the whole of what the pane needs, and the absence of a `failure` is
 * the difference between "the model stopped without answering" and "the child died", so both halves are
 * asserted here: the cause that is worded, and the ticket that must not be printed beside it.
 */
async function aSilentCleanExitEmitsAnEmptyStopNotice() {
  const script = scriptedChild()
  const chunks: EngineTranscriptChunk[] = []
  const turn = runCodexTurn(
    { engineId: CODEX, prompt: 'a question nobody answered', cwd: 'C:/work' },
    { spawnImpl: spawnOf(script.child), binaryOverride: CODEX_BINARY },
    (chunk) => chunks.push(chunk)
  )

  await new Promise((resolve) => setImmediate(resolve))
  script.close(0)
  const outcome = await turn

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['turn_end_notice', 'turn_end'],
    'the notice, then the ending it belongs to'
  )
  const notice = chunks[0]
  assert.equal(notice?.type === 'turn_end_notice' ? notice.cause : '', 'empty_stop', 'a clean exit with no answer')
  assert.equal(notice?.type === 'turn_end_notice' ? notice.resumable : false, true, 'and the ending offers Continue')
  assert.equal(notice?.type === 'turn_end_notice' ? notice.failure : null, undefined, 'with no failure ticket')
  assert.equal(
    chunks[1]?.type === 'turn_end' ? chunks[1].cause : '',
    'empty_stop',
    'the transcript is told the same thing the outcome is'
  )
  assert.equal(outcome.exitCode, 0, 'nothing failed, so there is no code to report')
  assert.equal(outcome.cause, 'empty_stop', 'the ending is the missing answer')

  results.push('a clean exit with nothing said is an empty_stop notice, never silence and never a failure ticket')
}

// ---------------------------------------------------------------- report

async function main() {
  // Every case runs, and every failure is reported: the red turn needs the three discarded paths
  // measured together rather than only the first one, and a green run is the same list with no
  // failures.
  let failed = 0
  const step = async (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    try {
      await fn()
    } catch (error) {
      failed += 1
      console.error(`  FAILED: ${label} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await step('baseline: probe four lines', theProbeFourLinesStillReadAsOkAndUsage)
  await step('non-zero exit', aNonZeroExitCarriesItsCodeAndTail)
  await step('child error', aChildErrorCarriesItsCodeAndTail)
  await step('synchronous spawn failure', aSynchronousSpawnFailureEmitsItsCode)
  await step('resolution refusal', aResolutionRefusalEmitsItsConveyorErrorCode)
  await step('clean exit', aSilentCleanExitEmitsAnEmptyStopNotice)

  console.log('codex failure visibility: ' + results.length + ' passed, ' + failed + ' failed')
  for (const result of results) console.log('  pass: ' + result)
  if (failed > 0) process.exitCode = 1
}

void main().catch((err) => {
  console.error('CODEX FAILURE VISIBILITY TEST FAILED:', err)
  process.exit(1)
})
