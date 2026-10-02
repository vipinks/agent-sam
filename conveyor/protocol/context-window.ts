/**
 * What a request is about to spend: the estimate, the breakdown, the window it is placed against, and
 * the point at which this app considers a conversation ready to compact.
 *
 * Pure, and its only import is the sibling usage protocol's own number formatting, for the reason the
 * usage protocol beside it is free of module imports itself: the loop computes a snapshot in main, the
 * card that draws it in the renderer, and the settings field that bounds the compact point is a rule a
 * suite has to be able to reach without a form. All four have to agree on one arithmetic, so the
 * arithmetic is stated once, here.
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
import { compactTokens } from './session-usage'

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

// ---------------------------------------------------------------- the card

/**
 * The dash the card draws where a number would be a claim it cannot support.
 *
 * The same statement the Overview's tiles make with it, and made here for the same reason: an unknown
 * window has no share to state, and a nought would read as a measurement rather than as an absence.
 */
export const CONTEXT_EM_DASH = '\u2014'

/**
 * The one line under the pill.
 *
 * It exists because the pill is a *preference* rather than a promise, and nothing this build does acts
 * on it: a card that drew an amber pill and said nothing else would read as a feature that is about to
 * do something on its own. No verb about compacting appears anywhere in it, because no such behaviour
 * exists to describe.
 */
export const CONTEXT_PILL_CAPTION = 'Agent Sam does not compact yet. Past the point, consider a new session.'

/**
 * The footnote under the card: the estimate stated as the rule it is, rather than as a measurement.
 *
 * All three clauses are load-bearing. The four characters are the heuristic this build counts with, the
 * per-image allowance is the one number that is not a count of characters, and the exclusion of the
 * running total is what keeps a reader from adding the Tiles' spend to this card and believing the sum.
 */
export const CONTEXT_ESTIMATOR_FOOTNOTE =
  'Estimated at four characters per token, plus 1,500 tokens per image. Cumulative session usage is not counted.'

/** The one sentence a card with nothing measured draws, in place of every figure it could invent. */
const CONTEXT_EMPTY_SENTENCE = 'Send a message to see what this conversation is about to spend.'

/**
 * The sentence an unknown window draws beside its dashes.
 *
 * A dash with no way out of it is a dead end, so the card names the surface the window is declared on:
 * the field is the model's own row, which is where a model the shipped table has never heard of is
 * given a window.
 */
const CONTEXT_WINDOW_POINTER =
  "Declare this model's window on its model row in Settings to read this card against a window."

/** The parts a request is assembled from, in the order it is assembled from them. */
const CATEGORY_KEYS = ['tools', 'systemPrompt', 'projectInstructions', 'skills', 'messages', 'other'] as const

export type ContextCategoryKey = (typeof CATEGORY_KEYS)[number]

/** What each part is called on the card, which is what a reader compares against the report they know. */
const CATEGORY_LABELS: Record<ContextCategoryKey, string> = {
  tools: 'Tool schemas',
  systemPrompt: 'System prompt',
  projectInstructions: 'Project instructions',
  skills: 'Skills',
  messages: 'Conversation',
  other: 'Other and images',
}

/** One category as the card draws it: what it costs, and what share of the window that is. */
export interface ContextCardRow {
  key: ContextCategoryKey
  label: string
  tokensText: string
  /** A whole percent of the window, or the dash when there is no window to take a share of. */
  percentText: string
}

/**
 * The card's four pills: the three statuses, and the window nobody has declared.
 *
 * The fourth is not a status — nothing about the conversation is known to be wrong — but it is what the
 * card shows where a status would go, because a pill-shaped gap would leave the reader wondering which
 * of the other three the truth is.
 */
export type ContextPill = ContextStatus | 'unknown'

/** What each pill says when it is stated rather than only coloured. */
const PILL_LABELS: Record<ContextPill, string> = {
  healthy: 'Healthy',
  pastCompact: 'Past compact point',
  overWindow: 'Over window estimate',
  unknown: 'Window unknown',
}

/**
 * Everything the context card draws, as strings — one value per thing a reader can point at.
 *
 * A view model rather than a component's own arithmetic, for the reason the tiles' rule is: the strings
 * are the answer, and the em dashes, the past-point flip and the badge's whole percent are all claims
 * that have to hold in a suite rather than only in a screenshot.
 */
export interface ContextCardView {
  /** `empty` before anything has been measured, which is the one state that draws no figures at all. */
  state: 'empty' | 'measured'
  /** The one sentence an empty card draws, or null on a measured one. */
  sentence: string | null
  pill: ContextPill | null
  pillLabel: string
  pillCaption: string
  /** The used tokens alone, compactly: the one figure that survives an unknown window. */
  usedText: string
  /** The used-over-window pair, as one string. */
  figure: string
  /** The badge riding the filled segment. */
  usedPercentText: string
  /** How far the filled segment reaches, as a whole percent of the bar, clamped to the bar's own end. */
  fillPercent: number
  /** Where the compact-point tick stands, or null when the window is unknown. */
  tickPercent: number | null
  remainderLabel: string
  remainderText: string
  categories: ContextCardRow[]
  freeLabel: string
  freeText: string
  freeCaption: string
  footnote: string
  /** The sentence pointing at the model row, or null when a window was resolved. */
  pointed: string | null
}

/** A whole percent, rounded: the reader adds percents up, so a fraction of one is not a reading. */
function wholePercent(part: number, total: number): number {
  return Math.round((part / total) * 100)
}

/**
 * The card with nothing measured.
 *
 * No pills, no rows, and no figures: the strings are empty rather than nought, so a component that drew
 * one of them anyway would draw nothing instead of drawing a claim.
 */
const EMPTY_CARD: ContextCardView = {
  state: 'empty',
  sentence: CONTEXT_EMPTY_SENTENCE,
  pill: null,
  pillLabel: '',
  pillCaption: '',
  usedText: '',
  figure: '',
  usedPercentText: '',
  fillPercent: 0,
  tickPercent: null,
  remainderLabel: '',
  remainderText: '',
  categories: [],
  freeLabel: '',
  freeText: '',
  freeCaption: '',
  footnote: '',
  pointed: null,
}

/**
 * The whole card, derived from one snapshot, the window it is placed against, and the compact point.
 *
 * The window arrives resolved, or as null: the caller has already fallen through the declaration and the
 * shipped table to get here, and this rule does not fall through again — a second resolution would be a
 * second answer to the same question, and the two could disagree about the one model the user typed a
 * window for.
 *
 * A window of nothing is treated as no window rather than as a window everything is over. Nothing this
 * build can declare is zero — a declaration below one is rejected by the store's own schema — so the
 * only way to arrive at a nought is for a caller to have made one up, and the honest reading of a
 * window nobody supplied is the unknown case.
 */
export function contextCard(input: {
  snapshot: ContextSnapshot | null | undefined
  window: number | null
  compactPercent: number
}): ContextCardView {
  const { snapshot, window, compactPercent } = input
  if (!snapshot) return EMPTY_CARD

  const used = snapshot.used
  const usedText = compactTokens(used)
  const known = window !== null && Number.isFinite(window) && window > 0

  const status: ContextPill = known ? contextStatus(used, window, compactPercent) : 'unknown'
  const remaining = known ? compactRemaining(used, window, compactPercent) : 0
  const free = known ? Math.max(0, window - used) : 0

  return {
    state: 'measured',
    sentence: null,
    pill: status,
    pillLabel: PILL_LABELS[status],
    pillCaption: CONTEXT_PILL_CAPTION,
    usedText,
    figure: known ? `${usedText} / ${compactTokens(window)}` : `${usedText} / ${CONTEXT_EM_DASH}`,
    usedPercentText: known ? `${wholePercent(used, window)}%` : CONTEXT_EM_DASH,
    // Clamped, and only the bar: a badge that read `100%` for a conversation over its window would state
    // the one thing the red pill exists to deny, so the figure keeps the whole truth and the fill stops
    // at the bar's end.
    fillPercent: known ? Math.min(100, wholePercent(used, window)) : 0,
    tickPercent: known ? Math.min(100, Math.max(0, compactPercent)) : null,
    // At the point exactly, the wording has already flipped: the setting is a share that is *reached*,
    // and one token over is not the first moment a reader needs the sentence.
    remainderLabel: known && remaining <= 0 ? 'Past compact point' : 'To compact point',
    remainderText: !known
      ? CONTEXT_EM_DASH
      : remaining > 0
        ? `${compactTokens(remaining)} tokens`
        : `${compactTokens(-remaining)} tokens over ${CONTEXT_EM_DASH} consider a new session`,
    categories: CATEGORY_KEYS.map((key) => ({
      key,
      label: CATEGORY_LABELS[key],
      tokensText: compactTokens(snapshot[key]),
      percentText: known ? `${wholePercent(snapshot[key], window)}%` : CONTEXT_EM_DASH,
    })),
    freeLabel: 'Free space',
    freeText: known ? compactTokens(free) : CONTEXT_EM_DASH,
    freeCaption: known ? `${wholePercent(free, window)}% of the window` : CONTEXT_EM_DASH,
    footnote: CONTEXT_ESTIMATOR_FOOTNOTE,
    pointed: known ? null : CONTEXT_WINDOW_POINTER,
  }
}
