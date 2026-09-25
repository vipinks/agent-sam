/**
 * Skills discovery and resolution, on the disk.
 *
 * The rules live in `conveyor/protocol/skills.ts` and the parser in
 * `conveyor/protocol/skill-manifest.ts`; this file is the part that touches the filesystem — scanning
 * four folders, reading one `SKILL.md`, and deciding what a skill id resolves to. The tier paths are
 * passed in rather than reached for, so the node suites can exercise the real decisions against a seeded
 * temp tree instead of a reimplementation that could pass while the shipped code disagrees. The module
 * record at the bottom is a thin wrapper over them, and the only thing that consults electron.
 *
 * Four tiers, in the order that decides a collision. A project skill is `<root>/.sam/skills/<id>/SKILL.md`
 * and travels with the repository; the project's compatibility folder is `<root>/.agents/skills`, which
 * is some other agent tool's folder that this app reads; a user skill is `%APPDATA%\era\skills\<id>` and
 * is available everywhere; and the user's compatibility folder is `~/.agents/skills`, which on Windows is
 * `%USERPROFILE%\.agents\skills`. The folder name *is* the id, so nothing inside the file can rename it
 * or point it elsewhere, and only a name that survives `isSafeSkillId` is ever joined to a path.
 *
 * The two compatibility tiers are read-only, and that is enforced by the tier a scan is walking rather
 * than by a flag on a skill: nothing in this module takes a write path, and a later turn that grows one
 * asks `isReadOnlyTier` before it does. The reason is ownership — a `.agents` folder belongs to whatever
 * else the user runs, and a skill written there is theirs to edit in whichever tool wrote it.
 *
 * A missing skills directory is not an error. Most workspaces have none, and the ordinary answer — no
 * skills — is what an empty list already says; reporting a failure for it would put a red mark on a
 * screen whose whole content is "nothing here yet". A skill *file* that cannot be read or parsed is the
 * opposite case: it is a fact about one folder, so it is reported as a per-file load error, with the
 * tier it was found in, and the rest of the list is still returned.
 *
 * It imports electron for `app.getPath`, like `mentions.ts` does. The suites still run outside Electron
 * because `tests/stubs/register.cjs` redirects the import, and nothing in the scanning itself consults it.
 */
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query } from '../init'
import { MAX_FILE_BYTES } from './workspace'
import { workspaceRootFromStoreFile } from './terminal'
import { orderDirectoryEntries } from '../protocol/mentions'
import { parseSkillText } from '../protocol/skill-manifest'
import {
  deriveSkillCounts,
  isSafeSkillId,
  isSkillTierId,
  MAX_SKILL_BODY_CHARS,
  mergeSkillTiers,
  skillBodyOverCap,
  SKILL_IO_ERROR,
  SKILL_NOT_FOUND,
  SKILL_PARSE_INVALID,
  SKILL_TIERS,
  SKILL_TOO_LARGE,
  tierById,
  tierIdFor,
  type ResolvedSkill,
  type SkillBody,
  type SkillErrorCode,
  type SkillListing,
  type SkillLoadError,
  type SkillScope,
  type SkillSummary,
  type SkillTierId,
  type SkillTierKind,
  type SkillTierPaths,
} from '../protocol/skills'

/** The file every skill folder must hold. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** The folder inside a workspace that holds its project skills. */
export const PROJECT_SKILLS_FOLDER = '.sam'

/** The compatibility folder inside a workspace, which belongs to whatever else the user runs. */
export const AGENTS_SKILLS_FOLDER = '.agents'

/** The folder under `%APPDATA%` that holds the user's own skills, across every project. */
export const USER_SKILLS_FOLDER = 'era'

/** Where a project's skills live: `<root>/.sam/skills`. */
export function projectSkillsDir(rootPath: string): string {
  return join(rootPath, PROJECT_SKILLS_FOLDER, 'skills')
}

/** Where a project's compatibility skills live: `<root>/.agents/skills`. */
export function projectAgentsSkillsDir(rootPath: string): string {
  return join(rootPath, AGENTS_SKILLS_FOLDER, 'skills')
}

/** Where the user's own skills live: `%APPDATA%\era\skills`. */
export function userSkillsDir(appDataPath: string): string {
  return join(appDataPath, USER_SKILLS_FOLDER, 'skills')
}

/**
 * Where the user's compatibility skills live: `~/.agents/skills`.
 *
 * Taken from the home directory rather than from app data, because the folder is not this app's: it is
 * the conventional per-user location the other tools use, and `app.getPath('home')` is the only way to
 * name it on all three platforms rather than guessing at `USERPROFILE` or `$HOME`.
 */
export function userAgentsSkillsDir(homePath: string): string {
  return join(homePath, AGENTS_SKILLS_FOLDER, 'skills')
}

/**
 * The four tier directories, from the things that name them.
 *
 * A project tier is `null` when there is no folder open: not an empty string, because "there is no
 * project" and "the project's folder happens to be the current directory" are different facts, and the
 * listing reports the first as a tier with no directory rather than as one that was scanned and held
 * nothing. The user tiers are always somewhere, whether or not they exist yet.
 */
export function skillTierPathsFor(input: {
  rootPath: string | null
  appDataPath: string
  homePath: string
}): SkillTierPaths {
  return {
    projectNative: input.rootPath === null ? null : projectSkillsDir(input.rootPath),
    projectCompat: input.rootPath === null ? null : projectAgentsSkillsDir(input.rootPath),
    userNative: userSkillsDir(input.appDataPath),
    userCompat: userAgentsSkillsDir(input.homePath),
  }
}

/**
 * The file one skill id names, inside a tier's own directory.
 *
 * The id is joined as a single segment, which is what `isSafeSkillId` has already guaranteed by the
 * time this is called: no separator, no leading dot, and no `..`. Containment is therefore a property
 * of the id rule rather than of a resolve, and a caller cannot be handed a path outside the folder it
 * named.
 */
export function skillFilePath(skillsDir: string, id: string): string {
  return join(skillsDir, id, SKILL_FILE_NAME)
}

/** The `code` of a thrown node filesystem error, or `UNKNOWN` for anything else. */
function nodeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code)
  return 'UNKNOWN'
}

/** The two codes that mean "there is nothing at this path", as opposed to "this path could not be used". */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** One skill file, as the disk answered. */
type SkillFileRead = { ok: true; text: string } | { ok: false; code: SkillErrorCode; message: string }

/**
 * Read one skill file, sized before it is loaded.
 *
 * `SKILL_NOT_FOUND` and `SKILL_IO_ERROR` are kept apart because resolution treats them differently: the
 * first means this tier does not have the skill and the next one may, while the second means the skill
 * is *there* and unusable — falling through on that would quietly run a different skill than the one the
 * project provides. The size check is the same byte cap every other read in this app obeys, and it is
 * checked before the read rather than after it, so an oversized file is refused rather than loaded and
 * then discarded.
 */
async function readSkillFile(path: string): Promise<SkillFileRead> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (MISSING_CODES.has(nodeErrorCode(error))) {
      return { ok: false, code: SKILL_NOT_FOUND, message: `No ${SKILL_FILE_NAME} here.` }
    }
    return {
      ok: false,
      code: SKILL_IO_ERROR,
      message: `This skill file could not be reached (${nodeErrorCode(error)}).`,
    }
  }

  if (size > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: SKILL_TOO_LARGE,
      message: `This skill file is larger than the ${MAX_FILE_BYTES} byte read cap.`,
    }
  }

  try {
    return { ok: true, text: await readFile(path, 'utf8') }
  } catch (error) {
    return { ok: false, code: SKILL_IO_ERROR, message: `This skill file could not be read (${nodeErrorCode(error)}).` }
  }
}

/** The directory one tier is read from in a given set of paths, or `null` for a project tier with no project. */
function tierDir(paths: SkillTierPaths, tier: SkillTierId): string | null {
  switch (tier) {
    case 'project-native':
      return paths.projectNative
    case 'project-compat':
      return paths.projectCompat
    case 'user-native':
      return paths.userNative
    case 'user-compat':
      return paths.userCompat
  }
}

/** One tier's directory as it was scanned, before precedence is applied. */
interface SkillTierScan {
  skills: SkillSummary[]
  errors: SkillLoadError[]
}

/**
 * Scan one tier's directory.
 *
 * The folder name is the id, so a name this app cannot address as an id is reported and skipped rather
 * than read: joining `../..` would leave the directory, and a skill that could never be activated is not
 * one a screen should offer as if it could. Everything else is read in the directory's own deterministic
 * order, so the listing and its errors are the same from run to run.
 *
 * Sequential rather than concurrent, deliberately: this runs once on a screen's open over a handful of
 * files, and a `Promise.all` would make which error is reported first depend on which read settled first.
 *
 * The tier is stamped onto every row and every error here, because this is the only layer that knows it:
 * the parser was handed text, and a folder name is not a folder.
 */
async function scanSkillTier(skillsDir: string | null, tier: SkillTierId, scope: SkillScope): Promise<SkillTierScan> {
  if (skillsDir === null) return { skills: [], errors: [] }

  let names: string[]
  try {
    names = await readdir(skillsDir)
  } catch {
    // Absent, or unreadable. Both mean there is nothing to offer here, which a screen shows as an empty
    // tier — the same rule the mention walk follows for a directory it cannot open.
    return { skills: [], errors: [] }
  }

  const skills: SkillTierScan['skills'] = []
  const errors: SkillLoadError[] = []

  for (const name of orderDirectoryEntries(names)) {
    if (!isSafeSkillId(name)) {
      errors.push({
        id: name,
        scope,
        tier,
        code: SKILL_PARSE_INVALID,
        message: 'This folder name is not a usable skill id, so its file was not read.',
      })
      continue
    }

    const read = await readSkillFile(skillFilePath(skillsDir, name))
    if (!read.ok) {
      errors.push({ id: name, scope, tier, code: read.code, message: read.message })
      continue
    }

    const parsed = parseSkillText(name, scope, read.text)
    if (!parsed.ok) {
      errors.push({ id: parsed.id, scope: parsed.scope, tier, code: parsed.code, message: parsed.message })
      continue
    }

    // The body is deliberately not carried: a listing is the set of skills a screen draws cards for, and
    // shipping every body over IPC to draw a title and a summary would be the whole library on the wire
    // on every open. `getSkillBody` reads the one file a card was expanded on.
    skills.push({
      id: parsed.skill.id,
      scope,
      tier,
      title: parsed.skill.title,
      summary: parsed.skill.summary,
      tags: parsed.skill.tags,
      sourcePath: skillFilePath(skillsDir, name),
    })
  }

  return { skills, errors }
}

/**
 * Every skill the user could activate, across all four tiers.
 *
 * A missing root is neither an error nor an empty answer: with no folder open there are no project
 * skills, and the user's own are still theirs. Precedence is applied here, through `mergeSkillTiers`, so
 * the rows a screen offers are the ids a turn would actually resolve — and a shadowed copy is dropped
 * rather than shown twice under two different badges.
 *
 * The errors come back in tier order, so the reported order is the order the screen draws the tiers in
 * rather than whichever scan happened to finish first.
 */
export async function listSkills(paths: SkillTierPaths): Promise<SkillListing> {
  // Sequential, in `SKILL_TIERS` order, so the error list is ordered by the folders as drawn rather than
  // by whichever scan settled first. There are four of them and this runs once on a screen's open.
  const scans = new Map<SkillTierId, SkillTierScan>()
  for (const tier of SKILL_TIERS) {
    scans.set(tier.id, await scanSkillTier(tierDir(paths, tier.id), tier.id, tier.scope))
  }

  const merged = mergeSkillTiers(
    SKILL_TIERS.map((tier) => ({
      tier: tier.id,
      scope: tier.scope,
      kind: tier.kind,
      sourceDir: tierDir(paths, tier.id),
      skills: scans.get(tier.id)?.skills ?? [],
    }))
  )
  const errors = SKILL_TIERS.flatMap((tier) => scans.get(tier.id)?.errors ?? [])

  return { tiers: merged, errors, counts: deriveSkillCounts(merged, errors) }
}

/** What a turn start hands the resolver: the four folders, and the ids the session carries. */
export interface SkillResolutionInput {
  paths: SkillTierPaths
  activeSkillIds: readonly string[]
}

/**
 * The skills a turn is to be sent with, in full, or a failure naming what could not be used.
 *
 * This is the turn-start half, and it is deliberately the opposite of the listing above in one respect:
 * a listing reports what it could not read and carries on, while a turn *fails* rather than proceed.
 * The difference is what the user asked for. A screen with one broken folder in it is still a screen; a
 * turn whose user turned a skill on and quietly did not get it has been misled about what the model was
 * told, and a skill that half-arrived is worse than one that refused to.
 *
 * So: thrown `ConveyorError`s with the code as the meaning. A missing skill is `SKILL_NOT_FOUND`, a body
 * past the character cap is `SKILL_TOO_LARGE`, a file that will not read or parse is that file's own
 * code — and in every case nothing is sent and nothing is silently dropped.
 *
 * Precedence is decided by *presence*, not by which tier happened to work. If a tier has the id and its
 * file cannot be read, the turn fails: falling through to a lower tier of the same id would run
 * something other than the skill the higher tier provides, which is exactly the substitution the
 * precedence rule exists to prevent. Only a tier that does not have the id at all passes the read on.
 */
export async function resolveActiveSkills(input: SkillResolutionInput): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = []

  for (const id of input.activeSkillIds) {
    if (!isSafeSkillId(id)) {
      throw new ConveyorError(SKILL_PARSE_INVALID, `"${id}" is not a usable skill id, so it was not sent.`)
    }

    const found = await readFromHighestTier(input.paths, id)
    if (!found.ok) throw new ConveyorError(found.code, `The active skill "${id}" could not be used: ${found.message}`)

    const parsed = parseSkillText(id, found.scope, found.text)
    if (!parsed.ok) {
      throw new ConveyorError(parsed.code, `The active skill "${id}" could not be read: ${parsed.message}`)
    }

    // The cap is on the body rather than the file: it is a budget on what is sent, and the body is what
    // is sent. Refused, never truncated — a half-sent skill would have the model following a partial
    // procedure and reporting on it as if it were the whole one.
    if (skillBodyOverCap(parsed.skill.body)) {
      throw new ConveyorError(
        SKILL_TOO_LARGE,
        `The active skill "${id}" is ${parsed.skill.body.length} characters, over the ${MAX_SKILL_BODY_CHARS} character limit.`
      )
    }

    resolved.push({
      id,
      scope: parsed.skill.scope,
      tier: found.tier,
      title: parsed.skill.title,
      body: parsed.skill.body,
    })
  }

  return resolved
}

/** One skill file as found by tier order: its text, its scope, and the tier it came from. */
type TierRead =
  | { ok: true; text: string; scope: SkillScope; tier: SkillTierId }
  | { ok: false; code: SkillErrorCode; message: string }

/**
 * The highest tier that has this id, read.
 *
 * Shared by the resolver and the body read, because "which folder answers for this id" has to have one
 * answer: a settings screen that showed a skill from the user's folder while a turn resolved the
 * project's copy of the same id would be showing the user a card for a skill they are not running.
 *
 * A tier with no directory is skipped rather than read: with no project open there is no `.sam/skills` to
 * look in, and `readSkillFile` on `join('')` would be a path into the current directory.
 */
async function readFromHighestTier(paths: SkillTierPaths, id: string): Promise<TierRead> {
  for (const tier of SKILL_TIERS) {
    const skillsDir = tierDir(paths, tier.id)
    if (skillsDir === null) continue

    const read = await readSkillFile(skillFilePath(skillsDir, id))
    if (read.ok) return { ok: true, text: read.text, scope: tier.scope, tier: tier.id }
    // There is a skill here and it cannot be used. Said now rather than tried in a lower tier.
    if (read.code !== SKILL_NOT_FOUND) return read
  }

  return {
    ok: false,
    code: SKILL_NOT_FOUND,
    message: `No skill "${id}" here.`,
  }
}

/**
 * One skill's body, read on its own.
 *
 * The listing is metadata-only on purpose, so this is the read a card asks for when it is expanded:
 * one file, named by the tier it is in and the id the listing showed. Both are required rather than
 * searched for, because the listing already answered where the skill was and re-deriving it here would
 * make an expanded card able to disagree with the card it was expanded from.
 *
 * A tier that no folder answers to is `SKILL_NOT_FOUND` rather than an internal error: the caller named
 * a skill in a place there is no such skill, which is the same thing to recover from — redraw what the
 * listing says — as an id that is simply gone, and it is reachable because a resolver is callable
 * without the boundary's own validation in front of it. A file that is there but unreadable or malformed
 * is that file's own code, passed through, because that one is worth saying differently.
 */
export async function getSkillBody(paths: SkillTierPaths, tier: SkillTierId, id: string): Promise<SkillBody> {
  const skillsDir = isSkillTierId(tier) ? tierDir(paths, tier) : null
  if (skillsDir === null || !isSafeSkillId(id)) {
    throw new ConveyorError(SKILL_NOT_FOUND, `There is no skill "${id}" in that folder.`)
  }

  const read = await readSkillFile(skillFilePath(skillsDir, id))
  // Named rather than passed through: `readSkillFile`'s own not-found sentence describes a file, and a
  // caller that asked for a skill needs the id it asked about. The other codes are that file's own and
  // are passed through as they are, because those already say which file was reached.
  if (!read.ok) {
    if (read.code === SKILL_NOT_FOUND) {
      throw new ConveyorError(SKILL_NOT_FOUND, `There is no skill "${id}" in ${tierById(tier).label}.`)
    }
    throw new ConveyorError(read.code, read.message)
  }

  const parsed = parseSkillText(id, tierById(tier).scope, read.text)
  if (!parsed.ok) throw new ConveyorError(parsed.code, parsed.message)

  return {
    id: parsed.skill.id,
    scope: parsed.skill.scope,
    tier,
    title: parsed.skill.title,
    summary: parsed.skill.summary,
    tags: parsed.skill.tags,
    sourcePath: skillFilePath(skillsDir, id),
    body: parsed.skill.body,
  }
}

/** The input `getSkillBody` takes across the boundary, and the tier pair it names. */
const skillBodyInputSchema = z.object({
  rootPath: z.string().min(1).nullable().optional(),
  scope: z.enum(['project', 'user']),
  tier: z.enum(['native', 'compat']),
  skillId: z.string().min(1),
})

/** The paths the two queries read from: the open folder unless the caller named one, and the user's own. */
function pathsFor(rootPath: string | null): SkillTierPaths {
  return skillTierPathsFor({
    rootPath,
    // `%APPDATA%\era\skills`: the requirement's own path, read from `appData` rather than from this app's
    // `userData`, so the folder is the user's across every build and every reinstall.
    appDataPath: app.getPath('appData'),
    homePath: app.getPath('home'),
  })
}

/**
 * The skills surface, as main offers it.
 *
 * Two queries and nothing that writes: this turn is read-only, and the folder list a scan reads is passed
 * in rather than reached for by the renderer. `listSkills` takes an optional root so the settings screen
 * can name the folder it is showing — omitted, it answers for the folder that is open, which is the same
 * workspace store file main already owns for `mentions.listFilesFlat`.
 */
export const skillsModule = defineModule({
  /** Every tier, every skill, its metadata, and the counts a header shows. */
  listSkills: query(z.object({ rootPath: z.string().min(1).optional() }).optional(), async ({ input }) => {
    const rootPath = input?.rootPath ?? workspaceRootFromStoreFile(app.getPath('userData'))
    return listSkills(pathsFor(rootPath))
  }),

  /** One skill's body, for the card that was expanded. */
  getSkillBody: query(skillBodyInputSchema, async ({ input }) => {
    const rootPath = input.rootPath !== undefined ? input.rootPath : workspaceRootFromStoreFile(app.getPath('userData'))
    // Composed here rather than carried as an id, because the two halves are what the caller knows: a
    // scope and a kind are the two things a card shows a badge for. A pair no tier answers to is
    // refused by `getSkillBody` itself, which is the one place that decides what an unknown tier means.
    const tier: SkillTierKind = input.tier
    return getSkillBody(pathsFor(rootPath), tierIdFor(input.scope, tier), input.skillId)
  }),
})
