/**
 * The engine turn input, as a boundary: the optional model, the bound it is held to, and what is refused.
 *
 * What a turn carries is the schema's business rather than the runner's, because the schema is the only thing
 * standing between a payload and the argv an OS is handed: a model id is a word of a length such an argument can
 * carry, so the shape of that field is judged here rather than by a runner that might read it. The four fields the
 * turn has always had are asserted to remain required in the same breath — a boundary that gained a field and lost
 * one would be a turn started with nothing to run.
 *
 * What this deliberately does *not* assert is that an unknown model id is refused here. Codex publishes no
 * catalogue this app can read, so there is nothing on this side to check an id against; an id the CLI does not
 * know is the CLI's own legible refusal, and that travels the path every engine error already takes.
 *
 * The schema and the bound are reached through namespace imports, once and for one reason: the claims below are
 * about what the protocol states and what the module registers, and a name import would make this suite
 * unbuildable on a tree where the field does not exist yet — a red that is a build failure states nothing about
 * the tree it is measuring.
 */
import { strict as assert } from 'node:assert'
import * as engineModule from '../../conveyor/modules/engine'
import * as engineProtocol from '../../conveyor/protocol/engine'

const results: string[] = []
const CODEX = 'codex'

/** A turn exactly as the pane sends one: the four fields every engine turn has had, and nothing more. */
const TURN = {
  engineId: CODEX,
  prompt: 'a prompt',
  cwd: 'C:/work',
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
}

/** The optional model, its bound, and the four fields that do not become optional. */
function theSchemaTakesAnOptionalModelAtAStatedBound() {
  const schema = engineModule.engineTurnInputSchema
  assert.ok(schema, 'the module registers its turn input schema')

  const bound = engineProtocol.ENGINE_MODEL_MAX_LENGTH
  assert.equal(Number.isInteger(bound), true, 'the protocol states the bound a model id is held to')

  // Absent, which is how every turn written before this phase travels.
  assert.equal(schema.safeParse(TURN).success, true, 'a turn with no model is accepted')

  const chosen = schema.safeParse({ ...TURN, model: 'gpt-5-codex' })
  assert.equal(chosen.success, true, 'and one naming a model')
  assert.equal(chosen.success === true && chosen.data.model, 'gpt-5-codex', 'carrying the id through unchanged')

  // An empty id is not a missing one: it is the second spelling of "the engine's own default", and the runner
  // injects no flag for either spelling.
  assert.equal(schema.safeParse({ ...TURN, model: '' }).success, true, 'an empty model is the engine default')

  // What the boundary refuses. A non-string is an id nothing downstream could compare, and an id past the bound
  // is a value a command line has no room for — this is the field the flag is built from, so this is where the
  // shape of it is judged.
  assert.equal(schema.safeParse({ ...TURN, model: 4242 }).success, false, 'a non-string model is refused')
  assert.equal(schema.safeParse({ ...TURN, model: null }).success, false, 'and so is a null one')
  assert.equal(
    schema.safeParse({ ...TURN, model: 'm'.repeat(bound + 1) }).success,
    false,
    'an id past the bound is refused'
  )
  assert.equal(
    schema.safeParse({ ...TURN, model: 'm'.repeat(bound) }).success,
    true,
    'while one exactly at the bound is accepted, which is what makes the bound a length rather than a guess'
  )

  for (const field of ['engineId', 'prompt', 'cwd', 'sessionId'] as const) {
    const missing: Record<string, unknown> = { ...TURN }
    delete missing[field]
    assert.equal(schema.safeParse(missing).success, false, `${field}: still required`)
  }

  results.push('the turn input takes an optional model at a stated bound, and refuses what is not a model id')
}

// ---------------------------------------------------------------- report

async function main() {
  const step = (label: string, fn: () => void | Promise<void>) => {
    process.stdout.write(`... ${label}\n`)
    return fn()
  }

  await step('turn input', theSchemaTakesAnOptionalModelAtAStatedBound)

  console.log('engine turn input: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('ENGINE TURN INPUT TEST FAILED:', err)
  process.exit(1)
})
