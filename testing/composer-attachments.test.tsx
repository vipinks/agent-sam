import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The composer's plus picker, as wiring rather than as rules.
 *
 * What only a rendered composer can show is that the control dispatches the bridge member main
 * registered, that the paths which come back are the paths that become chips, and that a batch too
 * large for one message is refused whole rather than truncated to the room that was left.
 *
 * The paths used here are absolute and outside any workspace on purpose: a chip is a file the user
 * chose, and the OS dialog is the one gesture that can reach a file the tree does not list.
 *
 * Residual, named rather than claimed: jsdom lays nothing out, so "beside the paperclip" is asserted
 * as the row's two labels existing together, not as two boxes being adjacent in pixels.
 */

/** The composer's state, seeded as the store main would: no conversation open, so the home card. */
const EMPTY_SESSIONS = { sessions: [], activeSessionId: null }

/** Install a stub whose `attachments.pick` answers with whatever the test's dialog returned. */
function stubComposer(pick: () => string[]): BridgeStub {
  const stub = createBridgeStub({ listFilesFlat: () => [], pick })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, EMPTY_SESSIONS)
  setActiveStub(stub)
  return stub
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The chips the draft is holding, by the path each one names for its remove control. */
function chipPaths(): string[] {
  return screen.queryAllByRole('button', { name: /^Remove / }).map((chip) => chip.getAttribute('aria-label') ?? '')
}

describe('the composer plus', () => {
  it('dispatches the picker and turns what it returns into chips, tails and full-path tooltips', async () => {
    const stub = stubComposer(() => ['C:/elsewhere/notes.txt', '/opt/data/report.csv'])
    renderChat()

    const plus = await screen.findByLabelText('Attach files')
    // The paperclip is untouched and still its own control: one attaches the open file, the other asks
    // the OS for any file at all.
    expect(screen.getByLabelText('Attach the open file')).toBeTruthy()

    await userEvent.click(plus)

    await waitFor(() => expect(stub.methodsOn('attachments')).toContain('pick'))
    // What the dialog returned is what the draft holds — same chip rules as any other path, so the
    // label is the tail and the tooltip is the whole path, workspace or not.
    const chip = await screen.findByTitle('C:/elsewhere/notes.txt')
    expect(chip.textContent).toBe('notes.txt')
    expect((await screen.findByTitle('/opt/data/report.csv')).textContent).toBe('report.csv')
    expect(chipPaths()).toEqual(['Remove C:/elsewhere/notes.txt', 'Remove /opt/data/report.csv'])
  })

  it('adds nothing and says nothing when the dialog is cancelled', async () => {
    const stub = stubComposer(() => [])
    renderChat()

    await userEvent.click(await screen.findByLabelText('Attach files'))

    await waitFor(() => expect(stub.methodsOn('attachments')).toContain('pick'))
    // A dismissed dialog is an ordinary outcome: no chip, and no line under the composer explaining a
    // refusal that did not happen.
    expect(chipPaths()).toEqual([])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('adds a batch whole, and refuses whole the batch that would go past the cap', async () => {
    const fits = Array.from(
      { length: MAX_MENTION_PATHS },
      (_, i) => `C:/elsewhere/file-${String(i + 1).padStart(2, '0')}.ts`
    )
    let pick: string[] = fits
    const stub = stubComposer(() => pick)
    renderChat()

    const plus = await screen.findByLabelText('Attach files')
    await userEvent.click(plus)

    // Exactly at the cap is allowed: the boundary is "would exceed", not "reached".
    await waitFor(() => expect(chipPaths().length).toBe(MAX_MENTION_PATHS))
    expect(chipPaths()).toEqual(fits.map((path) => `Remove ${path}`))

    // One more path than the message can carry. The whole batch is refused — the chips are exactly
    // where they were — and the wording is the cap's own, not a count of what fit.
    pick = ['C:/elsewhere/one-too-many.ts']
    stub.on('pick', () => pick)
    await userEvent.click(plus)

    expect(await screen.findByText(new RegExp(`at most ${MAX_MENTION_PATHS} files`))).toBeTruthy()
    expect(chipPaths().length).toBe(MAX_MENTION_PATHS)
    expect(chipPaths()).not.toContain('Remove C:/elsewhere/one-too-many.ts')
  })
})
