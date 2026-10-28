import type { HistoryMessage } from '@/conveyor/modules/llm-engine'
import type { FileDiff } from '@/conveyor/protocol/diff'
import type { ImageAttachmentRef } from '@/conveyor/protocol/image-attachments'
import type { McpConsent } from '@/conveyor/protocol/mcp-tools'
import { normalizePlan, reconcilePlanOnTurnEnd, type PlanStep } from '@/conveyor/protocol/plan'
import { summarizedIds } from '@/conveyor/protocol/truncate'
import { liveMessageVersion, saysTheSameVersion } from '@/conveyor/protocol/message-versions'
import {
  AUTO_CONTINUE_MAX,
  isResumable,
  midWorkNotice,
  planUnfinishedNotice,
  TURN_END_CAUSES,
  type TurnEndCause,
} from '@/conveyor/protocol/turn-end'

/** The call exactly as the model sent it, as the pause hands it over. */
export interface PendingCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * The renderer's model of an agent run.
 *
 * The agent streams chunks, and the UI has to turn them into turns: prose becomes the assistant's
 * answer, and every tool call becomes a card that shows what was asked for, whether it was allowed,
 * and what came back. That translation is the logic worth testing, so it lives here rather than
 * inside the component — the same split as `terminal-theme.ts`.
 *
 * Anything that is not text or a tool step is only meaningful to the component (the pause carries
 * history, `done` carries a reason), so the reducer deliberately reports only what it understands.
 */

/** One tool invocation as the transcript shows it. */
export interface ToolStep {
  callId: string
  tool: string
  args: Record<string, unknown>
  /**
   * 'running' until a result or a decision changes it.
   *
   * 'awaiting' and 'queued' are the two halves of a consent pause: the call being decided is
   * 'awaiting', and the others in the same frame are 'queued' behind it. They are distinct states
   * rather than one because only the awaiting call may be actioned — a queue that looked uniform
   * would invite the batch approval that consent is per call to prevent.
   *
   * 'interrupted' is the terminal state of a call that will never be decided: the pause it belonged to
   * died with the process that held the run, or the turn was denied and ended where it stood. It is a
   * state of its own rather than a `denied`, because a call the user never answered is not a call the
   * user refused, and a transcript that could not tell them apart would misreport consent.
   */
  status: 'running' | 'awaiting' | 'queued' | 'interrupted' | 'denied' | 'ok' | 'failed'
  output?: string
  /** A stable failure code, for the UI to branch on. */
  code?: string
  /**
   * The change a `write_file` would make, computed in main and handed over with the pause. Present
   * only on a gated write whose baseline could be read, so the card can show what is being asked for
   * instead of only which file it touches.
   */
  diff?: FileDiff
  /**
   * Which MCP server is asking, and what the card must say to be answerable.
   *
   * It belongs to the pause rather than to the call, and it is deliberately not written down: a
   * conversation reopened tomorrow holds calls that will never be decided, and a card that still named a
   * server and previewed arguments for one of those would be showing a question nobody can answer any
   * more. The transcript drops it on the way out, exactly as it drops a `diff`.
   */
  mcp?: McpConsent
  /**
   * The engine that is asking, when this card is that engine's question rather than a call of ours.
   *
   * The marker is what makes one card serve two protocols: an engine reaches its permission questions to the
   * same shield the agent's own calls use, and what the card reads here is only who is asking and what they
   * asked about. Present only on a card built from an engine's own request, and — like `mcp` — never written to
   * the transcript: the question it belongs to is waiting in main, so a reopened conversation can hold no such
   * card, exactly as it can hold no tool call still running.
   */
  engine?: { engineId: string; engineName: string; title: string }
  /**
   * The name of the flag that let this call run without a pause, when one did.
   *
   * Unlike `mcp`, this one *is* written down: it says nothing about a decision still waiting to be
   * made — the call these marks have already run — and a conversation reopened tomorrow should still
   * show which of its calls nobody was asked about. Absent on every call that was put to the user, which
   * is where a card draws nothing.
   */
  autoApproved?: string
  /**
   * The engine that ran this call, when it was not this app's own loop.
   *
   * Written by the engine turn's own mapper rather than by the model, and stored: a conversation reopened
   * tomorrow should still show which of its calls came from an engine, and unlike the consent marker above it
   * says nothing about a decision that is still waiting. Absent on every call our own loop made, which is where
   * the card draws no such line.
   */
  via?: string
}

/**
 * One parked trail: the turn records a branch point replaced, from that turn onward.
 *
 * The live model's counterpart of the record's `TranscriptTail`, and structurally the same for the
 * same reason the turns themselves are: a snapshot is handed straight to the reducer, and a second
 * shape to keep in step would be a translation layer with nothing to translate.
 */
export interface BranchTail {
  turns: AgentTurn[]
}

/** A transcript turn. Assistant turns carry both their prose and any tool steps interleaved after it. */
export interface AgentTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  steps: ToolStep[]
  error?: string
  /**
   * The ids of the turns this turn stands for at send time, when it is a summary.
   *
   * A summary is a regular turn — role `user`, its prose the summary itself — carrying the range it
   * replaces. The turns it names stay in the transcript: they are what the seam row expands to and what
   * the file still holds, and only the send-time projection in `toHistory` leaves them out. Absent for
   * every ordinary turn, so a conversation that was never compacted sends exactly what it always sent.
   */
  summarizesTurns?: string[]
  /**
   * The project instructions file this turn was sent under, when there was one.
   *
   * The name, never the text — the file is recomputed per send and is not stored anywhere. Recorded
   * so a transcript can say what stood behind an answer, and so an export can name it.
   */
  instructionsFile?: string
  /** True when only the first 16 KB of that file was read. */
  instructionsTruncated?: boolean
  /**
   * The workspace files this turn's message attached, as paths.
   *
   * Paths only: the contents were read in main for the provider, and a transcript records the
   * conversation rather than a copy of the source tree. The order is the user's, because that is what
   * a chip row shows.
   */
  mentionPaths?: string[]
  /**
   * The images this turn's message attached, as references: where the bytes are, never the bytes.
   *
   * References for the same reason `mentionPaths` is paths — a transcript records the conversation, and
   * an image inline would multiply the size of the one file this app rewrites at every turn boundary. The
   * order is the user's, which is what the chip row beside the message shows and what the model reads the
   * parts in. Written only when the send stored something, so a message with no image is stored exactly
   * as it was before images existed.
   */
  imageRefs?: ImageAttachmentRef[]
  /**
   * The trails this turn's position has held, when it is a branch point.
   *
   * An edit and a regenerate park the tail they replace — the question, its answer, and every turn
   * after them — rather than overwriting it, and this array is where the trails that are *not* on
   * screen live, in creation order. `turns` stays the checked-out trail, so every reader of a
   * conversation reads one branch without having to know there are others.
   *
   * Written only when a turn is a branch point, so an ordinary conversation is the same object it was
   * before rewriting branched.
   */
  branchPoints?: BranchTail[]
  /**
   * Which of those trails is checked out: an index into the parked tails with this turn's own trail
   * inserted at that position, counting from zero.
   *
   * Present only beside `branchPoints`. A walk changes this number and nothing else about the history,
   * which is what keeps a branch's position its own rather than letting "newest" mean "on screen".
   */
  branch?: number
  /**
   * Files this turn's message attached that could not be included, in the order they were reported.
   *
   * Live-only, and deliberately not stored: a skip is a fact about one send — the file may be under
   * the size cap by the next one — so it is reported on the turn while the run is happening and is
   * not written to the transcript. The paths a send did attach are what a reopened conversation
   * shows, as chips, which is why those *are* stored.
   */
  contextNotices?: ContextNotice[]
  /**
   * The plan the model has declared for this turn, as the checklist shows it.
   *
   * Live while the turn runs and stored when it ends: the plan is a fact about the turn, so it lives
   * on the turn rather than beside the transcript. Absent means no plan was ever declared, which is
   * the ordinary case — a conversation that needed none renders nothing for it.
   */
  plan?: PlanStep[]
  /**
   * How this turn ended, when it ended badly enough to say so.
   *
   * Absent for the ordinary ending, which is most turns: a turn the model finished needs no record,
   * and recording one for every answer would put a row above the composer under every reply. Set from
   * the notice chunk the loop sends when the reply was cut off or the stream broke, and written to the
   * transcript, because a conversation reopened tomorrow should still say that its last answer stopped
   * in the middle.
   *
   * `resumable` is the live half of the record: only a notice this session's own run produced carries
   * it, so a card read back from disk offers no button — the run it would continue is gone. See
   * `session-transcript.ts`, which is where that distinction is written down.
   */
  endNotice?: TurnEndNotice
  /**
   * The seams where this turn picked itself up again, in the order they happened.
   *
   * A turn that stops with work left on its plan is nudged rather than ended, so the run the user reads
   * is one turn with several stretches of work in it — and a stretch that simply continues a previous
   * one would be indistinguishable from a model that rambled on in one go. These are what the
   * transcript draws those seams from, and they are recorded as facts about the turn rather than
   * inferred at draw time: only the run knows where its pieces ended.
   *
   * Each carries the count it was shown with, because the line the user reads is the loop's own account
   * of its budget and the pane is not counting anything.
   */
  continuations?: AutoContinueMark[]
}

/**
 * One point where a turn continued itself.
 *
 * `afterSteps` and `afterChars` are where the seam is: the action cards already drawn and the
 * characters of narration already written when the loop decided to continue. Together they are what
 * puts the line between the work that was interrupted and the work that picked it up, rather than at
 * the top or the bottom of the answer — a turn is cards *and* prose, so one position cannot place a
 * line inside it. Stored beside `count` rather than recomputed, because a position read back from a
 * transcript has to mean what it meant when the seam was made.
 *
 * `cause` is why the machine kept going, and it is part of the mark rather than something the reader
 * infers: a turn picked up after the provider ran out of output room is a different event from one
 * picked up after the model stopped, and the user is owed the difference — it is the only part of the
 * line that tells them whether anything is worth doing about it. Optional for one reason only: a
 * transcript saved before the loop reported a cause reads as the ending it could have had then, which
 * was a plain stop.
 */
export interface AutoContinueMark {
  /** How many continuations this turn had spent when this seam was made, counting this one. */
  count: number
  /** The budget the count is shown against, as the loop reported it. */
  max: number
  afterSteps: number
  /**
   * How much of the turn's narration had been written when this seam was made, in characters.
   *
   * The other half of where the line goes, and the half a card count cannot express: the prose is one
   * assembled string, so the only way to draw a seam inside it is to know how much of it was there when
   * the turn picked itself up. Stored for the same reason `afterSteps` is — a seam read back from disk
   * has to land where it landed live, and the reply cannot say where it was cut. Optional for the same
   * reason `cause` is: a transcript written before this build has no such offset, and the seams in it are
   * drawn with the answer's prose below them, which is the only claim such a record supports.
   */
  afterChars?: number
  /** The ending the turn was picked up after, as the loop diagnosed it. */
  cause?: TurnEndCause
}

/**
 * What a turn says about its own ending, on the turn and in the card above the composer.
 *
 * `cause` is the diagnosis of the reply — the model finished, or it was cut off, or it stopped without
 * saying anything — and it is always present, because the vocabulary is closed and every ending is one of
 * its values. `lostPending` beside it is about something else the ending has to report, so a notice whose
 * cause words nothing (`model_stop`) can still say something rather than a turn ending silently because
 * its reply arrived complete.
 */
export interface TurnEndNotice {
  cause: TurnEndCause
  resumable: boolean
  /**
   * A consent pause this process did not survive, recorded when the transcript is read back.
   *
   * Sized to one value rather than a count: there was one pause, and what the user needs told is
   * that it ended without them, not how many calls were behind it.
   */
  lostPending?: boolean
  /**
   * Work the turn left undone, as the plan's own steps counted it.
   *
   * Absent for every ending that was about the reply alone. Present for the endings where the more
   * important fact is that the task is unfinished — including, and especially, the one where the reply
   * arrived complete and the model simply stopped mid-plan.
   */
  unfinishedSteps?: number
  /**
   * A planless stop after enough tool work to be a mid-work ending rather than a short answer.
   *
   * The generic notice has no count of its own: the threshold is a floor, and the transcript already
   * shows the tools that ran. It is separate from `unfinishedSteps` because there is no plan to count,
   * and separate from the cause copy because `model_stop` is ordinarily the ending that says nothing.
   */
  midWork?: boolean
}

/**
 * The code a card reads to know its call was never decided, and why.
 *
 * A stable code rather than a sentence: the wording belongs to the card, and a step that merely says
 * `interrupted` cannot be told apart from one whose turn ran out before its call was reached. Branching
 * on a code is the rule the rest of the app's failures follow, and this is a failure to decide.
 *
 * Two codes rather than one because the two reasons are different news: a pause the process did not
 * survive ended without the user, and a pause the user ended themselves did not. Neither is a refusal,
 * so neither is a `denied`.
 */
export const LOST_PAUSE_CODE = 'PAUSE_LOST'
export const ABANDONED_PAUSE_CODE = 'PAUSE_ABANDONED'

/** A call the user was asked about and never answered, as the two states a pause leaves it in. */
export function isUndecidedPause(step: { status: string }): boolean {
  return step.status === 'awaiting' || step.status === 'queued'
}

/**
 * Mark the calls a frame never got to as never decided.
 *
 * Called when a turn ends at the head of a frame — a denial, or the user stopping the run. The
 * provider's contract requires an answer for every call the frame declared, and a turn that has ended
 * cannot give one; what it can do is stop claiming the question is still open. Recording them as
 * undecided is what keeps a transcript from showing a decision waiting on a process that has moved on.
 */
export function abandonUndecidedCalls(turns: AgentTurn[], turnId: string, code: string): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => ({
    ...turn,
    steps: turn.steps.map((step) =>
      isUndecidedPause(step) ? { ...step, status: 'interrupted' as const, code } : step
    ),
  }))
}

/** A file a send asked for that could not be attached, named with the code main reported. */
export interface ContextNotice {
  path: string
  code: string
}

/**
 * What the reducer learned from one chunk.
 *
 * `approval` is reported rather than acted on: the reducer is pure, so it describes the pause and
 * lets the component decide whether it is already handling one.
 */
export interface AgentChunkEffect {
  textDelta?: string
  /**
   * A file that could not be included in this send.
   *
   * Reported rather than acted on, like `approval`: the reducer describes it and the component decides
   * how to say so.
   */
  contextNotice?: { path: string; code: string }
  approval?: {
    /** The one call this decision is about. The rest of `calls` are queued behind it. */
    callId: string
    tool: string
    messages: HistoryMessage[]
    /**
     * The frame's calls still awaiting a decision, this one first, as the model sent them. Only the
     * head is actioned; the others are carried so the card can show what is coming and so the run
     * re-enters with the model's own calls rather than a rebuild of them.
     */
    calls: PendingCall[]
    steps: number
    /**
     * Auto-continuations the turn had already spent when it paused.
     *
     * Carried for the same reason the plan is: the run behind the pause does not survive its stream
     * ending, and the budget belongs to the turn rather than to one generator. A resumed turn that came
     * back with a fresh budget could continue itself past the cap every time the model asked for a
     * permission.
     */
    continuations: number
    /** The change a gated `write_file` would make, when main could compute one. */
    diff?: FileDiff
    /**
     * The plan the turn had in hand when it paused.
     *
     * Carried so the resumed run is the same turn: the pane hands it straight back on the decision,
     * or the turn would come back with an empty plan and finish mid-plan without saying so.
     */
    plan: PlanStep[]
  }
  done?: { reason: 'complete' | 'max_steps' }
  /**
   * How the turn's reply ended, reported for every ending including the ordinary one.
   *
   * Reported rather than acted on, like every other effect here: the component is the side that
   * knows whether an ending is worth saying anything about, and for `model_stop` the answer is
   * nothing at all.
   */
  turnEnd?: { cause: TurnEndCause }
  /**
   * A turn that died, with the flag the Continue button reads.
   *
   * Separate from `turnEnd` because the two are shown differently: the cause is the diagnosis, and
   * this is the decision to put it in front of the user.
   */
  turnEndNotice?: TurnEndNotice
}

let counter = 0

/**
 * Continue the turn numbering after a rehydrated transcript.
 *
 * Ids are `<prefix>-<n>` and the counter is module-level, so reopening a saved conversation would
 * otherwise restart at one and hand new turns the ids already in the file — after which a chunk
 * addressed by turn id could land on the wrong turn, and two turns would share a React key.
 * Called when a transcript is loaded; it only ever moves the counter forward.
 */
export function resumeTurnNumbering(turns: readonly AgentTurn[]): void {
  for (const turn of turns) {
    const match = /-(\d+)$/.exec(turn.id)
    if (!match) continue
    const n = Number(match[1])
    if (Number.isFinite(n) && n > counter) counter = n
  }
}

/** Ids are local to the transcript; nothing outside it reads them. */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/**
 * Whether a transcript was cut off mid-turn.
 *
 * A step still marked `running` is the signature: nothing can still be running in a process that has
 * restarted. An `awaiting` step is deliberately not counted — a pause for approval is a legitimate
 * state, even though the pause itself is never persisted.
 */
export function isInterrupted(turns: readonly AgentTurn[]): boolean {
  return turns.some((turn) => turn.steps.some((step) => step.status === 'running'))
}

/**
 * Whether a diff arrived well enough formed to render.
 *
 * The chunk crosses IPC, so it is untrusted input here: a malformed diff must leave the card showing
 * the call rather than crash the turn that is waiting on the user.
 */
function isFileDiff(value: unknown): value is FileDiff {
  if (!value || typeof value !== 'object') return false
  const candidate = value as FileDiff
  return Array.isArray(candidate.lines) && typeof candidate.added === 'number' && typeof candidate.removed === 'number'
}

/**
 * The MCP consent a pause carries, read through the same suspicion as everything else that crosses IPC.
 *
 * A block missing the two facts the card is *for* — which server, which tool — is dropped rather than
 * half-rendered: the user is being asked to trust a process they cannot see, and a card naming the wrong
 * server, or none, would be worse than a card that showed only the call and said nothing about where it
 * would run. A scope or trust state this build cannot name is read as unknown, because those two are
 * labels on a decision, and a label is allowed to be missing where the decision is not.
 */
function readMcpConsent(value: unknown): McpConsent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const serverId = typeof candidate.serverId === 'string' ? candidate.serverId : ''
  const toolName = typeof candidate.toolName === 'string' ? candidate.toolName : ''
  if (!serverId || !toolName) return undefined

  const scope = candidate.scope === 'user' || candidate.scope === 'project' ? candidate.scope : null
  const trust =
    candidate.trust === 'matched' || candidate.trust === 'mismatched' || candidate.trust === 'absent'
      ? candidate.trust
      : null

  return {
    serverId,
    toolName,
    scope,
    trust,
    argsPreview: typeof candidate.argsPreview === 'string' ? candidate.argsPreview : '',
  }
}

/**
 * Whether a turn already carries a card for one call.
 *
 * Asked before a pause materialises its own card, so a call the fragments did announce keeps the step
 * it already has — with the args it was announced with — rather than gaining a second one.
 */
function hasStep(turns: readonly AgentTurn[], turnId: string, callId: string): boolean {
  return turns.find((turn) => turn.id === turnId)?.steps.some((step) => step.callId === callId) === true
}

/**
 * A call's arguments, for a card built from the pause rather than from the call's own fragment.
 *
 * Lenient for the same reason `argsForDisplay` in the loop is: malformed arguments are the
 * execution's problem to report, and a card with no arguments is still a card to decide on.
 */
function callArgs(call: PendingCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { raw: call.function.arguments }
  }
}

/**
 * The conversation history as main expects it: text turns, with a turn's image references beside them.
 *
 * Tool steps are deliberately excluded. The agent owns the provider-shaped history (with its
 * `tool_calls` and `tool` turns) and hands it back on a pause, so rebuilding it here would be a
 * second source of truth that could disagree with the first.
 *
 * Compaction is applied here and only here: a turn named by some summary turn's `summarizesTurns` is
 * left out of what is sent, and the summary turn that named it travels in its place. That is the one
 * place the two readings of a transcript part company — the pane and the file keep every turn, the
 * send gets the summary and the turns after it — which is why the projection is a rule about the list
 * rather than a rewrite of it. A transcript with no summary turn projects every turn, exactly as before.
 *
 * A turn's `imageRefs` travel with it, and they are references rather than pictures: main resolves each
 * one against the attachment store at the moment a request is built, so what crosses this boundary is
 * an id, a name, a media type and a size — never the bytes, which would multiply the size of everything
 * a send carries and would be a copy that could disagree with what the store holds. The key is written
 * only when there is something in it, so a message with no image is the same object it was before
 * images existed, which is what `tests/ui/agent-session-test.ts` pins by equality.
 */
export function toHistory(turns: AgentTurn[]): HistoryMessage[] {
  const summarized = new Set(summarizedIds(turns))
  return turns
    .filter((t) => !t.error && !summarized.has(t.id))
    .map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.imageRefs && t.imageRefs.length > 0 ? { images: t.imageRefs.map((ref) => ({ ...ref })) } : {}),
    }))
}

/** Replace one turn, leaving the identity of every other turn untouched so memo can skip them. */
function replaceTurn(turns: AgentTurn[], id: string, mutate: (turn: AgentTurn) => AgentTurn): AgentTurn[] {
  const index = turns.findIndex((t) => t.id === id)
  if (index === -1) return turns
  const next = turns.slice()
  next[index] = mutate(next[index])
  return next
}

function appendText(turns: AgentTurn[], turnId: string, text: string, paragraph: boolean): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => ({ ...turn, content: joinNarrationChunk(turn.content, text, paragraph) }))
}

function updateStep(
  turns: AgentTurn[],
  turnId: string,
  callId: string,
  mutate: (step: ToolStep) => ToolStep
): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => {
    const index = turn.steps.findIndex((s) => s.callId === callId)
    if (index === -1) return turn
    const steps = turn.steps.slice()
    steps[index] = mutate(steps[index])
    return { ...turn, steps }
  })
}

/**
 * The steps with `step` in place of the one that already carries its call id, appended when it is new.
 *
 * One call is one card for the whole of its life, however many times a run announces it: the loop
 * announces each call as it reaches it, and a call that waited behind a decision is reached twice —
 * once by the pause that held it, and once by the walk that came back for it.
 */
function upsertStep(steps: ToolStep[], step: ToolStep): ToolStep[] {
  const index = steps.findIndex((existing) => existing.callId === step.callId)
  if (index === -1) return [...steps, step]
  const next = steps.slice()
  next[index] = step
  return next
}

/**
 * The break between two pieces of narration, as the bubble's markdown reads it.
 *
 * A blank line, not a newline: the prose is rendered as markdown, where a single newline is a line
 * break *inside* one paragraph and only an empty line starts a new one. Two trailing spaces would be
 * the other way to write it and would be invisible in the source, which is why it is a constant here.
 */
export const NARRATION_BREAK = '\n\n'

/**
 * Append one streamed text chunk to the narration assembled so far.
 *
 * A model narrates between its tool calls — "let me look at the parser", then a call and its result,
 * then "the bug is on line 12" — and those two pieces of commentary used to arrive here as one string,
 * so a multi-step answer rendered as a single run-on wall with the cards interleaved through it. The
 * panel marks the seam (`paragraph`) because it is the side that sees the stream in order; this is
 * where the seam becomes a break.
 *
 * Why the join is conditional rather than universal: within one piece the provider splits a sentence
 * wherever its own token boundaries fall, so `Read` + `ing now.` must still be `Reading now.`. Joining
 * every pair of chunks would shred every answer into fragments — the opposite defect, and the reason
 * "always join" is not the fix.
 *
 * Trailing whitespace on the assembled side is absorbed by the break rather than left in front of it,
 * because a chunk ending in the space before a call is the ordinary case, and `…parser. \n\n` would
 * leave a ragged line in the rendered paragraph. A whitespace-only chunk is spacing and takes no break
 * in either direction: it carries no narration to separate.
 *
 * The rule reads only the two strings it is given, so the assembled message is a function of the chunks
 * and nothing else. That is also what makes a rehydrated turn render identically — the break is written
 * into the stored content rather than recomputed at draw time from state the transcript does not keep.
 */
export function joinNarrationChunk(current: string, chunk: string, paragraph: boolean): string {
  if (!chunk) return current
  if (!paragraph || current === '' || current.trim() === '' || chunk.trim() === '') return current + chunk
  return `${current.replace(/\s+$/, '')}${NARRATION_BREAK}${chunk.replace(/^\s+/, '')}`
}

/**
 * Apply one agent chunk to the transcript.
 *
 * `turnId` is the assistant turn receiving the chunk. A chunk addressed to a call id that is not in
 * the transcript is ignored rather than creating a stray step, which is what keeps a late chunk from
 * a cancelled run from appearing out of nowhere.
 */
export function applyAgentChunk(
  turns: AgentTurn[],
  turnId: string,
  chunk: unknown
): { turns: AgentTurn[]; effect: AgentChunkEffect } {
  if (!chunk || typeof chunk !== 'object') return { turns, effect: {} }
  const c = chunk as Record<string, unknown>

  switch (c.type) {
    case 'text_delta': {
      const text = typeof c.text === 'string' ? c.text : ''
      // `paragraph` is set by the panel, which is the side that sees the stream in order and so the only
      // side that knows a card landed since the last piece of prose. It is a marker, not content: the
      // reducer decides what a seam does to the message, and a chunk from main never carries it.
      const paragraph = c.paragraph === true
      return { turns: appendText(turns, turnId, text, paragraph), effect: { textDelta: text } }
    }

    case 'project_instructions': {
      // Recorded on the turn rather than shown: the card and the prose are the conversation, and this
      // is the context it happened under. A malformed announcement is ignored like any other, so a
      // chunk from a newer build cannot put a non-string into the transcript.
      const file = typeof c.file === 'string' ? c.file : ''
      if (!file) return { turns, effect: {} }
      const truncated = c.truncated === true
      return {
        turns: replaceTurn(turns, turnId, (turn) => ({
          ...turn,
          instructionsFile: file,
          instructionsTruncated: truncated,
        })),
        effect: {},
      }
    }

    case 'tool_call_start': {
      const callId = String(c.callId)
      const tool = String(c.tool)
      const args = (c.args && typeof c.args === 'object' ? c.args : {}) as Record<string, unknown>
      // Read through `typeof`: this arrives over IPC, and a marker this reducer cannot read is no marker
      // — the card draws nothing rather than a line naming a flag nobody can be shown. Absent is the
      // ordinary case, and it is what every call that was put to the user carries.
      const autoApproved = typeof c.autoApproved === 'string' ? c.autoApproved : undefined
      // The engine that ran this call, on the same terms: an engine turn's chunks carry it, our own loop's
      // never do, and a value this reducer cannot read is no marker rather than a blank line on the card.
      const via = typeof c.via === 'string' && c.via !== '' ? c.via : undefined
      // Upsert, not append. A resumed run announces each call as its walk reaches it, and the calls
      // that walk reaches include the ones the pause was holding — which already have a card, waiting
      // its turn. Appending would put the same call in the transcript twice and split its outcome
      // across two rows; replacing keeps the one card the user has been looking at, now running.
      return {
        turns: replaceTurn(turns, turnId, (turn) => ({
          ...turn,
          steps: upsertStep(turn.steps, {
            callId,
            tool,
            args,
            status: 'running',
            ...(via ? { via } : {}),
            ...(autoApproved ? { autoApproved } : {}),
          }),
        })),
        effect: {},
      }
    }

    case 'plan': {
      // Recorded, never merged here: main merges a declaration over the plan in hand and sends the
      // result, so merging again would be a second place for the same rule to be decided — and two
      // merges can disagree. Read through `normalizePlan` because the chunk crosses IPC: a plan this
      // reducer cannot read must leave the turn with no checklist rather than an empty one.
      //
      // Replaced rather than appended, which is what makes the row the user is looking at update in
      // place instead of a second copy appearing below it.
      const plan = normalizePlan(c.plan)
      if (!plan) return { turns, effect: {} }
      return { turns: replaceTurn(turns, turnId, (turn) => ({ ...turn, plan })), effect: {} }
    }

    case 'context_notice': {
      // A file the user attached that could not be included. Reported so the chip can be marked rather
      // than the message silently losing a file the user watched themselves attach. Carries the code,
      // never a sentence: the UI says what happened in its own words.
      const path = typeof c.path === 'string' ? c.path : ''
      const code = typeof c.code === 'string' ? c.code : ''
      if (!path || !code) return { turns, effect: {} }
      return { turns, effect: { contextNotice: { path, code } } }
    }

    case 'tool_result': {
      const callId = String(c.callId)
      const ok = c.ok === true
      const output = typeof c.output === 'string' ? c.output : ''
      const code = typeof c.code === 'string' ? c.code : undefined
      return {
        turns: updateStep(turns, turnId, callId, (step) => ({
          ...step,
          status: ok ? 'ok' : 'failed',
          output,
          code,
        })),
        effect: {},
      }
    }

    case 'awaiting_approval': {
      const callId = String(c.callId)
      const messages = Array.isArray(c.messages) ? (c.messages as HistoryMessage[]) : []
      const steps = typeof c.steps === 'number' ? c.steps : 0
      const diff = isFileDiff(c.diff) ? c.diff : undefined
      const mcp = readMcpConsent(c.mcp)
      // The plan the turn paused with, read through the same rule the plan chunk uses: this crosses
      // IPC, and a resumed run is handed it back as the plan it continues from.
      const plan = Array.isArray(c.plan) ? (c.plan as PlanStep[]) : []
      // A pause without any usable call cannot be resumed, so it is not reported as one: the card
      // would otherwise sit awaiting a decision that could never be carried out.
      const calls = Array.isArray(c.calls) ? (c.calls as PendingCall[]).filter((call) => call && call.id) : []
      if (calls.length === 0) return { turns, effect: {} }

      // The head is the one call being asked about; the rest of the frame is behind it. The queue's
      // order is authoritative — it is the frame's own order, which is what the loop walks.
      const headId = calls[0].id
      let next = turns
      // The pause is the authority on what is being asked, so a call the fragments never announced is
      // carded from the pause itself. Without this the pane would hold a decision with nothing on
      // screen to decide on — the one state this whole path exists to make impossible — and it happens
      // for real whenever a frame reaches the renderer without its `tool_call_start`.
      next = updateStep(next, turnId, headId, (step) => ({
        ...step,
        status: 'awaiting',
        diff,
        ...(mcp ? { mcp } : {}),
      }))
      if (!hasStep(next, turnId, headId)) {
        const step: ToolStep = {
          callId: headId,
          tool: String(c.tool),
          args: callArgs(calls[0]),
          status: 'awaiting',
          ...(diff ? { diff } : {}),
          ...(mcp ? { mcp } : {}),
        }
        next = replaceTurn(next, turnId, (turn) => ({ ...turn, steps: [...turn.steps, step] }))
      }
      for (const call of calls.slice(1)) {
        // Carded the way the head is carded, and for the same reason: the pause is the authority on
        // what is waiting, so a call behind the decision is shown even when the stream never announced
        // it — which is now the ordinary case, because the loop stops at the gate and announces nothing
        // behind it. `queued` is a state with no outcome in it: the call is there, and it has not run.
        const queued: ToolStep = { callId: call.id, tool: call.function.name, args: callArgs(call), status: 'queued' }
        next = replaceTurn(next, turnId, (turn) => ({ ...turn, steps: upsertStep(turn.steps, queued) }))
      }
      // A count that cannot be negative or fractional, because it is a budget: a value this build cannot
      // read is nothing spent, rather than a number the loop would then have to defend itself against.
      const continuations =
        typeof c.continuations === 'number' && Number.isInteger(c.continuations) && c.continuations > 0
          ? c.continuations
          : 0
      return {
        turns: next,
        effect: {
          approval: {
            callId: headId || callId,
            tool: String(c.tool),
            messages,
            calls,
            steps,
            continuations,
            diff,
            plan,
          },
        },
      }
    }

    case 'turn_end': {
      // Reported, never recorded. Every ending is diagnosed, so the reducer has to answer for the
      // ordinary one — but a turn the model finished is the normal case, and a transcript that kept a
      // row for it would grow a field on every reply to say nothing happened. The endings that do need
      // saying arrive as the notice below.
      const cause = asTurnEndCause(c.cause)
      if (!cause) return { turns, effect: {} }
      return { turns, effect: { turnEnd: { cause } } }
    }

    case 'turn_end_notice': {
      // Recorded on the turn, which is what puts the card above the composer and what a save writes.
      // The cause is read through the vocabulary rather than trusted: the chunk crosses IPC, so a
      // value this build does not know must leave the turn untouched rather than render an unworded
      // card, and the fallback is the same forward compatibility the default case below relies on.
      const cause = asTurnEndCause(c.cause)
      if (!cause) return { turns, effect: {} }
      const resumable = c.resumable === true
      // The plan's half of the notice, when it came with one. Read as a count only: a chunk claiming
      // no unfinished steps is the same as one that said nothing, so it cannot put a card on screen
      // for a turn that owes no such news.
      const unfinishedSteps =
        typeof c.unfinishedSteps === 'number' && c.unfinishedSteps > 0 ? c.unfinishedSteps : undefined
      const midWork = c.midWork === true
      const notice: TurnEndNotice = {
        cause,
        resumable,
        ...(unfinishedSteps ? { unfinishedSteps } : {}),
        ...(midWork ? { midWork: true } : {}),
      }
      return {
        turns: replaceTurn(turns, turnId, (turn) => ({ ...turn, endNotice: notice })),
        effect: { turnEndNotice: notice },
      }
    }

    case 'auto_continue': {
      // Recorded as a seam on the turn, never as a turn of its own. The nudge the loop sends with this
      // is not in the transcript and must not be: the user did not type it, and a pane that showed it
      // as their message would be putting words in their mouth. Drawing the line where it happened takes
      // two positions, and only one of them is the chunk's: the cards drawn so far are counted here, and
      // how much prose had been written is read off the turn's own content — assembled before this chunk
      // arrives, and the only place that offset exists.
      //
      // Read defensively for the same reason the notice is: the chunk crosses IPC, so a count this
      // build cannot render (a zero, a string, a missing key) leaves the turn exactly as it was rather
      // than drawing a line that says nothing true.
      const count = typeof c.count === 'number' && c.count > 0 ? c.count : null
      if (count === null) return { turns, effect: {} }
      // The budget comes from the chunk too, because the line the user reads names both numbers and the
      // pane is not entitled to assume what the loop's cap is. The protocol's own default is the
      // fallback for a chunk that arrived without one, which keeps a renderer wired to a newer or older
      // main from drawing a line with a blank where a number belongs.
      const max = typeof c.max === 'number' && c.max > 0 ? c.max : AUTO_CONTINUE_MAX
      // And the cause, read through the vocabulary rather than trusted, exactly as the notice's is. A
      // seam whose reason this build cannot name — or which arrived without one, from a run that predates
      // this field — is still a seam: the count is what the line needs to be drawn at all, so the mark is
      // kept and the copy falls back to the ending such a mark could have had.
      const cause = asTurnEndCause(c.cause) ?? undefined

      return {
        turns: replaceTurn(turns, turnId, (turn) => ({
          ...turn,
          continuations: [
            ...(turn.continuations ?? []),
            { count, max, afterSteps: turn.steps.length, afterChars: turn.content.length, cause },
          ],
        })),
        // Nothing reported to the pane. A seam is not an event the UI has to act on — the cards and the
        // prose that follow it arrive as chunks of their own and are applied as they always were — and a
        // second copy of the fact in component state would be a second thing to keep in step with the
        // turn that already carries it.
        effect: {},
      }
    }

    case 'done': {
      const reason = c.reason === 'max_steps' ? 'max_steps' : 'complete'
      return { turns, effect: { done: { reason } } }
    }

    default:
      // Forward-compatible: a chunk type this build does not know is not an error.
      return { turns, effect: {} }
  }
}

/**
 * Read a turn-end cause out of something that crossed a boundary.
 *
 * The vocabulary is main's and the renderer's at once, so an unknown value reads as no cause at all
 * rather than as a bug: a chunk from a newer build should leave the transcript exactly as a clean
 * stop would, which is the same forward compatibility the default case above relies on.
 */
function asTurnEndCause(value: unknown): TurnEndCause | null {
  return typeof value === 'string' && (TURN_END_CAUSES as readonly string[]).includes(value)
    ? (value as TurnEndCause)
    : null
}

/**
 * Write a decision into the transcript.
 *
 * Denial is recorded as a finished step, because that is what it is: the model will be told the tool
 * was refused, so the card should stop looking like it is waiting.
 */
export function resolveDecision(turns: AgentTurn[], turnId: string, callId: string, approved: boolean): AgentTurn[] {
  return updateStep(turns, turnId, callId, (step) =>
    approved ? { ...step, status: 'running' } : { ...step, status: 'denied', output: 'Denied by you.' }
  )
}

/** Start an assistant turn for a run; the id is what every following chunk addresses. */
export function startAssistantTurn(): AgentTurn {
  return { id: nextId('assistant'), role: 'assistant', content: '', steps: [] }
}

/**
 * Start the summary turn a compaction adds at the head of the transcript.
 *
 * A regular turn, written like any other: role `user`, the summary as its prose, and the range it
 * stands for in `summarizesTurns`. Nothing about it is live — there is no run behind it and no chunk
 * will ever address its id — which is why it is created whole rather than appended to.
 */
export function startSummaryTurn(content: string, summarizesTurns: readonly string[]): AgentTurn {
  return {
    id: nextId('summary'),
    role: 'user',
    content,
    steps: [],
    summarizesTurns: [...summarizesTurns],
  }
}

export function startUserTurn(
  text: string,
  mentionPaths?: readonly string[],
  imageRefs?: readonly ImageAttachmentRef[]
): AgentTurn {
  return {
    id: nextId('user'),
    role: 'user',
    content: text,
    steps: [],
    // Written only when something was attached, so a message with nothing attached is the same turn it
    // was before mentions existed — the same reason `instructionsFile` is conditional.
    ...(mentionPaths && mentionPaths.length > 0 ? { mentionPaths: [...mentionPaths] } : {}),
    // The same rule for images, and the array is copied rather than referenced so a later edit to the
    // draft cannot reach back into a turn that has been sent. The order is the caller's: the saves were
    // dispatched in attach order and came back one per image, so this list's order is the order the user
    // chose, and nothing here sorts or keys it.
    ...(imageRefs && imageRefs.length > 0 ? { imageRefs: imageRefs.map((ref) => ({ ...ref })) } : {}),
  }
}

/**
 * Revise a user message, branching at it.
 *
 * The turn keeps its id and its place — which is what leaves the reply it was answered with addressable
 * under the id it already had — and the tail it stood at the head of is parked rather than cut. The
 * words it used to say, the answer they were given, and every turn after that are one branch, so the
 * user can read them by checking the branch out instead of watching them disappear.
 *
 * The checked-out trail this returns is the edited question plus the reply being written again for it,
 * and nothing after that reply: those later turns are answers to the words that were replaced, and
 * showing them beside a new answer would be the divergence this model exists to remove.
 *
 * The images are deliberately untouched: the editor has no image controls, so a message being revised
 * keeps the references it had.
 *
 * A save that changes nothing opens no branch at all, which `saysTheSameVersion` decides. The
 * alternative is a switcher offering a walk between two identical conversations, which is a control
 * with nothing to show.
 */
export function reviseUserTurn(
  turns: AgentTurn[],
  turnId: string,
  text: string,
  mentionPaths: readonly string[]
): AgentTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return turns

  const turn = turns[index]
  if (turn.role !== 'user') return turns

  const revised = withMessage(stripBranch(turn), text, mentionPaths)
  if (saysTheSameVersion(liveMessageVersion(turn), liveMessageVersion(revised))) return turns

  const head = branchFrom(turn, revised, turns.slice(index))
  const trail = [...turns.slice(0, index), head]
  // The reply that answered the old question is parked with it, so the new trail ends with the reply
  // this one is being written again — under the id that reply already had, which is what the run fills.
  const answered = turns[index + 1]
  if (answered && answered.role === 'assistant') trail.push(restartedReply(answered))
  return trail
}

/** The turn's message fields replaced, with the chips key present only when there are chips. */
function withMessage(turn: AgentTurn, text: string, mentionPaths: readonly string[]): AgentTurn {
  const next: AgentTurn = { ...turn, content: text }
  // Deleted rather than emptied: absence is how "no chips" is spelled in this app, and an editor that
  // removed the last one has to be able to say so rather than leaving an empty array behind.
  delete next.mentionPaths
  if (mentionPaths.length > 0) next.mentionPaths = [...mentionPaths]
  return next
}

/**
 * Answer a reply again, branching at it.
 *
 * The reply keeps its id and its place, and the tail it stood at the head of is parked: the answer it
 * used to be and every turn written after it, which were written from a conversation this run is
 * replacing. The checked-out trail is the same question plus a reply being written from nothing, so
 * nothing after the branch point is shown as if it had been derived from the new answer.
 */
export function restartReplyTurn(turns: AgentTurn[], turnId: string): AgentTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return turns

  const turn = turns[index]
  if (turn.role !== 'assistant') return turns

  const head = branchFrom(turn, restartedReply(turn), turns.slice(index))
  return [...turns.slice(0, index), head]
}

/**
 * Check out one of the trails parked at a branch point, and hand back the whole trail that results.
 *
 * A walk moves the conversation, not a bubble: the trail from the branch point onward is replaced by
 * the one checked out, so the question, the answer, and the turns after them all change together. The
 * position walked away from is parked where it was created, which is what keeps `1` meaning the same
 * trail however many times the switcher is used.
 *
 * Out of range, absent, or already checked out: nothing moves, and the transcript is returned as it
 * is rather than rebuilt around a branch that is not there.
 */
export function checkoutBranch(turns: AgentTurn[], turnId: string, position: number): AgentTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index === -1) return turns

  const head = turns[index]
  if (position - 1 === (head.branch ?? 0)) return turns

  const trails = trailsAt(head, turns.slice(index))
  const target = trails[position - 1]
  if (!target || target.length === 0) return turns

  // Every other trail stays where it was created, including the one just left — which is the whole of
  // what makes this a walk rather than a swap: the order is creation's, and only the index moves.
  const parked = trails.filter((_, at) => at !== position - 1).map((trail) => ({ turns: trail }))
  const nextHead = withBranch(target[0], parked, position - 1)
  return [...turns.slice(0, index), nextHead, ...target.slice(1)]
}

/** How many trails this turn's position has held, the checked-out one included. */
export function branchCount(turn: AgentTurn): number {
  return (turn.branchPoints?.length ?? 0) + 1
}

/** Which of them is on screen, counting from one. */
export function branchPosition(turn: AgentTurn): number {
  return (turn.branch ?? 0) + 1
}

/**
 * The turn as the checked-out head of a new branch.
 *
 * The trail being replaced keeps the position it was created at, and the new one is created last — so
 * after a rewrite the pane shows the highest number, and walking back reaches every trail that came
 * before it in the order they were made.
 */
function branchFrom(previous: AgentTurn, head: AgentTurn, live: AgentTurn[]): AgentTurn {
  const parked = trailsAt(previous, live).map((trail) => ({ turns: trail }))
  return withBranch(head, parked, parked.length)
}

/** The trails a branch point holds, in creation order, with the checked-out one at its own position. */
function trailsAt(head: AgentTurn, live: AgentTurn[]): AgentTurn[][] {
  const parked = (head.branchPoints ?? []).map((tail) => tail.turns)
  const at = Math.min(head.branch ?? 0, parked.length)
  return [...parked.slice(0, at), tailOf(live), ...parked.slice(at)]
}

/**
 * A trail as it is parked: its head carries no branch metadata of its own.
 *
 * The branch point is a position in the conversation, and the switcher is drawn from the turn that
 * holds the position — so a parked copy of that turn carrying its own list would duplicate the same
 * trails one level down every time it was branched again, which is how a transcript grows by squaring
 * rather than by branching.
 */
function tailOf(live: AgentTurn[]): AgentTurn[] {
  return [stripBranch(live[0]), ...live.slice(1)]
}

/** The turn with no branch metadata: what a parked copy holds. */
function stripBranch(turn: AgentTurn): AgentTurn {
  const next = { ...turn }
  delete next.branchPoints
  delete next.branch
  return next
}

/** The turn as a branch point, or the turn itself when there is nothing to switch to. */
function withBranch(turn: AgentTurn, branchPoints: BranchTail[], branch: number): AgentTurn {
  return branchPoints.length > 0 ? { ...turn, branchPoints, branch } : turn
}

/** The reply turn ready to be written again: a run's starting shape, under the id it already had. */
function restartedReply(turn: AgentTurn): AgentTurn {
  return { id: turn.id, role: 'assistant', content: '', steps: [] }
}

/**
 * Record that one attached file could not be included.
 *
 * Kept as data rather than prose, because `context_notice` carries a code and the wording is the
 * renderer's to choose — the rule the rest of the app's failures follow. It lands on the assistant
 * turn being filled in, which is the one the user is looking at while they wait.
 */
export function noteContextSkip(turns: AgentTurn[], turnId: string, notice: ContextNotice): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => ({
    ...turn,
    contextNotices: [...(turn.contextNotices ?? []), notice],
  }))
}

/**
 * Mark a finished turn's plan as no longer running.
 *
 * Called when a run ends — because the model answered, because the stream failed, or because the user
 * stopped it. All three mean the same thing to a plan: nothing is doing that work any more, so a step
 * left `in_progress` is recorded as `interrupted` rather than left claiming to be under way. A turn
 * with no plan is returned untouched, so this is safe to call unconditionally at every turn end.
 *
 * Not called when a run pauses for consent: a pause ends the *stream*, not the turn — the decision
 * resumes it — and a checklist that marked its own step interrupted every time the app asked a
 * question would be wrong at exactly the moment the user is reading it. A pause that *ends* rather
 * than waiting — a denial, or a process that went away — does come through here, because that turn is
 * over and nothing can still be doing its work.
 */
export function endTurnPlan(turns: AgentTurn[], turnId: string): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => (turn.plan ? { ...turn, plan: reconcilePlanOnTurnEnd(turn.plan) } : turn))
}

/**
 * End a turn in the pane: reconcile its plan, and record the notice that plan has earned.
 *
 * The renderer's half of the one turn-end path, and the same rule main's `finishTurn` applies — an
 * ending must not depend on which side happened to notice it. It is needed here because two endings
 * never reach main at all: a run the user stopped, which unwinds the stream instead of finishing it,
 * and a denial, which ends the turn where it stands. Both used to need a plan to be visible; a stopped
 * planless turn is the other case, and it now says it was stopped rather than disappearing in silence.
 *
 * A notice already on the turn is left alone: that one is the diagnosis of the reply, and a second
 * card claiming the same ending would be the same news twice. A turn whose plan is finished is left
 * alone too, which is what keeps the card off the ordinary ending.
 *
 * The cause defaults to the ordinary one, and the ordinary one words nothing: for a denial or an
 * ordinary completion there is no reply to diagnose, and naming one that did not happen would be worse
 * than saying less. An explicit `interrupted` keeps the path Turn A added, and a planless model stop
 * with real work behind it earns the generic mid-work notice from the same rule main uses. The other
 * non-ordinary causes arrive with main's notice and are not re-worded here.
 *
 * Neither is an ending the app continues by itself, and the reason is the same as the loop's: a user who
 * stopped a run has said so, and a denial is a decision. The nudge in main is for the ending nobody
 * chose — the model quitting with work still on its plan.
 */
export function endTurn(
  turns: AgentTurn[],
  turnId: string,
  cause: TurnEndCause = 'model_stop',
  options: { allowMidWork?: boolean } = {}
): AgentTurn[] {
  const ended = endTurnPlan(turns, turnId)
  const turn = ended.find((t) => t.id === turnId)
  if (!turn || turn.endNotice) return ended

  // The plan this ending is judged against is the conversation's, not only this turn's. A nudge turn
  // declares nothing of its own — the plan it is working from belongs to the turn above it, which is
  // the turn the user is reading — so reading its own plan alone reported a conversation mid-plan as
  // one with no plan at all, and the turn ended with nothing on screen. `currentPlan` is the same
  // rule the checklist draws from, reconciled here because a turn that has ended cannot have a step
  // under way: a step an earlier turn left `in_progress` is work this turn inherited, not work it is
  // doing.
  const plan = reconcilePlanOnTurnEnd(currentPlan(ended) ?? [])
  const notice = planUnfinishedNotice(plan, cause)
  if (notice) {
    return replaceTurn(ended, turnId, (t) => ({
      ...t,
      endNotice: { cause: notice.cause, resumable: notice.resumable, unfinishedSteps: notice.unfinishedSteps },
    }))
  }

  // The existing interrupted path: the run was stopped from outside, and the pane is the side that
  // knows when the Stop button caused it. The other non-ordinary causes arrive with main's notice;
  // this pane does not invent a second card for them.
  if (cause === 'interrupted') {
    return replaceTurn(ended, turnId, (t) => ({
      ...t,
      endNotice: { cause, resumable: isResumable(cause) },
    }))
  }

  // A plan is the usual witness that a stopped turn was mid-work, but a planless turn can still have
  // run enough tools to be one. The pure rule owns the threshold and the set_plan/plan fences; this
  // side only supplies what the transcript knows. This branch is for `model_stop` alone: every other
  // ending has already returned above on the terms it had. A caller that already knows the stop was a
  // different existing ending — the step ceiling or a stream failure — turns this off rather than
  // teaching the rule to infer a reason it was never given.
  if (options.allowMidWork === false) return ended
  const midWork = midWorkNotice({
    cause,
    steps: turn.steps.length,
    sawSetPlan: turn.steps.some((step) => step.tool === 'set_plan'),
    plan,
  })
  if (!midWork) return ended

  return replaceTurn(ended, turnId, (t) => ({ ...t, endNotice: midWork }))
}

/**
 * The turn-end notice the card above the composer shows: the last turn's, if it has one.
 *
 * Derived from the transcript rather than held beside it, for the same reason `currentPlan` is: the
 * turns are where a turn's ending belongs, and a second copy in component state is a second thing to
 * keep in step. The *last* turn deliberately, not the newest notice anywhere: once the user sends
 * anything, the conversation has moved on and the newest turn is the one in flight — so the card
 * clears itself by the ordinary act of continuing, in a sentence or with the button.
 */
export function currentEndNotice(turns: readonly AgentTurn[]): TurnEndNotice | null {
  return turns[turns.length - 1]?.endNotice ?? null
}

/**
 * The plan the checklist shows: the newest one any turn in this conversation declared.
 *
 * Read from the turns rather than kept beside them, so there is one place a plan lives and one thing
 * to store. The newest, because a plan is about what is being worked on now — a second message in a
 * conversation that declares a new plan replaces the one before it on screen, and the earlier turn
 * still carries its own as a record. `null` when no turn declared one, which is the state the
 * checklist renders as nothing at all.
 */
export function currentPlan(turns: readonly AgentTurn[]): PlanStep[] | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const plan = turns[index].plan
    if (plan && plan.length > 0) return plan
  }
  return null
}
