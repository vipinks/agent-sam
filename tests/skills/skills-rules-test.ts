/**
 * Verifies the skill rules that hold without a disk: what a SKILL.md parses to, how many skills may be
 * active at once, how the Active Skills section is assembled, and what the session record does with the
 * key that remembers the choice.
 *
 * The parsing rules are the ones that are easy to get subtly wrong — where the manifest ends, what
 * counts as a valid one, what a skill with no manifest is called — and they are asserted against the
 * real parser rather than a copy of it, so a test cannot pass while the shipped code disagrees.
 *
 * The last step is about the session record rather than about skills as such, and it is here because
 * `activeSkillIds` is the one additive key this phase adds to it: the boundary's own rule — strip what
 * is not known, never default what is absent — is the thing that keeps every session written before
 * this phase a valid read.
 */
import { strict as assert } from 'node:assert'
import {
  ACTIVE_SKILLS_HEADING,
  applySkillToggle,
  assembleSkillsSection,
  MAX_ACTIVE_SKILLS,
  MAX_SKILL_SUMMARY_CHARS,
  mergeSkillScopes,
  parseSkillText,
  planSkillsInjection,
  SKILL_LIMIT_EXCEEDED,
  SKILL_MANIFEST_INVALID,
  SKILL_PARSE_INVALID,
  skillLimitReached,
  skillTitleFromId,
  type ResolvedSkill,
  type SkillSummary,
} from '../../conveyor/protocol/skills'
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import { createStoreHarness } from '../sessions/chat-sessions-store-harness'

const results: string[] = []

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  return Promise.resolve(fn()).then(() => undefined)
}

/** A skill file with a manifest, as a user would write one. */
const MANIFESTED = [
  '---',
  '{"schema":"1","title":"Code Review","summary":"Review a diff before it lands.","tags":["review","diff"]}',
  '---',
  '# Code Review',
  '',
  'Look for the things a test would have caught.',
  '',
].join('\n')

const MANIFESTED_BODY = '# Code Review\n\nLook for the things a test would have caught.'

// ---------------------------------------------------------------- parsing

function aSkillWithAManifestParses() {
  const parsed = parseSkillText('code-review', 'project', MANIFESTED)

  assert.ok(parsed.ok, 'a well-formed skill parses')
  assert.equal(parsed.skill.id, 'code-review', 'the id is the folder name it was read from')
  assert.equal(parsed.skill.scope, 'project', 'and the scope it was found in')
  assert.equal(parsed.skill.title, 'Code Review', 'the manifest names it')
  assert.equal(parsed.skill.summary, 'Review a diff before it lands.')
  assert.deepEqual(parsed.skill.tags, ['review', 'diff'], 'and its tags')
  assert.equal(parsed.skill.schema, '1', 'schema is a supported field and is carried')
  assert.equal(parsed.skill.body, MANIFESTED_BODY, 'the body is what follows the closing delimiter')

  // The same file written on Windows. A `\r` left at the end of a line would make the closing
  // delimiter unmatchable, which is the difference between a skill and a load error on the platform
  // this app mostly runs on.
  const crlf = parseSkillText('code-review', 'project', MANIFESTED.replace(/\n/g, '\r\n'))
  assert.ok(crlf.ok, 'a CRLF file parses too')
  assert.equal(crlf.skill.title, 'Code Review')
  assert.equal(crlf.skill.body, MANIFESTED_BODY, 'and its body carries no carriage returns')

  // A byte-order mark is what half the editors write; it must not hide the opening delimiter.
  const bom = parseSkillText('code-review', 'project', `\uFEFF${MANIFESTED}`)
  assert.ok(bom.ok, 'a file with a byte-order mark parses')
  assert.equal(bom.skill.title, 'Code Review')

  // A multi-line manifest is JSON across lines, which is how anyone writes more than two fields.
  const multi = parseSkillText(
    'deploy',
    'user',
    ['---', '{', '  "title": "Deploy",', '  "tags": ["ops"]', '}', '---', 'Body.'].join('\n')
  )
  assert.ok(multi.ok, 'a manifest spanning lines parses')
  assert.equal(multi.skill.title, 'Deploy')
  assert.equal(multi.skill.summary, 'Body.', 'and a manifest with no summary takes the first body line')

  // Unknown manifest keys are not a load error: a skill written for a later build must still load.
  const extra = parseSkillText('later', 'user', ['---', '{"title":"Later","future":true}', '---', 'Body.'].join('\n'))
  assert.ok(extra.ok, 'a manifest field this build does not know is tolerated')

  results.push('a manifest is parsed for title, summary, tags and schema, and the body follows it')
}

function aSkillWithoutAManifestIsTitledFromItsId() {
  const parsed = parseSkillText('deploy-runbook', 'user', '# Deploy runbook\n\nShip it, then watch the logs.\n')

  assert.ok(parsed.ok, 'a plain Markdown file is a skill')
  assert.equal(parsed.skill.title, 'Deploy Runbook', 'the title is derived from the id, not from the body')
  assert.equal(
    parsed.skill.summary,
    'Deploy runbook',
    'and the summary is the first non-empty body line, with its markdown heading marker dropped'
  )
  assert.deepEqual(parsed.skill.tags, [], 'a skill with no manifest has no tags')
  assert.equal(parsed.skill.schema, undefined, 'and no schema')
  assert.equal(parsed.skill.body, '# Deploy runbook\n\nShip it, then watch the logs.')

  // A first line longer than the display budget is clipped, and the clipping is stated.
  const long = parseSkillText('long', 'user', `${'y'.repeat(400)}\n\nmore\n`)
  assert.ok(long.ok)
  assert.ok(
    long.skill.summary.length <= MAX_SKILL_SUMMARY_CHARS,
    `a derived summary must fit ${MAX_SKILL_SUMMARY_CHARS} characters, got ${long.skill.summary.length}`
  )
  assert.ok(long.skill.summary.endsWith('…'), 'and say that it was clipped')

  // A summary authored in the manifest is the author's, so it is carried as written.
  const authored = 's'.repeat(MAX_SKILL_SUMMARY_CHARS + 40)
  const kept = parseSkillText('kept', 'user', ['---', `{"summary":"${authored}"}`, '---', 'Body.'].join('\n'))
  assert.ok(kept.ok)
  assert.equal(kept.skill.summary, authored, 'a manifest summary is not re-clipped')

  // An empty file is a skill with nothing to say rather than a failure.
  const empty = parseSkillText('empty', 'project', '   \n\n')
  assert.ok(empty.ok, 'an empty skill parses')
  assert.equal(empty.skill.summary, '')
  assert.equal(empty.skill.title, 'Empty', 'and is still named from its folder')

  assert.equal(skillTitleFromId('code-review'), 'Code Review', 'a hyphenated id is read as words')
  assert.equal(skillTitleFromId('a_b.c'), 'A B C', 'and so are the other separators a folder may use')

  results.push('a skill with no manifest is titled from its id and summarised from its first body line')
}

function anInvalidManifestIsALoadError() {
  const cases: Array<[string, string]> = [
    ['unclosed', ['---', '{"title":"x"}', '# Body'].join('\n')],
    ['not json', ['---', '{"title": "x",}', '---', 'Body'].join('\n')],
    ['not an object', ['---', '["a"]', '---', 'Body'].join('\n')],
    ['not even a value', ['---', 'title: x', '---', 'Body'].join('\n')],
    ['a title that is not a string', ['---', '{"title": 7}', '---', 'Body'].join('\n')],
    ['tags that are not a list', ['---', '{"tags":"review"}', '---', 'Body'].join('\n')],
    ['a tag that is not a string', ['---', '{"tags":["ok",3]}', '---', 'Body'].join('\n')],
    ['a summary that is not a string', ['---', '{"summary":[1]}', '---', 'Body'].join('\n')],
  ]

  for (const [label, text] of cases) {
    const parsed = parseSkillText('broken', 'project', text)
    assert.equal(parsed.ok, false, `${label} must be a load error rather than a skill`)
    assert.equal(parsed.code, SKILL_MANIFEST_INVALID, `${label} is reported as a manifest failure`)
    assert.equal(parsed.id, 'broken', 'and the error names the skill it came from')
    assert.equal(parsed.scope, 'project', 'with the scope it was read in')
    assert.ok(parsed.message.length > 0, `${label} must say something to show the user`)
  }

  results.push('a manifest that is not a JSON object of the known field types is a named load error')
}

// ---------------------------------------------------------------- activation

function theActiveCapIsEnforced() {
  assert.equal(MAX_ACTIVE_SKILLS, 3, 'the documented cap is three')
  assert.equal(skillLimitReached(['a', 'b', 'c']), true, 'three is the cap')
  assert.equal(skillLimitReached(['a', 'b']), false, 'two is not')

  const refused = applySkillToggle(['a', 'b', 'c'], 'd', true)
  assert.equal(refused.ok, false, 'a fourth skill is refused rather than silently stored')
  assert.equal(refused.code, SKILL_LIMIT_EXCEEDED)
  assert.equal(refused.message.includes(String(MAX_ACTIVE_SKILLS)), true, 'and the refusal names the cap')

  // Turning one off is always allowed, and it is what makes room.
  const off = applySkillToggle(['a', 'b', 'c'], 'b', false)
  assert.ok(off.ok)
  assert.deepEqual(off.activeSkillIds, ['a', 'c'], 'the removed skill is gone and the order of the rest is kept')

  const on = applySkillToggle(['a', 'c'], 'b', true)
  assert.ok(on.ok)
  assert.deepEqual(on.activeSkillIds, ['a', 'c', 'b'], 'an added skill is appended in the order it was turned on')

  // Idempotence: the control may be clicked twice, and the store must not gain a duplicate.
  const again = applySkillToggle(['a'], 'a', true)
  assert.ok(again.ok)
  assert.deepEqual(again.activeSkillIds, ['a'], 'turning on a skill that is already on changes nothing')

  const unknownOff = applySkillToggle(['a'], 'b', false)
  assert.ok(unknownOff.ok)
  assert.deepEqual(unknownOff.activeSkillIds, ['a'], 'turning off a skill that is not on changes nothing')

  // An id that could not name a folder is refused here, before it can become a session value.
  const unsafe = applySkillToggle([], '../elsewhere', true)
  assert.equal(unsafe.ok, false, 'an id that cannot be addressed is refused')
  assert.equal(unsafe.code, SKILL_PARSE_INVALID)

  // A session that somehow holds more than the cap reads as at the cap rather than as short of it.
  assert.equal(skillLimitReached(['a', 'a', 'a', 'a']), true)

  results.push('at most three skills are active, and a fourth is refused by code')
}

// ---------------------------------------------------------------- the prompt section

function theSectionIsOrderedAndStable() {
  const skills: ResolvedSkill[] = [
    { id: 'zeta', scope: 'user', title: 'Zeta', body: 'A third body.' },
    { id: 'alpha', scope: 'project', title: 'Alpha', body: 'A first body.' },
    { id: 'mu', scope: 'user', title: 'Mu', body: 'A second body.' },
  ]

  const section = assembleSkillsSection(skills)
  assert.ok(section, 'a section is assembled when skills are active')
  assert.ok(section.includes(ACTIVE_SKILLS_HEADING), 'it is headed as the Active Skills section')

  // Alphabetical by id, whatever order the store happened to hold them in.
  const positions = ['alpha', 'mu', 'zeta'].map((id) => section.indexOf(id))
  assert.ok(
    positions[0] < positions[1] && positions[1] < positions[2],
    `the entries must be ordered by id, got positions ${JSON.stringify(positions)}`
  )
  assert.equal(assembleSkillsSection([...skills].reverse()), section, 'and the order does not depend on the input')
  assert.equal(assembleSkillsSection(skills), section, 'the same input produces the same section')

  for (const skill of skills) {
    assert.ok(section.includes(skill.title), `${skill.id}: the entry carries the title`)
    assert.ok(section.includes(skill.body), `${skill.id}: and the body, in full`)
    assert.ok(section.includes(skill.id), `${skill.id}: and the id`)
    assert.ok(section.includes(skill.scope), `${skill.id}: and the scope it was found in`)
  }

  // The one line the whole feature rests on: these are documents, not authority.
  assert.ok(/guidance only/i.test(section), 'the section says the skills are guidance')
  assert.ok(
    /cannot override/i.test(section) && /consent|safety|laws/i.test(section),
    'and that they cannot override the app laws, consent or safety behaviour'
  )

  assert.equal(assembleSkillsSection([]), null, 'no active skills means no section at all')

  // The injection rule: the base prompt is untouched, and a resumed run is not given a second copy.
  assert.equal(planSkillsInjection([], null), null, 'nothing to inject for no section')
  assert.deepEqual(
    planSkillsInjection([{ role: 'user', content: 'hi' }], section),
    { content: section },
    'the section is injected into a history that does not carry it'
  )
  assert.equal(
    planSkillsInjection(
      [
        { role: 'system', content: section },
        { role: 'user', content: 'hi' },
      ],
      section
    ),
    null,
    'and refused when the history already carries it, which is the resumed case'
  )

  results.push('the Active Skills section is ordered by id, stable, complete, and injected once')
}

// ---------------------------------------------------------------- the listing merge

function theProjectScopeWins() {
  const summary = (id: string, scope: 'project' | 'user'): SkillSummary => ({
    id,
    scope,
    title: `${scope} ${id}`,
    summary: '',
    tags: [],
  })

  const merged = mergeSkillScopes(
    [summary('shared', 'project'), summary('only-project', 'project')],
    [summary('shared', 'user'), summary('only-user', 'user')]
  )

  assert.deepEqual(
    merged.project.map((s) => s.id),
    ['only-project', 'shared'],
    'the project scope is listed by id, the one order this app gives a set of skills'
  )
  assert.deepEqual(
    merged.user.map((s) => s.id),
    ['only-user'],
    'and a user skill the project shadows is dropped, so no toggle can point at a skill it would not activate'
  )

  results.push('a project skill overrides the user skill of the same id')
}

// ---------------------------------------------------------------- the session record

/**
 * The store's own schema for an action, as the IPC boundary applies it.
 *
 * Typed structurally rather than as zod's `parse`: conveyor is handed these as standard schemas and the
 * boundary validates a payload through `~standard.validate`, so asserting on zod's own API would be
 * asserting on something the wire never calls. `schemas` is optional on the authoring object — a store
 * needs none — so an action without one is a test failure rather than an empty object.
 */
function payloadSchema(name: 'addSession' | 'touchSession'): { validate: (value: unknown) => unknown } {
  const schema = chatSessionsStore.schemas?.[name] as unknown as
    { '~standard': { validate: (value: unknown) => unknown } } | undefined
  assert.ok(schema, `the store declares a ${name} schema`)
  return schema['~standard']
}

/** One payload through the boundary's own validation, as the record it produced. */
async function acceptedPayload(
  name: 'addSession' | 'touchSession',
  payload: unknown
): Promise<Record<string, unknown>> {
  const result = (await payloadSchema(name).validate(payload)) as { value?: unknown; issues?: readonly unknown[] }
  assert.equal(result.issues, undefined, `${name} accepts a well-formed payload`)
  return result.value as Record<string, unknown>
}

/** One payload the boundary is expected to refuse, which is what keeps the cap from being stored. */
async function refusedPayload(name: 'addSession' | 'touchSession', payload: unknown): Promise<void> {
  const result = (await payloadSchema(name).validate(payload)) as { issues?: readonly unknown[] }
  assert.ok(result.issues && result.issues.length > 0, `${name} refuses it`)
}

async function theSessionRecordKeepsTheKeyAdditive(): Promise<void> {
  const id = 'aaaaaaaa-1111-4111-8111-111111111111'
  const harness = createStoreHarness()

  harness.run('addSession', { id, title: 'one', providerId: 'deepseek', model: 'deepseek-chat' })
  const added = harness.state().sessions[0]
  assert.equal(
    'activeSkillIds' in added,
    false,
    'a conversation created with no skills chosen has no key rather than an empty list'
  )

  // The boundary's rule, asserted through the schema main validates with.
  const parsed = await acceptedPayload('touchSession', {
    id,
    activeSkillIds: ['code-review'],
    somethingElse: 'dropped',
  })
  assert.deepEqual(parsed.activeSkillIds, ['code-review'], 'a known key crosses the boundary')
  assert.equal('somethingElse' in parsed, false, 'an unknown key is stripped')

  const bare = await acceptedPayload('touchSession', { id })
  assert.equal('activeSkillIds' in bare, false, 'an absent key is stripped rather than defaulted to []')

  await refusedPayload('touchSession', { id, activeSkillIds: ['a', 'b', 'c', 'd'] })

  // Whole-record spread semantics: everything the payload does not name is carried through.
  harness.run('touchSession', { id, title: 'renamed', activeSkillIds: ['code-review'] })
  const touched = harness.state().sessions[0]
  assert.deepEqual(touched.activeSkillIds, ['code-review'])
  assert.equal(touched.title, 'renamed')
  assert.equal(touched.createdAt, added.createdAt, 'the record is not rebuilt from the payload')
  assert.equal(touched.providerId, 'deepseek')

  // A later touch that says nothing about skills leaves the stored ones exactly as they were.
  harness.run('touchSession', { id, title: 'renamed again' })
  assert.deepEqual(
    harness.state().sessions[0].activeSkillIds,
    ['code-review'],
    'a record written before this key existed is not rewritten by a touch that does not mention it'
  )

  // And removing the last skill is a change the user made, so the empty list is what gets written.
  harness.run('touchSession', { id, activeSkillIds: [] })
  assert.deepEqual(harness.state().sessions[0].activeSkillIds, [])

  // Creating a conversation while choices are pending carries them, and writes no key when there are none.
  harness.run('addSession', {
    id: 'bbbbbbbb-2222-4222-8222-222222222222',
    title: 'two',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    activeSkillIds: ['alpha', 'beta'],
  })
  const second = harness.state().sessions.find((s) => s.id === 'bbbbbbbb-2222-4222-8222-222222222222')
  assert.deepEqual(second?.activeSkillIds, ['alpha', 'beta'])

  results.push('activeSkillIds is an additive, optional session key that is stripped rather than defaulted')
}

// ---------------------------------------------------------------- harness

function main(): Promise<void> {
  return (async () => {
    await step('manifest', aSkillWithAManifestParses)
    await step('no manifest', aSkillWithoutAManifestIsTitledFromItsId)
    await step('bad manifest', anInvalidManifestIsALoadError)
    await step('cap', theActiveCapIsEnforced)
    await step('section', theSectionIsOrderedAndStable)
    await step('scopes', theProjectScopeWins)
    await step('session record', theSessionRecordKeepsTheKeyAdditive)

    console.log(`skills rules: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  })()
}

void main().catch((err: unknown) => {
  console.error('SKILLS RULES TEST FAILED:', err)
  process.exit(1)
})
