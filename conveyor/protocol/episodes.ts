import { z } from 'zod'
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
 * Declaration-only for the red pins: every body below answers the empty value until the green commit
 * fills it in. Nothing imports from here yet, which is what makes the red honest — the suites fail on
 * their assertions rather than on a missing module.
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

/** A session id is the page's filename segment, held to the same UUID rule the transcript uses. */
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

/** Extract the one turn an episode describes, or null when the turn is not one worth keeping. */
export function extractEpisode(
  _sessionId: string,
  _snapshot: TranscriptSnapshot,
  _turnId: string,
  _capturedAt: number = Date.now()
): Episode | null {
  return null
}

/** The last assistant turn in the checked-out trail, which is the turn a turn-end save just wrote. */
export function latestEpisodeTurnId(_snapshot: TranscriptSnapshot): string | null {
  return null
}

/** Render one episode as the page block that is stored, sanitized and cut to `MAX_EPISODE_BYTES`. */
export function renderEpisodeBlock(_episode: Episode, _homeDir: string): string {
  return ''
}

/** Split one page into its blocks, each carrying the marker's facts. */
export function parseEpisodeBlocks(_page: string, _sessionId: string): EpisodeBlock[] {
  return []
}

/** The row a block draws as: the same ordering facts, and the question it carried. */
export function episodeRowFromBlock(_block: EpisodeBlock): MemoryEpisodeRow {
  return { sessionId: '', turnId: '', capturedAt: 0, ordinal: 0, ask: '' }
}
