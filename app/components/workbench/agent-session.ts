import type { ChatMessage } from '@/conveyor/modules/llm-engine'
import type { FileDiff } from '@/conveyor/protocol/diff'
import { normalizePlan, reconcilePlanOnTurnEnd, type PlanStep } from '@/conveyor/protocol/plan'

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
   */
  status: 'running' | 'awaiting' | 'queued' | 'denied' | 'ok' | 'failed'
  output?: string
  /** A stable failure code, for the UI to branch on. */
  code?: string
  /**
   * The change a `write_file` would make, computed in main and handed over with the pause. Present
   * only on a gated write whose baseline could be read, so the card can show what is being asked for
   * instead of only which file it touches.
   */
  diff?: FileDiff
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
    /** The change a gated `write_file` would make, when main could compute one. */
    diff?: FileDiff
  }
  done?: { reason: 'complete' | 'max_steps' }
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

function appendText(turns: AgentTurn[], turnId: string, text: string): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => ({ ...turn, content: turn.content + text }))
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
      return { turns: appendText(turns, turnId, text), effect: { textDelta: text } }
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
      const step: ToolStep = { callId, tool, args, status: 'running' }
      return {
        turns: replaceTurn(turns, turnId, (turn) => ({ ...turn, steps: [...turn.steps, step] })),
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
      // A pause without any usable call cannot be resumed, so it is not reported as one: the card
      // would otherwise sit awaiting a decision that could never be carried out.
      const calls = Array.isArray(c.calls) ? (c.calls as PendingCall[]).filter((call) => call && call.id) : []
      if (calls.length === 0) return { turns, effect: {} }

      // The head is the one call being asked about; the rest of the frame is behind it. The queue's
      // order is authoritative — it is the frame's own order, which is what the loop walks.
      const headId = calls[0].id
      let next = turns
      next = updateStep(next, turnId, headId, (step) => ({ ...step, status: 'awaiting', diff }))
      for (const call of calls.slice(1)) {
        next = updateStep(next, turnId, call.id, (step) => ({ ...step, status: 'queued' }))
      }
      return {
        turns: next,
        effect: { approval: { callId: headId || callId, tool: String(c.tool), messages, calls, steps, diff } },
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
 * question would be wrong at exactly the moment the user is reading it.
 */
export function endTurnPlan(turns: AgentTurn[], turnId: string): AgentTurn[] {
  return replaceTurn(turns, turnId, (turn) => (turn.plan ? { ...turn, plan: reconcilePlanOnTurnEnd(turn.plan) } : turn))
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
