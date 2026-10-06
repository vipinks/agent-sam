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

/** The pane, over a window whose open project is — or is not — a folder. */
function renderChat(rootPath: string | null) {
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })
  stubStore(stub, 'workspace', { rootPath, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)

  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { stub }
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

    // The pickers are the cluster after the title — the Buddy Select and the engine picker — and the
    // Auto-approve control is the shield in the trailing row. The chip belongs between them: it is a fact
    // about the session like the auto-approve state, and it is not one of the things a session is picked by.
    const buddy = screen.getByRole('combobox', { name: 'Buddy' })
    const shield = screen.getByRole('switch', { name: 'Auto-approve tool actions' })

    expect(Boolean(buddy.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(found.compareDocumentPosition(shield) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
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
