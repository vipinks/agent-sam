import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryPanel } from '@/app/components/workbench/memory-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Slice 2's two renderer claims: the consent switch in the Memory panel's header, which is what
 * turns episodic capture on and off, and the read-only rows that preview the blocks the brief
 * carries. The four canonical page tabs are asserted untouched, because the panel they live in is
 * the one this phase edited.
 *
 * The rows are seeded out of order on purpose. Their order is the brief's own — newest capture
 * first — which is a rule main mirrors and the panel draws, not an accident of whatever the mirror
 * happened to hold last.
 */

const ROOT = 'C:/w'
const OLDEST = '11111111-2222-4333-8444-555555555555'
const NEWEST = '22222222-3333-4444-8555-666666666666'
const MIDDLE = '33333333-4444-4555-8666-777777777777'

const PAGES = [
  { page: 'handoff', exists: true, revisions: 0 },
  { page: 'decisions', exists: false, revisions: 0 },
  { page: 'parked', exists: false, revisions: 0 },
  { page: 'quirks', exists: false, revisions: 0 },
]

const EPISODES = [
  { sessionId: OLDEST, turnId: 'assistant-old', capturedAt: 1_000, ordinal: 1, ask: 'the oldest captured ask' },
  { sessionId: NEWEST, turnId: 'assistant-new', capturedAt: 3_000, ordinal: 2, ask: 'the newest captured ask' },
  { sessionId: MIDDLE, turnId: 'assistant-mid', capturedAt: 2_000, ordinal: 1, ask: 'the middle captured ask' },
]

/** The panel's own reads, and the memory store it mirrors. Nothing else is on screen here. */
function stubPanel(episodesEnabled = true): BridgeStub {
  const stub = createBridgeStub({
    listPages: () => PAGES,
    readPage: () => ({ content: 'ship the small release', revisions: 0 }),
    search: () => [],
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'memory', { pages: PAGES, episodes: EPISODES, episodesEnabled })
  setActiveStub(stub)
  return stub
}

function renderPanel() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryPanel />
    </QueryClientProvider>
  )
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

describe('the episode capture switch', () => {
  it('reflects the stored setting and dispatches the ruled action on click', async () => {
    const stub = stubPanel(false)
    renderPanel()

    const toggle = await screen.findByRole('switch', { name: 'Capture episodes' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await userEvent.click(toggle)
    await waitFor(() => {
      expect(
        stub.calls.some(
          (call) =>
            call.channel === 'conveyor:store:memory' &&
            call.method === 'setEpisodesEnabled' &&
            (call.args[0] as { enabled: boolean }).enabled === true
        )
      ).toBe(true)
    })
  })

  it('is checked when the stored setting is on, and states its name to a reader', async () => {
    stubPanel(true)
    renderPanel()

    const toggle = await screen.findByRole('switch', { name: 'Capture episodes' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})

describe('the episode rows', () => {
  it('lists captured episodes newest first and leaves the four page tabs untouched', async () => {
    stubPanel()
    const { container } = renderPanel()

    await waitFor(() => expect(container.querySelectorAll('[data-slot="memory-episode-row"]').length).toBe(3))

    const asks = [...container.querySelectorAll('[data-slot="memory-episode-row"]')].map((row) => row.textContent ?? '')
    expect(asks[0]).toContain('the newest captured ask')
    expect(asks[1]).toContain('the middle captured ask')
    expect(asks[2]).toContain('the oldest captured ask')

    // The four canonical pages are the panel's tabs, and the rows are a section beside them.
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(container.querySelector('[data-slot="memory-tabs"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="memory-episodes"]')).not.toBeNull()
  })
})
