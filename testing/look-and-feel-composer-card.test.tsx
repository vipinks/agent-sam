import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { HOME_HEADLINE } from '@/app/components/workbench/home'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The composer card at home, as structure.
 *
 * Its own file because the card exists only on the home screen, and the home state arrives from the
 * chat-sessions store rather than from a prop: a suite that seeded a conversation before this one
 * would leave the pane docked and read the wrong element. One file, one pane, one state.
 *
 * jsdom lays nothing out, so nothing here measures a corner. What it holds is the class contract the
 * running window is judged by — the radius step, the opaque tint and the hairline shadow, with
 * no border drawing the plate's edge.
 */

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: Element | null): string[] {
  if (!element) throw new Error('expected an element')
  return element.className.split(/\s+/).filter(Boolean)
}

/** The home pane with no conversation on record, which is the state the composer card belongs to. */
function renderHome(): void {
  const stub = createBridgeStub({
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    listFilesFlat: () => [],
    listDirectory: () => [],
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    chatWithTools: () => undefined,
    pickFolder: () => null,
    openRoot: (input) => ({ path: (input as { path: string }).path }),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
  stubStore(stub, 'workspace', { rootPath: 'C:/work/sam-ai', recentRoots: [] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('the composer card', () => {
  it('carries the unified radius, the opaque tint and no border', async () => {
    renderHome()

    // The hero is the pane's own statement that it is on the home screen; the composer above it is the
    // card only in that state.
    await screen.findByText(HOME_HEADLINE)

    const handle = document.querySelector('[aria-label="Resize the composer"]')
    const composer = handle?.parentElement ?? null
    const classes = tokens(composer)

    expect(classes).toContain('rounded-xl')
    expect(classes).toContain('bg-card')
    expect(classes).toContain('shadow-sm')
    expect(classes.filter((token) => token === 'border' || token.startsWith('border-'))).toEqual([])
  })
})
