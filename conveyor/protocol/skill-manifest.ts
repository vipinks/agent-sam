/**
 * The skill manifest: one parser for the JSON block this app writes and the YAML frontmatter everything
 * else writes.
 *
 * A skill file opens with a *leading* block — the first non-empty line is `---`, the block runs to the
 * next line that is exactly `---`, and everything after it is the body. That rule is unchanged from the
 * version of this file that lived in `skills.ts`; what changed is what reads the block. It used to be
 * `JSON.parse`, which meant a manifest written as YAML — the format every other agent-skills folder in
 * the world uses — was a load error here, and the `title: Code review` line a user typed by hand was
 * refused for not being JSON.
 *
 * JSON is a subset of YAML, so one YAML parser reads both. A manifest block written as JSON parses
 * exactly as it did, key for key; a frontmatter written as YAML parses to the same keys; and the two
 * normalize to one shape, because the rest of the app was written against that shape. That is the whole
 * argument for the dependency: it is not a second format this app now understands, it is the same
 * format read by a parser that also accepts the other spelling of it. A consequence worth stating is
 * that a hand-written frontmatter is held to the same field types as a written one — `title: 7` is
 * refused for being a title that is not a title, in either format, and never arrives as the string `"7"`.
 *
 * This module is deliberately not part of `skills.ts`, and the reason is a bundle rather than a taste.
 * The renderer imports the rules — the cap, the toggle, the tier list — and `skills.ts` is therefore in
 * the renderer's bundle. A parser is not: nothing in the renderer reads a skill file, because main does
 * the reading and answers with data. Keeping the parser in its own module keeps `yaml` out of the
 * renderer's bundle entirely, which is worth the second file. The types flow one way — this module knows
 * `skills.ts`, and `skills.ts` has never heard of this one — so there is no cycle to reason about.
 *
 * Nothing here executes what it reads. A manifest is text a user wrote, and the fields this build reads
 * are named below; an unknown key is left alone, because a manifest is a place a later version of this
 * app may write something, and refusing a whole skill for carrying a field this build does not know
 * would make that file unusable in both directions.
 */
import { parse as parseYaml } from 'yaml'
import { SKILL_MANIFEST_INVALID, type SkillErrorCode, type SkillScope } from './skills'

/** How much of a derived summary is kept. One line, because that is all a row in the picker has room for. */
export const MAX_SKILL_SUMMARY_CHARS = 160

/**
 * The title a skill with no manifest is shown under.
 *
 * Derived from the id because the id is the only name such a skill has: the folder is what the user
 * created, and a title invented from the body would disagree with the folder they will go and edit.
 */
export function skillTitleFromId(id: string): string {
  const words = id.split(/[-_.\s]+/).filter((word) => word !== '')
  if (words.length === 0) return id
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Cut a line to a display budget, marking the cut.
 *
 * Truncation is display-only and it always says so: a summary that ended mid-word with no marker would
 * read as a complete sentence that happens to stop.
 */
export function truncateForDisplay(text: string, max: number = MAX_SKILL_SUMMARY_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  // One character of the budget is spent on the marker, so the result is never longer than the budget.
  return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/**
 * The summary a skill with no manifest is shown under: its first non-empty body line.
 *
 * Leading heading markers are stripped, because almost every skill body opens with its own title and
 * `# Deploy runbook` as a summary reads as markup rather than as a sentence.
 */
export function skillSummaryFromBody(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line !== '') return truncateForDisplay(line)
  }
  return ''
}

/** A skill after its file has been read and parsed, body included. */
export interface ParsedSkill {
  id: string
  scope: SkillScope
  title: string
  summary: string
  tags: string[]
  /**
   * The manifest's own `schema` field, when it declared one.
   *
   * Carried rather than ignored: it is a supported field, so a manifest that writes it wrongly has to be
   * a load error, and validating it here is what makes that true. Nothing branches on its value yet —
   * the shape of a skill is the app's, and a skill cannot ask for a different one.
   */
  schema?: string
  /** Everything after the manifest, trimmed. What the model is actually given. */
  body: string
}

/**
 * One skill file that could not be read, named — without the tier.
 *
 * A parse is a function of text, so it knows the id and the scope it was handed and nothing more: which
 * of the four folders the file came from is the *scan's* fact, and it is attached there, one layer up.
 * Splitting them is what lets the same parse failure be reported by a listing (which knows the folder)
 * and by a body read (which was told it) without either inventing a tier it does not have.
 */
export interface SkillParseFailure {
  id: string
  scope: SkillScope
  code: SkillErrorCode
  message: string
}

/** A parsed skill, or the named reason it could not be parsed. */
export type SkillParseResult = ({ ok: true } & { skill: ParsedSkill }) | ({ ok: false } & SkillParseFailure)

const MANIFEST_DELIMITER = '---'

/** The manifest fields this build reads. Anything else in the object is left alone rather than refused. */
const MANIFEST_STRING_FIELDS = ['schema', 'title', 'summary'] as const

/** The failure shape, built in one place so every parse failure names the skill it belongs to. */
function parseFailure(id: string, scope: SkillScope, code: SkillErrorCode, message: string): SkillParseResult {
  return { ok: false, id, scope, code, message }
}

/** Read one manifest field as a trimmed string, or `''` when it is absent. Types are checked before this. */
function manifestText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Which of the known manifest fields is present with the wrong shape, if any.
 *
 * Only the fields this build reads are checked. An unknown key is left alone: a manifest is a place a
 * newer version of this app may write something, and refusing a whole skill because it carries a field
 * this build does not know would make every such file unusable in both directions.
 *
 * A string is a string in either format, so this is the same check the JSON-only parser made — the one
 * difference being that a YAML `title: 7` arrives here as the number 7 rather than as a syntax error,
 * and is refused for what it is: a title that is not a title.
 */
function manifestFieldError(manifest: Record<string, unknown>): string | null {
  for (const field of MANIFEST_STRING_FIELDS) {
    const value = manifest[field]
    if (value !== undefined && typeof value !== 'string') {
      return `The manifest's "${field}" must be a string.`
    }
  }
  const tags = manifest.tags
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
    return 'The manifest\'s "tags" must be an array of strings.'
  }
  return null
}

/**
 * Where the leading manifest ends, or `null` when the file has none.
 *
 * The delimiter is the first non-empty line only. A `---` that appears later is a horizontal rule in
 * somebody's prose, and treating one as a delimiter would turn an ordinary skill into a file whose
 * manifest happens to be invalid.
 */
function manifestBlock(
  lines: readonly string[]
): { ok: true; text: string; bodyStart: number } | { ok: false; message: string } | null {
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1 || lines[first].trim() !== MANIFEST_DELIMITER) return null

  for (let index = first + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === MANIFEST_DELIMITER) {
      return { ok: true, text: lines.slice(first + 1, index).join('\n'), bodyStart: index + 1 }
    }
  }
  return { ok: false, message: `The manifest is not closed by a ${MANIFEST_DELIMITER} line.` }
}

/**
 * The manifest the block holds, or the reason it is not one.
 *
 * One parser, and the message it produces is *ours* rather than the library's: a YAML error carries a
 * line, a column and the half-parsed text around it, which is a useful thing in a stack trace and a poor
 * thing to show a card. What a user needs to know is that the block between the delimiters is not a
 * manifest; where exactly the parser gave up is not something they can act on.
 */
function parseManifest(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  // An empty block is not an error: `---` above and below with nothing between them is a manifest that
  // says nothing, which is the same skill as one with no manifest at all.
  if (text.trim() === '') return { ok: true, value: {} }

  try {
    return { ok: true, value: parseYaml(text) }
  } catch {
    return { ok: false, message: 'The manifest is not valid YAML or JSON.' }
  }
}

/**
 * Parse one skill file.
 *
 * Never throws: a malformed file is a fact to report beside the skills that did load, so every failure
 * comes back as a code and a sentence rather than as an exception the caller has to catch per file.
 *
 * The body is trimmed, and the manifest is not part of it: what the model is given is the instructions,
 * not the metadata that describes them.
 *
 * `schema`, `title`, `summary` and `tags` are the four fields read, and the shape they come back in is
 * the one the rest of the app was written against. A frontmatter key that is not one of them is carried
 * nowhere and refused nowhere: it is a field for a later build, and a skill is not unusable because it
 * was written for one.
 */
export function parseSkillText(id: string, scope: SkillScope, text: string): SkillParseResult {
  // A leading byte-order mark is what a Windows editor writes. It must not stop the first line from
  // being the delimiter it looks like.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const block = manifestBlock(lines)

  if (block !== null && !block.ok) {
    return parseFailure(id, scope, SKILL_MANIFEST_INVALID, block.message)
  }

  let manifest: Record<string, unknown> = {}
  let body: string

  if (block !== null && block.ok) {
    const parsedManifest = parseManifest(block.text)
    if (!parsedManifest.ok) {
      return parseFailure(id, scope, SKILL_MANIFEST_INVALID, parsedManifest.message)
    }
    if (
      parsedManifest.value === null ||
      typeof parsedManifest.value !== 'object' ||
      Array.isArray(parsedManifest.value)
    ) {
      return parseFailure(id, scope, SKILL_MANIFEST_INVALID, 'The manifest must be a mapping of its fields.')
    }
    manifest = parsedManifest.value as Record<string, unknown>

    const fieldError = manifestFieldError(manifest)
    if (fieldError !== null) return parseFailure(id, scope, SKILL_MANIFEST_INVALID, fieldError)

    body = lines.slice(block.bodyStart).join('\n').trim()
  } else {
    body = lines.join('\n').trim()
  }

  const title = manifestText(manifest.title) || skillTitleFromId(id)
  const summary = manifestText(manifest.summary) || skillSummaryFromBody(body)
  const tags = Array.isArray(manifest.tags) ? (manifest.tags as string[]) : []
  const schema = manifestText(manifest.schema)

  return {
    ok: true,
    skill: {
      id,
      scope,
      title,
      summary,
      tags,
      // Absent rather than empty: a manifest that says nothing about its schema has no schema, and an
      // empty string would read as one that declared a blank one.
      ...(schema === '' ? {} : { schema }),
      body,
    },
  }
}
