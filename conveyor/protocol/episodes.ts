import { z } from 'zod'
import { sanitize, truncateBytes } from './memory'
import type { TranscriptSnapshot, TranscriptTurn, TranscriptToolStep } from './transcript'

/**
 * Episodes — the bounded, sanitized record of one completed turn, and the one page per session that
 * collects them.
 *
 * This file is the rules half: what one turn contributes to an episode, what is deliberately left out,
 * how a block is rendered, parsed and ordered. It is pure and free of electron and fs for the reason
 * `protocol/memory.ts` is: the interesting parts are the shapes rather than the disk, so a suite can
 * call in here without a filesystem or a dialog in the way.
 *
 * The field set is a decision about the next turn rather than a record of the last one. An episode
 * carries the question, the tools that ran and how the turn ended — never an output, an argument, a
 * plan title, an error or an image. A later turn has to be able to act on what it reads here, and a
 * transcript replayed into the prompt is exactly the context this feature exists to avoid.
 */

/**
 * The most bytes one rendered block may carry, heading and marker included, after sanitization.
 *
 * A block is standing context on the next turn rather than a transcript of the last one: enough to
 * say what was asked, what ran and how the turn ended, and never enough to carry an output, a plan
 * title or an argument value across the line `sanitize` draws.
 */
export const MAX_EPISODE_BYTES = 1024

/** Characters of the nearest preceding question a block carries, after whitespace is collapsed. */
export const MAX_EPISODE_ASK_CHARS = 240

/** Tool calls a block lists by name and status. The rest are counted, never named. */
export const MAX_EPISODE_TOOLS = 12

/** Combo members a block names as moved on from. The walk itself is already bounded. */
export const MAX_EPISODE_COMBO_ATTEMPTS = 4

/** The most bytes one session's episode page may hold. Over it, the oldest whole blocks are dropped. */
export const MAX_EPISODE_PAGE_BYTES = 128 * 1024

/** The most blocks one page keeps, newest first. The oldest go whole rather than truncated. */
export const MAX_EPISODES_PER_PAGE = 40

/** The directory the episode pages live in, beside the four canonical page files and `index.json`. */
export const EPISODE_PAGE_DIR = 'episodes'

/**
 * A session id is the page's filename segment, held to the same UUID rule the transcript uses
 * (`sessions.ts`'s input schema and the store's `sessionIdSchema`). The shape excludes separators,
 * dots and traversal segments by construction, so a crafted id can never name a file elsewhere.
 */
export const EPISODE_SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/

/** The one closing cause a stored turn can name, read off the transcript's own notice. */
export type EpisodeCause = NonNullable<TranscriptTurn['endNotice']>['cause']

/** One tool call, by name and settled status. The output, the arguments and the code never travel. */
export interface EpisodeTool {
  tool: string
  status: TranscriptToolStep['status']
}

/** How the turn ended, as counts and flags rather than as prose or a stored failure. */
export interface EpisodeOutcome {
  cause?: EpisodeCause
  midWork: boolean
  unfinishedSteps?: number
  continuations: number
  plan: { done: number; total: number } | null
}

/** Who served a turn and which members the walk moved on from. */
export interface EpisodeCombo {
  name: string
  providerId: string
  modelId: string
  attempts: Array<{ providerId: string; modelId: string; kind: 'skipped' | 'failed' }>
}

/** One extracted episode: the ruled field set, and nothing else. */
export interface Episode {
  sessionId: string
  turnId: string
  capturedAt: number
  ordinal: number
  ask: string
  tools: EpisodeTool[]
  toolsMore: number
  outcome: EpisodeOutcome
  combo: EpisodeCombo | null
}

/** One block on a page, with the marker's facts parsed back out for ordering and drawing. */
export interface EpisodeBlock {
  sessionId: string
  turnId: string
  capturedAt: number
  ordinal: number
  text: string
}

/** One episode row, as the panel draws it and the store mirrors it. Read-only by construction. */
export const memoryEpisodeRowSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  capturedAt: z.number(),
  ordinal: z.number().int().nonnegative(),
  ask: z.string(),
})

export type MemoryEpisodeRow = z.infer<typeof memoryEpisodeRowSchema>

/**
 * Extract the one turn an episode describes, or null when the turn is not one worth keeping.
 *
 * The gates are about what a saved transcript can legitimately contain at a moment that is not a turn
 * end: a compacted summary is not work somebody asked for, a call still `running`, `awaiting` or
 * `queued` is a turn that has not ended, and a turn with neither prose nor tools is nothing that
 * happened. `interrupted` is deliberately *not* refused: it is how a call nobody decided is written
 * down, and the turn it belongs to is over.
 *
 * `capturedAt` is main's capture clock, passed in so the rule stays free of a hidden `Date.now()` in a
 * suite. No other time is recorded: a transcript has no per-turn timestamp to copy, and inventing one
 * would date the work from when the file was written rather than when it ran.
 */
export function extractEpisode(
  sessionId: string,
  snapshot: TranscriptSnapshot,
  turnId: string,
  capturedAt: number = Date.now()
): Episode | null {
  const index = snapshot.turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return null

  const turn = snapshot.turns[index]
  if (turn.role !== 'assistant') return null
  if ((turn.summarizesTurns?.length ?? 0) > 0) return null
  if (turn.steps.some((step) => step.status === 'running' || step.status === 'awaiting' || step.status === 'queued')) {
    return null
  }
  if (turn.content.trim() === '' && turn.steps.length === 0) return null

  const notice = turn.endNotice
  const plan = turn.plan ?? []
  const served = notice?.combo ? servedCombo(notice.combo) : null

  return {
    sessionId,
    turnId,
    capturedAt,
    ordinal: index + 1,
    ask: nearestAsk(snapshot.turns, index),
    tools: turn.steps.slice(0, MAX_EPISODE_TOOLS).map(({ tool, status }) => ({ tool, status })),
    toolsMore: Math.max(0, turn.steps.length - MAX_EPISODE_TOOLS),
    outcome: {
      ...(notice?.cause === undefined ? {} : { cause: notice.cause }),
      midWork: notice?.midWork === true,
      ...(notice?.unfinishedSteps === undefined ? {} : { unfinishedSteps: notice.unfinishedSteps }),
      continuations: turn.continuations?.length ?? 0,
      plan:
        plan.length === 0 ? null : { done: plan.filter((step) => step.status === 'done').length, total: plan.length },
    },
    combo: served,
  }
}

/**
 * The last assistant turn on the checked-out trail, which is the turn a turn-end save just wrote.
 *
 * Null rather than the nearest guess when there is no answer to capture: a save with no turns at all
 * is the auto-approve-only write, and a save whose trail ends on a question is not a completed turn.
 */
export function latestEpisodeTurnId(snapshot: TranscriptSnapshot): string | null {
  for (let index = snapshot.turns.length - 1; index >= 0; index--) {
    if (snapshot.turns[index].role === 'assistant') return snapshot.turns[index].id
  }
  return null
}

/** The nearest preceding question, collapsed to one line and cut to the ask bound. */
function nearestAsk(turns: readonly TranscriptTurn[], before: number): string {
  for (let index = before - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn.role !== 'user') continue
    // A compaction summary is user-role but is not a question anybody asked.
    if ((turn.summarizesTurns?.length ?? 0) > 0) continue
    const collapsed = turn.content.replace(/\s+/g, ' ').trim()
    if (collapsed !== '') return collapsed.slice(0, MAX_EPISODE_ASK_CHARS)
  }
  return ''
}

/** Who answered, and the members the walk moved on from, bounded to the ruled count. */
function servedCombo(combo: NonNullable<NonNullable<TranscriptTurn['endNotice']>['combo']>): EpisodeCombo | null {
  const served = combo.requests.at(-1)
  if (!served) return null
  return {
    name: combo.name,
    providerId: served.providerId,
    modelId: served.modelId,
    attempts: combo.attempts.slice(0, MAX_EPISODE_COMBO_ATTEMPTS).map(({ providerId, modelId, kind }) => ({
      providerId,
      modelId,
      kind,
    })),
  }
}

/**
 * Render one episode as the page block that is stored, sanitized and cut to `MAX_EPISODE_BYTES`.
 *
 * Sanitizing the rendered block rather than each field is what makes the byte bound true of what is
 * stored: a redaction marker is bytes too, and a block cut before the markers were substituted could
 * keep half a secret while claiming to be under the cap. The marker leads the block, so a cut can only
 * lose the tail of a body, never the key that makes the block supersede in place.
 */
export function renderEpisodeBlock(episode: Episode, homeDir: string): string {
  const lines = [
    `<!-- episode turn=${episode.turnId} at=${new Date(episode.capturedAt).toISOString()} -->`,
    `## Episode ${episode.ordinal}`,
    `- ask: ${episode.ask}`,
    `- tools: ${toolsLine(episode.tools, episode.toolsMore)}`,
    `- outcome: ${outcomeLine(episode.outcome)}`,
  ]
  if (episode.combo !== null) lines.push(`- combo: ${comboLine(episode.combo)}`)
  return truncateBytes(sanitize(lines.join('\n'), homeDir), MAX_EPISODE_BYTES)
}

function toolsLine(tools: readonly EpisodeTool[], more: number): string {
  if (tools.length === 0) return 'none'
  const pairs = tools.map((tool) => `${tool.tool}:${tool.status}`).join(', ')
  return more > 0 ? `${pairs} (+${more} more)` : pairs
}

function outcomeLine(outcome: EpisodeOutcome): string {
  const parts: string[] = []
  if (outcome.cause !== undefined) parts.push(`cause=${outcome.cause}`)
  if (outcome.midWork) parts.push('mid-work')
  if (outcome.unfinishedSteps !== undefined) parts.push(`unfinished=${outcome.unfinishedSteps}`)
  parts.push(`continuations=${outcome.continuations}`)
  if (outcome.plan !== null) parts.push(`plan=${outcome.plan.done}/${outcome.plan.total}`)
  return parts.join(' ')
}

function comboLine(combo: EpisodeCombo): string {
  const served = `${combo.name} via ${combo.providerId}/${combo.modelId}`
  if (combo.attempts.length === 0) return served
  const moved = combo.attempts.map((attempt) => `${attempt.providerId}/${attempt.modelId} (${attempt.kind})`).join(', ')
  return `${served}; moved on from ${moved}`
}

/**
 * The marker every block starts with. The whole page is split on it, which is what makes a re-save of
 * one turn a replacement rather than an append, and what lets a block be dropped whole at the cap.
 */
const EPISODE_MARKER = /^<!-- episode turn=(\S+) at=(\S+) -->\s*$/gm

/** Split one page into its blocks, each carrying the marker's facts. */
export function parseEpisodeBlocks(page: string, sessionId: string): EpisodeBlock[] {
  const markers: Array<{ start: number; turnId: string; at: string }> = []
  EPISODE_MARKER.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EPISODE_MARKER.exec(page)) !== null) {
    markers.push({ start: match.index, turnId: match[1], at: match[2] })
  }

  const blocks: EpisodeBlock[] = []
  for (let index = 0; index < markers.length; index++) {
    const start = markers[index].start
    const end = index + 1 < markers.length ? markers[index + 1].start : page.length
    const text = page.slice(start, end).trim()
    const capturedAt = Date.parse(markers[index].at)
    const heading = /^## Episode (\d+)\s*$/m.exec(text)
    blocks.push({
      sessionId,
      turnId: markers[index].turnId,
      capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
      ordinal: heading === null ? 0 : Number(heading[1]),
      text,
    })
  }
  return blocks
}

/** The row a block draws as: the same ordering facts, and the question it carried. */
export function episodeRowFromBlock(block: EpisodeBlock): MemoryEpisodeRow {
  const ask = /^- ask: (.*)$/m.exec(block.text)?.[1] ?? ''
  return {
    sessionId: block.sessionId,
    turnId: block.turnId,
    capturedAt: block.capturedAt,
    ordinal: block.ordinal,
    ask,
  }
}
