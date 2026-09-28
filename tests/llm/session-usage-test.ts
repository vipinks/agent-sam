/**
 * Verifies what a session spends: the capture that asks a provider to report usage, and the pure rules
 * that price and format it — no network, no keys.
 *
 * Two halves, and they are here together because one is worthless without the other: the rules can only
 * be exercised on numbers the engine actually produced, and the engine's numbers are only worth
 * collecting if something can price them. The rules are asserted at their boundaries — a whole percent,
 * a micros rounding, a compacted scale — because a wrong-by-one display is built out of them.
 */
import { strict as assert } from 'node:assert'
import { buildRequest, extractDelta, parseSse, type StreamDelta } from '../../conveyor/modules/llm-engine'
import {
  accumulate,
  cachePercent,
  compactTokens,
  costMicros,
  declaredRates,
  formatCost,
  overviewTiles,
  parseUsage,
  readSessionUsage,
  resolveRates,
  sessionUsageSchema,
  type UsageCounters,
} from '../../conveyor/protocol/session-usage'

const results: string[] = []

/** A decoded frame shaped the way an OpenAI-dialect gateway sends it. */
function usageFrame(usage: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ choices: [], usage, ...extra })
}

/** An SSE body from whole frames, so the parser can be driven without a socket. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
      controller.close()
    },
  })
}

// ----------------------------------------------------------------- request shaping

function theRequestAsksForUsage() {
  // The flag that makes a provider send the final usage chunk at all. Without it the stream says
  // nothing about what it cost, and every tile the panel draws next turn would be empty.
  const openai = buildRequest('openai', 'sk-test', 'gpt-4o-mini', [{ role: 'user', content: 'hi' }])
  assert.deepEqual(openai.body.stream_options, { include_usage: true })

  // The same dialect, from every entry point that speaks it: the built-in table and a provider the user
  // added, since a request that asked for usage on one path and not the other would count half the app.
  assert.deepEqual(buildRequest('deepseek', 'k', 'deepseek-chat', []).body.stream_options, { include_usage: true })
  assert.deepEqual(buildRequest('openrouter', 'k', 'm', []).body.stream_options, { include_usage: true })
  assert.deepEqual(buildRequest('opencode', 'k', 'm', []).body.stream_options, { include_usage: true })
  const custom = buildRequest('local-llama', 'k', 'm', [], undefined, {
    id: 'local-llama',
    name: 'Local Llama',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    dialect: 'openai' as const,
    models: ['m'],
  })
  assert.deepEqual(custom.body.stream_options, { include_usage: true })

  // Anthropic is its own dialect and does not take this field: it reports usage on its own events, and a
  // body carrying a parameter it never documents is a request it refuses. Asserted so the two dialects
  // cannot be collapsed by a later edit that finds one of them convenient.
  const anthropic = buildRequest('anthropic', 'sk-ant', 'claude-3-5-sonnet-latest', [])
  assert.ok(!('stream_options' in anthropic.body), 'the Anthropic body carries no OpenAI-only field')

  results.push('request shaping asks for usage')
}

// ----------------------------------------------------------------- the usage frame

function theUsageFrameIsUnderstood() {
  const full = parseUsage({
    choices: [],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 340,
      prompt_tokens_details: { cached_tokens: 900 },
    },
  })
  assert.deepEqual(full, { prompt: 1200, completion: 340, cached: 900 })

  // No cache detail: the provider said nothing about cached tokens, so the key is absent rather than a
  // zero. A written zero would be this app claiming a measurement nobody made, and it is exactly what
  // `cachePercent` has to be able to tell apart from "none were cached".
  const noDetails = parseUsage({ usage: { prompt_tokens: 1200, completion_tokens: 340 } })
  assert.deepEqual(noDetails, { prompt: 1200, completion: 340 })
  assert.ok(!('cached' in (noDetails as UsageCounters)), 'an absent detail stays absent')

  // Partial: one counter reported is still a measurement.
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 50 } }), { prompt: 50, completion: 0 })

  // Nothing to measure: no usage at all, a usage that is not an object, an empty one, and counters that
  // are not usable numbers. Every one of these has to read as "no measurement" rather than as zeros.
  assert.equal(parseUsage({ choices: [{ delta: { content: 'hi' } }] }), null)
  assert.equal(parseUsage({ usage: 'nonsense' }), null)
  assert.equal(parseUsage({ usage: {} }), null)
  assert.equal(parseUsage({ usage: { prompt_tokens: -5 } }), null)
  assert.equal(parseUsage({ usage: { prompt_tokens: 'many' } }), null)
  assert.equal(parseUsage(null), null)
  assert.equal(parseUsage('[DONE]'), null)

  results.push('usage frame is understood')
}

function theParserSurfacesTheUsageChunk() {
  // A usage chunk carries no delta and no choice — which is exactly the shape the parser used to drop.
  const frame = usageFrame({
    prompt_tokens: 1200,
    completion_tokens: 340,
    prompt_tokens_details: { cached_tokens: 900 },
  })
  assert.deepEqual(extractDelta('openai', frame), {
    usage: { prompt: 1200, completion: 340, cached: 900 },
  })

  // The frame that closes a reply can carry the ending and the accounting together.
  const both = extractDelta(
    'openai',
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
  )
  assert.deepEqual(both, { finishReason: 'stop', usage: { prompt: 10, completion: 2 } })

  // Still nothing for a frame with nothing in it, and still nothing for a malformed one.
  assert.equal(extractDelta('openai', JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })), null)
  assert.equal(extractDelta('openai', '{"choices":[],"usage":'), null)

  results.push('usage frames are surfaced by the parser')
}

async function theTrailingUsageChunkArrives() {
  // The real ordering: prose, the frame that says why it stopped, then the accounting, then `[DONE]`.
  const deltas: StreamDelta[] = []
  for await (const delta of parseSse(
    sseBody([
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      usageFrame({ prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 640 } }),
      '[DONE]',
    ]),
    'openai'
  )) {
    deltas.push(delta)
  }
  assert.deepEqual(
    deltas.map((d) => (d.usage ? 'usage' : d.text ? 'text' : 'finish')),
    ['text', 'finish', 'usage']
  )
  assert.deepEqual(deltas[2].usage, { prompt: 900, completion: 120, cached: 640 })

  // Last in the stream with no trailing blank line, which is the tail the parser reads separately.
  const buffered: ReadableStream<Uint8Array> = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`)
      )
      controller.enqueue(
        new TextEncoder().encode(`data: ${usageFrame({ prompt_tokens: 4, completion_tokens: 1 })}\n\n`)
      )
      controller.close()
    },
  })
  const tail: StreamDelta[] = []
  for await (const delta of parseSse(buffered, 'openai')) tail.push(delta)
  assert.deepEqual(tail[1].usage, { prompt: 4, completion: 1 })

  results.push('a trailing usage chunk reaches the caller')
}

// ----------------------------------------------------------------- accumulation

function theRunningTotalAccumulates() {
  const first = accumulate(undefined, { prompt: 1000, completion: 200, cached: 940 }, 1_700_000_000_000)
  assert.deepEqual(first, { prompt: 1000, completion: 200, cached: 940, lastReportedAt: 1_700_000_000_000 })

  const second = accumulate(first, { prompt: 500, completion: 60 }, 1_700_000_001_000)
  assert.deepEqual(second, { prompt: 1500, completion: 260, cached: 940, lastReportedAt: 1_700_000_001_000 })

  // A turn that reported nothing leaves the accumulator exactly as it was — the same value, not a
  // re-stamped one, and never a zero that would read as a measurement of nothing.
  assert.equal(accumulate(first, null, 1_700_000_002_000), first)
  assert.equal(accumulate(undefined, null, 1), undefined)

  // Cache tokens that nobody ever reported stay unreported through every later turn.
  const thin = accumulate(undefined, { prompt: 10, completion: 5 }, 1)
  assert.deepEqual(accumulate(thin, { prompt: 1, completion: 1 }, 2), {
    prompt: 11,
    completion: 6,
    lastReportedAt: 2,
  })

  results.push('the running total accumulates')
}

// ----------------------------------------------------------------- pricing rules

function theCachePercentIsWhole() {
  assert.equal(cachePercent({ prompt: 1000, completion: 10, cached: 940 }), 94)
  // Rounded, not truncated: 33.3 percent is 33, and the rule is stated once here rather than in a tile.
  assert.equal(cachePercent({ prompt: 3, completion: 0, cached: 1 }), 33)
  // Nothing was cached, and that is a measurement worth showing as zero.
  assert.equal(cachePercent({ prompt: 200, completion: 0, cached: 0 }), 0)
  // No prompt to divide by, or no cache detail at all: the tile draws an em dash rather than a number
  // this module invented.
  assert.equal(cachePercent({ prompt: 0, completion: 40, cached: 0 }), null)
  assert.equal(cachePercent({ prompt: 500, completion: 40 }), null)

  results.push('cache percent is a whole number or nothing')
}

function theCostIsMicros() {
  // Micros per million tokens, so the rates a user will type next turn are the numbers a provider
  // publishes, four decimal places wider.
  const gptMini = { input: 150_000, output: 600_000 }
  assert.equal(costMicros({ prompt: 1_000_000, completion: 0 }, gptMini), 150_000)
  assert.equal(costMicros({ prompt: 0, completion: 1_000_000 }, gptMini), 600_000)
  assert.equal(costMicros({ prompt: 1_000_000, completion: 1_000_000 }, gptMini), 750_000)
  assert.equal(costMicros({ prompt: 0, completion: 0 }, gptMini), 0)
  // Rounded to the nearest micro, because a token count is not a whole number of micros.
  assert.equal(costMicros({ prompt: 762, completion: 0 }, gptMini), 114)
  assert.equal(costMicros({ prompt: 0, completion: 1 }, { input: 1, output: 1 }), 0)

  results.push('cost is computed in micros')
}

function theRatesResolve() {
  // A model in the table prices itself.
  const known = resolveRates({ model: 'gpt-4o-mini' })
  assert.ok(known !== null, 'a known model has rates')
  assert.equal(known.input, 150_000)
  assert.equal(known.output, 600_000)

  // An override wins, on a known model and on an unknown one.
  const override = { input: 1, output: 2 }
  assert.deepEqual(resolveRates({ model: 'gpt-4o-mini', override }), override)
  assert.deepEqual(resolveRates({ model: 'nobody-knows-this', override }), override)

  // No default rate and no guessing: an unknown model with nothing declared is priced as unknown, and
  // that absence is what the panel draws as an em dash rather than as a zero cost.
  assert.equal(resolveRates({ model: 'nobody-knows-this' }), null)
  assert.equal(resolveRates({ model: '' }), null)

  results.push('rates resolve, override first')
}

function theFormattingIsCompactAndExact() {
  assert.equal(compactTokens(850), '850')
  assert.equal(compactTokens(940_000), '940k')
  assert.equal(compactTokens(8_600_000), '8.6M')
  assert.equal(compactTokens(0), '0')
  assert.equal(compactTokens(999), '999')
  assert.equal(compactTokens(1000), '1k')
  assert.equal(compactTokens(1_000_000), '1M')
  // Rounding up to the next unit rather than printing an absurd four-digit count of the old one.
  assert.equal(compactTokens(999_999), '1M')

  assert.equal(formatCost(114_300), '$0.1143')
  assert.equal(formatCost(0), '$0.0000')
  assert.equal(formatCost(2_500_000), '$2.5000')
  assert.equal(formatCost(1), '$0.0000')

  results.push('tokens and cost format exactly')
}

// ----------------------------------------------------------------- the metadata key

function theUsageKeyRidesTheMetadataEntry() {
  const usage = { prompt: 1500, completion: 260, cached: 940, lastReportedAt: 1_700_000_001_000 }
  const record = { id: 'a-uuid', title: 'A conversation', providerId: 'deepseek', model: 'm', usage }

  // Through JSON, the way the store is written and read back.
  assert.deepEqual(readSessionUsage(JSON.parse(JSON.stringify(record))), usage)

  // A record written before this key existed: stripped rather than defaulted, so an old conversation is
  // a valid read that happens to have nothing to say about cost.
  const old = { id: 'a-uuid', title: 'A conversation', providerId: 'deepseek', model: 'm' }
  assert.equal(readSessionUsage(old), undefined)
  assert.ok(!('usage' in old), 'nothing writes the key to say the absence')

  // A key this build cannot believe — hand-edited, or written by something else — is stripped for the
  // same reason: a half-read total would be a wrong cost presented as a measured one.
  assert.equal(readSessionUsage({ usage: { prompt: 'many', completion: 1, lastReportedAt: 2 } }), undefined)
  assert.equal(readSessionUsage({ usage: { prompt: 1, completion: 1 } }), undefined)
  assert.equal(readSessionUsage({ usage: null }), undefined)
  assert.equal(readSessionUsage(null), undefined)

  // The schema is the one thing both the store and this reader agree on.
  const parsed = sessionUsageSchema.safeParse(usage)
  assert.equal(parsed.success, true)
  assert.equal(sessionUsageSchema.safeParse({ prompt: 1, completion: 1, lastReportedAt: 2 }).success, true)
  assert.equal(sessionUsageSchema.safeParse({ prompt: -1, completion: 1, lastReportedAt: 2 }).success, false)
  assert.equal(sessionUsageSchema.safeParse({ prompt: 1.5, completion: 1, lastReportedAt: 2 }).success, false)
  assert.equal(sessionUsageSchema.safeParse({ prompt: 1, completion: 1 }).success, false)

  results.push('the usage key rides the metadata entry')
}

// ----------------------------------------------------------------- the Overview tiles

function theOverviewTilesReadWhatASessionUsed() {
  // A measured session on a priced model: the four strings the resident draws, in the formats the
  // display rules above give them. The tile is a read of those rules, not a second formatter, so the
  // cost asserted here is the rule's own answer rather than a number written out twice.
  const rates = { input: 150_000, output: 600_000 }
  const usage = { prompt: 940_000, completion: 60_000, cached: 893_000, lastReportedAt: 1_700_000_000_000 }
  const measured = overviewTiles({ usage, rates, turns: 3 })

  assert.equal(measured.tokens, '1M')
  assert.equal(measured.cost, formatCost(costMicros(usage, rates)))
  assert.equal(measured.cost, '$0.1770')
  assert.equal(measured.cache, '95%')
  assert.equal(measured.turns, '3')

  // Nothing measured yet — every conversation before its first measured turn, and every conversation
  // whose providers report nothing at all. Three em dashes, and the count beside them: the count is
  // not a measurement of what was spent, it is how many replies the transcript holds.
  const unmeasured = overviewTiles({ usage: undefined, rates, turns: 2 })
  assert.deepEqual(unmeasured, { tokens: '—', cost: '—', cache: '—', turns: '2' })

  // Measured, but nobody has priced the model: what was used is known and what it cost is not, and the
  // one tile that cannot be priced says so rather than showing a confident zero.
  const unpriced = overviewTiles({ usage, rates: null, turns: 1 })
  assert.equal(unpriced.tokens, '1M')
  assert.equal(unpriced.cost, '—')
  assert.equal(unpriced.cache, '95%')
  assert.equal(unpriced.turns, '1')

  // Measured on a provider that never mentions caching: the cache tile is an em dash while its
  // neighbours are numbers, because "nobody measured the cache" is not "nothing was cached".
  const noCache = overviewTiles({ usage: { prompt: 10, completion: 2 }, rates, turns: 0 })
  assert.equal(noCache.cache, '—')
  assert.equal(noCache.tokens, '12')
  assert.equal(noCache.turns, '0')

  results.push('the overview tiles read what a session used')
}

function theDeclaredRatesConvertAndWin() {
  // What the settings fields hold, in the unit their label names: dollars per million tokens. The table
  // prices in micros, so the declaration is converted once, here, rather than at every tile.
  assert.deepEqual(declaredRates({ inputRate: 0.15, outputRate: 0.6 }), { input: 150_000, output: 600_000 })
  assert.deepEqual(declaredRates({ inputRate: 1, outputRate: 2 }), { input: 1_000_000, output: 2_000_000 })
  // Free is a price a user can declare — a model running on their own machine — and it is not the same
  // thing as no declaration: the fields hold a zero because somebody typed one.
  assert.deepEqual(declaredRates({ inputRate: 0, outputRate: 0 }), { input: 0, output: 0 })

  // Half a declaration is not a price: a user who knows one side only has not priced the model, and the
  // cost tile has to stay an em dash rather than pricing every completion at nothing.
  assert.equal(declaredRates({}), null)
  assert.equal(declaredRates({ inputRate: 0.15 }), null)
  assert.equal(declaredRates({ outputRate: 0.6 }), null)
  assert.equal(declaredRates({ inputRate: 0.15, outputRate: Number.NaN }), null)
  assert.equal(declaredRates({ inputRate: -1, outputRate: 0.6 }), null)

  // And the resolver prefers it to the table, which is the whole reason the fields exist: a provider
  // whose prices have moved can be priced without waiting for a build.
  const declared = declaredRates({ inputRate: 0.01, outputRate: 0.02 })
  assert.ok(declared !== null, 'a whole declaration is a price')
  assert.deepEqual(resolveRates({ model: 'deepseek-chat', override: declared }), { input: 10_000, output: 20_000 })
  assert.notDeepEqual(resolveRates({ model: 'deepseek-chat' }), declared)

  results.push('a declared price is micros, and it wins over the table')
}

async function main() {
  theRequestAsksForUsage()
  theUsageFrameIsUnderstood()
  theParserSurfacesTheUsageChunk()
  await theTrailingUsageChunkArrives()
  theRunningTotalAccumulates()
  theCachePercentIsWhole()
  theCostIsMicros()
  theRatesResolve()
  theFormattingIsCompactAndExact()
  theUsageKeyRidesTheMetadataEntry()
  theOverviewTilesReadWhatASessionUsed()
  theDeclaredRatesConvertAndWin()
  console.log('session usage tests: ' + results.length + ' passed')
  for (const r of results) console.log('  pass: ' + r)
}

void main().catch((err) => {
  console.error('SESSION USAGE TEST FAILED:', err)
  process.exit(1)
})
