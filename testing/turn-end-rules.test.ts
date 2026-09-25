import { describe, expect, it } from 'vitest'
import { reconcilePlanOnTurnEnd, type PlanStep } from '@/conveyor/protocol/plan'
import {
  AUTO_CONTINUE_MAX,
  autoContinueNudge,
  isReplyCutShort,
  isResumable,
  isToolCallCut,
  planUnfinishedNotice,
  RESUME_MESSAGE,
  shouldAutoContinue,
  TURN_END_CAUSES,
  turnEndCause,
  type TurnEndCause,
  type TurnEndEvidence,
} from '@/conveyor/protocol/turn-end'

/**
 * The turn-end rules, as rules rather than as wiring.
 *
 * A turn can stop because the model finished, because the provider ran out of output room, or because
 * the reply stopped arriving — and only the first of those is unremarkable. Which one happened is
 * decided here, from what the stream reported, so these assertions are the whole of the mapping: the
 * loop only collects the evidence, and the card only words the cause.
 *
 * The values below are the ones a provider actually sends, taken from the two dialects' wire formats
 * and confirmed against the parser in the node suite — a mapping keyed on a value nothing sends would
 * pass here and be wrong in the app.
 */

/**
 * One reply's evidence, with the two facts the loop always has about it filled in for the ordinary case.
 *
 * Written as a whole reply rather than as the observations the parser happened to make, because the loop
 * always knows what the model said and what it asked for — and a rule that decided without them could not
 * tell an answer that arrived from one that never did. Every case below overrides what it is about.
 */
function evidence(overrides: Partial<TurnEndEvidence> = {}): TurnEndEvidence {
  return { finishReasons: [], toolCallCut: false, finalText: 'The parser is fine.', toolCalls: 0, ...overrides }
}

describe('turnEndCause', () => {
  it('reads the OpenAI output-limit reason as truncation', () => {
    expect(turnEndCause(evidence({ finishReasons: ['length'] }))).toBe('truncated')
  })

  it("reads Anthropic's spelling of the same event as truncation", () => {
    expect(turnEndCause(evidence({ finishReasons: ['max_tokens'] }))).toBe('truncated')
  })

  it('reads every ordinary reason as the model stopping on its own', () => {
    for (const reason of ['stop', 'tool_calls', 'end_turn', 'tool_use', 'stop_sequence']) {
      expect(turnEndCause(evidence({ finishReasons: [reason] }))).toBe('model_stop')
    }
  })

  it('does not invent truncation for a reason it cannot name, or for none at all', () => {
    // An ending nobody can name is not evidence of anything: the card exists for the endings that
    // were cut short, and a card under a complete answer is how the button stops meaning anything.
    for (const reasons of [[], ['content_filter'], [''], ['some_future_reason']]) {
      expect(turnEndCause(evidence({ finishReasons: reasons }))).toBe('model_stop')
    }
  })

  it('treats one truncating reason anywhere in the reply as truncation', () => {
    // Providers may send the frame more than once, and a later ordinary reason must not erase the
    // one that says the reply was cut off.
    expect(turnEndCause(evidence({ finishReasons: ['length', 'stop'] }))).toBe('truncated')
    expect(turnEndCause(evidence({ finishReasons: ['stop', 'length'] }))).toBe('truncated')
  })

  it('reads a tool-call payload that does not parse as truncation, with no reason given', () => {
    // The provider said nothing about why it stopped, so the payload is the only evidence there is.
    expect(turnEndCause(evidence({ toolCallCut: true }))).toBe('truncated')
  })

  it('reads a failure raised while the reply was arriving as a broken stream', () => {
    expect(turnEndCause(evidence({ streamErrorCode: 'STREAM_ERROR' }))).toBe('stream_error')
  })

  it('reads a broken stream as explaining everything else it arrived with', () => {
    // The strongest evidence wins: a reply that stopped arriving explains why its payload is half a
    // payload, and why the provider never got as far as saying why it stopped.
    expect(turnEndCause(evidence({ streamErrorCode: 'STREAM_ERROR', toolCallCut: true }))).toBe('stream_error')
    expect(turnEndCause(evidence({ streamErrorCode: 'STREAM_ERROR', finishReasons: ['length'] }))).toBe('stream_error')
  })

  it('names a stop whose reply never arrived, which is the ending that used to be invisible', () => {
    // Every other fact about this reply is ordinary — an ordinary reason, no cut payload, a stream that
    // ended cleanly — so the absent answer is the only evidence there is. Without a name for it the turn
    // ended as `model_stop`, the one cause whose copy renders nothing, and with no plan on the turn no
    // notice was emitted either: the conversation simply stopped on a tool outcome.
    expect(turnEndCause(evidence({ finishReasons: ['stop'], finalText: '' }))).toBe('empty_stop')
    // Whitespace is not an answer. A reply of three spaces is a reply that said nothing, and treating it
    // as prose would leave the silence exactly where it was.
    expect(turnEndCause(evidence({ finalText: '   \n\t ' }))).toBe('empty_stop')
  })

  it('leaves a reply that says anything at all as the ordinary stop', () => {
    // The other half of the rule, and the reason it is written on the text rather than on its absence: the
    // card exists for the turns that need explaining, and a card under every answer is how the one that
    // matters stops being read.
    expect(turnEndCause(evidence({ finalText: 'The parser is fine.' }))).toBe('model_stop')
    expect(turnEndCause(evidence({ finishReasons: ['stop'], finalText: '  ok ' }))).toBe('model_stop')
  })

  it('does not call a reply empty when it asked for a tool, whatever its prose says', () => {
    // The shape most assistant turns actually have: a tool call and no narration at all. Reading the text
    // alone would call this a silent stop, and the loop ends a reply that was cut short over whatever it
    // asked for — so the call the model asked for would never be announced and never be run.
    expect(turnEndCause(evidence({ finalText: '', toolCalls: 1 }))).toBe('model_stop')
    expect(turnEndCause(evidence({ finishReasons: ['tool_calls'], finalText: '', toolCalls: 2 }))).toBe('model_stop')
  })

  it('keeps the two cut-short endings whatever the reply said', () => {
    // The reply's content is not evidence about how it stopped: a cap and a dropped line are facts about
    // the stream, and an empty reply is no less truncated for being empty. Only the fallback ending is
    // decided by what the model wrote.
    for (const finalText of ['', '   ', 'The parser works by ']) {
      expect(turnEndCause(evidence({ finishReasons: ['length'], finalText }))).toBe('truncated')
      expect(turnEndCause(evidence({ toolCallCut: true, finalText }))).toBe('truncated')
      expect(turnEndCause(evidence({ streamErrorCode: 'STREAM_ERROR', finalText }))).toBe('stream_error')
    }
  })
  it('reads a broken stream as outranking an empty reply, as it outranks everything else', () => {
    // Order matters, and this is the case that pins it: a connection that dropped on an empty reply is a
    // dropped connection — the wording a user can act on — rather than a model that had nothing to say.
    expect(turnEndCause(evidence({ streamErrorCode: 'STREAM_ERROR', finalText: '', toolCalls: 0 }))).toBe(
      'stream_error'
    )
  })
})

describe('isReplyCutShort', () => {
  // The one distinction the loop runs a frame on: a reply the provider cut short is over whatever it asked
  // for, because acting on half a request is worse than acting on none of it — while a reply that simply
  // stopped, said or unsaid, owns its calls and always runs them.
  it('is true for the two endings where the reply itself was cut short', () => {
    expect(isReplyCutShort('truncated')).toBe(true)
    expect(isReplyCutShort('stream_error')).toBe(true)
  })

  it('is false for the endings where the reply simply ended, whether it said anything or not', () => {
    // `empty_stop` belongs with `model_stop` here and not with the two above it, which is the whole of
    // what keeps a silent stop from being treated as a turn that must discard what it asked for.
    expect(isReplyCutShort('model_stop')).toBe(false)
    expect(isReplyCutShort('empty_stop')).toBe(false)
  })
})

describe('isToolCallCut', () => {
  it('counts JSON that does not parse as a payload that was still being written', () => {
    expect(isToolCallCut(['{"path":"x.tx'])).toBe(true)
    expect(isToolCallCut(['{"path": "x.txt"}'])).toBe(false)
  })

  it('does not count a payload that never arrived, which is a malformed call rather than a cut one', () => {
    // A provider that sent an id and a name and no arguments has said something the tool layer can
    // refuse in its own terms; calling that a cut reply would put a truncation card under it.
    expect(isToolCallCut(['', '   '])).toBe(false)
    expect(isToolCallCut([])).toBe(false)
  })

  it('counts the cut payload when one call parsed and another did not', () => {
    expect(isToolCallCut(['{"path":"a.txt"}', '{"path":"b'])).toBe(true)
  })
})

describe('isResumable', () => {
  it('offers a way on for the two endings that mean the reply was cut short', () => {
    expect(isResumable('truncated')).toBe(true)
    expect(isResumable('stream_error')).toBe(true)
  })

  it('offers nothing for the model stopping by itself, because there is nothing to continue', () => {
    expect(isResumable('model_stop')).toBe(false)
  })

  it('offers a way on for an ending that said nothing, because the answer never arrived', () => {
    // The reply is incomplete in the only sense that matters to this predicate: the model stopped short of
    // answering, and asking it to carry on is the same click a capped reply gets.
    expect(isResumable('empty_stop')).toBe(true)
  })

  it('answers for every cause in the vocabulary, so a new one cannot be forgotten', () => {
    const answers = TURN_END_CAUSES.map((cause: TurnEndCause) => isResumable(cause))
    expect(answers).toEqual([false, true, true, true])
  })
})

describe('planUnfinishedNotice', () => {
  const step = (id: string, status: PlanStep['status']): PlanStep => ({ id, text: id, status })

  it('announces a plan that stopped partway, and counts what is left', () => {
    const plan = reconcilePlanOnTurnEnd([step('a', 'done'), step('b', 'in_progress'), step('c', 'pending')])
    expect(planUnfinishedNotice(plan, 'model_stop')).toEqual({
      cause: 'model_stop',
      unfinishedSteps: 2,
      resumable: true,
    })
  })

  it('counts a step the turn was midway through as unfinished, not as work it finished', () => {
    const plan = reconcilePlanOnTurnEnd([step('a', 'in_progress')])
    expect(plan.map((s) => s.status)).toEqual(['interrupted'])
    expect(planUnfinishedNotice(plan, 'model_stop')?.unfinishedSteps).toBe(1)
  })

  it('speaks up for every cause, including the ordinary ending', () => {
    // The whole reason this rule is not folded into the cause copy: a model that stops on its own
    // with work left on the plan has stopped mid-task, and that is exactly the turn that used to end
    // in silence.
    const plan = [step('a', 'pending')]
    for (const cause of TURN_END_CAUSES) {
      expect(planUnfinishedNotice(plan, cause)?.resumable).toBe(true)
      expect(planUnfinishedNotice(plan, cause)?.cause).toBe(cause)
    }
  })

  it('says nothing for a plan with every step done, or for no plan at all', () => {
    expect(planUnfinishedNotice([step('a', 'done'), step('b', 'done')], 'model_stop')).toBeNull()
    expect(planUnfinishedNotice([], 'truncated')).toBeNull()
    expect(planUnfinishedNotice([], 'model_stop')).toBeNull()
  })
})

/**
 * The auto-continue rule, which is the one place the app sends without being asked.
 *
 * Phase 23 and Phase 31 both chose no auto-continue, and this reverses that for two of the three
 * endings: a model that stops on its own with work left on its plan is a turn the manual card turned
 * into a treadmill, because the user's next click was always the same click, and a reply the provider
 * capped at its output limit is the same turn stopped by a limit on the reply rather than by the model.
 * A dropped connection stays the user's: nothing the app sends reopens it, so a nudge there would spend
 * a round-trip on a line that is not there.
 */
describe('shouldAutoContinue', () => {
  const step = (id: string, status: PlanStep['status']): PlanStep => ({ id, text: id, status })
  const unfinished = [step('a', 'done'), step('b', 'pending')]

  it('continues a model that stopped on its own with work left and budget to spend', () => {
    expect(shouldAutoContinue('model_stop', reconcilePlanOnTurnEnd(unfinished), 0)).toBe(true)
  })

  it('counts a step the turn was midway through as work to pick up, not as work it finished', () => {
    const plan = reconcilePlanOnTurnEnd([step('a', 'in_progress')])
    expect(plan.map((s) => s.status)).toEqual(['interrupted'])
    expect(shouldAutoContinue('model_stop', plan, 0)).toBe(true)
  })

  it('continues a reply the provider cut off, which is how a long turn actually dies', () => {
    // The cause the rule was written for. A capped reply is not a decision the model made — it is the
    // same turn, stopped at the same place by the provider's output limit — so nudging it is the click
    // the user would make anyway, and the ending a live long turn is overwhelmingly likely to have.
    expect(shouldAutoContinue('truncated', unfinished, 0)).toBe(true)
    expect(shouldAutoContinue('truncated', reconcilePlanOnTurnEnd([step('a', 'in_progress')]), 0)).toBe(true)
  })

  it('leaves a dropped connection to the user, because a nudge needs the connection back', () => {
    // The one ending a further request cannot fix: the reply stopped arriving. Nothing the app sends
    // changes that, and the human is the only party who can act on it.
    expect(shouldAutoContinue('stream_error', unfinished, 0)).toBe(false)
  })

  it('says nothing for a finished plan, or for no plan at all', () => {
    expect(shouldAutoContinue('model_stop', [step('a', 'done'), step('b', 'done')], 0)).toBe(false)
    expect(shouldAutoContinue('model_stop', [], 0)).toBe(false)
  })

  it('spends a budget of eight continuations and then stops', () => {
    expect(AUTO_CONTINUE_MAX).toBe(8)
    // A budget a long turn can spend rather than one it spends at once: eight is the point at which the
    // same unfinished step has survived eight round-trips, which is the evidence a ninth would not fix.
    for (const cause of ['model_stop', 'truncated'] as const) {
      expect(shouldAutoContinue(cause, unfinished, AUTO_CONTINUE_MAX - 1)).toBe(true)
      for (let used = AUTO_CONTINUE_MAX; used <= AUTO_CONTINUE_MAX + 2; used += 1) {
        expect(shouldAutoContinue(cause, unfinished, used)).toBe(false)
      }
    }
  })

  it('continues a silent stop that left work on the plan, on exactly a plain stop’s terms', () => {
    // The two endings are the same ending with and without words, so the rule must not be able to tell
    // them apart at any point: the same budget, the same work, the same answer for every input. The
    // comparison rather than a table of expectations is the assertion — a table would pin today's answers
    // and let the two causes drift apart later, which is the thing being prevented.
    const plans = [
      [],
      [step('a', 'pending')],
      [step('a', 'done'), step('b', 'done')],
      reconcilePlanOnTurnEnd([step('a', 'in_progress')]),
    ]
    for (const plan of plans) {
      for (const used of [0, 1, AUTO_CONTINUE_MAX - 1, AUTO_CONTINUE_MAX, AUTO_CONTINUE_MAX + 1]) {
        expect(shouldAutoContinue('empty_stop', plan, used)).toBe(shouldAutoContinue('model_stop', plan, used))
      }
    }
    // And what that amounts to for the case that matters, said outright so the comparison above is anchored:
    // work left and budget to spend is continued, and a spent budget is not.
    expect(shouldAutoContinue('empty_stop', reconcilePlanOnTurnEnd(unfinished), 0)).toBe(true)
    expect(shouldAutoContinue('empty_stop', reconcilePlanOnTurnEnd(unfinished), AUTO_CONTINUE_MAX)).toBe(false)
  })

  it('still refuses a dropped connection, which no cause beside it may change', () => {
    // The one ending a further request cannot fix, and the one line kept from the phase that split them.
    expect(shouldAutoContinue('stream_error', unfinished, 0)).toBe(false)
  })

  it('answers for the loop’s own step ceiling the same way, because the ceiling is not a cause', () => {
    // The step budget is the loop ending a turn rather than the model ending it, and the phase that made
    // it continuable added no cause, no flag and no parameter to this rule: the ending it produces is
    // diagnosed as `model_stop` — the last reply arrived complete, and it was the loop that stopped — so
    // this predicate was already the one that answered for it. What that phase changed is the caller: the
    // ceiling's exit now asks this rule instead of short-circuiting past it, and the step counter restarts
    // with the segment the nudge opens, which is a fact about the caller's counter rather than about this
    // rule. Pinned here so a later reader tempted to widen the vocabulary for the ceiling — a
    // `step_ceiling` cause, or a fourth argument — has a test to argue with first.
    expect(TURN_END_CAUSES).toEqual(['model_stop', 'empty_stop', 'truncated', 'stream_error'])
    expect(shouldAutoContinue('model_stop', unfinished, 0)).toBe(true)
    expect(shouldAutoContinue('model_stop', unfinished, AUTO_CONTINUE_MAX)).toBe(false)
  })
})

describe('autoContinueNudge', () => {
  it('names the steps left and sends the model to the first one unfinished', () => {
    expect(autoContinueNudge(2)).toBe(
      'You stopped with 2 plan steps remaining; continue now from the first unfinished step without restating completed work'
    )
  })

  it('is one line, because it arrives at the provider where a user message arrives', () => {
    // Sent as a user-role message, so it is written as one: a multi-line value would read as a pasted
    // document in a request log rather than as the sentence it is.
    expect(autoContinueNudge(1)).not.toContain('\n')
    expect(autoContinueNudge(1)).toBe(autoContinueNudge(1).trim())
  })
})

describe('RESUME_MESSAGE', () => {
  it('is one line, because it arrives as something the user typed', () => {
    // It is sent as an ordinary user message, so it is read on screen as one: a multi-line value
    // would look like a pasted document rather than a sentence the user could have written.
    expect(RESUME_MESSAGE.trim()).toBe(RESUME_MESSAGE)
    expect(RESUME_MESSAGE).not.toContain('\n')
    expect(RESUME_MESSAGE.length).toBeGreaterThan(0)
  })
})
