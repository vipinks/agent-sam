import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentActionCard } from '@/app/components/workbench/agent-action-card'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { IconRail } from '@/app/components/workbench/icon-rail'
import { MessageBubble } from '@/app/components/workbench/message-bubble'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { WindowFrame } from '@/app/shell'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The third look-and-feel pass, as structure: the shell and the sidebar under the discipline the
 * centre column already had.
 *
 * jsdom lays nothing out, so nothing here measures a pixel. What it holds is the class and element
 * contract the running window is judged by:
 *
 * 1. The containers left in the transcript column — the tool-call row, the agent-action card and the
 *    answer's own plate — are borderless: an opaque surface plus a hairline shadow, no outline.
 * 2. The titlebar's icon cluster is grouped by hairline separators, with no icon moved and no control
 *    renamed to make room.
 * 3. The rail's active indicator is one accent plate at the pass's radius, on all four rail icons.
 * 4. A session group's header is a quiet plate at the row's radius, with its count right-aligned on
 *    the row grid rather than sized by how many digits it happens to carry.
 *
 * Residual, named rather than claimed: the *appearance* — the plate separating from the lifted page,
 * the separators reading as hairline rules rather than as boxes, the hover plate settling under the
 * pointer — is Boss's eyes in the running window, in both modes and all five themes, on a conversation
 * view and on the home view. This file proves the class strings and the elements that produce it.
 */

const ROOT = 'C:/work/sam-ai'
const SESSION_ONE = 'aaaaaaaa-1111-4111-8111-111111111111'
const SESSION_TWO = 'bbbbbbbb-2222-4222-8222-222222222222'

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [], activeActivity: 'chat', drawerCollapsed: false })
})

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: Element | null): string[] {
  if (!element) throw new Error('expected an element')
  return element.className.split(/\s+/).filter(Boolean)
}

/** A border utility is any `border`/`border-*` token: the grammar removes the container's outline. */
function borderTokens(element: Element | null): string[] {
  return tokens(element).filter((token) => token === 'border' || token.startsWith('border-'))
}

/** A bridge stub with the stores each surface reads, and the conversations the sidebar lists. */
function renderWithStub(node: ReactNode, sessionState?: { sessions: unknown[]; activeSessionId: string | null }): void {
  const stub = createBridgeStub({
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
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
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    resetZoom: () => undefined,
    toggleFullscreen: () => undefined,
  })
  stubStore(
    stub,
    CHAT_SESSIONS_STORE_ID,
    sessionState ?? {
      sessions: [
        {
          id: SESSION_ONE,
          title: 'parser work',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          providerId: 'deepseek',
          model: 'deepseek-chat',
          lastRoot: ROOT,
        },
        {
          id: SESSION_TWO,
          title: 'parser follow-up',
          createdAt: 1_700_000_500_000,
          updatedAt: 1_700_000_500_000,
          providerId: 'deepseek',
          model: 'deepseek-chat',
          lastRoot: ROOT,
        },
      ],
      activeSessionId: SESSION_ONE,
    }
  )
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>{node}</ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('the transcript containers', () => {
  it('draws a tool-call row as a borderless plate: opaque surface, hairline shadow, no outline', () => {
    const { container } = render(
      <AgentActionCard
        step={{
          callId: 'call-1',
          tool: 'read_file',
          args: { path: 'src/app.ts' },
          status: 'ok',
          output: 'body',
        }}
      />
    )

    const row = container.querySelector('[data-slot="agent-action-card"]')
    expect(row, 'the row is drawn').not.toBeNull()
    expect(borderTokens(row), `row border utilities: ${borderTokens(row).join(', ')}`).toEqual([])
    expect(tokens(row)).toContain('bg-card')
    expect(tokens(row)).toContain('shadow-sm')

    // The body is part of the same plate: a `border-t` across it would put the outline back inside the
    // container the sweep just took it off.
    const body = container.querySelector('[data-slot="agent-action-card-body"]')
    expect(body, 'the row draws its body').not.toBeNull()
    expect(borderTokens(body), `body border utilities: ${borderTokens(body).join(', ')}`).toEqual([])
  })

  it('keeps the card that is waiting on a decision a plate rather than an outlined box', () => {
    const { container } = render(
      <AgentActionCard
        step={{ callId: 'call-2', tool: 'run_command', args: { command: 'npm test' }, status: 'awaiting' }}
      />
    )

    const row = container.querySelector('[data-slot="agent-action-card"]')
    expect(borderTokens(row), `awaiting row border utilities: ${borderTokens(row).join(', ')}`).toEqual([])
    // What marks it as needing the user is the accent plate, not an outline in the brand colour.
    expect(tokens(row)).toContain('bg-brand-soft')
  })

  it('draws the answer’s own plate with no persistent border', () => {
    const { container } = render(
      <MessageBubble message={{ id: 'assistant-1', role: 'assistant', content: 'Set up.', steps: [] }} />
    )

    const body = container.querySelector('[data-slot="message-body"]')
    expect(body, 'the answer is drawn').not.toBeNull()
    expect(borderTokens(body), `answer border utilities: ${borderTokens(body).join(', ')}`).toEqual([])
    expect(tokens(body)).toContain('bg-card')
    expect(tokens(body)).toContain('shadow-sm')
  })
})

describe('the titlebar’s icon cluster', () => {
  it('draws a hairline separator between each pair of functional groups', () => {
    renderWithStub(<WindowFrame>{null}</WindowFrame>)

    const separators = [...document.querySelectorAll('[data-titlebar-separator]')]
    // Four groups draw a seam with no update badge in the bar — reload │ zoom → layout → theme → the
    // terminal's own leading rule — and the badge adds a fifth while it has something to say. What the
    // assertion pins is that the count is at least the four seams the row always has.
    expect(separators.length).toBeGreaterThanOrEqual(4)
    for (const separator of separators) expect(separator.getAttribute('aria-hidden') ?? 'true').toBe('true')
  })

  it('leaves every control where it was, so a separator changes the grouping and nothing else', () => {
    renderWithStub(<WindowFrame>{null}</WindowFrame>)

    for (const name of ['Zoom In', 'Actual Size', 'Toggle Fullscreen', 'Toggle theme', 'Terminal panel']) {
      expect(screen.getByRole('button', { name }), name).toBeTruthy()
    }

    // The zoom ladder still sits immediately before the theme toggle, with only a separator between
    // them: a wrapper element would have made this walk come back empty. Reload leads it, as Phase 100
    // put it there, and fullscreen is the last of the five.
    const themeToggle = screen.getByRole('button', { name: 'Toggle theme' })
    const labels: string[] = []
    for (let node = themeToggle.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.hasAttribute('data-titlebar-separator')) continue
      if (node.tagName !== 'BUTTON') break
      labels.unshift(node.getAttribute('aria-label') ?? '')
    }
    expect(labels).toEqual(['Reload', 'Zoom In', 'Zoom Out', 'Actual Size', 'Toggle Fullscreen'])
  })
})

describe('the icon rail’s active indicator', () => {
  /**
   * The rail's four top icons, each with the state that makes it the active one.
   *
   * Home is active at home, which is the window with no conversation open; the three activities are
   * active through the store while a conversation is. Each case is its own test with its own single
   * render, because two rails in one document would make every lookup ambiguous — and because what is
   * being compared is one treatment across four controls, asserted against one literal four times.
   */
  const RAIL_ICONS = ['Home', 'Chat', 'Explorer', 'Git'] as const

  /** The whole of the active indicator, as the one string all four must agree on. */
  const INDICATOR = 'rounded-xl bg-brand-soft text-brand'

  /** Render the rail with one icon active. */
  function renderRailWith(name: (typeof RAIL_ICONS)[number]): void {
    if (name === 'Home') {
      useWorkbenchStore.setState({ activeActivity: 'chat', drawerCollapsed: false })
      renderWithStub(<IconRail />, { sessions: [], activeSessionId: null })
      return
    }

    const activity = { Chat: 'chat', Explorer: 'files', Git: 'git' }[name]
    useWorkbenchStore.setState({ activeActivity: activity, drawerCollapsed: false })
    renderWithStub(<IconRail />)
  }

  it('carries the pass’s radius on all four rail icons, active or not', () => {
    renderWithStub(<IconRail />)

    for (const name of RAIL_ICONS) {
      const button = screen.getByRole('button', { name })
      expect(tokens(button), `${name}: the plate's radius`).toContain('rounded-xl')
    }
  })

  for (const name of RAIL_ICONS) {
    it(`paints ${name}’s active indicator as the accent plate, in the same words as the other three`, async () => {
      renderRailWith(name)

      // Read inside the retry rather than around it. The plate arrives with the session state, which the
      // pane reads through the bridge: at home the rail is drawn before that state settles, so the
      // indicator is asserted on the paint that has it rather than on the first one — and a treatment
      // that never appears there still fails, because the retry has nothing to pass on.
      let indicator = ''
      await waitFor(() => {
        indicator = tokens(screen.getByRole('button', { name }))
          .filter((token) => token === 'rounded-xl' || token === 'bg-brand-soft' || token === 'text-brand')
          .join(' ')
        expect(indicator, `${name}: the indicator, token for token`).toBe(INDICATOR)
      })
    })
  }
})

describe('the session group header', () => {
  it('draws a quiet hover plate at the row’s radius, with its count on the row grid', async () => {
    renderWithStub(
      <SessionListPanel
        onCreate={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onExport={() => undefined}
        onDelete={() => undefined}
        onMove={() => undefined}
        error={null}
        notice={null}
      />
    )

    const header = await screen.findByRole('button', { name: /sam-ai, 2 conversations/ })
    const headerTokens = tokens(header)
    expect(headerTokens, 'the header is a plate at the row radius').toContain('rounded-xl')
    // Quiet: the row under it hovers at full accent, the header at part of it, so the group is legible
    // as a heading without competing with the conversations it heads.
    expect(headerTokens, 'the header hovers on a quieter plate than a row').toContain('hover:bg-accent/60')

    const count = header.querySelector('span.tabular-nums')
    expect(count, 'the count is drawn').not.toBeNull()
    const countTokens = tokens(count)
    // Right-aligned in a fixed box, so a group of nine and a group of ten put their digits on the same
    // edge as the row below them rather than shifting with the number's width.
    expect(countTokens, 'the count aligns to the row edge').toContain('text-right')
    expect(
      countTokens.some((token) => /^w-\d/.test(token)),
      'the count holds a fixed slot'
    ).toBe(true)
  })
})
