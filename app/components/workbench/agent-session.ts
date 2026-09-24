import type { ChatMessage } from '@/conveyor/modules/llm-engine'
import type { FileDiff } from '@/conveyor/protocol/diff'
import type { McpConsent } from '@/conveyor/protocol/mcp-tools'
import { normalizePlan, reconcilePlanOnTurnEnd, type PlanStep } from '@/conveyor/protocol/plan'
import {
  AUTO_CONTINUE_MAX,
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
 * inside the component — the same split as `terminal-session.ts`.
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
}

/** A transcript turn. Assistant turns carry both their prose and any tool steps interleaved after it. */
export interface AgentTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  steps: ToolStep[]
  error?: string
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
 * `cause` is the diagnosis of the reply — the model finished, or it was cut off — and it is always
 * present, because the vocabulary is closed and every ending is one of its three values. `lostPending`
 * beside it is about something else the ending has to report, so a notice whose cause words nothing
 * (`model_stop`) can still say something rather than a turn ending silently because its reply arrived
 * complete.
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
    messages: ChatMessage[]
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
 * The conversation history as the provider expects it: text turns only.
 *
 * Tool steps are deliberately excluded. The agent owns the provider-shaped history (with its
 * `tool_calls` and `tool` turns) and hands it back on a pause, so rebuilding it here would be a
 * second source of truth that could disagree with the first.
 */
export function toHistory(turns: AgentTurn[]): ChatMessage[] {
  return turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }))
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
      // Upsert, not append. A resumed run announces each call as its walk reaches it, and the calls
      // that walk reaches include the ones the pause was holding — which already have a card, waiting
      // its turn. Appending would put the same call in the transcript twice and split its outcome
      // across two rows; replacing keeps the one card the user has been looking at, now running.
      return {
        turns: replaceTurn(turns, turnId, (turn) => ({
          ...turn,
          steps: upsertStep(turn.steps, { callId, tool, args, status: 'running' }),
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
      const messages = Array.isArray(c.messages) ? (c.messages as ChatMessage[]) : []
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
      next = updateStep(next, turnId, headId, (step) => ({ ...step, status: 'awaiting', diff, ...(mcp ? { mcp } : {}) }))
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
      // row for it would grow a field on every reply to say nothing happened. The two endings that do
      // need saying arrive as the notice below.
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
      const notice: TurnEndNotice = { cause, resumable, ...(unfinishedSteps ? { unfinishedSteps } : {}) }
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

export function startUserTurn(text: string, mentionPaths?: readonly string[]): AgentTurn {
  return {
    id: nextId('user'),
    role: 'user',
    content: text,
    steps: [],
    // Written only when something was attached, so a message with nothing attached is the same turn it
    // was before mentions existed — the same reason `instructionsFile` is conditional.
    ...(mentionPaths && mentionPaths.length > 0 ? { mentionPaths: [...mentionPaths] } : {}),
  }
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
 * and a denial, which ends the turn where it stands. Both are exactly the case a plan makes visible,
 * and before this a stopped turn mid-plan went entirely unsaid.
 *
 * A notice already on the turn is left alone: that one is the diagnosis of the reply, and a second
 * card claiming the same ending would be the same news twice. A turn whose plan is finished is left
 * alone too, which is what keeps the card off the ordinary ending.
 *
 * The cause defaults to the ordinary one, and the ordinary one words nothing: for these two endings
 * there is no reply to diagnose, and naming one that did not happen would be worse than saying less.
 * What the card is about in both cases is the work.
 *
 * Neither is an ending the app continues by itself, and the reason is the same as the loop's: a user who
 * stopped a run has said so, and a denial is a decision. The nudge in main is for the ending nobody
 * chose — the model quitting with work still on its plan.
 */
export function endTurn(turns: AgentTurn[], turnId: string, cause: TurnEndCause = 'model_stop'): AgentTurn[] {
  const ended = endTurnPlan(turns, turnId)
  const turn = ended.find((t) => t.id === turnId)
  if (!turn || turn.endNotice) return ended

  const notice = planUnfinishedNotice(turn.plan ?? [], cause)
  if (!notice) return ended

  return replaceTurn(ended, turnId, (t) => ({
    ...t,
    endNotice: { cause: notice.cause, resumable: notice.resumable, unfinishedSteps: notice.unfinishedSteps },
  }))
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
