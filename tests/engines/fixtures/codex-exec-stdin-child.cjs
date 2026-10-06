/**
 * A stand-in for `codex exec --json`, for the child-lifecycle suite.
 *
 * It exists because the defect these cases are about is not in the dialect but in what the client hands the
 * child at spawn. The behavior that matters here is measured, not invented: with the prompt given as an
 * argument and stdin a *pipe*, the real CLI prints `Reading additional input from stdin...` and then waits
 * for that pipe to end before it says anything — against `codex-cli 0.160.1` that was zero events in 45
 * seconds, and the same binary with stdin closed streamed `thread.started` → `turn.completed` and exited 0
 * in 12.4 seconds. So this fixture waits for its stdin to end before it speaks, exactly as the CLI does, and
 * a client that leaves stdin open gets a child that never speaks and never exits.
 *
 * Its vocabulary is the captured one (`codex-exec-tool-capture.jsonl`), cut down to a reply: the four lines a
 * plain answer is made of, so a suite can assert on the ending without repeating the tool capture.
 *
 * Modes, as `argv[2]`:
 *   reply        — wait for stdin to end, print the vocabulary, exit 0.
 *   silent-ok    — wait for stdin to end, say nothing, exit 0.
 *   silent-fail  — wait for stdin to end, say nothing, exit 3.
 *   block        — say nothing and never exit: a turn in flight, for the cancel case. It ignores stdin, so
 *                  it is the one mode whose silence is not about the pipe.
 *
 * The self-destruct is a safety net, not the behavior under test: a suite that fails must not be able to
 * leave a process behind, so every mode exits on its own after fifteen seconds.
 */
// Imported rather than taken from the global scope: the eslint block that covers `tests/**/*.cjs` declares
// Node's `process` and `require` globals but not its timer functions, and widening that block for one fixture
// would be a change to the gate itself rather than to what the gate is checking.
const { setInterval, setTimeout } = require('node:timers')

const mode = process.argv[2] ?? 'reply'
const SELF_DESTRUCT_MS = 15000

const REPLY = [
  '{"type":"thread.started","thread_id":"01a1113f-52f1-70c3-90b4-06f3e9a76cae"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":20775,"cached_input_tokens":6912,"output_tokens":5}}',
]

function speak() {
  if (mode === 'reply') {
    process.stdout.write(`${REPLY.join('\n')}\n`)
    process.exit(0)
  }
  process.exit(mode === 'silent-fail' ? 3 : 0)
}

if (mode === 'block') {
  setInterval(() => {}, 1000)
} else {
  // The CLI's own wait: the prompt is an argument, the piped stdin is appended to it, and nothing is
  // printed until that pipe ends.
  let spoken = false
  const once = () => {
    if (spoken) return
    spoken = true
    speak()
  }
  process.stdin.on('end', once)
  process.stdin.on('close', once)
  process.stdin.resume()
}

setTimeout(() => process.exit(0), SELF_DESTRUCT_MS)
