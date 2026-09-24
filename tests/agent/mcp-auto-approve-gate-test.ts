/**
 * The per-server auto-approve flag's decision, at the one place a call is actually gated on.
 *
 * `protocol/mcp-settings` owns the rule and `mcp-settings-rules-test.ts` proves it in isolation. What
 * that cannot prove is the *composition*: the loop asks two questions about a call — what the session's
 * Auto-approve shield says, and what the server behind the call says about itself — and the matrix of the
 * two answers is where a defect would live. The failure mode this file exists to catch is the one the
 * design names last and a hurried implementation gets wrong: a session with the shield on starting to
 * skip *every* server's calls, rather than only the flagged server's.
 *
 * `callNeedsApproval` takes the server's flag as an argument rather than reading it, which is what makes
 * that matrix provable here with no window, no bridge, and no config file. The read itself — and the fact
 * that it happens per call, from the file as it stands — belongs to the loop and is covered by the agent
 * loop's own suite.
 *
 * Built-in tools are asserted in both shield states, because their behaviour is the part that must not
 * move: this turn adds an exception for one kind of call and is not allowed to disturb the other.
 */
import { strict as assert } from 'node:assert'
import { callNeedsApproval } from '../../conveyor/modules/agent'
import { isMcpToolName, mcpToolIdentity } from '../../conveyor/protocol/mcp-tools'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** A call to one server's tool, named the way the loop names it. */
const MCP_CALL = mcpToolIdentity('playwright', 'browser_click')
/** A call this app's own tools answer: a write, which the shield covers. */
const BUILTIN_WRITE = 'write_file'
/** A call this app's own tools answer: a read, which was never gated in either state. */
const BUILTIN_READ = 'read_file'

function anMcpCallIsGatedPerServerRatherThanPerSession() {
  assert.equal(isMcpToolName(MCP_CALL), true, 'the matrix is about a call the loop recognises as a server call')

  // The flagged server, with the shield off as well as on: the flag is the whole reason the call runs
  // without a pause, so it must not depend on the session setting in either direction. A flag that only
  // worked while the shield happened to be on would be a setting that silently stops working.
  assert.equal(callNeedsApproval(MCP_CALL, false, true), false, 'a flagged server call skips with the shield off')
  assert.equal(callNeedsApproval(MCP_CALL, true, true), false, 'and with the shield on')

  // The unflagged server: asked about in both shield states, and *asked about* is the load-bearing half.
  // This is the case a session-wide reading of the flag would have got wrong.
  assert.equal(callNeedsApproval(MCP_CALL, true, false), true, 'an unflagged server call still asks with the shield on')
  assert.equal(callNeedsApproval(MCP_CALL, false, false), true, 'and with the shield off')

  // And the ordinary call site's default: a caller that knows nothing about a server behind the call —
  // every built-in call, and any call whose server could not be read — gets the always-ask rule.
  assert.equal(callNeedsApproval(MCP_CALL, true), true, 'no flag is not a flag, whatever the shield says')
  assert.equal(callNeedsApproval(MCP_CALL, false), true)

  results.push('an mcp call is skipped only for its own flagged server, in either shield state')
}

function builtInCallsStillFollowTheSessionShield() {
  assert.equal(isMcpToolName(BUILTIN_WRITE), false, 'a write is not a server call')

  // Unchanged behaviour, asserted here rather than assumed: with the shield off a write waits, with it on
  // the write runs, and a read runs either way. A server flag passed to a built-in call must not change
  // any of that, which is the other way this turn could have gone wrong.
  assert.equal(callNeedsApproval(BUILTIN_WRITE, false), true, 'a write waits while the shield is off')
  assert.equal(callNeedsApproval(BUILTIN_WRITE, true), false, 'and runs when the user turned it on')
  assert.equal(callNeedsApproval(BUILTIN_WRITE, false, true), true, 'an mcp flag cannot approve one')
  assert.equal(callNeedsApproval(BUILTIN_WRITE, true, true), false, 'and does not disturb the shield here either')

  assert.equal(callNeedsApproval(BUILTIN_READ, false), false, 'a read was never gated')
  assert.equal(callNeedsApproval(BUILTIN_READ, true), false)
  assert.equal(callNeedsApproval(BUILTIN_READ, false, true), false, 'nor is it gated by a flag somewhere else')

  results.push('built-in calls follow the session shield exactly as before, flag or no flag')
}

async function main() {
  await step('mcp calls: per-server gate', anMcpCallIsGatedPerServerRatherThanPerSession)
  await step('built-in calls: session shield', builtInCallsStillFollowTheSessionShield)

  console.log(`mcp auto-approve gate: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('MCP AUTO-APPROVE GATE TEST FAILED:', err)
  process.exit(1)
})
