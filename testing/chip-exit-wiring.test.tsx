import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AttachmentChipRow } from '@/app/components/workbench/attachment-chip'
import { MentionChipRow } from '@/app/components/workbench/mention-chip'
import { SkillChipRow } from '@/app/components/workbench/skill-picker'
import type { DraftAttachment } from '@/app/components/workbench/attachments'

/**
 * Chip removal as a window, on all three chip rows that can lose an item.
 *
 * A chip is the one removal where the surface is not the layout: the composer reflows when the last
 * chip goes, so the chip can fade where it stands and the row is laid out without it. The union is
 * drawn from the current list plus whatever is leaving, the leaving item keeps the classes that carry
 * it out, loses its remove control — a control that removed something already gone is a lie — and is
 * pointer-transparent for the window. What the window buys is not decoration: an attachment's object
 * URL is revoked by the chip's own unmount, so a chip dropped on the same frame it was removed would
 * revoke the bytes before the picture finished leaving the screen.
 *
 * The skill row is pinned beside it because its exit is new *and* its arrival is: a composer that
 * fades a chip in and snaps it out is the one-sided motion this pass exists to remove.
 */

function chipTokens(element: Element | null): string[] {
  if (!element) throw new Error('expected a chip')
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

const EXIT_TOKENS = [
  'animate-out',
  'fade-out',
  'zoom-out-95',
  'slide-out-to-left-1',
  'duration-150',
  'ease-out',
  'motion-reduce:animate-none',
]

const IMAGE: DraftAttachment = {
  id: 'image-one',
  name: 'shot.png',
  mimeType: 'image/png',
  size: 3,
  bytes: new Uint8Array([1, 2, 3]),
}

describe('a mention chip leaving the composer', () => {
  it('stays for the window with its exit classes and no remove control, then leaves the list', async () => {
    const onRemove = vi.fn()
    const view = render(<MentionChipRow paths={['src/a.ts', 'src/b.ts']} onRemove={onRemove} animateOnMount />)

    view.rerender(<MentionChipRow paths={['src/b.ts']} onRemove={onRemove} animateOnMount />)

    const leaving = screen.getByTitle('src/a.ts')
    expect(leaving.getAttribute('data-leaving')).toBe('true')
    expect(chipTokens(leaving)).toEqual(expect.arrayContaining(EXIT_TOKENS))
    // The control goes before the chip does: nothing offers to remove what is already being removed.
    expect(screen.queryByRole('button', { name: 'Remove src/a.ts' })).toBeNull()
    expect(chipTokens(leaving)).toContain('pointer-events-none')

    // The surviving chip is not marked.
    expect(screen.getByTitle('src/b.ts').hasAttribute('data-leaving')).toBe(false)

    await waitFor(() => expect(screen.queryByTitle('src/a.ts')).toBeNull())
  })
})

describe('an attachment chip leaving the composer', () => {
  it('leaves the same way, so its object URL is released at the end of the window', async () => {
    const onRemove = vi.fn()
    const view = render(<AttachmentChipRow images={[IMAGE]} onRemove={onRemove} />)

    view.rerender(<AttachmentChipRow images={[]} onRemove={onRemove} />)

    const leaving = document.querySelector('[data-slot="attachment-chip"]')
    expect(leaving?.getAttribute('data-leaving')).toBe('true')
    expect(chipTokens(leaving)).toEqual(expect.arrayContaining(EXIT_TOKENS))
    expect(screen.queryByRole('button', { name: 'Remove shot.png' })).toBeNull()

    await waitFor(() => expect(document.querySelector('[data-slot="attachment-chip"]')).toBeNull())
  })
})

describe('a skill chip', () => {
  it('arrives with the composer motion and leaves with the same exit', async () => {
    const onRemove = vi.fn()
    const view = render(
      <SkillChipRow skills={[{ id: 'skill-one', title: 'Alpha' }]} disabled={false} onRemove={onRemove} />
    )

    const badge = screen.getByTitle('skill-one')
    expect(chipTokens(badge)).toEqual(
      expect.arrayContaining([
        'animate-in',
        'fade-in',
        'zoom-in-95',
        'slide-in-from-left-1',
        'duration-150',
        'ease-out',
        'motion-reduce:animate-none',
      ])
    )

    view.rerender(<SkillChipRow skills={[]} disabled={false} onRemove={onRemove} />)

    const leaving = screen.getByTitle('skill-one')
    expect(leaving.getAttribute('data-leaving')).toBe('true')
    expect(chipTokens(leaving)).toEqual(expect.arrayContaining(EXIT_TOKENS))
    expect(screen.queryByRole('button', { name: 'Remove skill skill-one' })).toBeNull()

    await waitFor(() => expect(screen.queryByTitle('skill-one')).toBeNull())
  })
})
