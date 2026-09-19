/**
 * Verifies the xterm-facing half: turning the terminal module's chunk protocol into writes.
 *
 * This is the part the component calls per chunk, so it is where the marker parsing and colouring
 * live. No DOM is needed — `write` is a plain function — which is what makes it testable here.
 */
import { strict as assert } from 'node:assert'
import { createTerminalSession, exitMessage } from '../../app/components/workbench/terminal-session'
import { STDERR_MARKER } from '../../conveyor/protocol/terminal'

const results: string[] = []
const RED = '\u001b[31m'
const RESET = '\u001b[0m'

/** Collect what the session would hand to xterm. */
function session() {
  const written: string[] = []
  const exits: number[] = []
  const s = createTerminalSession(
    (text) => written.push(text),
    (code) => exits.push(code)
  )
  return { s, written, exits }
}

// ---------------------------------------------------------------- stdout passes through

function stdoutUntouched() {
  const { s, written } = session()
  s.consume('hello world\n')
  assert.deepEqual(written, ['hello world\n'], 'stdout should reach xterm verbatim')

  results.push('stdout is written untouched')
}

// ---------------------------------------------------------------- stderr is coloured

function stderrColoured() {
  const { s, written } = session()
  s.consume(`${STDERR_MARKER}something went wrong\n`)

  assert.equal(written.length, 1)
  assert.ok(written[0].startsWith(RED), 'a stderr chunk should open a red span')
  assert.ok(written[0].endsWith(RESET), 'and close it again')
  assert.ok(!written[0].includes(STDERR_MARKER), 'the marker itself must not be shown')
  assert.ok(written[0].includes('something went wrong\n'), 'the text, and its newline, survive')

  results.push('stderr is reddened and the marker is stripped')
}

function stderrKeepsNewline() {
  const { s, written } = session()
  s.consume(`${STDERR_MARKER}a\n`)
  // Trimming would swallow the newline and run the next chunk onto the same line.
  assert.ok(written[0].includes('a\n'), `newline lost: ${JSON.stringify(written[0])}`)

  results.push('a stderr chunk keeps its trailing newline')
}

// ---------------------------------------------------------------- the exit marker

function exitIsRecognised() {
  const { s, written, exits } = session()
  s.consume('output\n')
  assert.equal(s.ended, false, 'not ended before the marker')
  assert.equal(s.exitCode, null)

  s.consume('[EXIT_CODE:0]')

  assert.equal(s.ended, true, 'the marker ends the session')
  assert.equal(s.exitCode, 0, 'the code is parsed')
  assert.deepEqual(exits, [0], 'onExit fires once with the code')
  // The marker is protocol, not output: xterm must not see it.
  assert.ok(!written.some((w) => w.includes('EXIT_CODE')), 'the raw marker must not be written')
  assert.equal(written.length, 1, 'and nothing else should be written for it')

  results.push('the exit marker is parsed and never written to the terminal')
}

function nonZeroExit() {
  const { s, exits } = session()
  s.consume('[EXIT_CODE:130]')
  assert.equal(s.exitCode, 130)
  assert.deepEqual(exits, [130])

  // Negative codes (killed by a signal) parse too.
  const killed = session()
  killed.s.consume('[EXIT_CODE:-1]')
  assert.equal(killed.s.exitCode, -1)

  results.push('non-zero and negative exit codes parse')
}

function markerTextInOutputIsNotAnExit() {
  const { s, written } = session()
  // A command legitimately printing that text must not look like the process ending — which is why
  // the pattern is anchored rather than searched for.
  s.consume('the string [EXIT_CODE:0] appears in this line\n')
  assert.equal(s.ended, false, 'marker text inside output must not end the session')
  assert.equal(written.length, 1, 'it should be written as ordinary output')

  results.push('marker text inside command output is treated as output')
}

// ---------------------------------------------------------------- after the end

function nothingAfterExit() {
  const { s, written } = session()
  s.consume('one\n')
  s.consume('[EXIT_CODE:0]')
  s.consume('late chunk\n')

  assert.deepEqual(written, ['one\n'], 'nothing should be written after the exit marker')

  results.push('chunks after the exit marker are ignored')
}

// ---------------------------------------------------------------- the closing line

function exitLineWording() {
  assert.ok(exitMessage(0).includes('Process exited with code 0'))
  assert.ok(exitMessage(1).includes('Process exited with code 1'))
  // A successful run is green, a failed one red, so the code reads at a glance.
  assert.ok(exitMessage(0).includes('\u001b[32m'), 'success should be green')
  assert.ok(exitMessage(2).includes(RED), 'failure should be red')

  results.push('the closing line names the code and colours it by success')
}

// ---------------------------------------------------------------- run

function main() {
  stdoutUntouched()
  stderrColoured()
  stderrKeepsNewline()
  exitIsRecognised()
  nonZeroExit()
  markerTextInOutputIsNotAnExit()
  nothingAfterExit()
  exitLineWording()
  console.log('terminal session: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

main()
