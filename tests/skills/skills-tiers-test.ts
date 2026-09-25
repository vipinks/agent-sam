/**
 * Verifies the skills tiers: the four folders a skill may come from, the precedence between them, the
 * one parser that reads both manifest formats, and the derivations a surface needs from a tier list.
 *
 * The tiers are four directories rather than two scopes, because two of them — the `.agents` folders —
 * are a compatibility surface this app reads and never writes, and a listing that could not say which
 * folder a skill came from would leave the settings screen unable to say it either. Precedence is
 * therefore a property of the *order* of four scans, and it is asserted here against a seeded tree so
 * the collision cases are decided by the real walk rather than by a re-implementation of it.
 *
 * Parsing is asserted where the two formats meet: a JSON manifest block and a YAML frontmatter that say
 * the same thing must normalize to the same values, because that equality is the whole point of reading
 * both through one parser. A file that cannot be parsed stays a per-file error with valid siblings
 * loading beside it.
 *
 * No electron in the body: every function here takes the paths it reads, so this writes into temp
 * directories and reads them back. The last step exercises the registered surface, which does read
 * electron — the stub points that at the suite's private userData directory.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  getSkillBody,
  listSkills,
  projectAgentsSkillsDir,
  projectSkillsDir,
  resolveActiveSkills,
  skillsModule,
  userAgentsSkillsDir,
  userSkillsDir,
} from '../../conveyor/modules/skills'
import {
  deriveSkillCounts,
  filterSkillSummaries,
  isReadOnlyTier,
  mergeSkillTiers,
  SKILL_MANIFEST_INVALID,
  SKILL_NOT_FOUND,
  SKILL_TIERS,
  tierById,
  tierIdFor,
  type SkillSummary,
  type SkillTierId,
  type SkillTierListing,
  type SkillTierPaths,
} from '../../conveyor/protocol/skills'
import { parseSkillText } from '../../conveyor/protocol/skill-manifest'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(prefix = 'sam-skill-tiers-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Write one skill file under a skills directory and return its folder path. */
function writeSkill(skillsDir: string, id: string, text: string): string {
  const folder = join(skillsDir, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), text, 'utf8')
  return folder
}

/**
 * The four tier directories, named explicitly.
 *
 * Built by hand rather than through `skillTierPathsFor` so each test can point one tier at a seeded
 * folder and leave another missing — which is the difference between "this tier is empty" and "this
 * tier is not there", and the suite has to be able to say both.
 */
function tierPaths(input: {
  root?: string | null
  userNative?: string
  userCompat?: string
  projectCompat?: string | null
}): SkillTierPaths {
  const root = input.root ?? null
  return {
    projectNative: root === null ? null : projectSkillsDir(root),
    projectCompat:
      input.projectCompat !== undefined ? input.projectCompat : root === null ? null : projectAgentsSkillsDir(root),
    userNative: input.userNative ?? join(makeRoot('sam-user-skills-'), 'era', 'skills'),
    userCompat: input.userCompat ?? join(makeRoot('sam-user-agents-'), '.agents', 'skills'),
  }
}

/** The `code` of a thrown error, or undefined when it was not a ConveyorError. */
function codeOf(err: unknown): string | undefined {
  return err instanceof ConveyorError ? err.code : undefined
}

/** The tier listing a listing carries for one tier, so an assertion does not depend on array order alone. */
function tierOf(listing: { tiers: readonly SkillTierListing[] }, tier: SkillTierId): SkillTierListing {
  const found = listing.tiers.find((entry) => entry.tier === tier)
  assert.ok(found, `${tier} must appear in the listing even when it is empty`)
  return found
}

/** A manifest the two formats can both express, so normalization can be compared rather than described. */
const JSON_MANIFEST = [
  '---',
  '{"schema":"1","title":"Code Review","summary":"Review a diff before it lands.","tags":["review","diff"]}',
  '---',
  '# Code Review',
  '',
  'Look for the things a test would have caught.',
  '',
].join('\n')

const YAML_MANIFEST = [
  '---',
  'schema: "1"',
  'title: Code Review',
  'summary: Review a diff before it lands.',
  'tags:',
  '  - review',
  '  - diff',
  '---',
  '# Code Review',
  '',
  'Look for the things a test would have caught.',
  '',
].join('\n')

const MANIFESTED_BODY = '# Code Review\n\nLook for the things a test would have caught.'

// ---------------------------------------------------------------- the one parser

function yamlFrontmatterIsParsed() {
  const parsed = parseSkillText('code-review', 'project', YAML_MANIFEST)

  assert.ok(parsed.ok, 'a YAML frontmatter parses')
  assert.equal(parsed.skill.title, 'Code Review', 'a frontmatter title is read')
  assert.equal(parsed.skill.summary, 'Review a diff before it lands.', 'and its summary')
  assert.deepEqual(parsed.skill.tags, ['review', 'diff'], 'and its tags, as a block sequence')
  assert.equal(parsed.skill.schema, '1', 'a quoted scalar keeps its quotes off the value')
  assert.equal(parsed.skill.body, MANIFESTED_BODY, 'the body is what follows the closing delimiter')

  // The flow form of the same frontmatter, which is how a short manifest is usually written.
  const flow = parseSkillText('flow', 'user', ['---', '{title: Flow Style, tags: [a, b]}', '---', 'Body.'].join('\n'))
  assert.ok(flow.ok, 'a flow mapping parses too')
  assert.equal(flow.skill.title, 'Flow Style')
  assert.deepEqual(flow.skill.tags, ['a', 'b'])
  assert.equal(flow.skill.summary, 'Body.', 'and a manifest with no summary still takes the first body line')

  // CRLF and a byte-order mark are unchanged by the move to this parser, and are the two things a
  // Windows editor writes that would otherwise hide the delimiters.
  const crlf = parseSkillText('crlf', 'project', YAML_MANIFEST.replace(/\n/g, '\r\n'))
  assert.ok(crlf.ok, 'a CRLF frontmatter parses')
  assert.equal(crlf.skill.body, MANIFESTED_BODY, 'and carries no carriage returns in its body')

  const bom = parseSkillText('bom', 'project', `\uFEFF${YAML_MANIFEST}`)
  assert.ok(bom.ok, 'a file with a byte-order mark parses')

  results.push('YAML frontmatter is read for title, summary, tags and schema, in both of its shapes')
}

function jsonManifestBlocksStillParse() {
  const parsed = parseSkillText('code-review', 'project', JSON_MANIFEST)

  assert.ok(parsed.ok, 'the JSON block this app writes is still a manifest')
  assert.equal(parsed.skill.title, 'Code Review')
  assert.equal(parsed.skill.summary, 'Review a diff before it lands.')
  assert.deepEqual(parsed.skill.tags, ['review', 'diff'])
  assert.equal(parsed.skill.schema, '1')

  // JSON across lines is what anyone writes past two fields, and it is still JSON-shaped input to a
  // YAML parser: the parser is the one thing that changed about it.
  const multi = parseSkillText(
    'deploy',
    'user',
    ['---', '{', '  "title": "Deploy",', '  "tags": ["ops"]', '}', '---', 'Body.'].join('\n')
  )
  assert.ok(multi.ok, 'a manifest spanning lines parses')
  assert.equal(multi.skill.title, 'Deploy')
  assert.equal(multi.skill.summary, 'Body.')

  results.push('a JSON manifest block parses through the YAML parser, single-line and multi-line')
}

function bothFormatsNormalizeToTheSameShape() {
  const fromJson = parseSkillText('code-review', 'project', JSON_MANIFEST)
  const fromYaml = parseSkillText('code-review', 'project', YAML_MANIFEST)

  assert.ok(fromJson.ok && fromYaml.ok, 'both formats parse')
  assert.deepEqual(
    fromYaml,
    fromJson,
    'the same skill written in either format normalizes to the same result, value for value'
  )
  assert.deepEqual(
    Object.keys(fromJson.skill).sort(),
    ['body', 'id', 'schema', 'scope', 'summary', 'tags', 'title'],
    'and to the one shape the renderer and the prompt assembler are written against'
  )
  assert.equal(fromJson.skill.schema, '1', 'the schema key is the same key in both')

  // A manifest that declares no schema carries no key rather than an empty one, in either format.
  const bare = parseSkillText('bare', 'project', ['---', 'title: Bare', '---', 'Body.'].join('\n'))
  assert.ok(bare.ok)
  assert.equal('schema' in bare.skill, false, 'an undeclared schema is absent, not blank')

  results.push('a manifest normalizes to one shape whether it was written as JSON or as YAML')
}

function invalidYamlIsAPerSkillError() {
  const cases: Array<[string, string]> = [
    ['unclosed quote', ['---', 'title: "Code Review', '---', 'Body.'].join('\n')],
    ['a nested mapping where a scalar belongs', ['---', 'summary: one: two', '---', 'Body.'].join('\n')],
    ['a duplicate key', ['---', 'title: one', 'title: two', '---', 'Body.'].join('\n')],
    ['a sequence where a mapping belongs', ['---', '- one', '- two', '---', 'Body.'].join('\n')],
    ['a scalar where a mapping belongs', ['---', '42', '---', 'Body.'].join('\n')],
    ['a title that is not a string', ['---', 'title: 7', '---', 'Body.'].join('\n')],
    ['tags that are not a list', ['---', 'tags: review', '---', 'Body.'].join('\n')],
    ['a tag that is not a string', ['---', 'tags: [ok, 3]', '---', 'Body.'].join('\n')],
    ['an unclosed manifest', ['---', 'title: x', '# Body'].join('\n')],
  ]

  for (const [label, text] of cases) {
    const parsed = parseSkillText('broken', 'project', text)
    assert.equal(parsed.ok, false, `${label} must be a load error rather than a skill`)
    assert.equal(parsed.code, SKILL_MANIFEST_INVALID, `${label} is reported as a manifest failure`)
    assert.equal(parsed.id, 'broken', 'and the error names the skill it came from')
    assert.ok(parsed.message.length > 0, `${label} must say something to show the user`)
    assert.equal('tier' in parsed, false, 'a parse failure carries no tier: only the scan knows which folder it read')
  }

  results.push('frontmatter that is not a mapping of the known field types is a named per-skill load error')
}

// ---------------------------------------------------------------- tiers

function theTiersAreFourInPrecedenceOrder() {
  assert.deepEqual(
    SKILL_TIERS.map((tier) => tier.id),
    ['project-native', 'project-compat', 'user-native', 'user-compat'],
    'the four tiers are stated once, in the order that decides a collision'
  )
  assert.equal(new Set(SKILL_TIERS.map((tier) => tier.id)).size, SKILL_TIERS.length, 'and no id is stated twice')

  for (const tier of SKILL_TIERS) {
    assert.equal(tierById(tier.id).scope, tier.scope, `${tier.id} round-trips through the lookup`)
    assert.equal(tierIdFor(tier.scope, tier.kind), tier.id, 'and through the scope and kind that name it')
  }

  assert.equal(tierById('project-native').kind, 'native', 'the project `.sam` folder is a native tier')
  assert.equal(tierById('user-native').kind, 'native', 'and so is the user `era` folder')
  assert.equal(tierById('project-compat').kind, 'compat', 'the project `.agents` folder is a compatibility tier')
  assert.equal(tierById('user-compat').kind, 'compat', 'and so is the user one')
  assert.equal(tierById('project-compat').scope, 'project', 'compat is a tier rather than a third scope')

  // The read-only rule is a property of the tier, decided here rather than carried per skill: Sam never
  // writes inside a `.agents` folder, and nothing a skill file says can change that.
  assert.equal(isReadOnlyTier('project-compat'), true, 'a compat tier is read-only')
  assert.equal(isReadOnlyTier('user-compat'), true, 'in either scope')
  assert.equal(isReadOnlyTier('project-native'), false, 'a native tier is the app’s to write')
  assert.equal(isReadOnlyTier('user-native'), false, 'in either scope')

  results.push('the four tiers, their precedence order, and the read-only compat rule are stated once')
}

function countAndFilterDerivations() {
  const summary = (id: string, tier: SkillTierId, over: Partial<SkillSummary> = {}): SkillSummary => ({
    id,
    scope: tier.startsWith('project') ? 'project' : 'user',
    tier,
    title: id,
    summary: '',
    tags: [],
    sourcePath: `/${tier}/${id}/SKILL.md`,
    ...over,
  })
  const tiers: SkillTierListing[] = [
    {
      tier: 'project-native',
      scope: 'project',
      kind: 'native',
      sourceDir: '/p/.sam/skills',
      skills: [summary('alpha', 'project-native'), summary('beta', 'project-native')],
    },
    {
      tier: 'project-compat',
      scope: 'project',
      kind: 'compat',
      sourceDir: '/p/.agents/skills',
      skills: [summary('shared', 'project-compat')],
    },
    {
      tier: 'user-native',
      scope: 'user',
      kind: 'native',
      sourceDir: '/u/era/skills',
      skills: [summary('shared', 'user-native'), summary('gamma', 'user-native')],
    },
    {
      tier: 'user-compat',
      scope: 'user',
      kind: 'compat',
      sourceDir: '/u/.agents/skills',
      skills: [],
    },
  ]

  const merged = mergeSkillTiers(tiers)
  assert.deepEqual(
    merged.map((tier) => tier.skills.map((skill) => skill.id)),
    [['alpha', 'beta'], ['shared'], ['gamma'], []],
    'an id offered by a higher tier is dropped from every tier below it, and the winner keeps its place'
  )
  assert.equal(merged.length, 4, 'every tier stays in the list, empty or not: the screen draws four sections')

  // `shared` is the collision: project-compat holds it and user-native does too, so the higher tier keeps
  // it and the user's copy is dropped — which is also why the project count is three and the user's one.
  const counts = deriveSkillCounts(merged, [])
  assert.deepEqual(
    counts,
    { total: 4, project: 3, user: 1, errors: 0 },
    'the counts are the tier list counted, not a second walk of the disk'
  )

  const withErrors = deriveSkillCounts(merged, [
    { id: 'broken', scope: 'project', tier: 'project-native', code: SKILL_MANIFEST_INVALID, message: 'x' },
    { id: 'gone', scope: 'user', tier: 'user-native', code: SKILL_NOT_FOUND, message: 'y' },
  ])
  assert.equal(withErrors.total, 4, 'a load error is not a skill and does not change the total')
  assert.equal(withErrors.errors, 2, 'it is counted on its own line')

  const skills = merged.flatMap((tier) => tier.skills)
  assert.deepEqual(
    filterSkillSummaries(skills, 'GAM').map((skill) => skill.id),
    ['gamma'],
    'a filter matches an id, case-insensitively'
  )
  assert.deepEqual(
    filterSkillSummaries(
      [summary('one', 'user-native', { title: 'Deploy Runbook', summary: 'Ship it, then watch the logs.' })],
      'watch'
    ).map((skill) => skill.id),
    ['one'],
    'and it matches the summary'
  )
  assert.deepEqual(
    filterSkillSummaries(
      [summary('one', 'user-native', { title: 'Deploy Runbook', summary: 'unrelated' })],
      'runbook'
    ).map((skill) => skill.id),
    ['one'],
    'and the title'
  )
  assert.deepEqual(filterSkillSummaries(skills, '').length, 4, 'an empty filter is the whole list')
  assert.deepEqual(filterSkillSummaries(skills, '   ').length, 4, 'and so is one that is only spaces')
  assert.deepEqual(
    filterSkillSummaries(skills, 'nothing-matches'),
    [],
    'a filter that matches nothing narrows to nothing'
  )

  results.push('counts, precedence and filter matching are derived from the tier list alone')
}

// ---------------------------------------------------------------- the disk

async function listReadsAllFourTiers() {
  const root = makeRoot()
  const userNative = join(makeRoot('sam-user-skills-'), 'era', 'skills')
  const userCompat = join(makeRoot('sam-user-agents-'), '.agents', 'skills')

  writeSkill(projectSkillsDir(root), 'native-one', ['---', 'title: Native One', '---', 'Body.'].join('\n'))
  writeSkill(projectAgentsSkillsDir(root), 'compat-one', ['---', 'title: Compat One', '---', 'Body.'].join('\n'))
  writeSkill(userNative, 'user-native-one', ['---', 'title: User Native', '---', 'Body.'].join('\n'))
  writeSkill(userCompat, 'user-compat-one', ['---', 'title: User Compat', '---', 'Body.'].join('\n'))

  const listing = await listSkills(tierPaths({ root, userNative, userCompat }))

  assert.deepEqual(
    listing.tiers.map((tier) => tier.skills.map((skill) => skill.id)),
    [['native-one'], ['compat-one'], ['user-native-one'], ['user-compat-one']],
    'each tier lists what its own folder holds, and nothing from its neighbours'
  )
  assert.deepEqual(listing.errors, [], 'a clean tree produces no load errors')
  assert.equal(tierOf(listing, 'project-compat').kind, 'compat', 'a tier listing carries the kind the card badges')
  assert.equal(
    tierOf(listing, 'project-native').sourceDir,
    projectSkillsDir(root),
    'and the directory it was scanned from, which is what an empty section points at'
  )

  const compat = tierOf(listing, 'project-compat').skills[0]
  assert.equal(
    compat.sourcePath,
    join(projectAgentsSkillsDir(root), 'compat-one', 'SKILL.md'),
    'a skill names its own file, so a card can show where it came from'
  )
  assert.equal(compat.tier, 'project-compat', 'and the tier it was read in')
  assert.equal(compat.scope, 'project', 'with the scope that tier belongs to')

  assert.deepEqual(
    listing.counts,
    { total: 4, project: 2, user: 2, errors: 0 },
    'and the listing carries the counts the settings header shows'
  )

  results.push('a listing reads all four tiers, with each skill naming its tier, scope and own file')
}

async function theHighestTierWinsACollision() {
  const root = makeRoot()
  const userNative = join(makeRoot('sam-user-skills-'), 'era', 'skills')
  const userCompat = join(makeRoot('sam-user-agents-'), '.agents', 'skills')

  writeSkill(projectSkillsDir(root), 'shared', ['---', 'title: Project Native', '---', 'Body.'].join('\n'))
  writeSkill(projectAgentsSkillsDir(root), 'shared', ['---', 'title: Project Compat', '---', 'Body.'].join('\n'))
  writeSkill(projectAgentsSkillsDir(root), 'compat-only', ['---', 'title: Compat Only', '---', 'Body.'].join('\n'))
  writeSkill(userNative, 'shared', ['---', 'title: User Native', '---', 'Body.'].join('\n'))
  writeSkill(userNative, 'user-only', ['---', 'title: User Only', '---', 'Body.'].join('\n'))
  writeSkill(userCompat, 'shared', ['---', 'title: User Compat', '---', 'Body.'].join('\n'))
  writeSkill(userCompat, 'user-compat-only', ['---', 'title: User Compat Only', '---', 'Body.'].join('\n'))

  const listing = await listSkills(tierPaths({ root, userNative, userCompat }))

  assert.equal(tierOf(listing, 'project-native').skills[0].title, 'Project Native', 'the project’s own is the winner')
  assert.deepEqual(
    listing.tiers.map((tier) => tier.skills.map((skill) => skill.id)),
    [['shared'], ['compat-only'], ['user-only'], ['user-compat-only']],
    'and the three shadowed copies are dropped rather than offered as skills of their own'
  )
  assert.equal(
    tierOf(listing, 'project-native').skills[0].tier,
    'project-native',
    'so the badge and the path a card shows are the winner’s'
  )
  assert.deepEqual(
    listing.counts,
    { total: 4, project: 2, user: 2, errors: 0 },
    'and a shadowed copy is not a skill in the counts either'
  )

  // User native over user compat, with no project open: the same rule one step down the order.
  const userOnlyListing = await listSkills(tierPaths({ root: null, userNative, userCompat }))
  assert.deepEqual(
    userOnlyListing.tiers.map((tier) => tier.skills.map((skill) => skill.id)),
    [[], [], ['shared', 'user-only'], ['user-compat-only']],
    'with no root open the user’s own folder still beats the compatibility folder'
  )
  assert.equal(tierOf(userOnlyListing, 'user-native').skills[0].title, 'User Native')

  // And the resolver agrees with the listing, because both walk the same order.
  const [resolved] = await resolveActiveSkills({
    paths: tierPaths({ root, userNative, userCompat }),
    activeSkillIds: ['shared'],
  })
  assert.equal(resolved.tier, 'project-native', 'an activated id resolves to the tier the listing showed it in')
  assert.ok(resolved.body.includes('Body.'), 'and reads that tier’s file')

  results.push('a same-id collision is resolved by tier order, in the listing and in the resolver alike')
}

async function missingDirectoriesAreEmptyAndNotErrors() {
  const root = makeRoot()
  const userNative = join(makeRoot('sam-user-skills-'), 'era', 'skills')
  const userCompat = join(makeRoot('sam-user-agents-'), '.agents', 'skills')

  const listing = await listSkills(tierPaths({ root, userNative, userCompat }))

  assert.equal(listing.tiers.length, 4, 'all four tiers are listed even when none of them exists')
  assert.deepEqual(
    listing.tiers.map((tier) => tier.skills),
    [[], [], [], []],
    'each one is empty rather than absent'
  )
  assert.deepEqual(listing.errors, [], 'a folder that is not there yet is the ordinary case, not a failure')
  assert.deepEqual(listing.counts, { total: 0, project: 0, user: 0, errors: 0 })

  // With no root open the two project tiers have no directory at all, and say so rather than inventing one.
  const withoutRoot = await listSkills(tierPaths({ root: null, userNative, userCompat }))
  assert.equal(
    tierOf(withoutRoot, 'project-native').sourceDir,
    null,
    'a project tier with no project points at nothing'
  )
  assert.equal(tierOf(withoutRoot, 'user-native').sourceDir, userNative, 'while a user tier still names its folder')

  results.push('a missing tier directory yields an empty tier rather than an error')
}

async function oneBadFileDoesNotStopItsTier() {
  const root = makeRoot()
  const userNative = join(makeRoot('sam-user-skills-'), 'era', 'skills')
  writeSkill(projectSkillsDir(root), 'good', JSON_MANIFEST)
  writeSkill(projectSkillsDir(root), 'broken-yaml', ['---', 'title: "unclosed', '---', 'Body.'].join('\n'))
  writeSkill(projectSkillsDir(root), 'nested-colon', ['---', 'summary: one: two', '---', 'Body.'].join('\n'))
  writeSkill(userNative, 'valid-sibling', ['---', 'title: Valid Sibling', '---', 'Body.'].join('\n'))

  const listing = await listSkills(tierPaths({ root, userNative }))

  assert.deepEqual(
    tierOf(listing, 'project-native').skills.map((skill) => skill.id),
    ['good'],
    'the skill that parsed is still listed beside the ones that did not'
  )
  assert.deepEqual(
    tierOf(listing, 'user-native').skills.map((skill) => skill.id),
    ['valid-sibling'],
    'and the tiers that were fine are untouched'
  )
  const byId = new Map(listing.errors.map((error) => [error.id, error]))
  assert.equal(listing.errors.length, 2, 'each malformed file is reported once')
  assert.equal(byId.get('broken-yaml')?.code, SKILL_MANIFEST_INVALID, 'a YAML file that will not parse is named as one')
  assert.equal(byId.get('broken-yaml')?.tier, 'project-native', 'and the error names the tier it was read in')
  assert.equal(byId.get('nested-colon')?.code, SKILL_MANIFEST_INVALID, 'a colon in an unquoted scalar is a parse error')
  assert.equal(listing.counts.errors, 2, 'and the counts carry them separately from the skills')
  assert.equal(listing.counts.total, 2, 'a load error is not a skill')

  results.push('a malformed YAML file is a per-file error and its valid siblings still load')
}

async function aBodyIsReadLazilyByTier() {
  const root = makeRoot()
  const userCompat = join(makeRoot('sam-user-agents-'), '.agents', 'skills')
  writeSkill(projectSkillsDir(root), 'code-review', JSON_MANIFEST)
  writeSkill(userCompat, 'agents-only', ['---', 'title: Agents Only', '---', 'Read-only, still readable.'].join('\n'))

  const paths = tierPaths({ root, userCompat })
  const body = await getSkillBody(paths, 'project-native', 'code-review')
  assert.equal(body.id, 'code-review', 'the body names the skill it belongs to')
  assert.equal(body.title, 'Code Review', 'and carries the title the list row showed')
  assert.equal(body.body, MANIFESTED_BODY, 'and the instructions, without the manifest that describes them')
  assert.equal(body.tier, 'project-native')
  assert.equal(
    body.sourcePath,
    join(projectSkillsDir(root), 'code-review', 'SKILL.md'),
    'and the file it was read from'
  )
  assert.equal('tags' in body, true, 'a body is a list row with the text added, not a shape of its own')

  // A compatibility tier is read-only, not unreadable: the expand view has to work for one.
  const compat = await getSkillBody(paths, 'user-compat', 'agents-only')
  assert.equal(compat.body, 'Read-only, still readable.')
  assert.equal(compat.tier, 'user-compat')

  await assert.rejects(
    () => getSkillBody(paths, 'project-native', 'ghost'),
    (err: unknown) => {
      assert.equal(codeOf(err), SKILL_NOT_FOUND, 'an unknown id is refused by code, so a caller can branch on it')
      assert.ok((err as Error).message.includes('ghost'), 'and the message names the id')
      return true
    }
  )
  await assert.rejects(
    () => getSkillBody(paths, 'user-native', 'ghost'),
    (err: unknown) => codeOf(err) === SKILL_NOT_FOUND,
    'in any tier'
  )
  await assert.rejects(
    () => getSkillBody(paths, 'project-native', '../../etc'),
    (err: unknown) => codeOf(err) === SKILL_NOT_FOUND,
    'and a name that could never be a skill id names no skill rather than reaching outside the folder'
  )

  results.push('a body is read one skill at a time, by tier, and an unknown id is refused by code')
}

// ---------------------------------------------------------------- the registered surface

async function theRegisteredSurfaceIsTwoQueries() {
  const listingMember = skillsModule.record['listSkills'] as unknown as {
    kind?: string
    input?: { '~standard': { validate: (value: unknown) => { value?: unknown; issues?: readonly unknown[] } } }
    resolver: (opts: { input: unknown }) => Promise<unknown>
  }
  assert.ok(listingMember?.resolver, 'listSkills must have a resolver')
  assert.equal(listingMember.kind, 'query', 'it reads the disk, and it is a query')
  assert.ok(listingMember.input, 'it declares an input schema, so a caller may name a root explicitly')
  assert.equal(
    (await listingMember.input['~standard'].validate(undefined)).issues,
    undefined,
    'and the input is optional: the renderer omits it and main answers for the open folder'
  )
  assert.equal(
    (await listingMember.input['~standard'].validate({ rootPath: 42 })).issues !== undefined,
    true,
    'while a root that is not a path is refused at the boundary'
  )

  const bodyMember = skillsModule.record['getSkillBody'] as unknown as {
    kind?: string
    resolver: (opts: { input: unknown }) => Promise<unknown>
  }
  assert.ok(bodyMember?.resolver, 'getSkillBody must have a resolver')
  assert.equal(bodyMember.kind, 'query', 'and it reads one file rather than changing anything')

  const userData = process.env.SAM_TEST_USER_DATA
  assert.ok(userData, 'the suite runs with a private userData directory')

  const root = makeRoot()
  writeSkill(projectSkillsDir(root), 'from-project', JSON_MANIFEST)
  mkdirSync(join(userData, 'conveyor-stores'), { recursive: true })
  writeFileSync(join(userData, 'conveyor-stores', 'workspace.json'), JSON.stringify({ rootPath: root }), 'utf8')
  const home = makeRoot('sam-home-')
  writeSkill(
    join(home, '.agents', 'skills'),
    'from-user-agents',
    ['---', 'title: From User Agents', '---', 'Body.'].join('\n')
  )
  assert.equal(
    userAgentsSkillsDir(home),
    join(home, '.agents', 'skills'),
    'the user compatibility folder is `.agents/skills` under the home directory, which is %USERPROFILE% on Windows'
  )
  assert.equal(
    userSkillsDir(userData),
    join(userData, 'era', 'skills'),
    'and the user native folder is still era/skills under the app data directory'
  )

  // With no input: the project tiers come from the workspace store file main already owns.
  const listing = (await listingMember.resolver({ input: undefined })) as {
    tiers: SkillTierListing[]
    counts: { total: number }
  }
  assert.deepEqual(
    listing.tiers.map((tier) => tier.skills.map((skill) => skill.id)),
    [['from-project'], [], [], []],
    'no input means the open folder’s skills, and the user folders answered emptily by the stub'
  )
  assert.equal(listing.counts.total, 1)

  // With a root: the scan goes where the caller pointed, which is what makes the settings screen able to
  // show a folder other than the one that happens to be open.
  const other = makeRoot()
  writeSkill(projectSkillsDir(other), 'elsewhere', JSON_MANIFEST)
  const pointed = (await listingMember.resolver({ input: { rootPath: other } })) as {
    tiers: SkillTierListing[]
  }
  assert.deepEqual(
    pointed.tiers[0].skills.map((skill) => skill.id),
    ['elsewhere'],
    'a named root is the root that is scanned'
  )

  // The body query is code-branched rather than message-branched, for the renderer's sake.
  await assert.rejects(
    () => bodyMember.resolver({ input: { scope: 'project', tier: 'native', skillId: 'ghost' } }),
    (err: unknown) => codeOf(err) === SKILL_NOT_FOUND,
    'an unknown id crosses the boundary as SKILL_NOT_FOUND'
  )
  const read = (await bodyMember.resolver({
    input: { scope: 'project', tier: 'native', skillId: 'from-project' },
  })) as { id: string; body: string }
  assert.equal(read.id, 'from-project', 'and a known one crosses as its body')

  results.push('listSkills and getSkillBody are registered as queries, code-branched, with an optional root')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('parser: YAML', yamlFrontmatterIsParsed)
    await step('parser: JSON', jsonManifestBlocksStillParse)
    await step('parser: one shape', bothFormatsNormalizeToTheSameShape)
    await step('parser: bad frontmatter', invalidYamlIsAPerSkillError)
    await step('tiers: declared', theTiersAreFourInPrecedenceOrder)
    await step('tiers: derivations', countAndFilterDerivations)
    await step('disk: four tiers', listReadsAllFourTiers)
    await step('disk: precedence', theHighestTierWinsACollision)
    await step('disk: missing folders', missingDirectoriesAreEmptyAndNotErrors)
    await step('disk: one bad file', oneBadFileDoesNotStopItsTier)
    await step('disk: body', aBodyIsReadLazilyByTier)
    await step('surface: registered', theRegisteredSurfaceIsTwoQueries)

    console.log(`skills tiers: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SKILLS TIERS TEST FAILED:', err)
  process.exit(1)
})
