import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryPanel } from '@/app/components/workbench/memory-panel'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The memory panel, and the rail button that docks it.
 *
 * Three claims, two of them only a rendered workbench can show and one only the rail's own markup can:
 *
 * - The panel renders its four canonical pages as tabs, in order — the list is the protocol's fixed
 *   four, not something the panel invents per project.
 * - The new rail button reuses the active-indicator literal verbatim, so the look-and-feel pin at
 *   right-rail.tsx stays green: the inactive arm states the muted/hover pair and the docked arm states
 *   the brand-soft pair, exactly as the four existing residents do.
 * - Clicking the Memory resident docks the panel into the right slot, the same way the other four do.
 */

const ROOT = 'C:/w'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

const PAGES = [
  { page: 'handoff', exists: true, revisions: 0 },
  { page: 'decisions', exists: false, revisions: 0 },
  { page: 'parked', exists: false, revisions: 0 },
  { page: 'quirks', exists: false, revisions: 0 },
]

/** One captured turn, so the panel's store mirror is the slice-2 shape rather than the slice-1 one. */
const EPISODES = [
  {
    sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
    turnId: 'assistant-2',
    capturedAt: 1_000,
    ordinal: 2,
    ask: 'fix the parser',
  },
]

function sessionStore() {
  return {
    sessions: [
      {
        id: SESSION_ID,
        title: 'a conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        rootPath: ROOT,
      },
    ],
    activeId: SESSION_ID,
  }
}

/** A stub for the workbench's own reads, plus the memory reads the panel makes. */
function stubWorkbench(): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    openRoot: () => ROOT,
    readPage: () => ({ content: 'ship the small release', revisions: 0 }),
    listPages: () => PAGES,
    search: () => [],
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'memory', { pages: PAGES, episodes: EPISODES, episodesEnabled: true })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore())
  setActiveStub(stub)
  return stub
}

function renderMemoryPanel() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryPanel />
    </QueryClientProvider>
  )
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

function rightRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Right rail' })
}

function resident(label: string): HTMLElement {
  return within(rightRail()).getByRole('button', { name: label })
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

describe('the memory panel', () => {
  it('renders its four canonical pages as tabs, in order', async () => {
    stubWorkbench()
    renderMemoryPanel()

    await waitFor(() => expect(screen.getByText('Handoff')).toBeTruthy())
    expect(screen.getByText('Decisions')).toBeTruthy()
    expect(screen.getByText('Parked')).toBeTruthy()
    expect(screen.getByText('Quirks')).toBeTruthy()
    // Still exactly four: the episode rows are a section beside the tabs, never a fifth tab.
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })
})

describe('the memory rail button', () => {
  it('reuses the active-indicator literal verbatim and docks the panel', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    // The inactive arm states the muted/hover pair the four existing residents use, byte for byte.
    const button = resident('Memory')
    expect(button.className).toContain('text-muted-foreground hover:bg-accent hover:text-foreground')

    await userEvent.click(button)

    // The docked arm states the brand-soft pair, and the panel's own node is in the right slot.
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'))
    expect(button.className).toContain('bg-brand-soft text-brand')
    await waitFor(() => expect(container.querySelector('[data-slot="memory-panel"]')).not.toBeNull())
  })
})
