/**
 * Verifies the skills discovery and resolution rules against a real seeded tree.
 *
 * Three properties are why this is asserted against the disk rather than a mock: that a project skill
 * and a user skill of the same id resolve to the project one, that a missing skills directory is an
 * ordinary empty result rather than a failure, and that one unreadable or malformed skill file leaves
 * the rest of the list intact. A mock would have to be told all three, which is the same as not
 * testing them.
 *
 * The resolution failures are the other half: an active skill that is gone and an active skill whose
 * body is over the character cap both have to fail the turn by name rather than quietly dropping out
 * of the prompt. The codes are asserted, not the wording, because the renderer branches on the code.
 *
 * No electron in the body: every function here takes the paths it reads, so this writes into temp
 * directories and reads them back. The last step exercises the registered query, which does read
 * electron — the stub points that at the suite's private userData directory.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  listSkills,
  projectSkillsDir,
  resolveActiveSkills,
  skillsModule,
  userSkillsDir,
} from '../../conveyor/modules/skills'
import {
  MAX_SKILL_BODY_CHARS,
  SKILL_MANIFEST_INVALID,
  SKILL_NOT_FOUND,
  SKILL_PARSE_INVALID,
  SKILL_TOO_LARGE,
} from '../../conveyor/protocol/skills'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(prefix = 'sam-skills-'): string {
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

/** A skill file with a manifest, named so a listing's title cannot be confused with its id. */
function manifested(title: string): string {
  return [
    '---',
    `{"schema":"1","title":"${title}","summary":"${title} in one line.","tags":["one"]}`,
    '---',
    '# Body',
    '',
    `${title} guidance.`,
    '',
  ].join('\n')
}

/** A user skills directory that exists but holds only what the caller puts in it. */
function makeUserDir(): string {
  const dir = join(makeRoot('sam-user-skills-'), 'era', 'skills')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- listing

async function aListingReadsBothScopes() {
  const root = makeRoot()
  writeSkill(projectSkillsDir(root), 'alpha', manifested('Alpha Skill'))
  writeSkill(projectSkillsDir(root), 'beta', '# Beta\n\nThe beta line.\n')
  const userDir = makeUserDir()
  writeSkill(userDir, 'gamma', manifested('Gamma Skill'))

  const listing = await listSkills(root, userDir)

  assert.deepEqual(
    listing.project.map((s) => s.id),
    ['alpha', 'beta'],
    'project skills are listed by folder name, in a stable order'
  )
  assert.deepEqual(
    listing.user.map((s) => s.id),
    ['gamma'],
    'and user skills come from the user skills directory'
  )
  assert.deepEqual(listing.errors, [], 'a clean tree produces no load errors')

  const alpha = listing.project[0]
  assert.equal(alpha.title, 'Alpha Skill', 'a manifest title is shown as written')
  assert.equal(alpha.summary, 'Alpha Skill in one line.')
  assert.equal(alpha.scope, 'project')
  const beta = listing.project[1]
  assert.equal(beta.title, 'Beta', 'and a skill with no manifest is titled from its id')
  assert.equal(beta.summary, 'Beta', 'with the first non-empty body line as its summary')

  results.push('listing reads the project and user skills directories, by folder name and scope')
}

async function aProjectSkillWinsOverAUserSkillOfTheSameId() {
  const root = makeRoot()
  writeSkill(projectSkillsDir(root), 'shared', manifested('Project Shared'))
  const userDir = makeUserDir()
  writeSkill(userDir, 'shared', manifested('User Shared'))
  writeSkill(userDir, 'only-user', manifested('Only User'))

  const listing = await listSkills(root, userDir)

  const shared = listing.project.filter((s) => s.id === 'shared')
  assert.equal(shared.length, 1, 'the project skill is listed once')
  assert.equal(shared[0].title, 'Project Shared')
  assert.ok(
    !listing.user.some((s) => s.id === 'shared'),
    'and the shadowed user skill is not offered as a second, different skill of the same id'
  )
  assert.ok(
    listing.user.some((s) => s.id === 'only-user'),
    'while a user skill nothing shadows is still listed'
  )

  // The same precedence decides what an activation actually reads.
  const [resolved] = await resolveActiveSkills({ rootPath: root, userDir, activeSkillIds: ['shared'] })
  assert.equal(resolved.scope, 'project', 'an activated id resolves to the project folder when both exist')
  assert.equal(resolved.title, 'Project Shared')
  assert.ok(resolved.body.includes('Project Shared guidance.'), 'and the body it carries is that file’s')

  // And with no folder open the user copy is what is left.
  const [userOnly] = await resolveActiveSkills({ rootPath: null, userDir, activeSkillIds: ['shared'] })
  assert.equal(userOnly.scope, 'user', 'with no root open the user skill of that id is the one that resolves')

  results.push('a project skill of an id overrides the user skill of the same id, and is what resolves')
}

async function aMissingSkillsDirectoryIsNotAnError() {
  const root = makeRoot()
  const userDir = join(makeRoot('sam-absent-user-'), 'era', 'skills')

  const listing = await listSkills(root, userDir)
  assert.deepEqual(listing.project, [], 'a project with no .sam/skills lists nothing')
  assert.deepEqual(listing.user, [], 'and so does a user directory that does not exist')
  assert.deepEqual(listing.errors, [], 'neither is a failure: no folder yet is the ordinary case')

  // No root at all is the other shape of the same rule: whatever the user folder holds is the answer.
  const seeded = makeUserDir()
  writeSkill(seeded, 'standalone', manifested('Standalone'))
  const withoutRoot = await listSkills(null, seeded)
  assert.deepEqual(withoutRoot.project, [], 'with no root open there are no project skills')
  assert.deepEqual(
    withoutRoot.user.map((s) => s.id),
    ['standalone'],
    'and the user skills are still available'
  )
  assert.deepEqual(withoutRoot.errors, [])

  // And nothing to activate is an empty resolution rather than a failure.
  assert.deepEqual(await resolveActiveSkills({ rootPath: null, userDir: seeded, activeSkillIds: [] }), [])

  results.push('a missing skill directory lists nothing and is not an error, and no root means user skills only')
}

async function oneBadFileDoesNotFailTheList() {
  const root = makeRoot()
  writeSkill(projectSkillsDir(root), 'good', manifested('Good Skill'))
  writeSkill(projectSkillsDir(root), 'broken-manifest', '---\n{"title": }\n---\nBody\n')
  mkdirSync(join(projectSkillsDir(root), 'no-file'), { recursive: true })
  mkdirSync(join(projectSkillsDir(root), 'not a skill id'), { recursive: true })
  writeFileSync(join(projectSkillsDir(root), 'not a skill id', 'SKILL.md'), manifested('Unreachable'), 'utf8')

  const listing = await listSkills(root, makeUserDir())

  assert.deepEqual(
    listing.project.map((s) => s.id),
    ['good'],
    'the readable skill is still listed when its neighbours are not readable'
  )
  const byId = new Map(listing.errors.map((e) => [e.id, e]))
  assert.equal(listing.errors.length, 3, 'every failure is reported, one entry per file')
  assert.equal(byId.get('broken-manifest')?.code, SKILL_MANIFEST_INVALID, 'a malformed manifest is named as one')
  assert.equal(byId.get('broken-manifest')?.scope, 'project')
  assert.ok(byId.get('broken-manifest')?.message.length, 'and carries a message rather than a bare code')
  assert.equal(byId.get('no-file')?.code, SKILL_NOT_FOUND, 'a folder with no SKILL.md says so')
  assert.equal(
    byId.get('not a skill id')?.code,
    SKILL_PARSE_INVALID,
    'and a folder name that cannot be a skill id is refused rather than read'
  )

  results.push('a malformed or unreadable skill file is a per-file load error, and the list survives it')
}

// ---------------------------------------------------------------- resolution

async function anActiveSkillThatIsGoneFailsTheTurnByCode() {
  const root = makeRoot()
  const userDir = makeUserDir()
  writeSkill(projectSkillsDir(root), 'present', manifested('Present'))

  await assert.rejects(
    () => resolveActiveSkills({ rootPath: root, userDir, activeSkillIds: ['present', 'ghost'] }),
    (err: unknown) => {
      assert.ok(err instanceof ConveyorError, 'a missing active skill is a ConveyorError')
      assert.equal(err.code, SKILL_NOT_FOUND, 'named by code, so the renderer can branch on it')
      assert.ok((err as Error).message.includes('ghost'), 'and the message names the id that could not be found')
      return true
    }
  )

  // A name that could not be a skill id never becomes a path segment, and is refused by its own code:
  // the meaning is "this could not name a skill at all", which is a different failure from a skill that
  // exists and is not there.
  await assert.rejects(
    () => resolveActiveSkills({ rootPath: root, userDir, activeSkillIds: ['../../etc'] }),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_PARSE_INVALID
  )

  results.push('an active skill that cannot be found fails the turn with SKILL_NOT_FOUND')
}

async function anOversizedBodyFailsTheTurnByCode() {
  const root = makeRoot()
  const userDir = makeUserDir()
  const atCap = writeSkill(projectSkillsDir(root), 'at-cap', 'x'.repeat(MAX_SKILL_BODY_CHARS))
  writeSkill(projectSkillsDir(root), 'over-cap', 'x'.repeat(MAX_SKILL_BODY_CHARS + 1))

  const [ok] = await resolveActiveSkills({ rootPath: root, userDir, activeSkillIds: ['at-cap'] })
  assert.equal(ok.body.length, MAX_SKILL_BODY_CHARS, 'a body exactly at the cap is carried whole')
  assert.ok(atCap.endsWith('at-cap'), 'and the fixture is the file the assertion is about')

  await assert.rejects(
    () => resolveActiveSkills({ rootPath: root, userDir, activeSkillIds: ['over-cap'] }),
    (err: unknown) => {
      assert.ok(err instanceof ConveyorError)
      assert.equal(err.code, SKILL_TOO_LARGE, 'a body over the cap is refused, not truncated')
      assert.ok((err as Error).message.includes('over-cap'), 'and the message names the skill')
      return true
    }
  )

  results.push('an active skill body over 32,000 characters fails the turn with SKILL_TOO_LARGE')
}

async function resolutionKeepsTheActivatedOrderAndScope() {
  const root = makeRoot()
  const userDir = makeUserDir()
  writeSkill(projectSkillsDir(root), 'project-one', manifested('Project One'))
  writeSkill(userDir, 'user-one', manifested('User One'))

  const resolved = await resolveActiveSkills({
    rootPath: root,
    userDir,
    activeSkillIds: ['user-one', 'project-one'],
  })

  assert.deepEqual(
    resolved.map((s) => `${s.scope}:${s.id}`),
    ['user:user-one', 'project:project-one'],
    'resolution reports each skill with the scope it was read from, in the order it was asked for'
  )
  assert.ok(resolved[0].body.includes('User One guidance.'))
  assert.ok(resolved[1].body.includes('Project One guidance.'))

  results.push('resolution reports each active skill with its scope, and nothing is silently dropped')
}

// ---------------------------------------------------------------- the registered query

async function theRegisteredQueryListsTheOpenWorkspace() {
  const member = skillsModule.record['list'] as unknown as {
    kind?: string
    resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown>
  }
  assert.ok(member?.resolver, 'list must have a resolver')
  assert.equal(member.kind, 'query', 'and must be a query: it reads the disk and takes no input')
  assert.equal(
    (member as { input?: unknown }).input,
    undefined,
    'the walk takes no input, so it cannot be pointed anywhere the renderer chooses'
  )

  const userData = process.env.SAM_TEST_USER_DATA
  assert.ok(userData, 'the suite runs with a private userData directory')

  // The project side comes from the workspace store file the module reads, and the user side from
  // `app.getPath('appData')`, which the shared electron stub points at the same private directory.
  const root = makeRoot()
  writeSkill(projectSkillsDir(root), 'from-project', manifested('From Project'))
  mkdirSync(join(userData, 'conveyor-stores'), { recursive: true })
  writeFileSync(join(userData, 'conveyor-stores', 'workspace.json'), JSON.stringify({ rootPath: root }), 'utf8')
  const appData = makeRoot('sam-appdata-')
  writeSkill(join(appData, 'era', 'skills'), 'from-user', manifested('From User'))
  assert.equal(
    userSkillsDir(appData),
    join(appData, 'era', 'skills'),
    'the user skills directory is era/skills under the app data directory'
  )

  const listing = (await member.resolver({ input: undefined })) as {
    project: Array<{ id: string }>
    user: Array<{ id: string }>
  }
  assert.ok(Array.isArray(listing.project), 'the query resolves to a listing')
  assert.deepEqual(
    listing.project.map((s) => s.id),
    ['from-project'],
    'and the project list is the open workspace’s skills'
  )

  results.push('skills.list is registered as an inputless query over the open workspace and the user folder')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('list: both scopes', aListingReadsBothScopes)
    await step('list: precedence', aProjectSkillWinsOverAUserSkillOfTheSameId)
    await step('list: no directory', aMissingSkillsDirectoryIsNotAnError)
    await step('list: bad file', oneBadFileDoesNotFailTheList)
    await step('resolve: missing', anActiveSkillThatIsGoneFailsTheTurnByCode)
    await step('resolve: too large', anOversizedBodyFailsTheTurnByCode)
    await step('resolve: scopes', resolutionKeepsTheActivatedOrderAndScope)
    await step('query: wired', theRegisteredQueryListsTheOpenWorkspace)

    console.log(`skills files: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SKILLS FILES TEST FAILED:', err)
  process.exit(1)
})
