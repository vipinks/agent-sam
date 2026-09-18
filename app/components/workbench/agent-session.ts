import type { ChatMessage } from '@/conveyor/modules/llm-engine'

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
  /** 'running' until a result or a decision changes it. */
  status: 'running' | 'awaiting' | 'denied' | 'ok' | 'failed'
  output?: string
  /** A stable failure code, for the UI to branch on. */
  code?: string
}

/** A transcript turn. Assistant turns carry both their prose and any tool steps interleaved after it. */
export interface AgentTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  steps: ToolStep[]
  error?: string
}

/**
 * What the reducer learned from one chunk.
 *
 * `approval` is reported rather than acted on: the reducer is pure, so it describes the pause and
 * lets the component decide whether it is already handling one.
 */
export interface AgentChunkEffect {
  textDelta?: string
  approval?: {
    callId: string
    tool: string
    messages: ChatMessage[]
    /**
     * Every call waiting on this decision, as the model sent them. One decision answers the whole
     * batch, because the provider requires a result for each call in the turn that asked for them.
     */
    calls: PendingCall[]
    steps: number
  }
  done?: { reason: 'complete' | 'max_steps' }
}

let counter = 0
/** Ids are local to the transcript; nothing outside it reads them. */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
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
      // A pause without any usable call cannot be resumed, so it is not reported as one: the card
      // would otherwise sit awaiting a decision that could never be carried out.
      const calls = Array.isArray(c.calls) ? (c.calls as PendingCall[]).filter((call) => call && call.id) : []
      if (calls.length === 0) return { turns, effect: {} }

      // Every gated call is marked, not just the one the pause names: one decision answers the whole
      // batch, so every card in it has to show that it is waiting.
      let next = turns
      for (const call of calls) {
        next = updateStep(next, turnId, call.id, (step) => ({ ...step, status: 'awaiting' }))
      }
      return {
        turns: next,
        effect: { approval: { callId, tool: String(c.tool), messages, calls, steps } },
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

export function startUserTurn(text: string): AgentTurn {
  return { id: nextId('user'), role: 'user', content: text, steps: [] }
}
