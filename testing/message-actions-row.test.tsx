import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import type { AgentTurn } from '@/app/components/workbench/agent-session'
import type { BubbleAlignment } from '@/conveyor/protocol/appearance'

/**
 * The row of controls each bubble carries at its bottom.
 *
 * The bubble's own file for the row: what it holds per kind, where it sits, and how it is revealed.
 * The claims that need a rendered transcript — that these controls still reach the pane's handlers at
 * all — are made in `message-copy-wiring`, `message-edit-bubble`, `message-edit-wiring` and
 * `message-regenerate-wiring`, which find the same controls by name and are unmoved by the row
 * drawing them somewhere else.
 *
 * jsdom computes no layout and loads no stylesheet, so the Tailwind classes a bubble carries are
 * strings in a document with no CSS behind them: `:hover`, `:focus-within` and `opacity` cannot be
 * observed here. What is observable — and what these tests hold — is the wiring: which controls the
 * row draws for each kind, that the row is the bubble's own last box, that it stays in flow at a
 * fixed size while hidden so revealing it can move nothing, that the reveal is the traced
 * group/focus-within idiom and costs the DOM no change, and that a click or a tab arriving in the row
 * still calls the handler it always called. Whether the row appears at the bubble's bottom without
 * shifting the transcript is a pixel claim, and pixels are read by eye.
 */

const USER_TEXT = 'rename the parser'
const AGENT_TEXT = 'The parser is renamed.'

const TURN_ID = 'user-1'
const REPLY_ID = 'assistant-2'

/** A sent message, as the transcript stores it. */
function userTurn(): AgentTurn {
  return { id: TURN_ID, role: 'user', content: USER_TEXT, steps: [] }
}

/** A reply, as the transcript stores it. */
function agentTurn(): AgentTurn {
  return { id: REPLY_ID, role: 'assistant', content: AGENT_TEXT, steps: [] }
}

/** The bubble body that draws `text`, which is how one message is told from the other on screen. */
function bodyDrawing(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-slot="message-body"]')].find((node) =>
    node.textContent?.includes(text)
  )
  if (!found) throw new Error(`no bubble draws ${text}`)
  return found
}

/** The group a bubble's reveal answers to: the element carrying `group`, which wraps the whole bubble. */
function groupDrawing(text: string): HTMLElement {
  const found = bodyDrawing(text).parentElement
  if (!found) throw new Error(`the bubble drawing ${text} has no wrapper`)
  return found
}

/** The action row of the bubble that draws `text`, found through that bubble's own body. */
function actionsOn(text: string): HTMLElement {
  const found = groupDrawing(text).querySelector<HTMLElement>('[data-slot="message-actions"]')
  if (!found) throw new Error(`the bubble drawing ${text} draws no action row`)
  return found
}

/** Every class in the document, which is what a layout engine would read a box out of. */
function classNames(): (string | null)[] {
  return [...document.querySelectorAll<HTMLElement>('*')].map((node) => node.getAttribute('class'))
}

describe('the row a bubble carries at its bottom', () => {
  it('holds copy on a reply, and no edit', () => {
    render(<MessageBubble message={agentTurn()} canEdit onRegenerate={vi.fn()} />)

    const row = actionsOn(AGENT_TEXT)

    // At the bottom: the row is the last box of the bubble's own group, below the words rather than
    // beside them.
    expect(groupDrawing(AGENT_TEXT).lastElementChild).toBe(row)
    expect(row.previousElementSibling).toBe(bodyDrawing(AGENT_TEXT))
    // Copy on either kind of bubble, and named by the kind it is copying.
    expect(within(row).getByRole('button', { name: 'Copy reply' })).toBeTruthy()
    // The action set is the one this kind carried before the row: a regenerate stays on a reply, and
    // an edit — which rewrites a message the user sent — has no business here.
    expect(within(row).getByRole('button', { name: 'Regenerate reply' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Edit message' })).toBeNull()
  })

  it('holds copy and edit on the user’s own message, and no regenerate', () => {
    render(<MessageBubble message={userTurn()} canEdit onResend={vi.fn()} />)

    const row = actionsOn(USER_TEXT)

    expect(groupDrawing(USER_TEXT).lastElementChild).toBe(row)
    expect(row.previousElementSibling).toBe(bodyDrawing(USER_TEXT))
    expect(within(row).getByRole('button', { name: 'Copy message' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Edit message' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
  })

  it('is in the bubble at rest, hidden by opacity and revealed by the bubble’s own hover or focus', async () => {
    const user = userEvent.setup()
    render(<MessageBubble message={userTurn()} canEdit onResend={vi.fn()} />)

    const row = actionsOn(USER_TEXT)
    const group = groupDrawing(USER_TEXT)

    // Present while hidden: a control that existed only on hover could not be tabbed to, which is why
    // the reveal is `opacity-0` and not `hidden` — the same reasoning the controls carried when they
    // sat beside the bubble.
    expect([...row.classList]).toContain('opacity-0')
    expect([...row.classList]).not.toContain('opacity-100')
    // Revealed by the bubble this row acts on rather than by empty space beside it, on hover for the
    // pointer and on focus for the keyboard — the idiom the session list already reveals its own
    // controls with.
    expect([...group.classList]).toContain('group')
    expect([...row.classList]).toContain('group-hover:opacity-100')
    expect([...row.classList]).toContain('focus-within:opacity-100')
    expect([...row.classList]).toContain('transition-opacity')

    // The keyboard half, as far as it can be observed: focus arriving inside the row is what
    // `focus-within` answers, and both controls are reachable in turn.
    await user.tab()
    expect(row.contains(document.activeElement)).toBe(true)
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Edit message')
    await user.tab()
    expect(row.contains(document.activeElement)).toBe(true)
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Copy message')
  })

  it('copies the bubble’s text from the row, exactly once', async () => {
    const user = userEvent.setup()
    // Spied after `setup()`, which defines the clipboard stub this file reads: a double installed
    // first is silently replaced, and the assertion would then watch a mock nothing calls.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    render(<MessageBubble message={userTurn()} canEdit onResend={vi.fn()} />)

    await user.click(within(actionsOn(USER_TEXT)).getByRole('button', { name: 'Copy message' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(USER_TEXT)
  })

  it('opens the existing editor from the row when edit is used', async () => {
    const user = userEvent.setup()
    render(<MessageBubble message={userTurn()} canEdit onResend={vi.fn()} />)

    await user.click(within(actionsOn(USER_TEXT)).getByRole('button', { name: 'Edit message' }))

    // The edit-and-resend mode the control opened before the row existed, entered the same way and
    // open on the message as it was sent.
    expect((screen.getByLabelText('Edit message text') as HTMLTextAreaElement).value).toBe(USER_TEXT)
  })

  it('regenerates from the row through the handler the reply always called', async () => {
    const user = userEvent.setup()
    const onRegenerate = vi.fn()
    render(<MessageBubble message={agentTurn()} canEdit laterTurns={0} onRegenerate={onRegenerate} />)

    await user.click(within(actionsOn(AGENT_TEXT)).getByRole('button', { name: 'Regenerate reply' }))

    // The reply's own id, and nothing asked first: nothing follows this one, so there is nothing the
    // cut would remove.
    expect(onRegenerate).toHaveBeenCalledWith(REPLY_ID)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

/**
 * The row under both alignment modes.
 *
 * The pane passes the preference down, so a bubble drawn without it is drawn the way this app has
 * always drawn it. What the row adds is a second box under the bubble, and the two things that could
 * go wrong with it are both checkable here: that it moves the words when it appears, and that it
 * lands on the wrong side.
 */
describe.each<BubbleAlignment>(['split', 'same-side'])('the row under %s', (alignment) => {
  it('keeps its own box, and moves nothing when the bubble is hovered', async () => {
    const user = userEvent.setup()
    render(
      <>
        <MessageBubble message={userTurn()} canEdit onResend={vi.fn()} alignment={alignment} />
        <MessageBubble message={agentTurn()} canEdit onRegenerate={vi.fn()} alignment={alignment} />
      </>
    )

    for (const text of [USER_TEXT, AGENT_TEXT]) {
      const row = actionsOn(text)
      const classes = [...row.classList]

      // In flow, at a height of its own: a row positioned out of flow would hang over a neighbour, and
      // one that carried `hidden` would collapse and push the transcript down the moment it appeared.
      for (const token of ['absolute', 'fixed', 'sticky', 'hidden', 'invisible']) {
        expect(classes).not.toContain(token)
      }
      expect(classes).toContain('opacity-0')
      // The reserved height is the shown height: every control in the row is a fixed box, so the
      // space the row occupies is the same whether it is drawn at zero opacity or at one.
      for (const button of [...row.querySelectorAll('button')]) {
        expect([...button.classList]).toContain('size-6')
      }
      // A sibling of the body rather than a layer over it, so revealing the row cannot reflow the
      // words it sits under.
      expect(row.previousElementSibling).toBe(bodyDrawing(text))
      expect(row.contains(bodyDrawing(text))).toBe(false)
    }

    // Hovering changes no class anywhere in the bubble: the reveal is the stylesheet's, so every box
    // the layout engine would measure after the hover is the box it had before it.
    const before = classNames()
    await user.hover(bodyDrawing(USER_TEXT))
    expect(classNames()).toEqual(before)
  })

  it('takes the side the bubble itself sits on', () => {
    render(
      <>
        <MessageBubble message={userTurn()} canEdit onResend={vi.fn()} alignment={alignment} />
        <MessageBubble message={agentTurn()} canEdit onRegenerate={vi.fn()} alignment={alignment} />
      </>
    )

    // The row is the bubble's own column, aligned as the bubble is: the user's own message keeps to
    // the right under `split` and joins the agent on the left under `same side`, and a reply is on
    // the left either way — the same rule the message rows themselves follow.
    const group = groupDrawing(USER_TEXT).className
    expect(group).toContain(alignment === 'split' ? 'items-end' : 'items-start')
    expect(groupDrawing(AGENT_TEXT).className).toContain('items-start')
  })
})
