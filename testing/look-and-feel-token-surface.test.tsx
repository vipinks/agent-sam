import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Card } from '@/app/components/ui/card'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { OverviewPanel } from '@/app/components/workbench/overview-panel'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { THEMES, THEME_MODES } from '@/app/components/workbench/themes'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'
import { parseHslString, rgbOf } from './theme-css'

/**
 * The look-and-feel pass, as structure: one accent per theme, borderless cards, one radius.
 *
 * jsdom lays nothing out, so nothing here measures a pixel. What it can hold is the contract the
 * running window is judged by — that the card primitive draws a tinted, shadowed, borderless plate;
 * that the three surfaces Boss named carry the same radius step; and that each theme carries exactly
 * one accent hue rather than a second brand colour beside the first.
 *
 * The accent claim is stated as a hue rather than as a whole string: a theme may move the accent's
 * lightness in dark mode for legibility, and one that spells the same hue three ways (`--brand`,
 * `--brand-soft`, the syntax keyword derived from it) is still carrying one accent. A theme that
 * introduced a second hue anywhere in that family would fail here, which is the discipline the phase
 * is about.
 *
 * Residual, named rather than claimed: the palette's *appearance* — one accent, borderless cards, the
 * unified radius — is Boss's eyes in the running window, in all five themes. This file only proves the
 * tokens and the class strings that produce it.
 */

/** The five accents the pass prescribes, by the ids the registry actually uses. */
const PRESCRIBED_ACCENT: Record<string, string> = {
  // The brief calls these midnight, parchment and slate; the registry's own names are ocean, amber and
  // violet. The ids are the source of truth for what a theme is called, so the colours are keyed by them.
  crimson: '#dc2626',
  ocean: '#3b82f6',
  amber: '#d97706',
  forest: '#059669',
  violet: '#6366f1',
}

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const ROOT = 'C:/work/sam-ai'

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: Element | null): string[] {
  if (!element) throw new Error('expected an element')
  return element.className.split(/\s+/).filter(Boolean)
}

/** A border utility is any `border`/`border-*` token: the pass removes the plate's outline, not its colour. */
function borderTokens(element: Element | null): string[] {
  return tokens(element).filter((token) => token === 'border' || token.startsWith('border-'))
}

/** A bridge stub with the stores each surface reads, and one active conversation. */
function renderWithStub(node: ReactNode): void {
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
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: 'a conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        lastRoot: ROOT,
      },
    ],
    activeSessionId: SESSION_ID,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>{node}</ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('the card primitive is a borderless tinted plate', () => {
  it('carries the hairline shadow and the translucent card tint, and draws no border', () => {
    const { container } = render(<Card />)
    const card = container.firstElementChild

    expect(tokens(card)).toContain('shadow-sm')
    expect(tokens(card)).toContain('bg-card/80')
    expect(tokens(card)).toContain('backdrop-blur-sm')
    expect(borderTokens(card), `border utilities: ${borderTokens(card).join(', ')}`).toEqual([])
  })

  it('keeps the one radius step the rest of the pass uses', () => {
    const { container } = render(<Card />)
    expect(tokens(container.firstElementChild)).toContain('rounded-xl')
  })
})

describe('the named surfaces carry the unified radius', () => {
  it('gives the session row rounded-xl', async () => {
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

    const title = await screen.findByText('a conversation')
    const row = title.closest('button')?.parentElement ?? null
    expect(tokens(row)).toContain('rounded-xl')
  })

  it('gives every overview tile rounded-xl and no border', async () => {
    renderWithStub(<OverviewPanel />)

    await screen.findByText('Tokens')
    const tiles = Array.from(document.querySelectorAll('[data-slot="overview-tiles"] > div'))

    expect(tiles.length).toBe(4)
    for (const tile of tiles) {
      expect(tokens(tile)).toContain('rounded-xl')
      expect(borderTokens(tile), `tile border utilities: ${borderTokens(tile).join(', ')}`).toEqual([])
    }
  })
})

describe('each theme carries one accent hue', () => {
  it('paints the prescribed accent in both modes', () => {
    for (const theme of THEMES) {
      const expected = PRESCRIBED_ACCENT[theme.id]
      expect(expected, `no prescribed accent for ${theme.id}`).toBeDefined()
      for (const mode of THEME_MODES) {
        expect(rgbOf(theme.tokens[mode].brand), `${theme.id} ${mode} --brand`).toEqual(rgbOf(expected))
      }
    }
  })

  it('gives each theme a different accent, so five themes are five hues', () => {
    const accents = THEMES.map((theme) => rgbOf(theme.tokens.light.brand))
    const distinct = new Set(accents.map(({ r, g, b }) => `${r},${g},${b}`))
    expect(distinct.size).toBe(THEMES.length)
  })

  it('derives the soft and hover accents from that one hue, adding no second colour', () => {
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const brand = parseHslString(theme.tokens[mode].brand)
        expect(brand, `${theme.id} ${mode} --brand is not an hsl colour`).not.toBeNull()

        for (const name of ['brand-soft', 'brand-hover', 'syntax-keyword'] as const) {
          const derived = parseHslString(theme.tokens[mode][name])
          expect(derived, `${theme.id} ${mode} --${name} is not an hsl colour`).not.toBeNull()
          expect(derived?.h, `${theme.id} ${mode} --${name} hue`).toBeCloseTo(brand?.h ?? 0, 0)
        }
      }
    }
  })
})
