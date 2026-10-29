import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The conversation row's alignment: under its project, and beside its always-visible actions.
 *
 * jsdom lays nothing out, so this suite pins the structural contract the running window draws. The
 * kebab is a sibling in the row's flow rather than an absolutely positioned overlay, so the title keeps
 * the space that is left and the trigger can never become a hidden hit target over its tail.
 */

const PROJECT_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const LOOSE_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** The folder the window is showing; the loose row deliberately has none. */
const ROOT = 'C:/work/sam-ai'

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

/** Install a stub, seed one project row and one no-project row, and render the real panel. */
function renderPanel(activeSessionId: string | null = null) {
  const stub = createBridgeStub({
    loadTranscript: () => null,
    listFilesFlat: () => [],
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: PROJECT_ID,
        title: 'project work',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_002,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        lastRoot: ROOT,
      },
      {
        id: LOOSE_ID,
        title: 'before projects existed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
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
          onMove={vi.fn()}
          error={null}
          notice={null}
        />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

/** The row container for a title: the open control's parent, which also holds the actions. */
function rowFor(title: string): HTMLElement {
  const open = screen.getByText(title).closest('button') as HTMLElement
  return open.parentElement as HTMLElement
}

/** The open control whose text and meta line make up the row's title area. */
function titleButtonFor(title: string): HTMLElement {
  return screen.getByText(title).closest('button') as HTMLElement
}

/** The always-visible action trigger, named for its row. */
function triggerFor(title: string): HTMLElement {
  return screen.getByLabelText(`Session actions for ${title}`)
}

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean)
}

describe('the session row aligns under its project and its actions', () => {
  it("indents every row by the group header's chevron column", async () => {
    renderPanel()
    await screen.findByText('project work')

    // The header's chevron is size-3.5 with gap-1.5 after it, and the header itself starts at px-3:
    // 12 + 14 + 6 = 32px, which is pl-8. A row in the no-project group indents the same way, because
    // that group has a chevron too.
    expect(tokens(rowFor('project work'))).toContain('pl-8')
    expect(tokens(rowFor('before projects existed'))).toContain('pl-8')
  })

  it('keeps the title flexible and the action trigger beside it in the row flow', async () => {
    renderPanel()
    const title = await screen.findByText('project work')
    const button = titleButtonFor('project work')
    const trigger = triggerFor('project work')

    // The title is the in-flow child that shrinks first; the trigger is its sibling, not an overlay
    // pinned over the title's tail.
    expect(tokens(button)).toContain('flex-1')
    expect(tokens(button)).toContain('min-w-0')
    expect(trigger.parentElement).toBe(button.parentElement)
    expect(tokens(trigger)).toContain('shrink-0')
    expect(tokens(trigger)).toContain('self-center')
    expect(tokens(trigger)).not.toContain('absolute')
    expect(tokens(trigger)).not.toContain('opacity-0')
    expect(tokens(title)).toContain('truncate')
  })

  it('removes the hover-only cluster and its fade from the row', async () => {
    renderPanel()
    await screen.findByText('project work')

    const row = rowFor('project work')
    // The old surface was guarded by `group relative`, revealed by group-hover, and painted an
    // absolutely positioned plate with a gradient fence. None of it has a job now that the kebab is
    // visible in flow.
    expect(tokens(row)).not.toContain('group')
    expect(tokens(row)).not.toContain('relative')
    expect(row.querySelector('div.absolute.opacity-0')).toBeNull()
    expect(row.querySelector('span[aria-hidden="true"].h-6')).toBeNull()
    expect(tokens(row)).toContain('hover:bg-accent')
    expect(tokens(row)).toContain('focus-within:bg-accent')
  })

  it("keeps the selected row's tint while the actions stay visible", async () => {
    renderPanel(PROJECT_ID)
    await screen.findByText('project work')

    // Selection remains a row state, not a reason to hide the way out of the row's menu.
    const row = tokens(rowFor('project work'))
    expect(row).toContain('bg-brand-soft')
    expect(tokens(triggerFor('project work'))).not.toContain('opacity-0')
  })
})
