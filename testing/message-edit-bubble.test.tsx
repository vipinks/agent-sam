import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import type { AgentTurn } from '@/app/components/workbench/agent-session'

/**
 * The editor a bubble offers for the message it is showing.
 *
 * The bubble's own half of editing a message: the affordance, the fields it opens with, and what it
 * hands back when the user confirms. Nothing here touches a transcript or a bridge — the pane's half,
 * where a confirmed resend cuts the conversation and sends it again, is asserted in
 * `message-edit-wiring.test.tsx`. Splitting it this way is what makes the props contract testable on
 * its own: these are the inputs a bubble is given and the exact call it makes back.
 */

const TURN_ID = 'user-3'
const SENT_TEXT = 'refactor the lexer'
const CHIPS = ['src/lexer.ts', 'src/tokens.ts']

function userTurn(): AgentTurn {
  return { id: TURN_ID, role: 'user', content: SENT_TEXT, steps: [], mentionPaths: [...CHIPS] }
}

function agentTurn(): AgentTurn {
  return { id: 'assistant-4', role: 'assistant', content: 'Done.', steps: [] }
}

/** The editor's text box, by the label a screen reader is given for it. */
function editor(): HTMLTextAreaElement {
  return screen.getByLabelText('Edit message text') as HTMLTextAreaElement
}

/**
 * Open the editor and replace what is in it, as a user editing a sent message does.
 *
 * The caller's own `userEvent` instance is passed in rather than a second one being created here:
 * each instance carries its own pointer and keyboard state, and mixing two in one test has the second
 * clicking from wherever the first one left the pointer.
 */
async function rewrite(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Edit message' }))
  await user.clear(editor())
  await user.type(editor(), text)
}

describe('the edit affordance on a bubble', () => {
  it('offers a named edit button on a user message, and none on a reply', () => {
    render(
      <>
        <MessageBubble message={userTurn()} canEdit />
        <MessageBubble message={agentTurn()} canEdit />
      </>
    )

    // Named, not merely present: the label names the action, and it is the whole of what the control
    // says about itself to someone who cannot see the glyph. One button for two bubbles is the claim
    // that this belongs to the user's own message rather than to the transcript.
    expect(screen.getAllByRole('button', { name: 'Edit message' }).length).toBe(1)
  })

  it('offers it only when the pane says the conversation is editable', () => {
    render(<MessageBubble message={userTurn()} />)

    // The default is off, so a bubble rendered without the pane's verdict — a reply streaming in, a
    // message in a conversation that is waiting on a decision — offers nothing it could not do.
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
  })

  it('reaches the edit button by keyboard', async () => {
    const user = userEvent.setup()
    render(<MessageBubble message={userTurn()} canEdit />)

    // Drawn only on hover, so the claim that it is not a pointer-only affordance is made against the
    // tab order rather than against the styling.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit message' }))
  })
})

describe('the editor a bubble opens', () => {
  it('opens with the message as it was sent, and its chips', async () => {
    const user = userEvent.setup()
    render(<MessageBubble message={userTurn()} canEdit onResend={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Edit message' }))

    // The stored content, verbatim: the editor is a copy of what was sent rather than a paraphrase of
    // it, which is what makes an edit an edit.
    expect(editor().value).toBe(SENT_TEXT)
    // Every chip the message carried, each with the control that removes it — a screen reader is told
    // which file, so two chips for `index.ts` in different folders are distinguishable.
    expect(screen.getByRole('button', { name: 'Remove src/lexer.ts' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove src/tokens.ts' })).toBeTruthy()
  })

  it('removes a chip, and sends what is left', async () => {
    const user = userEvent.setup()
    const onResend = vi.fn()
    render(<MessageBubble message={userTurn()} canEdit onResend={onResend} />)

    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    await user.click(screen.getByRole('button', { name: 'Remove src/lexer.ts' }))
    expect(screen.queryByRole('button', { name: 'Remove src/lexer.ts' })).toBeNull()

    await user.clear(editor())
    await user.type(editor(), 'refactor the lexer tokens')
    await user.click(screen.getByRole('button', { name: 'Save and resend' }))

    // The turn's own id as well as its new contents: the pane needs the id to know what to cut, and it
    // is the one thing the editor itself cannot describe.
    expect(onResend).toHaveBeenCalledWith(TURN_ID, 'refactor the lexer tokens', ['src/tokens.ts'])
  })

  it('abandons the edit on cancel, leaving the message as it was', async () => {
    const user = userEvent.setup()
    const onResend = vi.fn()
    render(<MessageBubble message={userTurn()} canEdit onResend={onResend} />)

    await rewrite(user, 'something else entirely')
    await user.click(screen.getByRole('button', { name: 'Cancel editing' }))

    expect(screen.queryByLabelText('Edit message text')).toBeNull()
    expect(screen.getByText(SENT_TEXT)).toBeTruthy()
    expect(onResend).not.toHaveBeenCalled()
  })

  it('sends without asking when nothing follows the message', async () => {
    const user = userEvent.setup()
    const onResend = vi.fn()
    render(<MessageBubble message={userTurn()} canEdit laterTurns={0} onResend={onResend} />)

    await rewrite(user, 'and the readme')
    await user.click(screen.getByRole('button', { name: 'Save and resend' }))

    // Nothing to remove, so nothing to confirm: a dialog with nothing to say would be noise the user
    // learns to click through.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onResend).toHaveBeenCalledWith(TURN_ID, 'and the readme', CHIPS)
  })
})

describe('the confirmation before a resend', () => {
  it('names how many later turns the edit will remove', async () => {
    const user = userEvent.setup()
    const onResend = vi.fn()
    render(<MessageBubble message={userTurn()} canEdit laterTurns={2} onResend={onResend} />)

    await rewrite(user, 'refactor the lexer, and keep the tokens split')
    await user.click(screen.getByRole('button', { name: 'Save and resend' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('2 later turns will be removed from this conversation.')).toBeTruthy()
    // Asked, not done: the click that reaches this dialog has not sent anything.
    expect(onResend).not.toHaveBeenCalled()
  })

  it('names a single later turn in the singular', async () => {
    const user = userEvent.setup()
    render(<MessageBubble message={userTurn()} canEdit laterTurns={1} onResend={vi.fn()} />)

    await rewrite(user, 'refactor the lexer, and keep the tokens split')
    await user.click(screen.getByRole('button', { name: 'Save and resend' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('One later turn will be removed from this conversation.')).toBeTruthy()
  })

  it('keeps the edit when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    const onResend = vi.fn()
    render(<MessageBubble message={userTurn()} canEdit laterTurns={2} onResend={onResend} />)

    await rewrite(user, 'refactor the lexer, and keep the tokens split')
    await user.click(screen.getByRole('button', { name: 'Save and resend' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    // Backing out of the confirmation is not the same as abandoning the edit: what the user typed is
    // still there to save, which is why the editor survives the dialog.
    expect(editor().value).toBe('refactor the lexer, and keep the tokens split')
    expect(onResend).not.toHaveBeenCalled()
  })
})
