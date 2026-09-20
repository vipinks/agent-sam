import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import type { SessionSearchResult } from '@/conveyor/protocol/search'
import type { ExportFormat } from '@/conveyor/protocol/export'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The wiring for Phase 12's three capabilities, asserted where they can actually break.
 *
 * The pure rules are covered by node suites; what only a DOM test can see is whether the panel calls
 * them. Each case below is a way that wiring has already gone wrong once in this codebase — a rule
 * that existed and was never reached — so the assertions are on the call the panel makes and on what
 * the row does with the result, not on the rule's arithmetic.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** Two conversations, one of which a search for "parser" should reach. */
function twoSessions() {
  return {
    sessions: [
      {
        id: SESSION_ID,
        title: 'the parser drops newlines',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
      {
        id: OTHER_ID,
        title: 'unrelated subject entirely',
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_001,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId: SESSION_ID,
  }
}

/** Install a stub, seed the store, and render the real panel with real props. */
function renderPanel(
  options: {
    onRename?: (id: string, title: string) => void
    onExport?: (id: string, format: ExportFormat) => void
    stub?: BridgeStub
  } = {}
) {
  const stub = options.stub ?? createBridgeStub({ loadTranscript: () => null })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, twoSessions())
  setActiveStub(stub)

  const onRename = options.onRename ?? vi.fn()
  const onExport = options.onExport ?? vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <SessionListPanel
          onCreate={vi.fn()}
          onOpen={vi.fn()}
          onRename={onRename}
          onExport={onExport}
          onDelete={vi.fn()}
          error={null}
        />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { view, stub, onRename, onExport }
}

/**
 * Wait for the store's state to reach the rows.
 *
 * conveyor's store mirror fetches once per store id and caches itself at module scope, so whether
 * this is the first test to touch the store decides which mechanism delivers the state — and both are
 * asynchronous, so nothing here can be read synchronously.
 */
async function ready() {
  await screen.findByText('the parser drops newlines')
}

describe('session rename wiring', () => {
  it('renames through the panel when the editor commits on Enter', async () => {
    const { onRename } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Rename the parser drops newlines'))
    const field = await screen.findByLabelText('Session title')
    await userEvent.clear(field)
    await userEvent.type(field, 'newlines investigation{Enter}')

    // The panel reports intent; writing the title is the hook's job, which is what keeps the store
    // semantics (and the schema that validates them) in one place.
    expect(onRename).toHaveBeenCalledWith(SESSION_ID, 'newlines investigation')
    // And the editor is closed, so the row is back to being a row.
    await waitFor(() => expect(screen.queryByLabelText('Session title')).toBeNull())
  })

  it('reverts on Escape and reports nothing', async () => {
    const { onRename } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Rename the parser drops newlines'))
    const field = await screen.findByLabelText('Session title')
    await userEvent.clear(field)
    await userEvent.type(field, 'discard me')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByLabelText('Session title')).toBeNull())
    // Escape must not commit, and must not be followed by the blur-commit either: that pair is why
    // the field tracks its own cancellation.
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('the parser drops newlines')).toBeTruthy()
  })

  it('refuses a whitespace-only title and leaves the old one showing', async () => {
    const { onRename } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Rename the parser drops newlines'))
    const field = await screen.findByLabelText('Session title')
    await userEvent.clear(field)
    await userEvent.type(field, '   {Enter}')

    await waitFor(() => expect(screen.queryByLabelText('Session title')).toBeNull())
    // The rejection is the point: an empty name would have been written to the store, and the row
    // would then render a blank line where its title used to be.
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('the parser drops newlines')).toBeTruthy()
  })

  it('commits on blur, so clicking away is not a silent discard', async () => {
    const { onRename } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Rename the parser drops newlines'))
    const field = await screen.findByLabelText('Session title')
    await userEvent.clear(field)
    await userEvent.type(field, 'committed by blur')
    // Tabbing away blurs the field without pressing anything.
    await userEvent.tab()

    await waitFor(() => expect(onRename).toHaveBeenCalledWith(SESSION_ID, 'committed by blur'))
  })
})

describe('session search wiring', () => {
  it('filters rows by title as the user types', async () => {
    const { stub } = renderPanel()
    await ready()

    expect(screen.getByText('unrelated subject entirely')).toBeTruthy()

    const input = screen.getByLabelText('Search conversations')
    await userEvent.type(input, 'parser')

    // The title filter is client-side: the row that does not match is gone without the scan having to
    // answer — which is what makes typing feel immediate.
    await waitFor(() => expect(screen.queryByText('unrelated subject entirely')).toBeNull())
    expect(screen.getByText('the parser drops newlines')).toBeTruthy()

    // And the transcript scan was asked for, because the term is long enough to be worth one.
    // Deliberately not asserting on the *first* call: typing three characters reaches the floor, so
    // the earliest scan of "parser" is "par" — which is the correct behaviour (the floor is three,
    // not three-and-only-when-finished) and would be misreported as a defect by a first-call
    // assertion. What matters is that the finished term was scanned for.
    await waitFor(() => {
      const searched = stub.calls.filter((c) => c.method === 'searchSessions')
      expect(searched.length).toBeGreaterThan(0)
      expect(searched.map((c) => c.args[0])).toContainEqual({ term: 'parser' })
    })
  })

  it('does not scan for a term below the floor', async () => {
    const { stub } = renderPanel()
    await ready()

    await userEvent.type(screen.getByLabelText('Search conversations'), 'ab')

    // A two-character term would be refused by the command's own schema, so asking would be a request
    // that can only fail. Give any call a chance to happen before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stub.calls.filter((c) => c.method === 'searchSessions')).toHaveLength(0)
  })

  it('shows snippets under the matching row only while the input is focused', async () => {
    const snippet = '…the parser needs a trim before it splits…'
    const stub = createBridgeStub({
      loadTranscript: () => null,
      searchSessions: (): SessionSearchResult[] => [{ id: SESSION_ID, matchCount: 3, snippets: [snippet] }],
    })
    stubStore(stub, CHAT_SESSIONS_STORE_ID, twoSessions())
    setActiveStub(stub)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatSessionsProvider>
          <SessionListPanel
            onCreate={vi.fn()}
            onOpen={vi.fn()}
            onRename={vi.fn()}
            onExport={vi.fn()}
            onDelete={vi.fn()}
            error={null}
          />
        </ChatSessionsProvider>
      </QueryClientProvider>
    )

    const input = screen.getByLabelText('Search conversations')
    await userEvent.click(input)
    await userEvent.type(input, 'parser')

    // While focused, the excerpt is on screen under its row.
    expect(await screen.findByText(snippet)).toBeTruthy()
    // The full count is shown too, because the snippets are only the first few occurrences.
    expect(screen.getByText('3 matches')).toBeTruthy()

    // Blurring hides them: the list is for scanning names, and the excerpts are the answer to a
    // question the user was asking while typing. Blurred by clicking the search field's own label
    // area rather than a row, so the row's open handler is not what moves the focus.
    input.blur()
    await waitFor(() => expect(screen.queryByText(snippet)).toBeNull())
  })

  it('clears the search on Escape', async () => {
    renderPanel()
    await ready()

    const input = screen.getByLabelText('Search conversations')
    await userEvent.type(input, 'parser')
    await waitFor(() => expect(screen.queryByText('unrelated subject entirely')).toBeNull())

    await userEvent.keyboard('{Escape}')

    // Escape clears the field rather than leaving it: there is nowhere to go "back" to in a list that
    // filters in place, so clearing is the only thing it can sensibly mean.
    await waitFor(() => expect(screen.getByText('unrelated subject entirely')).toBeTruthy())
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('says so when a filter matches nothing', async () => {
    renderPanel()
    await ready()

    await userEvent.type(screen.getByLabelText('Search conversations'), 'zzzznotpresent')

    // An empty list would read as \"all my conversations are gone\"; naming the term is what makes it
    // read as a filter.
    expect(await screen.findByText(/No conversations match/)).toBeTruthy()
  })
})

describe('session export wiring', () => {
  it('asks for the format from the row and reports the choice', async () => {
    const { onExport } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Export the parser drops newlines'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }))

    expect(onExport).toHaveBeenCalledWith(SESSION_ID, 'markdown')
  })

  it('offers json as the other format', async () => {
    const { onExport } = renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Export unrelated subject entirely'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'JSON (.json)' }))

    expect(onExport).toHaveBeenCalledWith(OTHER_ID, 'json')
  })

  it('closes the format menu on Escape', async () => {
    renderPanel()
    await ready()

    await userEvent.click(screen.getByLabelText('Export the parser drops newlines'))
    expect(await screen.findByRole('menu', { name: 'Export format' })).toBeTruthy()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Export format' })).toBeNull())
  })
})
