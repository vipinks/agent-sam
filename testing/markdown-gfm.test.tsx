import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import type { AgentTurn } from '@/app/components/workbench/agent-session'

/**
 * GFM as the chat shows it, which is the other half of the claim the Code Viewer's preview makes.
 *
 * The plugin is wired once, in `markdown.tsx`, and both surfaces consume that one component — the
 * chat's assistant bubble and the viewer's preview. The preview's own suite is in
 * `code-viewer-preview.test.tsx`; what only this file can show is that the *chat* gained the same
 * constructs in the same commit, rather than the capability living only where it was first asserted.
 * That is the difference between an inheritance the reader can see and one they have to take on trust.
 *
 * A `user` turn is asserted too, and not for completeness: their message is deliberately rendered as
 * literal text rather than parsed as markdown, because parsing it would eat the angle brackets and
 * asterisks of a sentence someone typed. Adding GFM to the renderer must not have reached that path,
 * and the case here is what would fail if a later change decided to render every turn as markdown.
 */

const TABLE_SOURCE = ['| Name | Value |', '| --- | --- |', '| alpha | 1 |', ''].join('\n')
const TASK_SOURCE = ['- [x] shipped', '- [ ] not yet', ''].join('\n')

/** One assistant turn with the fixture as its prose and no tool steps. */
function assistant(content: string): AgentTurn {
  return { id: 'turn-1', role: 'assistant', content, steps: [] }
}

describe('GFM in the chat', () => {
  it('renders a pipe table in an assistant answer', () => {
    const { container } = render(<MessageBubble message={assistant(TABLE_SOURCE)} />)

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('thead tr')).toHaveLength(1)
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(1)
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((cell) => cell.textContent)).toEqual(['Name', 'Value'])
  })

  it('renders a task list in an assistant answer, with its boxes disabled', () => {
    const { container } = render(<MessageBubble message={assistant(TASK_SOURCE)} />)

    const boxes = [...container.querySelectorAll('li input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes).toHaveLength(2)
    expect(boxes.map((box) => box.disabled)).toEqual([true, true])
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
  })

  it('still shows a user’s own message literally, so the new parsing did not reach it', () => {
    const { container } = render(<MessageBubble message={{ ...assistant(TABLE_SOURCE), role: 'user' }} />)

    // The pipes stay on screen and no table is built: the user's text is theirs, exactly as typed.
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('| Name | Value |')
  })
})
