/**
 * Verifies what this app *writes*: creating a skill, copying one into the open project, deleting one,
 * and the availability sidecar that decides which of them a conversation may draw on.
 *
 * The reading half is the other two suites' subject. This one is about the four things that change the
 * disk, and the reason it is asserted against a real tree is the same as theirs: a write is a fact about
 * a folder, so a mock would only be told what it should have done — that a created skill is a folder with
 * a `SKILL.md` whose manifest parses back, that a copy carries the assets beside it rather than only the
 * manifest, that a delete removes the folder and touches nothing in a compatibility tier.
 *
 * Two rules are load-bearing enough to be asserted here rather than only in the UI: a compatibility tier
 * is refused by *code* on every write path, because the tier is what makes a `.agents` folder somebody
 * else's; and the availability store is keyed by tier and, for a project, by the root it was switched off
 * in, because "off in this repository" is not "off everywhere".
 *
 * No electron in the body: every function under test takes the paths it reads or writes, so this builds
 * temp trees and checks them afterwards. The one exception is the prune sink, which production installs
 * from `router.ts` and this installs against a store harness — that is the connection between switching a
 * skill off and the conversations that carried it.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  copySkillIntoProject,
  createSkill,
  deleteSkill,
  disabledSkillsPath,
  listSkills,
  projectAgentsSkillsDir,
  projectSkillsDir,
  readDisabledSkills,
  resolveActiveSkills,
  setSkillAvailability,
  setSkillPruneSink,
  skillTierPathsFor,
  userSkillsDir,
} from '../../conveyor/modules/skills'
import { parseSkillText } from '../../conveyor/protocol/skill-manifest'
import {
  applySkillToggle,
  disabledRefsForRoot,
  isSkillHidden,
  MAX_ACTIVE_SKILLS,
  planTurnSkillIds,
  skillLimitReached,
  SKILL_ID_TAKEN,
  SKILL_LIMIT_EXCEEDED,
  SKILL_NOT_FOUND,
  SKILL_PARSE_INVALID,
  type DisabledSkillRef,
  type SkillTierPaths,
} from '../../conveyor/protocol/skills'
import { chatSessionsStore } from '../../conveyor/stores/chat-sessions'
import { createStoreHarness } from '../sessions/chat-sessions-store-harness'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(prefix = 'sam-skills-manage-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** The four tier directories for one open project, on temp user and home folders. */
function tierPaths(root: string | null, appData: string, home: string): SkillTierPaths {
  return skillTierPathsFor({ rootPath: root, appDataPath: appData, homePath: home })
}

/** Write one skill file under a skills directory, creating the folder. */
function writeSkill(skillsDir: string, id: string, text: string): string {
  const folder = join(skillsDir, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), text, 'utf8')
  return folder
}

/** A skill file with a manifest, as anything but this app would write one. */
function manifested(title: string): string {
  return [
    '---',
    `{"schema":"1","title":"${title}","summary":"${title} in one line.","tags":[]}`,
    '---',
    '# Body',
    '',
    `${title} guidance.`,
    '',
  ].join('\n')
}

/** One session payload through the store's own boundary schema, as the store would validate it. */
function touchSchema(): { validate: (value: unknown) => unknown } {
  const schema = chatSessionsStore.schemas?.touchSession as unknown as
    { '~standard': { validate: (value: unknown) => unknown } } | undefined
  assert.ok(schema, 'the store declares a touchSession schema')
  return schema['~standard']
}

/** Whether the privacy boundary accepted this payload. */
async function touchAccepted(payload: unknown): Promise<boolean> {
  const result = (await touchSchema().validate(payload)) as { issues?: readonly unknown[] }
  return result.issues === undefined
}

// ---------------------------------------------------------------- create

async function createWritesAManifestAndRefusesADuplicateId() {
  const root = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(root, appData, home)

  const created = await createSkill(paths, {
    tier: 'project-native',
    skillId: 'release-notes',
    title: 'Release Notes',
    summary: 'How one release is written up.',
    body: '# Release Notes\n\nWrite it up before tagging.\n',
  })

  assert.equal(created.path, join(projectSkillsDir(root), 'release-notes', 'SKILL.md'))
  const text = readFileSync(created.path, 'utf8')
  assert.ok(text.startsWith('---\n{'), 'the manifest is the Phase 40 JSON block, on its own lines')

  // Read back through the shipped parser, so what was written is asserted as what the app will read.
  const parsed = parseSkillText('release-notes', 'project', text)
  assert.ok(parsed.ok, 'the file this app wrote parses with the parser it ships')
  assert.equal(parsed.skill.title, 'Release Notes')
  assert.equal(parsed.skill.summary, 'How one release is written up.')
  assert.deepEqual(parsed.skill.tags, [], 'tags are written empty rather than omitted')
  assert.equal(parsed.skill.schema, '1')
  assert.equal(parsed.skill.body, '# Release Notes\n\nWrite it up before tagging.')

  // And the listing sees it as one skill, with no error beside it.
  const listing = await listSkills(paths)
  const row = listing.tiers.find((tier) => tier.tier === 'project-native')?.skills.find((s) => s.id === 'release-notes')
  assert.ok(row, 'the created skill is in the listing')
  assert.equal(listing.counts.errors, 0)

  await assert.rejects(
    () =>
      createSkill(paths, {
        tier: 'project-native',
        skillId: 'release-notes',
        title: 'Another',
        summary: '',
        body: 'overwritten',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConveyorError)
      assert.equal(err.code, SKILL_ID_TAKEN, 'a duplicate id in the target tier is refused by code')
      return true
    }
  )
  assert.equal(readFileSync(created.path, 'utf8'), text, 'and the refused write changed nothing')

  results.push('create writes a manifest plus body into the chosen writable tier and refuses a duplicate id by code')
}

async function createRefusesAnIdThatCannotBeAFolderName() {
  const root = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(root, appData, home)

  for (const bad of ['../escape', 'with/slash', '.hidden', '', 'x'.repeat(65)]) {
    await assert.rejects(
      () => createSkill(paths, { tier: 'user-native', skillId: bad, title: 'Bad', summary: '', body: 'body' }),
      (err: unknown) => {
        assert.ok(err instanceof ConveyorError, `${JSON.stringify(bad)} is refused rather than written`)
        assert.equal(err.code, SKILL_PARSE_INVALID, 'and refused by the slug rule, server-side')
        return true
      }
    )
  }

  assert.equal(existsSync(join(userSkillsDir(appData), 'escape')), false, 'nothing was written outside the folder')
  assert.equal(existsSync(join(userSkillsDir(appData), 'with')), false, 'and no path was built from a bad id')

  // A compatibility tier is not a place this app writes, whatever the caller asks for.
  await assert.rejects(
    () => createSkill(paths, { tier: 'project-compat', skillId: 'legit', title: 'Legit', summary: '', body: 'body' }),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_NOT_FOUND
  )
  // Nor is a project tier with no project open.
  await assert.rejects(
    () =>
      createSkill(tierPaths(null, appData, home), {
        tier: 'project-native',
        skillId: 'legit',
        title: 'L',
        summary: '',
        body: 'b',
      }),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_NOT_FOUND
  )

  results.push('create refuses a bad id by the slug rule server-side, and never writes into a compat tier')
}

// ---------------------------------------------------------------- copy

async function copyRecursesTheWholeFolderAndRefusesAnExistingProjectId() {
  const root = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(root, appData, home)

  const source = writeSkill(userSkillsDir(appData), 'deploy-runbook', manifested('Deploy Runbook'))
  mkdirSync(join(source, 'scripts'), { recursive: true })
  writeFileSync(join(source, 'scripts', 'ship.sh'), '#!/bin/sh\necho ship\n', 'utf8')
  writeFileSync(join(source, 'NOTES.md'), 'Read the runbook first.\n', 'utf8')

  // A compatibility tier is a source like any other: reading one is what this app is allowed to do there.
  const compat = writeSkill(projectAgentsSkillsDir(root), 'shared-compat', manifested('Shared Compat'))

  const copied = await copySkillIntoProject(paths, 'user-native', 'deploy-runbook')
  const destination = join(projectSkillsDir(root), 'deploy-runbook')
  assert.equal(copied.path, join(destination, 'SKILL.md'))
  assert.ok(existsSync(join(destination, 'scripts', 'ship.sh')), 'a non-SKILL.md asset is copied with the folder')
  assert.ok(existsSync(join(destination, 'NOTES.md')), 'and so is every other file beside the manifest')
  assert.ok(existsSync(join(source, 'SKILL.md')), 'the source folder is left where it was')

  await assert.rejects(
    () => copySkillIntoProject(paths, 'user-native', 'deploy-runbook'),
    (err: unknown) => {
      assert.ok(err instanceof ConveyorError)
      assert.equal(err.code, SKILL_ID_TAKEN, 'an id the project already has is refused by code')
      return true
    }
  )

  const fromCompat = await copySkillIntoProject(paths, 'project-compat', 'shared-compat')
  assert.ok(existsSync(fromCompat.path), 'a compat skill can be copied into the project')
  assert.ok(existsSync(join(compat, 'SKILL.md')), 'and the compat folder it came from is untouched')

  await assert.rejects(
    () => copySkillIntoProject(paths, 'user-native', 'ghost'),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_NOT_FOUND
  )
  // With no root open there is nowhere to copy into, which is the same answer as no destination.
  await assert.rejects(
    () => copySkillIntoProject(tierPaths(null, appData, home), 'user-native', 'deploy-runbook'),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_NOT_FOUND
  )

  results.push('copy recurses a whole folder, including its assets, and refuses an existing project id by code')
}

// ---------------------------------------------------------------- delete

async function deleteRemovesAWritableFolderAndRefusesACompatTier() {
  const root = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(root, appData, home)

  const folder = writeSkill(userSkillsDir(appData), 'throwaway', manifested('Throwaway'))
  const removed = await deleteSkill(paths, 'user-native', 'throwaway')
  assert.equal(removed.skillId, 'throwaway')
  assert.equal(existsSync(folder), false, 'the folder is gone from a writable tier')

  const compatFolder = writeSkill(projectAgentsSkillsDir(root), 'not-ours', manifested('Not Ours'))
  await assert.rejects(
    () => deleteSkill(paths, 'project-compat', 'not-ours'),
    (err: unknown) => {
      assert.ok(err instanceof ConveyorError)
      assert.equal(err.code, SKILL_NOT_FOUND, 'a compat tier is never a delete target')
      return true
    }
  )
  assert.ok(existsSync(join(compatFolder, 'SKILL.md')), 'and its file is still there')

  await assert.rejects(
    () => deleteSkill(paths, 'project-native', 'never-was'),
    (err: unknown) => err instanceof ConveyorError && err.code === SKILL_NOT_FOUND
  )

  results.push('delete removes the folder on a writable tier and raises SKILL_NOT_FOUND for compat-tier attempts')
}

// ---------------------------------------------------------------- availability

async function disablingPrunesEveryConversationAndEnablingDoesNotReAddIt() {
  const root = makeRoot()
  const userData = makeRoot('sam-userdata-')
  const harness = createStoreHarness()
  const first = 'aaaaaaaa-1111-4111-8111-111111111111'
  const second = 'bbbbbbbb-2222-4222-8222-222222222222'

  harness.run('addSession', {
    id: first,
    title: 'one',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    activeSkillIds: ['code-review', 'deploy-runbook'],
  })
  harness.run('addSession', {
    id: second,
    title: 'two',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    activeSkillIds: ['code-review'],
  })

  // The sink production installs from `router.ts`, pointed at the harness instead of the live store.
  setSkillPruneSink((skillId) => harness.run('dropSkill', { id: skillId }))

  const ref: DisabledSkillRef = { tier: 'project-native', rootPath: root, skillId: 'code-review' }
  const afterDisable = await setSkillAvailability({ userDataDir: userData, ref, disabled: true })

  assert.equal(isSkillHidden(afterDisable, 'project-native', 'code-review'), true)
  const firstRecord = harness.state().sessions.find((s) => s.id === first)
  const secondRecord = harness.state().sessions.find((s) => s.id === second)
  assert.deepEqual(firstRecord?.activeSkillIds, ['deploy-runbook'], 'every conversation that had it loses it')
  assert.deepEqual(secondRecord?.activeSkillIds, [], 'including one whose only skill it was')
  assert.equal(firstRecord?.title, 'one', 'and the rest of the record is carried through, not rebuilt')
  assert.equal(firstRecord?.createdAt, harness.state().sessions.find((s) => s.id === first)?.createdAt)

  await setSkillAvailability({ userDataDir: userData, ref, disabled: false })
  assert.deepEqual(
    harness.state().sessions.find((s) => s.id === first)?.activeSkillIds,
    ['deploy-runbook'],
    'enabling restores availability only — nothing is switched back on in a conversation'
  )

  setSkillPruneSink(() => {})
  results.push(
    'disabling prunes the id from every conversation with whole-record preservation, and enabling does not re-add it'
  )
}

async function theSidecarRoundTripsAndIsKeyedByTierAndRoot() {
  const userData = makeRoot('sam-userdata-')
  const rootA = makeRoot()
  const rootB = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(rootA, appData, home)

  const skillPath = writeSkill(projectSkillsDir(rootA), 'shared', manifested('Shared'))
  const before = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')

  await setSkillAvailability({
    userDataDir: userData,
    ref: { tier: 'project-native', rootPath: rootA, skillId: 'shared' },
    disabled: true,
  })
  await setSkillAvailability({
    userDataDir: userData,
    ref: { tier: 'project-native', rootPath: rootB, skillId: 'shared' },
    disabled: true,
  })
  await setSkillAvailability({
    userDataDir: userData,
    ref: { tier: 'user-native', rootPath: null, skillId: 'global-off' },
    disabled: true,
  })

  // Read from disk the way a later launch reads it: nothing is cached between the write and the read.
  const reloaded = await readDisabledSkills(userData)
  assert.equal(reloaded.length, 3, 'every tier and root it was keyed by is written')
  assert.ok(existsSync(disabledSkillsPath(userData)), 'the store is a sidecar file under userData')

  assert.deepEqual(
    disabledRefsForRoot(reloaded, rootA).map((ref) => `${ref.tier}:${ref.skillId}`),
    ['project-native:shared', 'user-native:global-off'],
    'the open root sees its own project entry and the user one'
  )
  assert.deepEqual(
    disabledRefsForRoot(reloaded, rootB).map((ref) => ref.skillId),
    ['shared', 'global-off'],
    'and so does the other project, which is a different entry with the same id'
  )
  assert.deepEqual(
    disabledRefsForRoot(reloaded, makeRoot()).map((ref) => ref.skillId),
    ['global-off'],
    'a third project sees only what is off for every project'
  )

  // The entries are also equal under two spellings of the same folder, which is what keeps the two
  // halves — the write and the read that filters — from disagreeing about which project this is.
  assert.deepEqual(
    disabledRefsForRoot(reloaded, rootA.replace(/\\/g, '/'))
      .map((ref) => ref.skillId)
      .sort(),
    ['global-off', 'shared']
  )

  assert.equal(readFileSync(join(skillPath, 'SKILL.md'), 'utf8'), before, 'availability is never written into SKILL.md')
  assert.equal(
    existsSync(join(projectAgentsSkillsDir(rootA), 'disabled-skills.json')),
    false,
    'and never into a compatibility folder'
  )
  const raw = JSON.parse(readFileSync(disabledSkillsPath(userData), 'utf8')) as { disabled?: unknown[] }
  assert.equal(raw.disabled?.length, 3, 'the sidecar is a JSON record rather than a bare list')

  const listing = await listSkills(paths, {
    disabled: reloaded,
    rootPath: rootA,
  })
  assert.equal(listing.counts.hidden, 1, 'the listing counts what it is hiding')
  assert.equal(listing.counts.total, 1, 'and still counts the skill itself')

  results.push('the availability sidecar round-trips and survives a reload, keyed correctly per tier and root')
}

async function disabledSkillsAreAbsentFromTheListingAndFromATurn() {
  const rootA = makeRoot()
  const rootB = makeRoot()
  const appData = makeRoot('sam-appdata-')
  const home = makeRoot('sam-home-')
  const paths = tierPaths(rootA, appData, home)

  writeSkill(projectSkillsDir(rootA), 'alpha', manifested('Alpha'))
  writeSkill(projectSkillsDir(rootA), 'beta', manifested('Beta'))
  writeSkill(userSkillsDir(appData), 'gamma', manifested('Gamma'))

  const refs: DisabledSkillRef[] = [
    { tier: 'project-native', rootPath: rootA, skillId: 'beta' },
    { tier: 'user-native', rootPath: null, skillId: 'gamma' },
  ]

  const listing = await listSkills(paths, { disabled: refs, rootPath: rootA })
  assert.deepEqual(
    listing.disabled.map((ref) => ref.skillId),
    ['beta', 'gamma'],
    'the listing carries what is off'
  )
  assert.equal(isSkillHidden(listing.disabled, 'project-native', 'beta'), true)
  assert.equal(isSkillHidden(listing.disabled, 'user-native', 'gamma'), true)
  assert.equal(isSkillHidden(listing.disabled, 'project-native', 'alpha'), false)
  assert.equal(listing.counts.hidden, 2)

  const elsewhere = await listSkills(tierPaths(rootB, appData, home), { disabled: refs, rootPath: rootB })
  assert.deepEqual(
    elsewhere.disabled.map((ref) => ref.skillId),
    ['gamma'],
    'another project sees only the user entry'
  )
  assert.equal(elsewhere.counts.hidden, 1)

  // The turn start: ids only, filtered before anything is read from disk.
  assert.deepEqual(planTurnSkillIds(['alpha', 'beta', 'gamma'], refs, rootA), ['alpha'])
  assert.deepEqual(planTurnSkillIds(['alpha', 'beta'], refs, rootB), ['alpha', 'beta'])

  const resolved = await resolveActiveSkills({
    paths,
    activeSkillIds: planTurnSkillIds(['alpha', 'beta'], refs, rootA),
  })
  assert.deepEqual(
    resolved.map((skill) => skill.id),
    ['alpha'],
    'a switched-off skill is not resolved into a turn'
  )
  assert.equal(listing.counts.errors, 0, 'and switching one off is not an error')

  results.push('disabled skills are excluded from the listing and from turn-start resolution input')
}

// ---------------------------------------------------------------- the cap

async function theActiveCapIsTen() {
  const ten = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  const id = 'cccccccc-3333-4333-8333-333333333333'

  assert.equal(MAX_ACTIVE_SKILLS, 10, 'the documented cap is ten')
  assert.equal(skillLimitReached(ten), true, 'ten is the cap')
  assert.equal(skillLimitReached(ten.slice(0, 9)), false, 'nine is not')

  const tenth = applySkillToggle(ten.slice(0, 9), 'ten', true)
  assert.ok(tenth.ok, 'the tenth skill is accepted')
  assert.deepEqual(tenth.activeSkillIds.length, 10)

  const eleventh = applySkillToggle(ten, 'eleven', true)
  assert.equal(eleventh.ok, false, 'an eleventh is refused rather than silently stored')
  assert.equal(eleventh.code, SKILL_LIMIT_EXCEEDED)
  assert.equal(eleventh.message.includes('10'), true, 'and the refusal names the cap')

  // The session write path enforces the same boundary, because the renderer's array crosses there.
  assert.equal(await touchAccepted({ id, activeSkillIds: ten }), true, 'the store accepts ten')
  assert.equal(await touchAccepted({ id, activeSkillIds: [...ten, 'eleven'] }), false, 'and refuses eleven')

  results.push(
    'the cap is ten: an eleventh activation is refused by code, and the session write enforces the same boundary'
  )
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('create', createWritesAManifestAndRefusesADuplicateId)
    await step('create: bad id', createRefusesAnIdThatCannotBeAFolderName)
    await step('copy', copyRecursesTheWholeFolderAndRefusesAnExistingProjectId)
    await step('delete', deleteRemovesAWritableFolderAndRefusesACompatTier)
    await step('availability: prune', disablingPrunesEveryConversationAndEnablingDoesNotReAddIt)
    await step('availability: sidecar', theSidecarRoundTripsAndIsKeyedByTierAndRoot)
    await step('availability: listing and turn', disabledSkillsAreAbsentFromTheListingAndFromATurn)
    await step('cap', theActiveCapIsTen)

    console.log(`skills manage: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SKILLS MANAGE TEST FAILED:', err)
  process.exit(1)
})
