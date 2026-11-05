/**
 * The folder the chat header names, as wiring.
 *
 * The claim here is the smallest one in the pane and the easiest to get wrong quietly: a reader looking at
 * a conversation should be able to see which folder it is running in without opening anything. The chip
 * states the folder's own name — the last segment of the root — with the whole path kept for the tooltip,
 * and states nothing at all when the window has no project open, because a chip with no folder in it is a
 * chip that says the opposite of what it means.
 *
 * What is asserted is the composition rather than the string work: that the header draws the chip at all,
 * that it draws the name the pure rule returns, that the tooltip is the whole path, where in the row it
 * sits — between the pickers and the Auto-approve control — and that a session with no project draws no
 * chip. The rule itself is `tests/sessions/root-name-test.ts`'s subject, which is why the trailing
 * separator is pinned there rather than twice.
 *
 * The width contract is pinned here too, because it is the one thing about this chip that a jsdom suite
 * can hold: the chip keeps a floor (`min-w-20`) and the model combobox beside it sizes to its value
 * (`w-fit`, capped by `max-w-64`) and yields space at the narrow end (`shrink`) rather than claiming the
 * trailing row's whole width (`w-full`). A combobox that claims the row leaves the folder's name with
 * zero pixels to be read in.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the chip looks right in either theme, or
 * that the header still fits its own height with one more control in it; that is Boss's eyes on the
 * running app with a long folder name at a narrow drawer width.
 */
import { describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/conveyor/client'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

const ROOT = 'C:/xampp8212/htdocs/sam-ai'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** One open conversation, so the header draws the trailing controls it draws mid-session. */
const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'the header names the folder',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/** The chat column's declared floor, from `workbench.tsx`: the narrowest a chat header can be. */
const NARROW_HEADER_PX = 320

/** The pane, over a window whose open project is — or is not — a folder, at an optional column width. */
function renderChat(rootPath: string | null, width?: number) {
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })
  stubStore(stub, 'workspace', { rootPath, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)

  // The width is the column's, not the header's: the pane fills whatever column it is given, and the
  // header degrades inside it. jsdom has no layout engine, so this states the width the contract is
  // about; the pixels themselves are the screenshot's to prove.
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        {width === undefined ? (
          <ChatPanel />
        ) : (
          <div style={{ width }}>
            <ChatPanel />
          </div>
        )}
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { stub, unmount: view.unmount }
}

/** The chip as the document has it right now, or null while the header draws none. */
function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="chat-root-chip"]')
}

/**
 * The chip, waited for because the root arrives as a store push.
 *
 * The workspace state crosses the bridge: the pane reads a store hydrated on the tick after it subscribes,
 * so a chip asserted synchronously after a render would be asserted against the header before the project
 * was known — a fact about the harness rather than about the chip.
 */
async function rootChip(): Promise<HTMLElement> {
  const found = await waitFor(() => {
    const node = chip()
    if (!node) throw new Error('the header draws no root chip')
    return node
  })
  return found
}

describe('the chat header’s root chip', () => {
  it('names the session’s working folder, and carries the whole path in its tooltip', async () => {
    renderChat(ROOT)

    const found = await rootChip()
    expect(found.textContent).toBe('sam-ai')
    // The whole path, because the name is a claim about which folder and the path is the answer to the
    // reader who has two folders called `sam-ai`.
    expect(found.getAttribute('title')).toBe(ROOT)
    // Marked with a glyph, so the chip reads as the folder it names rather than as one more label.
    expect(found.querySelector('svg')).not.toBeNull()
  })

  it('sits between the pickers and the Auto-approve control', async () => {
    renderChat(ROOT)

    const found = await rootChip()

    // The pickers are the cluster after the title — the engine picker and the Buddy Select — and the
    // Auto-approve control is the shield in the trailing row. The chip belongs between them: it is a fact
    // about the session like the auto-approve state, and it is not one of the things a session is picked by.
    const buddy = screen.getByRole('combobox', { name: 'Buddy' })
    const shield = screen.getByRole('switch', { name: 'Auto-approve tool actions' })

    expect(Boolean(buddy.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(found.compareDocumentPosition(shield) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('keeps the name beside its glyph and ahead of the model trigger at a narrow and a wide header', async () => {
    // The two widths the contract is about: the chat column's own floor, and a comfortable workbench.
    // The chip must read at both; a label that only survives a wide pane is a label that is missing
    // exactly where the folder matters most.
    for (const width of [NARROW_HEADER_PX, 1200]) {
      const view = renderChat(ROOT, width)
      const found = await rootChip()

      // The glyph and then the name, as the element has always drawn them.
      const glyph = found.firstElementChild
      const name = found.lastElementChild as HTMLElement
      expect(glyph?.tagName.toLowerCase()).toBe('svg')
      expect(name.textContent).toBe('sam-ai')
      expect(name.className).toContain('truncate')
      // The same title it always carried: the whole path, for the reader with two folders of one name.
      expect(found.getAttribute('title')).toBe(ROOT)

      // The label holds a floor of its own, so the control beside it cannot take the last of its width.
      expect(found.className).toContain('min-w-20')

      // And it is drawn before the model trigger, which sizes to its value rather than claiming the
      // trailing row. `w-full` on that trigger is the defect this pair of assertions exists to keep out:
      // a 100-percent flex basis starves the label to zero pixels without deleting anything. `shrink`
      // overrides the Button primitive's `shrink-0`, so the trigger yields at the narrow end too.
      const model = screen.getByRole('combobox', { name: /^Provider and model/ })
      expect(Boolean(found.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
      expect(model.className).toContain('w-fit')
      expect(model.className).not.toContain('w-full')
      expect(model.className.split(' ')).toContain('shrink')
      // The truncation bound, not the layout width: a long model or combo still ellipsizes here.
      expect(model.className).toContain('max-w-64')

      // And the control between them has not moved: Auto-approve still sits after the chip and before
      // the model combobox, which is the row order the folder chip was introduced into.
      const shield = screen.getByRole('switch', { name: 'Auto-approve tool actions' })
      expect(Boolean(found.compareDocumentPosition(shield) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
      expect(Boolean(shield.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)

      view.unmount()
    }
  })

  it('draws nothing at all when the project is closed under it', async () => {
    const { stub } = renderChat(ROOT)

    // The chip is waited for first, so "nothing is drawn" is a claim about a header that had one: a header
    // that never drew a chip would satisfy the assertion below for the wrong reason.
    await rootChip()

    // Closing the project is `rootPath: null` on the store the chip reads, which is the only thing a
    // session with no project means.
    await act(async () => stubStore(stub, 'workspace', { rootPath: null, recentRoots: [] }))
    await waitFor(() => expect(chip()).toBeNull())

    // The rest of the header is unaffected: nothing about a missing project moves the controls that were
    // already there.
    expect(screen.getByRole('combobox', { name: 'Buddy' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Auto-approve tool actions' })).toBeTruthy()
  })
})
