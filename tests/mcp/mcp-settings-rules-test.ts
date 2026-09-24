/**
 * Verifies the settings surface's derivation rules: which servers are running and with how many tools,
 * what a trust state reads as, and whether a start is permitted.
 *
 * Pure by construction, and for the same reason `mcp-rules-test.ts` is: these are the rules the MCP
 * section branches on, so they have to be provable without a window, a bridge, or a running process.
 * The screen then asserts only what a screen can — that the row shows what these functions derived.
 *
 * What is deliberately *not* here: the wording of a failure. That comes from an error code raised in
 * main, and the code is the contract; the section is where codes become words.
 */
import { strict as assert } from 'node:assert'
import {
  canStartServer,
  deriveRunningServers,
  MCP_SERVER_AUTO_APPROVE,
  mcpCallSkipsConsent,
  trustPresentation,
  type McpRunningToolRef,
  type McpTrustState,
} from '../../conveyor/protocol/mcp-settings'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** One tool, as the runtime tags it: the id of the server that offers it, and nothing else this needs. */
function toolOf(serverId: string): McpRunningToolRef {
  return { serverId }
}

// ---------------------------------------------------------------- the running set

function theRunningSetIsGroupedByServerWithCounts() {
  // Nothing running is the ordinary state of a fresh launch, and it must derive an empty set rather
  // than an entry per configured server: a server with no process is not running, and inventing a row
  // for it would be the screen reporting a process that does not exist.
  assert.deepEqual(deriveRunningServers([]), [], 'no tools means nothing is running')

  const derived = deriveRunningServers([
    toolOf('filesystem'),
    toolOf('playwright'),
    toolOf('filesystem'),
    toolOf('playwright'),
    toolOf('playwright'),
  ])

  assert.deepEqual(derived, [
    { serverId: 'filesystem', toolCount: 2 },
    { serverId: 'playwright', toolCount: 3 },
  ])

  // Sorted rather than left in the order the tools arrived: the set is a derivation of what is running,
  // and two reads of the same registry must produce the same answer for a reader comparing them.
  assert.deepEqual(
    deriveRunningServers([toolOf('zulu'), toolOf('alpha')]).map((entry) => entry.serverId),
    ['alpha', 'zulu']
  )

  // A server whose tool list is momentarily empty is not in the set at all. This is the honest reading:
  // the runtime derives the set from the tools, so a server that offers none is indistinguishable from
  // one that is not there — and the row then says stopped rather than "running, with nothing".
  assert.deepEqual(deriveRunningServers([toolOf('filesystem')]).length, 1)
  assert.equal(
    deriveRunningServers([toolOf('filesystem')]).some((entry) => entry.serverId === 'playwright'),
    false
  )

  results.push('the running set is grouped by serverId with a tool count per server')
}

// ---------------------------------------------------------------- trust

function trustHasThreeReadingsAndOnlyOneOfThemAllowsAStart() {
  const matched = trustPresentation('matched')
  assert.equal(matched.startAllowed, true, 'a server that is still the one that was trusted may run')
  assert.equal(matched.action, 'revoke')
  assert.match(matched.label, /trusted/i)

  const mismatched = trustPresentation('mismatched')
  assert.equal(mismatched.startAllowed, false, 'a changed server is not the one that was trusted')
  assert.equal(mismatched.action, 'retrust')
  // The sentence has to name *what* happened, because the two refusals are fixed differently: a changed
  // server was trusted once and is not any more.
  assert.match(mismatched.label, /chang/i)

  const absent = trustPresentation('absent')
  assert.equal(absent.startAllowed, false, 'nobody ever granted this server anything')
  assert.equal(absent.action, 'trust')
  assert.notEqual(absent.label, mismatched.label, 'and the two refusals read differently')

  results.push('trust maps to a label, an action and a start-allowed flag, and only matched allows one')
}

// ---------------------------------------------------------------- the start gate

function startIsAllowedPerScopeAndState() {
  // Project scope: enabled *and* still trusted. Either one missing is a refusal, and trust being the
  // thing that changed is not a lesser refusal than trust never having been granted.
  assert.equal(canStartServer({ scope: 'project', enabled: true, trust: 'matched' }), true)
  assert.equal(canStartServer({ scope: 'project', enabled: true, trust: 'mismatched' }), false)
  assert.equal(canStartServer({ scope: 'project', enabled: true, trust: 'absent' }), false)
  assert.equal(canStartServer({ scope: 'project', enabled: false, trust: 'matched' }), false)
  assert.equal(canStartServer({ scope: 'project', enabled: false, trust: 'absent' }), false)

  // User scope: the flag alone. There is no trust record for a user server — the file is the user's own
  // and nobody else can put a command in it — so a state passed anyway must not be consulted.
  assert.equal(canStartServer({ scope: 'user', enabled: true, trust: null }), true)
  assert.equal(canStartServer({ scope: 'user', enabled: false, trust: null }), false)
  assert.equal(
    canStartServer({ scope: 'user', enabled: true, trust: 'mismatched' as McpTrustState }),
    true,
    'trust governs the project scope only'
  )

  results.push('start needs enabled plus, for a project server, matched trust')
}

// ---------------------------------------------------------------- the per-server exception

/**
 * The per-server skip rule, and the two halves of its input.
 *
 * This is the whole of the exception, so it is asserted in both directions: a flagged server's call
 * skips the pause, and nothing else does — not an unflagged server's call, and not any call to this
 * app's own tools, whose consent is the session's business. The two are separate clauses rather than one
 * `&&` so that neither can be dropped without a case failing.
 */
function onlyAFlaggedServersCallSkipsConsent() {
  const flagged = { autoApprove: true }
  const unflagged = { autoApprove: false }

  assert.equal(mcpCallSkipsConsent({ isMcpCall: true, server: flagged }), true, "a flagged server's call skips it")
  assert.equal(mcpCallSkipsConsent({ isMcpCall: true, server: unflagged }), false, 'an unflagged one does not')
  assert.equal(mcpCallSkipsConsent({ isMcpCall: true, server: null }), false, 'and neither does one with no server')

  // The other half: a built-in call is never this rule's to answer, whatever it is handed. Passing a
  // flagged view alongside `isMcpCall: false` is the shape a caller would produce by forgetting which
  // call it is looking at, and it must still be `false` — the session's shield decides those.
  assert.equal(mcpCallSkipsConsent({ isMcpCall: false, server: flagged }), false)
  assert.equal(mcpCallSkipsConsent({ isMcpCall: false, server: unflagged }), false)
  assert.equal(mcpCallSkipsConsent({ isMcpCall: false, server: null }), false)

  // The marker is the flag's own name in the config file, because that is the thing the user turned on
  // and the thing a record read back has to name.
  assert.equal(MCP_SERVER_AUTO_APPROVE, 'autoApprove')

  results.push("only a flagged server's own call skips the consent pause; every other call is unchanged")
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('running: grouped counts', theRunningSetIsGroupedByServerWithCounts)
  await step('trust: three readings', trustHasThreeReadingsAndOnlyOneOfThemAllowsAStart)
  await step('start: scope and state', startIsAllowedPerScopeAndState)
  await step('consent: per-server exception', onlyAFlaggedServersCallSkipsConsent)

  console.log(`mcp settings rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('MCP SETTINGS RULES TEST FAILED:', err)
  process.exit(1)
})
