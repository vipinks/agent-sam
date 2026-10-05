import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import { NARRATION_BREAK, type AgentTurn } from '@/app/components/workbench/agent-session'

/**
 * The copy button on a bubble, as wiring.
 *
 * What a turn's text *is* — for an assistant turn, the narration its chunks were assembled into and
 * not the cards that sit among it — follows from the fields the transcript keeps, so there is no rule
 * module to test in isolation here. The claim is instead the one only a DOM test can make: that the
 * button hands the platform's clipboard exactly that text and nothing else. It is asserted on the
 * string `writeText` received, which is the only place the claim is checkable — reading the component
 * cannot tell a correct copy from a plausible one.
 *
 * The bubbles are rendered directly rather than through the panel. The panel adds the transport, the
 * virtualizer and a fabricated jsdom viewport, none of which a clipboard assertion is about, and a
 * test that needs them to pass is one that can fail for reasons unrelated to copying.
 *
 * The mock is a spy on whatever `navigator.clipboard` already holds, taken *after* `userEvent.setup()`
 * rather than installed by this file: `setup()` defines its own clipboard on the window, so a double
 * installed first is silently replaced and the assertions then read a mock nothing ever calls. The
 * spy is restored for us — `restoreMocks` is on in the vitest config.
 */

const USER_TEXT = 'Rename the parser, then **stop** — leave <config> alone.'
const AGENT_TEXT = `The bug is on line 12.${NARRATION_BREAK}I fixed it by re-reading the header.`
const TOOL_OUTPUT = 'tool output that must never be copied'
const PLAN_TEXT = 'plan row that must never be copied'

/** A sent message, and a clipboard watching the platform call, as the transcript stores them. */
function withClipboard() {
  const user = userEvent.setup()
  return { user, writeText: vi.spyOn(navigator.clipboard, 'writeText') }
}

beforeEach(() => {
  vi.useRealTimers()
})

/**
 * Timers are reset before each test and, in the one test that fakes them, switched over *after*
 * `withClipboard()`.
 *
 * That ordering is load-bearing: `userEvent.setup()` defines the clipboard stub this file spies on and
 * arms its own waiting on the real clock, so installing fake timers first leaves that waiting with
 * nothing to run on and no click is ever delivered. Faking them afterwards — around the one
 * synchronous `fireEvent` in that test — keeps the stub and the interval under test together.
 */
afterEach(() => {
  vi.useRealTimers()
})

/** A sent message, as the transcript stores it. */
function userTurn(): AgentTurn {
  return { id: 'turn-1', role: 'user', content: USER_TEXT, steps: [] }
}

/**
 * A reply carrying everything a turn can hold besides its prose.
 *
 * The step, the plan and the ending are here because they are what a copy must *not* contain; a
 * fixture without them could not tell a read of `content` from a scrape of the rendered bubble.
 */
function agentTurn(): AgentTurn {
  return {
    id: 'turn-2',
    role: 'assistant',
    content: AGENT_TEXT,
    steps: [
      {
        callId: 'call-1',
        tool: 'read_file',
        args: { path: 'src/parser.ts' },
        status: 'ok',
        output: TOOL_OUTPUT,
      },
    ],
    plan: [{ id: 'step-1', text: PLAN_TEXT, status: 'done' }],
    endNotice: { cause: 'truncated', resumable: true },
  }
}

describe('copy on a message bubble', () => {
  it('offers a named copy button on a user message and on a reply', () => {
    render(
      <>
        <MessageBubble message={userTurn()} />
        <MessageBubble message={agentTurn()} />
      </>
    )

    // Named, not merely present: the label names the action, and it is the whole of what this control
    // says about itself to someone who cannot see the glyph.
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy reply' })).toBeTruthy()
  })

  it('reaches the copy button by keyboard', async () => {
    const { user } = withClipboard()
    render(<MessageBubble message={userTurn()} />)

    // The button is drawn only on hover, so the claim that it is not a pointer-only affordance has to
    // be made against the tab order rather than against the styling.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy message' }))
  })

  it('copies a user message exactly as it was sent', async () => {
    const { user, writeText } = withClipboard()
    render(<MessageBubble message={userTurn()} />)

    await user.click(screen.getByRole('button', { name: 'Copy message' }))

    // Exact, not merely containing: a user's message is literal text, so its markdown, angle brackets
    // and em dash all have to survive the trip untouched.
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(USER_TEXT)
  })

  it('copies a reply as its assembled prose, and nothing from its cards', async () => {
    const { user, writeText } = withClipboard()
    render(<MessageBubble message={agentTurn()} />)

    // Opened first, so the exclusions below are a real exclusion: the card's output is on screen
    // while the copy is taken, and still does not reach the clipboard.
    //
    // Opened by the row that folds the run of steps, which is the only foldable thing left in a
    // transcript: a card no longer carries a header of its own, so "the button the call is behind" is
    // the run's row and not the call. The reply's prose, meanwhile, is not folded at all any more.
    await user.click(screen.getByRole('button', { name: /View Steps/ }))
    expect(screen.getByText(TOOL_OUTPUT)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy reply' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toBe(AGENT_TEXT)
    expect(copied).not.toContain(TOOL_OUTPUT)
    expect(copied).not.toContain(PLAN_TEXT)
  })

  it('confirms the copy on the button, then clears the confirmation', async () => {
    const { writeText } = withClipboard()
    vi.useFakeTimers()
    render(<MessageBubble message={userTurn()} />)

    // Fire-then-timers rather than `userEvent`, whose own waiting uses timers and deadlocks against
    // them; the pointer path is already exercised by the tests above.
    const button = screen.getByRole('button', { name: 'Copy message' })
    expect(button.querySelector('svg.lucide-copy')).toBeTruthy()

    fireEvent.click(button)
    // A microtask flush, not a timer: the confirmation is set after the clipboard write settles. No
    // `waitFor` here — it would advance the very timers under test and clear the thing being asserted.
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith(USER_TEXT)
    expect(button.querySelector('svg.lucide-check')).toBeTruthy()

    // Still confirming a second in — a confirmation that vanished before it was read would be none —
    // and gone a moment after the interval.
    act(() => void vi.advanceTimersByTime(1000))
    expect(button.querySelector('svg.lucide-check')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(600))
    expect(button.querySelector('svg.lucide-check')).toBeNull()
    expect(button.querySelector('svg.lucide-copy')).toBeTruthy()
  })
})
