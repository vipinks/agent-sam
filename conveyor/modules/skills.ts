/**
 * Skills discovery and resolution, on the disk.
 *
 * The rules live in `conveyor/protocol/skills.ts`; this file is the part that touches the filesystem —
 * scanning two folders, reading one `SKILL.md`, and deciding what a skill id resolves to. Both folders
 * are passed in rather than reached for, so the node suites can exercise the real decisions against a
 * seeded temp tree instead of a reimplementation that could pass while the shipped code disagrees. The
 * module member at the bottom is a thin wrapper over them.
 *
 * Two scopes, and one precedence rule between them. A project skill is `<root>/.sam/skills/<id>/SKILL.md`
 * and travels with the repository; a user skill is `%APPDATA%\era\skills\<id>/SKILL.md` and is available
 * everywhere. The folder name *is* the id, so nothing inside the file can rename it or point it
 * elsewhere, and only a name that survives `isSafeSkillId` is ever joined to a path.
 *
 * A missing skills directory is not an error. Most workspaces have none, and the ordinary answer — no
 * skills — is what an empty list already says; reporting a failure for it would put a red mark on a
 * picker whose whole content is "nothing here yet". A skill *file* that cannot be read or parsed is the
 * opposite case: it is a fact about one folder, so it is reported as a per-file load error and the rest
 * of the list is still returned.
 *
 * It imports electron for `app.getPath`, like `mentions.ts` does. The suites still run outside Electron
 * because `tests/stubs/register.cjs` redirects the import, and nothing in the scanning itself consults it.
 */
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query } from '../init'
import { MAX_FILE_BYTES } from './workspace'
import { workspaceRootFromStoreFile } from './terminal'
import { orderDirectoryEntries } from '../protocol/mentions'
import {
  isSafeSkillId,
  MAX_SKILL_BODY_CHARS,
  mergeSkillScopes,
  parseSkillText,
  skillBodyOverCap,
  SKILL_IO_ERROR,
  SKILL_NOT_FOUND,
  SKILL_PARSE_INVALID,
  SKILL_TOO_LARGE,
  type ResolvedSkill,
  type SkillErrorCode,
  type SkillListing,
  type SkillLoadError,
  type SkillScope,
  type SkillSummary,
} from '../protocol/skills'

/** The file every skill folder must hold. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** The folder inside a workspace that holds its project skills. */
export const PROJECT_SKILLS_FOLDER = '.sam'

/** The folder under `%APPDATA%` that holds the user's own skills, across every project. */
export const USER_SKILLS_FOLDER = 'era'

/** Where a project's skills live: `<root>/.sam/skills`. */
export function projectSkillsDir(rootPath: string): string {
  return join(rootPath, PROJECT_SKILLS_FOLDER, 'skills')
}

/** Where the user's own skills live: `%APPDATA%\era\skills`. */
export function userSkillsDir(appDataPath: string): string {
  return join(appDataPath, USER_SKILLS_FOLDER, 'skills')
}

/**
 * The file one skill id names, inside a scope's own directory.
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
 * first means this scope does not have the skill and the next one may, while the second means the skill
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

/** One skills directory, as the scan found it. */
interface SkillDirScan {
  skills: SkillSummary[]
  errors: SkillLoadError[]
}

/**
 * Scan one skills directory.
 *
 * The folder name is the id, so a name this app cannot address as an id is reported and skipped rather
 * than read: joining `../..` would leave the directory, and a skill that could never be activated is not
 * one a picker should offer as if it could. Everything else is read in the directory's own deterministic
 * order, so the listing and its errors are the same from run to run.
 *
 * Sequential rather than concurrent, deliberately: this runs once on a picker's open over a handful of
 * files, and a `Promise.all` would make which error is reported first depend on which read settled first.
 */
async function scanSkillDir(skillsDir: string, scope: SkillScope): Promise<SkillDirScan> {
  let names: string[]
  try {
    names = await readdir(skillsDir)
  } catch {
    // Absent, or unreadable. Both mean there is nothing to offer here, which a picker shows as an empty
    // scope — the same rule the mention walk follows for a directory it cannot open.
    return { skills: [], errors: [] }
  }

  const skills: SkillSummary[] = []
  const errors: SkillLoadError[] = []

  for (const name of orderDirectoryEntries(names)) {
    if (!isSafeSkillId(name)) {
      errors.push({
        id: name,
        scope,
        code: SKILL_PARSE_INVALID,
        message: 'This folder name is not a usable skill id, so its file was not read.',
      })
      continue
    }

    const read = await readSkillFile(skillFilePath(skillsDir, name))
    if (!read.ok) {
      errors.push({ id: name, scope, code: read.code, message: read.message })
      continue
    }

    const parsed = parseSkillText(name, scope, read.text)
    if (!parsed.ok) {
      errors.push({ id: parsed.id, scope: parsed.scope, code: parsed.code, message: parsed.message })
      continue
    }

    // The body is deliberately not carried: a listing is the set of skills that could be turned on, and
    // shipping every body over IPC to draw a title and a summary would be the whole library on the wire
    // on every open. The body is read again by the turn that activates one.
    skills.push({
      id: parsed.skill.id,
      scope: parsed.skill.scope,
      title: parsed.skill.title,
      summary: parsed.skill.summary,
      tags: parsed.skill.tags,
    })
  }

  return { skills, errors }
}

/**
 * Every skill the user could activate, in both scopes.
 *
 * A missing root is neither an error nor an empty answer: with no folder open there are no project
 * skills, and the user's own are still theirs. The precedence rule between the scopes is applied here,
 * through `mergeSkillScopes`, so the rows a picker offers are the ids a turn would actually resolve.
 *
 * The project's errors come first, so the reported order is the scope order the picker draws rather than
 * whichever scan happened to finish first.
 */
export async function listSkills(rootPath: string | null, userDir: string): Promise<SkillListing> {
  const project = rootPath ? await scanSkillDir(projectSkillsDir(rootPath), 'project') : { skills: [], errors: [] }
  const user = await scanSkillDir(userDir, 'user')
  const merged = mergeSkillScopes(project.skills, user.skills)

  return { ...merged, errors: [...project.errors, ...user.errors] }
}

/** What a turn start hands the resolver: the folder it is running in, and the ids the session carries. */
export interface SkillResolutionInput {
  rootPath: string | null
  userDir: string
  activeSkillIds: readonly string[]
}

/**
 * The skills a turn is to be sent with, in full, or a failure naming what could not be used.
 *
 * This is the turn-start half, and it is deliberately the opposite of the listing above in one respect:
 * a listing reports what it could not read and carries on, while a turn *fails* rather than proceed.
 * The difference is what the user asked for. A picker with one broken folder in it is still a picker; a
 * turn whose user turned a skill on and quietly did not get it has been misled about what the model was
 * told, and a skill that half-arrived is worse than one that refused to.
 *
 * So: thrown `ConveyorError`s with the code as the meaning. A missing skill is `SKILL_NOT_FOUND`, a body
 * past the character cap is `SKILL_TOO_LARGE`, a file that will not read or parse is that file's own
 * code — and in every case nothing is sent and nothing is silently dropped.
 *
 * Precedence is decided by *presence*, not by which scope happened to work. If the project has the id
 * and its file cannot be read, the turn fails: falling through to a user skill of the same id would run
 * something other than the skill the project provides, which is exactly the substitution the precedence
 * rule exists to prevent. Only a scope that does not have the id at all passes the read on.
 */
export async function resolveActiveSkills(input: SkillResolutionInput): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = []

  for (const id of input.activeSkillIds) {
    if (!isSafeSkillId(id)) {
      throw new ConveyorError(SKILL_PARSE_INVALID, `"${id}" is not a usable skill id, so it was not sent.`)
    }

    const candidates: Array<{ scope: SkillScope; path: string }> = []
    if (input.rootPath) {
      candidates.push({ scope: 'project', path: skillFilePath(projectSkillsDir(input.rootPath), id) })
    }
    candidates.push({ scope: 'user', path: skillFilePath(input.userDir, id) })

    let found: { scope: SkillScope; text: string } | null = null
    for (const candidate of candidates) {
      const read = await readSkillFile(candidate.path)
      if (read.ok) {
        found = { scope: candidate.scope, text: read.text }
        break
      }
      // There is a skill here and it cannot be used. Said now rather than tried in the other scope.
      if (read.code !== SKILL_NOT_FOUND) {
        throw new ConveyorError(read.code, `The active skill "${id}" could not be used: ${read.message}`)
      }
    }

    if (found === null) {
      throw new ConveyorError(
        SKILL_NOT_FOUND,
        `The active skill "${id}" was not found in this project or in your skills folder.`
      )
    }

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

    resolved.push({ id, scope: parsed.skill.scope, title: parsed.skill.title, body: parsed.skill.body })
  }

  return resolved
}

/**
 * Every skill the user could activate, as one read for the picker.
 *
 * A query, and it takes no input: the folder comes from the workspace store file main already owns and
 * the user's folder from `appData`, so the renderer cannot point a skills scan at a directory it names —
 * the same shape, and the same reason, as `mentions.listFilesFlat`.
 */
export const skillsModule = defineModule({
  /** The project's skills and the user's, with the project's precedence already applied. */
  list: query(async () => {
    return listSkills(
      workspaceRootFromStoreFile(app.getPath('userData')),
      // `%APPDATA%\era\skills`: the requirement's own path, read from `appData` rather than from this
      // app's `userData`, so the folder is the user's across every build and every reinstall.
      userSkillsDir(app.getPath('appData'))
    )
  }),
})
