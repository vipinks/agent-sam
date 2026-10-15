/**
 * The OpenCode model choice, as the runner's own rule: the id a turn was handed is judged against the catalogue
 * the session advertised *before* any `session/set_model` is sent, and an id the catalogue does not carry is
 * refused with this app's own code instead of being handed to an engine that would accept it.
 *
 * The defect this suite was written red against, and the live evidence for it: the Phase 82 probe
 * (`tests/probes/acp-model-surface-probe.mjs`) asked `opencode acp` for a model it does not have and the agent
 * answered *success*. The id is therefore not a thing the engine judges — it is a thing this app has to judge,
 * because the only list of real ids is the one the engine itself advertises on `session/new`, and a turn that
 * forwarded an unchecked word would run, silently, on whatever the engine made of it.
 *
 * The three claims, one per case below, are the rule the design names: the advertised id is set on the session;
 * an id in neither the catalogue nor the session's current model is refused, and refused *before* the peer is
 * told anything; and the session's own `currentModelId` is always a valid choice, because a catalogue is the
 * engine's advertisement of what it *offers* and the model a session is already running need not appear in it —
 * the shape the probe recorded for OpenCode, whose current model was absent from the list it sent.
 *
 * The turn is driven against `tests/engines/fixtures/acp-fixture-agent.cjs`, whose `catalogue` mode advertises a
 * catalogue and echoes back the id it was told. The echo is the point: what is asserted is what the *agent* was
 * told, not what the client believed it sent. The fixture accepts a garbage id exactly as the live engine did,
 * which is what makes the second case a statement about this app's refusal rather than about the peer's manners.
 *
 * What the fixture deliberately does not claim: that a live OpenCode obeys `session/set_model`'s answer, or that
 * 1367 advertised ids is what a real session sends. The catalogue's shape is the probe's recorded measurement;
 * this suite's subject is the judgement made about it.
 */
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runAcpTurn } from '../../conveyor/modules/engine-acp-turn'
import type { AcpSpawnImpl } from '../../conveyor/modules/engine-acp'
import type { AcpModelCatalogue } from '../../conveyor/protocol/acp'
import type { EngineTranscriptChunk } from '../../conveyor/protocol/codex-turn'

const results: string[] = []
const OPENCODE = 'opencode'

/**
 * The refusal's own code, written out rather than imported.
 *
 * A name import would make this suite unbuildable on a tree that has no such code, and the red it has to record
 * is a failed claim about the runner rather than a failed import. The word here is the code a caller branches on.
 */
const MODEL_UNKNOWN_CODE = 'ACP_MODEL_UNKNOWN'

/** The fixture's advertisement: three offered ids, and a current model that is deliberately not among them. */
const ADVERTISED = 'opencode/sonnet-4'
const OFFERED = ['opencode/gpt-5', 'opencode/sonnet-4', 'opencode/gemini-3']
const CURRENT_AND_UNLISTED = 'opencode/big-pickle'

/** An id nothing could have advertised: unmistakable, so the refusal below cannot be about a real model. */
const UNKNOWN = 'phase87-not-a-real-model-xyz'

const FIXTURE = join(process.cwd(), 'tests', 'engines', 'fixtures', 'acp-fixture-agent.cjs')
if (!existsSync(FIXTURE)) {
  throw new Error(`the ACP fixture is missing at ${FIXTURE}: run the suites from the repository root`)
}

/** Every child this suite started, so a failing assertion cannot leave one behind. */
const children: ChildProcess[] = []

/** The spawn that runs the fixture instead of a vendor binary, in the shape the OpenCode suite spawns it. */
function fixtureSpawn(mode: string): AcpSpawnImpl {
  // The command and arguments the law resolved are the OpenCode suite's subject and are asserted there; what this
  // suite needs of the spawn layer is only that the fixture is the process standing behind whatever was resolved.
  return (_command, _args, options) => {
    const child = spawn(process.execPath, [FIXTURE, mode], options as SpawnOptionsWithoutStdio)
    children.push(child)
    return child
  }
}

/** Stop every child this suite started, so a failing assertion cannot leave one behind. */
async function reapAll(): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

/** One turn's observable result: what the agent said, whether the turn refused, and the catalogues recorded. */
interface TurnRun {
  chunks: EngineTranscriptChunk[]
  /** The refusal, as a code, when the turn refused. `null` when it ran. */
  code: string | null
  /** The catalogue `session/new` advertised, as the runner recorded it. */
  catalogues: AcpModelCatalogue[]
}

/**
 * Run one turn for a chosen model, with the catalogue mode's fixture underneath it.
 *
 * The catalogue is collected through the same hook the app installs to feed the header's control, so the record
 * asserted here is the record the picker would be drawn from rather than a second reading of the wire.
 */
async function runModelTurn(model: string): Promise<TurnRun> {
  const chunks: EngineTranscriptChunk[] = []
  const catalogues: AcpModelCatalogue[] = []

  try {
    await runAcpTurn(
      { engineId: OPENCODE, prompt: 'write the notes', cwd: process.cwd(), model },
      {
        spawnImpl: fixtureSpawn('catalogue'),
        onPermissionRequest: () => Promise.resolve('allow-once'),
        onCatalogue: (catalogue) => catalogues.push(catalogue),
      },
      (chunk) => chunks.push(chunk)
    )
    return { chunks, code: null, catalogues }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { chunks, code: typeof code === 'string' ? code : `not-a-code: ${String(error)}`, catalogues }
  }
}

/** What the agent said it was told, read from the prose the fixture streamed back. */
function modelTold(chunks: EngineTranscriptChunk[]): string[] {
  return chunks
    .filter((chunk) => chunk.type === 'text_delta')
    .map((chunk) => (chunk.type === 'text_delta' ? chunk.text : ''))
    .filter((text) => text.startsWith('model:'))
}

/**
 * An advertised id is set on the session, and the catalogue it was judged against is recorded.
 *
 * The catalogue's own recording is asserted here rather than in a case of its own, because the two are one
 * claim: the list the judgement used is the list the header's control is drawn from, so a list read once and
 * used in two places cannot come to mean two different things.
 */
async function anAdvertisedModelIsJudgedAgainstTheCatalogueAndSetOnTheSession() {
  const run = await runModelTurn(ADVERTISED)

  assert.equal(run.code, null, 'an advertised id is not refused')
  assert.deepEqual(modelTold(run.chunks), ['model:' + ADVERTISED], 'and the agent was told that id')

  assert.equal(run.catalogues.length, 1, 'the catalogue is recorded once, for the turn that read it')
  const catalogue = run.catalogues[0]
  assert.deepEqual(catalogue.ids, OFFERED, 'with the ids the agent advertised, in its own order')
  assert.equal(catalogue.currentModelId, CURRENT_AND_UNLISTED, "and the session's own current model")

  await reapAll()
  results.push('an advertised model is judged against the catalogue and then set on the session')
}

/**
 * An id in neither the catalogue nor the current model is refused, and refused before the peer hears anything.
 *
 * The second half is the whole of the claim: the live engine answers *success* to an id it does not know, so a
 * turn that validated after the call would have changed the session's model to a word nothing resolved. The
 * fixture proves the peer was never told — no model echo, and no ending, because the turn ended here.
 */
async function anIdTheCatalogueDoesNotCarryIsRefusedBeforeTheSessionIsToldAnything() {
  const run = await runModelTurn(UNKNOWN)

  assert.equal(run.code, MODEL_UNKNOWN_CODE, 'an id the catalogue does not carry is refused by this app')
  assert.deepEqual(modelTold(run.chunks), [], 'and the agent was never told a model')
  assert.equal(
    run.chunks.some((chunk) => chunk.type === 'turn_end'),
    false,
    'the turn refused rather than ending, so nothing claims it ran'
  )

  await reapAll()
  results.push('an unknown model is refused with the app\u2019s own code before the session is told anything')
}

/**
 * The session's own current model is a valid choice even when the catalogue omits it.
 *
 * The probe's own observation, as a rule: OpenCode advertised a catalogue whose `currentModelId` was not among
 * its entries, so a check that consulted only the list would refuse the model the session was already running —
 * a refusal to change to the model already in force. The case states the omission rather than assuming it.
 */
async function theSessionsOwnCurrentModelIsAcceptedEvenThoughTheCatalogueOmitsIt() {
  const run = await runModelTurn(CURRENT_AND_UNLISTED)

  assert.equal(
    OFFERED.includes(CURRENT_AND_UNLISTED),
    false,
    'the case is about the current-model rule only if the catalogue really does omit it'
  )
  assert.equal(run.code, null, 'the current model is accepted')
  assert.deepEqual(
    modelTold(run.chunks),
    ['model:' + CURRENT_AND_UNLISTED],
    'and the agent was told the id the session was already running'
  )

  await reapAll()
  results.push('the session\u2019s own current model is accepted even though the catalogue omits it')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('advertised id', anAdvertisedModelIsJudgedAgainstTheCatalogueAndSetOnTheSession)
  await step('unknown id', anIdTheCatalogueDoesNotCarryIsRefusedBeforeTheSessionIsToldAnything)
  await step('current model', theSessionsOwnCurrentModelIsAcceptedEvenThoughTheCatalogueOmitsIt)

  console.log('engine model catalogue: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch(async (err) => {
  await reapAll()
  console.error('ENGINE MODEL CATALOGUE TEST FAILED:', err)
  process.exit(1)
})
