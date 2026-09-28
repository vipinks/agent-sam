/**
 * What a request is about to spend: the estimate, the breakdown, the window it is placed against, and
 * the point at which this app considers a conversation ready to compact.
 *
 * Pure, and free of module imports, for the reason the usage protocol beside it is: the loop computes a
 * snapshot in main, the card that draws it next turn lives in the renderer, and the settings field that
 * bounds the compact point is a rule a suite has to be able to reach without a form. All three have to
 * agree on one arithmetic, so the arithmetic is stated once, here.
 *
 * The estimate is deliberately an estimate. A real token count belongs to the provider's tokenizer,
 * which this app does not ship and cannot call without paying for a round-trip to ask; what it can do
 * honestly is count the characters it is about to send and say so. Four characters per token is the
 * rule every other tool in this space uses, and it is stated as a rule rather than hidden in a card, so
 * a reader who distrusts the number can see exactly how it was reached.
 *
 * Nothing here reads or writes anything: main assembles the parts, this measures the text they carry,
 * and the session record stores the answer.
 */
import { z } from 'zod'

// ---------------------------------------------------------------- the estimate

/**
 * What a piece of text costs, in tokens, at four characters each.
 *
 * Rounded up rather than down, because the two failure directions are not equal: this number decides
 * whether a conversation is described as past its compact point, and one that under-counts would
 * describe a conversation as having room it does not have. An over-count is visible and cheap; an
 * under-count is the one that arrives as a provider's own refusal to accept the request.
 *
 * Empty text is zero rather than a token: a category nobody wrote to must cost nothing, or every
 * conversation would start in debt to the parts it does not have.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------- the breakdown

/**
 * The parts one request was assembled from, each already serialized as the text it will carry.
 *
 * Strings rather than structures, deliberately: this rule measures bytes of text, and a caller that
 * handed over an object would leave the serialization to the rule — which would then disagree with the
 * body it is describing the moment the two were written by different code. The loop serializes what it
 * is about to send and measures that, so the measurement is of the artifact rather than of a copy.
 *
 * The message history is the one part that is measured *unresolved*: a message's images are references
 * until the wire is built, and the bytes behind one are a base64 data URL that no character count
 * describes. They are counted as references instead, by the argument below.
 */
export interface AssembledParts {
  /** The tool schemas this request offers, as the provider receives them. */
  tools: string
  /** The agent's own standing instruction. */
  systemPrompt: string
  /** The project instructions read from the workspace, when there are any. */
  projectInstructions: string
  /** The skills section, when the conversation runs with any skill active. */
  skills: string
  /** The conversation itself, with every image still a reference. */
  messages: string
  /** Whatever else this send carries that none of the categories above names. */
  other: string
}

/**
 * What one image reference costs, in tokens.
 *
 * A flat allowance rather than a measurement, because there is nothing here to measure: an image's
 * transport is a data URL whose length is a fact about its compression rather than about its content,
 * and a model charges for a picture by how many tiles it is cut into. 1500 is the published figure for
 * a mid-sized image on the models this app offers, and it is a rule a reader can argue with — which is
 * the point, since the alternative is a number that looks measured and is not.
 */
export const IMAGE_REF_TOKENS = 1500

/** One request's cost, by category, and the total the categories add up to. */
export interface ContextBreakdown {
  tools: number
  systemPrompt: number
  projectInstructions: number
  skills: number
  messages: number
  /** The residual text, plus one image allowance per reference. */
  other: number
  /** Every category added up. Never a second measurement of the same request. */
  used: number
}

/** A reference count as a count: whole, non-negative, and zero for anything that is not one. */
function refCount(refs: number): number {
  if (typeof refs !== 'number' || !Number.isFinite(refs) || refs <= 0) return 0
  return Math.trunc(refs)
}

/**
 * The parts as per-category token counts.
 *
 * `used` is the sum and not a separate estimate, so the number drawn beside the categories is one a
 * reader can add up themselves. The image allowance folds into `other` rather than taking a category of
 * its own: it is charged for something the parts do not name in text, which is exactly what `other` is,
 * and a seventh category would be a column that is empty on every conversation without an image.
 */
export function estimateBreakdown(parts: AssembledParts, imageRefs: number): ContextBreakdown {
  const tools = estimateTokens(parts.tools)
  const systemPrompt = estimateTokens(parts.systemPrompt)
  const projectInstructions = estimateTokens(parts.projectInstructions)
  const skills = estimateTokens(parts.skills)
  const messages = estimateTokens(parts.messages)
  const other = estimateTokens(parts.other) + refCount(imageRefs) * IMAGE_REF_TOKENS

  return {
    tools,
    systemPrompt,
    projectInstructions,
    skills,
    messages,
    other,
    used: tools + systemPrompt + projectInstructions + skills + messages + other,
  }
}

/**
 * A measurement as it is persisted on a session's metadata entry: the breakdown, and when it was taken.
 *
 * The moment travels with it because a snapshot is a fact about one request rather than a total — the
 * key is replaced by each send, and a reader that could not tell a snapshot taken a minute ago from one
 * taken last week would be reading a stale number as a current one. Whole and non-negative like every
 * other counter this app stores: what is written here is what a reader trusts.
 */
export const contextSnapshotSchema = z.object({
  tools: z.number().int().nonnegative(),
  systemPrompt: z.number().int().nonnegative(),
  projectInstructions: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  /** When the request was measured, in epoch milliseconds. */
  at: z.number().int().nonnegative(),
})

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>

/** One request's measurement, taken at the moment it was built. */
export function snapshotRequest(parts: AssembledParts, imageRefs: number, at: number): ContextSnapshot {
  return { ...estimateBreakdown(parts, imageRefs), at }
}

/**
 * Read the snapshot key off a session's metadata entry, or undefined when it has none this build trusts.
 *
 * The reading half of the additive-optional pattern, on the same terms as `readSessionUsage` beside it:
 * an absent key, a key of the wrong shape, and a key from a newer build all leave the record valid and
 * this returning nothing. Stripped rather than defaulted, so a conversation that has never been
 * measured reads as one rather than as a measurement of zero.
 */
export function readContextSnapshot(record: unknown): ContextSnapshot | undefined {
  if (!record || typeof record !== 'object') return undefined
  const parsed = contextSnapshotSchema.safeParse((record as Record<string, unknown>).contextSnapshot)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------- the window

/**
 * The context window of the models this app ships against, in tokens.
 *
 * Recorded by hand at the time this table was written, for the reason the rates table is: a provider
 * publishes a window per model, nothing in a shipped build can ask it again for free, and a wrong
 * number would be indistinguishable from a right one until a request was refused. Half of a window is
 * reserved for the reply — these are the *prompt* budgets of a two-way conversation, which is why they
 * are stated as the whole window and the compact point is a share of it rather than a token count.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'deepseek-flash': 64_000,
  'deepseek-chat': 64_000,
  'deepseek-pro': 64_000,
  'deepseek-reasoner': 64_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
}

/**
 * What a record may declare about one model's window.
 *
 * The one field a model row will write next turn, optional and additive, exactly like the rate
 * declaration in the usage protocol beside it — a partial entry is not a declaration, and the rules
 * below fall through to the table rather than inventing a window from half of one.
 */
export interface WindowDeclaration {
  contextWindow?: number
}

/**
 * A provider's declared windows, keyed by the model each belongs to.
 *
 * Keyed by model because a window belongs to the model that enforces it: one gateway serves a model
 * with a small window and one with a large one, and a single number for the provider would have to be
 * wrong about at least one of them.
 */
export type ModelWindows = Record<string, WindowDeclaration>

/** The model being placed, and the windows the provider serving it has declared. */
export interface WindowRule {
  model: string
  /** Absent is the ordinary state: a provider nobody has declared a window for carries no map. */
  modelWindows?: ModelWindows | null
}

/** A declared window as a window, or null when the entry is not one. */
function declaredWindow(entry: WindowDeclaration | undefined): number | null {
  const value = entry?.contextWindow
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value)
}

/**
 * The window to place a model against, or null when nothing knows it.
 *
 * Three layers, and the order is the whole rule: what was declared for this model, then the table this
 * build ships, then nothing. A declaration wins because a user who typed a window is not argued with,
 * and it wins for *its* model only — the row beside it in the same provider is placed against the
 * table, which is why a window belongs to a model rather than to the provider that serves it.
 *
 * There is deliberately no fourth layer and no default window. A model nothing knows is measured
 * against nothing, and that absence is what a reader draws as "unknown" instead of as a share of a
 * number nobody supplied.
 */
export function resolveWindow(rule: WindowRule): number | null {
  const declared = declaredWindow(rule.modelWindows?.[rule.model])
  if (declared !== null) return declared
  return CONTEXT_WINDOWS[rule.model] ?? null
}

// ---------------------------------------------------------------- the compact point

/**
 * The share of a window this app will let a conversation reach before it is described as past its
 * compact point.
 *
 * A floor and a ceiling rather than a range of any length, because both ends are the setting becoming
 * useless in different ways: below half a window there is no room left to answer, and past 95 percent
 * the point is a line the request itself can never be built past.
 */
export const MIN_COMPACT_PERCENT = 50
export const MAX_COMPACT_PERCENT = 95

/** The share a conversation is measured against when nobody has said otherwise. */
export const DEFAULT_COMPACT_PERCENT = 70

/**
 * What the compact-point field's check answered: the percent to store, or the words the field shows
 * instead.
 *
 * The same shape `protocol/terminal-preferences` answers with, and for the same reason: an out-of-range
 * percent is not a failure of anything, it is a value the Settings field explains under itself, so the
 * refusal is a field rule rather than a `ConveyorError` code. `reason` is for the caller's branching and
 * `message` is what a reader is shown; two refusals can share a sentence and still be different cases.
 */
export type CompactPointCheck =
  { ok: true; value: number } | { ok: false; reason: 'not-a-number' | 'out-of-range'; message: string }

/** Digits only, deliberately, rather than `Number(raw)`: a percent is a whole number someone typed. */
const WHOLE_NUMBER = /^\d+$/

/** Whether a typed string is a compact point this app will store, and why not when it is not. */
export function checkCompactPoint(raw: string): CompactPointCheck {
  const trimmed = raw.trim()
  if (!WHOLE_NUMBER.test(trimmed)) {
    return { ok: false, reason: 'not-a-number', message: 'Enter a whole number of percent.' }
  }

  const value = Number(trimmed)
  // One range check for two cases: a percent below the floor, and a string of digits long enough to
  // arrive as an infinity — out of range rather than unreadable, since the repair is the same.
  if (value < MIN_COMPACT_PERCENT || value > MAX_COMPACT_PERCENT) {
    return {
      ok: false,
      reason: 'out-of-range',
      message: `Enter a whole number between ${MIN_COMPACT_PERCENT} and ${MAX_COMPACT_PERCENT}.`,
    }
  }

  return { ok: true, value }
}

/**
 * Where the compact point falls in a window, in tokens.
 *
 * Floored, so the point is a token count a request can actually reach: an unfloored share of an odd
 * window would be a fraction, and a status decided against a fraction is a status nobody can reproduce
 * from the numbers they can see. A window nobody knows yields zero — there is no point in a window of
 * nothing, and a caller reading this only after `resolveWindow` answered has a window in hand.
 */
export function compactPoint(window: number, percent: number): number {
  if (!Number.isFinite(window) || window <= 0) return 0
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.floor((window * percent) / 100)
}

/**
 * How many tokens are left before the compact point, or how many past it when the sign is negative.
 *
 * Signed rather than clamped, because the sign is the answer: a zero means the conversation has just
 * reached the point, and a negative is the amount by which it has gone past it. A clamped remainder
 * would make "just at the point" and "far past it" the same number.
 */
export function compactRemaining(used: number, window: number, percent: number): number {
  return compactPoint(window, percent) - used
}

/**
 * Where a conversation stands: below its compact point, past it, or over the window entirely.
 *
 * Two boundaries, and both are inclusive at the moment they become true. A conversation *at* the point
 * is past it — the setting is about a share of the window, and a share is reached rather than exceeded.
 * A conversation *at* the window is over it, because the window is the largest prompt a provider will
 * accept, so the request itself has stopped being sendable.
 */
export type ContextStatus = 'healthy' | 'pastCompact' | 'overWindow'

export function contextStatus(used: number, window: number, percent: number): ContextStatus {
  if (used >= window) return 'overWindow'
  if (used >= compactPoint(window, percent)) return 'pastCompact'
  return 'healthy'
}
