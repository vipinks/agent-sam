import { z } from 'zod'

/**
 * What a session spent: the provider's report, the running total, and the rules that price it.
 *
 * Pure, and free of module imports, for the reason the transcript protocol is: main keeps the running
 * total on a session's metadata and the renderer prices it, so both processes have to agree on the
 * shape, and neither may drag main-only code across.
 *
 * The rules live here rather than beside the tile that shows them, because each one has a boundary that
 * is easy to get subtly wrong — a percent that is not a whole number, a micro that rounds the other way,
 * a model nobody priced that must read as unknown rather than as free.
 */

// ---------------------------------------------------------------- the provider's report

/**
 * One token count, as a number this app is willing to add up.
 *
 * Whole and non-negative or absent: a provider that reported a count as a string, or as a negative, has
 * said nothing a total can be built from, and reading it as `0` would be this app inventing a
 * measurement. Absent is the honest answer, and every rule below treats it as one.
 */
function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** The counters as a provider reports them for one completion, before they are added to anything. */
export interface UsageCounters {
  prompt: number
  completion: number
  /**
   * Tokens the provider served from its cache, when it said.
   *
   * Absent rather than zero on a provider that reports no cache detail, and the distinction is load
   * bearing: `cachePercent` answers with a number for "none were cached" and with nothing at all for
   * "nobody measured", and the panel's tile draws an em dash for the second.
   */
  cached?: number
}

/**
 * Read a decoded chunk for what it cost, or null when it says nothing about cost.
 *
 * The tolerant half of the capture: every field is optional, a `usage` that is not an object or that
 * carries no usable counter is not a measurement, and a chunk with no `usage` at all — every ordinary
 * content frame — is null. Null is what keeps a turn that reported nothing from moving a total.
 *
 * The dialect is the OpenAI one: a frame bearing `usage` and no content delta is the accounting frame
 * that closes a reply. Anthropic reports the same facts on its own events and is not read here.
 */
export function parseUsage(chunk: unknown): UsageCounters | null {
  if (!chunk || typeof chunk !== 'object') return null

  const reported = (chunk as Record<string, unknown>).usage
  if (!reported || typeof reported !== 'object') return null

  const usage = reported as Record<string, unknown>
  const prompt = counter(usage.prompt_tokens)
  const completion = counter(usage.completion_tokens)
  // Neither counter is usable, so this frame is not about cost — the same as no frame at all.
  if (prompt === undefined && completion === undefined) return null

  const details = usage.prompt_tokens_details
  const cached =
    details && typeof details === 'object' ? counter((details as Record<string, unknown>).cached_tokens) : undefined

  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    ...(cached !== undefined ? { cached } : {}),
  }
}

// ---------------------------------------------------------------- the running total

/**
 * A session's spend so far, as it is persisted on the session's metadata entry.
 *
 * Additive and optional on the entry: a conversation that has never had a turn, or whose providers
 * report nothing, simply has no such key. Nothing writes zeros to say so — a stored zero would be
 * indistinguishable from a measurement of zero, which is the one thing this must not become.
 */
export const sessionUsageSchema = z.object({
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
  /** When the total last moved, in epoch milliseconds. */
  lastReportedAt: z.number().int().nonnegative(),
})

export type SessionUsage = z.infer<typeof sessionUsageSchema>

/**
 * Add one report to the running total, or hand back exactly what was there.
 *
 * `null` is the whole of the "nothing was reported" case, and it returns `previous` itself rather than a
 * re-stamped copy: a turn that reported nothing did not happen as far as cost is concerned, and a total
 * whose timestamp moved anyway would claim the app had measured something.
 *
 * Cache tokens follow the same rule one level down: they are added only once something has reported
 * them, so a conversation whose providers never mention caching keeps the absence rather than acquiring
 * a zero that would render as "0% cached".
 */
export function accumulate(
  previous: SessionUsage | undefined,
  parsed: UsageCounters | null,
  at: number
): SessionUsage | undefined {
  if (!parsed) return previous

  const cached =
    previous?.cached === undefined && parsed.cached === undefined
      ? undefined
      : (previous?.cached ?? 0) + (parsed.cached ?? 0)

  return {
    prompt: (previous?.prompt ?? 0) + parsed.prompt,
    completion: (previous?.completion ?? 0) + parsed.completion,
    ...(cached !== undefined ? { cached } : {}),
    lastReportedAt: at,
  }
}

/**
 * Read the usage key off a session's metadata entry, or undefined when it has none this build believes.
 *
 * The reading half of the additive-optional pattern: an absent key, a key of the wrong shape, and a key
 * from a newer build all leave the record valid and this returning nothing. Stripped rather than
 * defaulted, exactly as the transcript's optional keys are, so an old conversation reads as a
 * conversation rather than as a zero cost.
 */
export function readSessionUsage(record: unknown): SessionUsage | undefined {
  if (!record || typeof record !== 'object') return undefined
  const parsed = sessionUsageSchema.safeParse((record as Record<string, unknown>).usage)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------- pricing

/** What the input, its cached share and the output of one model cost, in micros per million tokens. */
export interface Rates {
  input: number
  /**
   * What a prompt token the provider served from its own cache costs.
   *
   * Cheaper than `input` on every provider that publishes such a rate, and that is the whole reason the
   * shape is a triple: a warm session's prompt is mostly hits, and a pair charging them at the input rate
   * would overstate the Cost tile by more than half on an ordinary conversation.
   */
  cacheHit: number
  output: number
}

/**
 * Published list rates for the models this app ships against, in micros per million tokens.
 *
 * Micros rather than dollars so the arithmetic is integer at the ends anyone recognises: $0.15 per
 * million *is* 150 000 micros per million, and `formatCost` puts the dollar sign back. Recorded by hand
 * at the time this table was written, which is the whole reason an override exists — a provider changes
 * its prices, and the number in a shipped build cannot change with it.
 *
 * Three numbers per model, in the order a bill reads them: a prompt token that missed the cache, a prompt
 * token that hit it, and a completion token. The DeepSeek entries are that provider's published table,
 * which is why this phase exists - the Cost tile was reading a pair and pricing a warm session as if
 * every prompt token had missed.
 */
export const RATES: Record<string, Rates> = {
  'gpt-4o-mini': { input: 150_000, cacheHit: 75_000, output: 600_000 },
  'gpt-4o': { input: 2_500_000, cacheHit: 1_250_000, output: 10_000_000 },
  'deepseek-flash': { input: 270_000, cacheHit: 70_000, output: 1_100_000 },
  'deepseek-chat': { input: 270_000, cacheHit: 70_000, output: 1_100_000 },
  'deepseek-pro': { input: 550_000, cacheHit: 140_000, output: 2_190_000 },
  'deepseek-reasoner': { input: 550_000, cacheHit: 140_000, output: 2_190_000 },
  'claude-3-5-haiku-latest': { input: 800_000, cacheHit: 80_000, output: 4_000_000 },
  'claude-3-5-sonnet-latest': { input: 3_000_000, cacheHit: 300_000, output: 15_000_000 },
}

/** The model being priced, and the triple the user has declared for it. */
export interface RateRule {
  model: string
  /** A per-provider override, which wins whenever it is there. */
  override?: Rates | null
}

/**
 * The rates to price a model with, or null when nothing knows the model.
 *
 * A declared override wins over the table, so a user who knows what their gateway charges is not argued
 * with. There is deliberately no default rate: a model nothing has priced is priced as *unknown*, which
 * is what turns into an em dash rather than into a confident zero.
 */
export function resolveRates(rule: RateRule): Rates | null {
  if (rule.override) return rule.override
  return RATES[rule.model] ?? null
}

/**
 * What a session's counters cost, in micros, at the given rates.
 *
 * The cached share of the prompt is billed at `cacheHit` and the rest at `input`, which is how every
 * provider that publishes a cache rate bills it. A record with no cache detail — or a zero, which says
 * the same thing — pays the whole prompt at the input rate: the absence of a measurement is not a
 * discount, and reading it as one would price a session below what it cost.
 *
 * No clamp on the subtraction, deliberately. `cached` is a subset of `prompt` by the provider's own
 * definition, and `accumulate` sums both, so the difference is non-negative on every record this app
 * writes.
 */
export function costMicros(totals: UsageCounters, rates: Rates): number {
  const cached = totals.cached !== undefined && totals.cached > 0 ? totals.cached : 0
  const fresh = totals.prompt - cached
  return Math.round((fresh * rates.input + cached * rates.cacheHit + totals.completion * rates.output) / 1_000_000)
}

/** How much of the prompt the provider served from its cache, as a whole percent. */
export function cachePercent(usage: UsageCounters): number | null {
  // No prompt to divide by, or no cache detail at all: nothing to report, which is not the same as
  // reporting nothing was cached.
  if (usage.prompt <= 0 || usage.cached === undefined) return null
  return Math.round((usage.cached / usage.prompt) * 100)
}

// ---------------------------------------------------------------- display

/**
 * A token count at a glance: `850`, `940k`, `8.6M`.
 *
 * One decimal place, and a whole number of the larger unit rather than an absurd count of the smaller:
 * 999 999 tokens is `1M`, not `1000k`.
 */
export function compactTokens(count: number): string {
  const tokens = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
  if (tokens < 1000) return String(tokens)
  if (tokens < 999_950) return `${Math.round(tokens / 100) / 10}k`
  return `${Math.round(tokens / 100_000) / 10}M`
}

/**
 * Micros as dollars, to four decimal places: `$0.1143`.
 *
 * Four because a single cheap turn costs a fraction of a cent, and a tile that rounded to cents would
 * show a real conversation as `$0.00`. Anything below half a tenth of a millidollar still reads as
 * `$0.0000`, which is the honest floor of this format rather than a wrong number.
 */
export function formatCost(micros: number): string {
  const value = Number.isFinite(micros) && micros > 0 ? micros : 0
  return `$${(value / 1_000_000).toFixed(4)}`
}

// ---------------------------------------------------------------- the Overview tiles

/**
 * What a custom provider's record may declare about its prices.
 *
 * The three fields the settings box writes, in the unit that box labels them in: dollars per million
 * tokens. Optional and additive, exactly like the image-support declaration beside it - a provider nobody
 * has priced carries no key, and the three are read as one declaration rather than as three independent
 * numbers.
 *
 * Dollars here and micros in `RATES`, deliberately: a price is typed the way the provider publishes it
 * - `0.15`, not `150000` - and the one conversion happens in `declaredRates`, so no tile ever has to
 * know which of the two units it is holding.
 */
export interface RateDeclaration {
  inputRate?: number
  cacheHitRate?: number
  outputRate?: number
}

/** A usable number, or null. One a person typed, and only when every side is there. */
function declaredMicros(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1_000_000)
}

/**
 * A provider's declared prices as rates this app can bill with, or null when it has declared none.
 *
 * All or nothing, and that is the load-bearing part: a declaration short of a side is not a cheap model,
 * it is an un-priced one. Reading a missing side as free would bill those tokens at nothing, and reading
 * a missing cache-hit rate as the input rate would overstate every warm session - either way looking like
 * a measurement, which is the one thing the em dash exists to prevent. So a user who knows two sides of
 * three has still not priced the model, and the Cost tile says so until they know all three.
 *
 * That is also the migration for a record written before a cached token had a rate of its own: its input
 * and output survive the read whole, because they are still what the user typed, but the declaration is
 * not one until the third field is filled in, so the shipped table prices the model meanwhile rather than
 * that silence being read as a discount.
 *
 * A declared `0` is not the same as no declaration: a model running on the user's own machine costs
 * nothing, and a person who typed that zero has priced the model and is entitled to see `$0.0000` rather
 * than an em dash.
 */
export function declaredRates(record: RateDeclaration | undefined): Rates | null {
  if (!record) return null
  const input = declaredMicros(record.inputRate)
  const cacheHit = declaredMicros(record.cacheHitRate)
  const output = declaredMicros(record.outputRate)
  if (input === null || cacheHit === null || output === null) return null
  return { input, cacheHit, output }
}

/** The four strings the Overview resident draws. */
export interface OverviewTiles {
  tokens: string
  cost: string
  cache: string
  turns: string
}

/**
 * The Overview's four tiles, derived from what the session spent and what the transcript holds.
 *
 * The whole display rule, in one pure function, so the resident itself is layout and the em dashes have
 * exactly one definition. Three of the four tiles are measurements and say so by withholding a number
 * they do not have:
 *
 * - **Tokens** and **Cache** are em dashes until a usage record exists at all, because before the first
 *   measured turn there is no zero to report — there is nothing measured, and `0` would be a claim.
 * - **Cost** is an em dash whenever the rates resolve to nothing, which includes every model missing from
 *   the shipped table and every provider the user has not priced. That is the honest reading of "this
 *   session used 940k tokens": the usage is known and the price of it is not.
 * - **Cache** is separately an em dash on a provider that never mentions caching, where tokens and cost
 *   are numbers: "none were cached" and "nobody looked" are different answers.
 * - **Turns** always renders its count. It is not a measurement of what was spent but of how much
 *   conversation there is, and a session with no measured usage still has the replies it had.
 */
export function overviewTiles(input: { usage?: UsageCounters; rates: Rates | null; turns: number }): OverviewTiles {
  const { usage, rates } = input
  const turns = Number.isFinite(input.turns) && input.turns > 0 ? Math.trunc(input.turns) : 0

  const percent = usage ? cachePercent(usage) : null

  return {
    tokens: usage ? compactTokens(usage.prompt + usage.completion) : '—',
    cost: usage && rates ? formatCost(costMicros(usage, rates)) : '—',
    cache: percent === null ? '—' : `${percent}%`,
    turns: String(turns),
  }
}
