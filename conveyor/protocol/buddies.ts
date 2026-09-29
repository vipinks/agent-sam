/**
 * Buddies: what a conversation runs as, and what that Buddy may declare.
 *
 * A Buddy is a named way of working — a writer and editor, a tutor, an analyst — that a conversation can
 * be created as. It is three kinds of thing at once, and the split between them is the whole design: a
 * *record* the user can edit, a *seed* of session fields taken once at creation, and a *subset* of MCP
 * servers applied at every tool assembly. The seed is taken rather than re-resolved, because what a
 * conversation is running as must not change under it when the user edits the record a month later.
 *
 * Pure data in, pure data out — no disk, no electron, no window. Two processes need these rules and
 * neither owns them: main combs a Buddy's server list against what the user has trusted, and the
 * renderer resolves a Buddy at the moment it creates the conversation. The store of *custom* records is
 * `conveyor/stores/buddies.ts`; the built-ins live here, as the app's own data beside it, which is what
 * keeps them out of every user's file and impossible to corrupt by editing.
 *
 * One law is load-bearing enough to state up front, because every rule below is shaped by it: a Buddy
 * may only ever **narrow** what the app was already allowed to do. Its server list is read as an
 * intersection with the servers the user trusted and enabled, never as a wish list — so a record cannot
 * grant itself a server, and `SamAi`, the default, is what every conversation that named nobody runs as.
 */
import { z } from 'zod'
import { isSafeMcpServerId, MAX_MCP_SERVER_ID_CHARS } from './mcp-ids'
import { MAX_ACTIVE_SKILLS, MAX_SKILL_ID_CHARS } from './skills'

/**
 * The Buddy a conversation runs as when it named none.
 *
 * Named rather than spelled `''` so the one thing a caller has to compare against is written down once.
 * It is deliberately *not* a record: giving the default a record would make it something to edit,
 * disable and list beside the others, and the default is the app's own behavior rather than one
 * choice among several.
 */
export const SAMAI_BUDDY_ID = 'samai'

/** How long a Buddy id may be. The same budget a skill id and a server id get: it is a key, not prose. */
export const MAX_BUDDY_ID_CHARS = 64

/** How long a Buddy's name may be. It is a label on a row, and a paragraph there reads as a mistake. */
export const MAX_BUDDY_NAME_CHARS = 40

/** How long the mark beside a Buddy's name may be. Two characters: a letter, or a letter and a tiebreak. */
export const MAX_BUDDY_GLYPH_CHARS = 2

/** How long the one line under a Buddy's name may be: what it is for, in a sentence. */
export const MAX_BUDDY_DESCRIPTION_CHARS = 160

/**
 * How long a role prompt may be.
 *
 * Stated as a character budget rather than left open because this text is injected into every turn of
 * the conversation, ahead of the project's own instructions: it is the most expensive thing a Buddy can
 * declare, so it is bounded at the boundary where it is stored rather than discovered in a request that
 * has already been built. Over the cap is a refusal, not a truncation — half a role reads as a whole one.
 */
export const MAX_BUDDY_ROLE_PROMPT_CHARS = 4000

/** How many starter prompts a Buddy may offer. Four fit a row; more is a menu. */
export const MAX_BUDDY_STARTERS = 4

/** How long one starter prompt may be. Long enough to be a sentence, short enough to be a chip. */
export const MAX_BUDDY_STARTER_CHARS = 200

/**
 * How many MCP servers a Buddy may name.
 *
 * Bounded like every other list a record carries, and for the same reason: this one decides what a turn
 * is offered, so an unbounded list would be an unbounded claim about a set the user built by hand.
 */
export const MAX_BUDDY_MCP_IDS = 16

/**
 * What a Buddy id may be.
 *
 * The slug rule the server ids use, deliberately: lower case only, no leading dot, no separator, which
 * is what makes an id safe as a map key, as a filename segment if a later turn ever writes one per
 * Buddy, and as something a human can read in a session record.
 */
const BUDDY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/** Whether a string could be a Buddy id at all: the rule the schema and the store both measure against. */
export function isSafeBuddyId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_BUDDY_ID_CHARS) return false
  return BUDDY_ID_PATTERN.test(value)
}

/**
 * What one Buddy is, as it is stored and handed around.
 *
 * One shape for built-ins and custom records both, because every rule below reads one shape: `builtin`
 * is the only field that says which of the two it is, and a custom record is *never* written with it
 * true — the store's own schema refuses that, so a stored record cannot claim to be the app's.
 *
 * `providerId` and `model` are optional as a pair and are seeded as a pair: a model id belongs to the
 * provider that serves it, so seeding one without the other would pin a conversation to a pair that
 * cannot run. `autoApprove` is optional and means what it means everywhere else in this app — a
 * preference the user set, defaulted to off and never inferred from a Buddy's own text.
 */
export const buddyRecordSchema = z.object({
  id: z.string().min(1).max(MAX_BUDDY_ID_CHARS).regex(BUDDY_ID_PATTERN, 'A Buddy id must be a lower-case slug.'),
  name: z.string().trim().min(1).max(MAX_BUDDY_NAME_CHARS),
  glyph: z.string().trim().min(1).max(MAX_BUDDY_GLYPH_CHARS),
  description: z.string().trim().min(1).max(MAX_BUDDY_DESCRIPTION_CHARS),
  rolePrompt: z.string().trim().min(1).max(MAX_BUDDY_ROLE_PROMPT_CHARS),
  /** The skills the conversation starts with, by id. Resolved against the disk at its first turn. */
  skillIds: z.array(z.string().min(1).max(MAX_SKILL_ID_CHARS)).max(MAX_ACTIVE_SKILLS),
  /** The MCP servers the conversation may use, by id. Read as an intersection, never as a grant. */
  mcpIds: z.array(z.string().min(1).max(MAX_MCP_SERVER_ID_CHARS)).max(MAX_BUDDY_MCP_IDS),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  autoApprove: z.boolean().optional(),
  starters: z.array(z.string().trim().min(1).max(MAX_BUDDY_STARTER_CHARS)).max(MAX_BUDDY_STARTERS),
  builtin: z.boolean(),
})

export type BuddyRecord = z.infer<typeof buddyRecordSchema>

/**
 * The three built-ins: the app's own data, never written to a store.
 *
 * They are data rather than code so that a later turn can list them beside the user's own without a
 * second shape to render, and pure so that a suite can assert what they say without a filesystem. Each
 * declares no servers: the default position for a Buddy is that it asks for nothing the user has not
 * already given the app, and a built-in that shipped naming a server would be a feature granting itself
 * an integration.
 *
 * The role prompts are written the way the app writes an instruction it means: concrete, in the second
 * person, and short enough that the model reads all of it.
 */
export const BUILTIN_BUDDIES: readonly BuddyRecord[] = [
  {
    id: 'writer-editor',
    name: 'Writer / Editor',
    glyph: 'W',
    description: 'Drafts and edits prose, and says what it would cut and why.',
    rolePrompt:
      "You are a careful writer and editor. Write prose that says what it means in as few words as it takes, and when you are asked to edit, change the writing rather than the claims: keep the author's meaning, voice and structure unless you are asked to change them, and say plainly what you cut and why. Prefer the concrete noun and the active verb, and never inflate a sentence to sound thorough.",
    skillIds: [],
    mcpIds: [],
    starters: [
      'Tighten this draft without losing anything it says',
      'Write the README for what we just built',
      'Review this copy and list every change you would make',
    ],
    builtin: true,
  },
  {
    id: 'study-tutor',
    name: 'Study Tutor',
    glyph: 'T',
    description: 'Teaches by question: works you to the answer instead of handing it over.',
    rolePrompt:
      'You are a patient tutor. Your job is to make the person you are teaching able to do this without you: explain the idea behind the answer before the answer itself, ask one question at a time to find out what they actually understand, and when they are close, let them finish the step rather than finishing it for them. Say when something is a simplification, and never state a fact you are not sure of as though you were.',
    skillIds: [],
    mcpIds: [],
    starters: [
      'Quiz me on what we just went through',
      'Explain this from first principles',
      'Where is my reasoning wrong?',
    ],
    builtin: true,
  },
  {
    id: 'analyst',
    name: 'Analyst',
    glyph: 'A',
    description: 'Reads the numbers and says what they support, and what they do not.',
    rolePrompt:
      'You are an analyst. Read the numbers before you interpret them, state the question each figure actually answers, and separate what the data shows from what you take it to mean. When something cannot be concluded from what is in hand, say so and name what would settle it, rather than answering a slightly different question that the data does support.',
    skillIds: [],
    mcpIds: [],
    starters: ['What do these numbers actually say?', 'Which of these claims is the data strong enough for?'],
    builtin: true,
  },
]

/**
 * Whether an id names something the app already owns: the default, or one of the built-ins.
 *
 * Asked by the store before it accepts a custom record, because a custom record under a built-in's id
 * could never resolve: the built-in wins, and the user's own record would sit in the store unreachable
 * and unopenable — a write that looked like it worked and had no effect.
 */
export function isReservedBuddyId(id: string): boolean {
  return id === SAMAI_BUDDY_ID || BUILTIN_BUDDIES.some((buddy) => buddy.id === id)
}

/**
 * The record an id names, or null.
 *
 * `null` for the default and for an absent id, and the caller is expected to read that as SamAi rather
 * than as a failure: a conversation with no Buddy and a conversation whose Buddy was deleted both mean
 * "run as the app does". Built-ins are searched first, so a stored record can never shadow one — which,
 * with `isReservedBuddyId` refusing such a write at the boundary, is a second answer to the same
 * question rather than the only one.
 *
 * The custom list is passed in rather than imported: this module is shared with the renderer, and a
 * resolver that reached for the store itself could not be tested without one.
 */
export function resolveBuddy(id: string | null | undefined, custom: readonly BuddyRecord[] = []): BuddyRecord | null {
  if (typeof id !== 'string' || id === '' || id === SAMAI_BUDDY_ID) return null

  const builtin = BUILTIN_BUDDIES.find((buddy) => buddy.id === id)
  if (builtin) return builtin

  return custom.find((buddy) => buddy.id === id) ?? null
}

/**
 * What a conversation created as this Buddy carries, from the moment it exists.
 *
 * Every field is present only when the record declares it. That is not tidiness: each key's *absence*
 * already means something — no skills chosen, no limit on servers, the window's own provider — and a key
 * written with a default would say the same thing a second way while making the record claim the user
 * chose it.
 *
 * `autoApprove` travels with this seed because it is a choice made at the same moment and by the same
 * hand, though it lands on the transcript rather than on the session record: consent belongs to the
 * conversation's consent setting, not to its metadata.
 */
export interface BuddySessionSeed {
  /** The Buddy the conversation was created as. Never the default — a default is the absent key. */
  buddyId: string
  /** The role as it stood at creation, snapshotted so an edit to the record cannot change this run. */
  rolePrompt: string
  /** The servers the Buddy named, or absent when it named none: no limit, not an empty limit. */
  mcpSubset?: string[]
  /** The skills the conversation starts running, by id, or absent when the Buddy chose none. */
  activeSkillIds?: string[]
  providerId?: string
  model?: string
  autoApprove?: boolean
}

export function buddySessionSeed(buddy: BuddyRecord): BuddySessionSeed {
  // The model travels with its provider or not at all: see the record's own note.
  const pinned = buddy.providerId !== undefined

  return {
    buddyId: buddy.id,
    rolePrompt: buddy.rolePrompt,
    ...(buddy.mcpIds.length > 0 ? { mcpSubset: [...buddy.mcpIds] } : {}),
    ...(buddy.skillIds.length > 0 ? { activeSkillIds: [...buddy.skillIds] } : {}),
    ...(buddy.providerId !== undefined ? { providerId: buddy.providerId } : {}),
    ...(pinned && buddy.model !== undefined ? { model: buddy.model } : {}),
    ...(buddy.autoApprove !== undefined ? { autoApprove: buddy.autoApprove } : {}),
  }
}

/**
 * The servers a turn may use, given what it asked for and what the app was already allowed to use.
 *
 * The intersection, and only ever the intersection. `trusted` is what the user has trusted *and* left
 * enabled — in practice the servers that are running, because a server this app has not been given does
 * not run — and it is the ceiling rather than the starting point: a declaration naming a server outside
 * it does not bring that server in, and a declaration naming nothing at all is *not* a claim about
 * anything, so it leaves the whole trusted set standing.
 *
 * That last case is what makes the SamAi default and a Buddy with no `mcpIds` the same request, and it
 * is why this returns a fresh array in the trusted set's own order: the same subset has to produce the
 * same list on two builds, and a caller that mutated the result must not be able to edit the set it was
 * handed.
 */
export function mcpSubsetFor(declared: readonly string[] | null | undefined, trusted: readonly string[]): string[] {
  if (declared === null || declared === undefined || declared.length === 0) return [...trusted]

  const wanted = new Set(declared)
  return trusted.filter((id) => wanted.has(id))
}

/**
 * The three keys a session record carries about its Buddy, read the way every other optional key in that
 * record is read: absent is a value, and a key of the wrong shape is stripped rather than guessed at.
 *
 * `null` for each one rather than `undefined`, because there is no difference to draw between a
 * conversation that never had a role and one whose role key is nonsense: both run as the app does, and
 * both send no role section. The record itself is not rebuilt here — this reads, it does not write — so
 * a session restored from an older file keeps exactly the keys it had.
 */
export interface BuddySessionSnapshot {
  /** The Buddy the conversation was created as, or null for the SamAi default. */
  buddyId: string | null
  /** The role snapshotted at creation, or null when the conversation has none. */
  rolePrompt: string | null
  /** The servers named at creation, or null when the Buddy limited nothing. */
  mcpSubset: string[] | null
}

export function readBuddySession(record: unknown): BuddySessionSnapshot {
  const source = (record ?? {}) as Record<string, unknown>
  const { buddyId, rolePrompt, mcpSubset } = source

  return {
    buddyId: isSafeBuddyId(buddyId) ? buddyId : null,
    // Bounded as well as shaped: a role this long would not have been stored by this build, so a record
    // carrying one is not a record this build wrote — and it is not sent as standing context either.
    rolePrompt:
      typeof rolePrompt === 'string' && rolePrompt.trim() !== '' && rolePrompt.length <= MAX_BUDDY_ROLE_PROMPT_CHARS
        ? rolePrompt
        : null,
    mcpSubset:
      Array.isArray(mcpSubset) && mcpSubset.length > 0 && mcpSubset.every((id) => isSafeMcpServerId(id))
        ? [...mcpSubset]
        : null,
  }
}

/**
 * What a record's own field is called in a refusal.
 *
 * `record` is the one member that is not a field: a payload that is not an object at all has no name to
 * report, and answering with a field it never had would send a caller to edit the wrong box.
 */
export type BuddyField =
  | 'record'
  | 'id'
  | 'name'
  | 'glyph'
  | 'description'
  | 'rolePrompt'
  | 'skillIds'
  | 'mcpIds'
  | 'providerId'
  | 'model'
  | 'autoApprove'
  | 'starters'
  | 'builtin'

export type BuddyCheck = { ok: true; buddy: BuddyRecord } | { ok: false; field: BuddyField; message: string }

/**
 * Whether a record may exist, and which field refuses it when it may not.
 *
 * By *field* rather than by code, and that is the one place this module differs from the rules beside
 * it: a rejection here is answered by a control somebody is looking at — an empty name, a role prompt
 * past its cap — so the field is what the caller branches on, and the sentence is left free to change.
 * No error code is minted for it, because nothing upstream has to distinguish one refusal from another;
 * the store's own payload schema refuses the same shapes at the boundary it guards.
 *
 * The record is handed back as it was read, trimmed of the surrounding space the schema strips, so a
 * caller has one value to store rather than a choice between what it typed and what would be kept.
 */
export function checkBuddy(input: unknown): BuddyCheck {
  const parsed = buddyRecordSchema.safeParse(input)
  if (parsed.success) return { ok: true, buddy: parsed.data }

  const issue = parsed.error.issues[0]
  const field = issue?.path[0]
  return {
    ok: false,
    field: typeof field === 'string' && field !== '' ? (field as BuddyField) : 'record',
    message: issue?.message ?? 'A Buddy must be an object.',
  }
}
