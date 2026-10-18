import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Card } from '@/app/components/ui/card'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { HOME_HEADLINE, HOME_STARTERS } from '@/app/components/workbench/home'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The second look-and-feel pass, as structure: one home stack, opaque surfaces, one border grammar,
 * and a disabled send that reads as a control rather than as a smudge.
 *
 * jsdom lays nothing out, so nothing here measures a pixel. What it holds is the class contract the
 * running window is judged by:
 *
 * 1. The home screen is one vertically-centred stack — hero, composer, recents, starters — with the
 *    leftover height distributed outside it rather than inside the hero as a void.
 * 2. A card is an opaque surface: `bg-card`, the hairline shadow, no alpha and no border.
 * 3. Chips are containers, so they carry the plate treatment and no persistent border.
 * 4. The disabled send is ink at reduced opacity, never a grey fill.
 *
 * Residual, named rather than claimed: the *appearance* — the gap above and below the stack on a tall
 * and a short window, the card separating from the page in both modes, the chips reading as plates —
 * is Boss's eyes in the running window, in both modes and all five themes. This file proves the class
 * strings that produce it.
 */

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

/** A border utility is any `border`/`border-*` token: the grammar removes the container's outline. */
function borderTokens(element: Element | null): string[] {
  return tokens(element).filter((token) => token === 'border' || token.startsWith('border-'))
}

/** The home pane with one remembered folder and no conversation, which is the state this pass is about. */
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
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT] })
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

describe('the home stack', () => {
  it('is one vertically-centred container with a bounded gap and no void spacer', async () => {
    renderHome()
    await screen.findByText(HOME_HEADLINE)

    const stack = document.querySelector('[data-slot="home-stack"]')
    expect(stack, 'home is drawn as one stack').not.toBeNull()
    const stackTokens = tokens(stack)
    expect(stackTokens).toContain('flex-col')
    expect(stackTokens).toContain('justify-center')
    expect(
      stackTokens.some((token) => /^gap-/.test(token)),
      'the gaps inside the stack are bounded'
    ).toBe(true)

    // The hero is an item in that stack, not the element that swallows the window's leftover height:
    // the void was a centred paragraph inside a `flex-1` block, and a hero that still grows would put
    // it back at any window tall enough to have space left over.
    const hero = screen.getByText(HOME_HEADLINE).parentElement
    expect(tokens(hero)).not.toContain('flex-1')
    expect(tokens(hero)).not.toContain('justify-center')

    // The stack is the stack: the hero, the composer card, the remembered folder and the starters all
    // live inside the one container whose leftover height is distributed outside it.
    const composerHandle = document.querySelector('[aria-label="Resize the composer"]')
    const composer = composerHandle?.parentElement ?? null
    // Scoped to the stack: the pane header can carry a folder control with the same title, and it is
    // not the chip this pass is about.
    const recentChip = stack?.querySelector(`[title="${ROOT}"]`) ?? null
    const starter = screen.getByRole('button', { name: HOME_STARTERS[0] })

    expect(stack?.contains(hero ?? null)).toBe(true)
    expect(stack?.contains(composer)).toBe(true)
    expect(stack?.contains(recentChip)).toBe(true)
    expect(stack?.contains(starter)).toBe(true)
  })
})

describe('the surface grammar', () => {
  it('makes a card opaque: bg-card, the hairline shadow, no alpha and no border', () => {
    const { container } = render(<Card />)
    const card = container.firstElementChild
    const cardTokens = tokens(card)

    expect(cardTokens).toContain('bg-card')
    expect(cardTokens).toContain('shadow-sm')
    expect(
      cardTokens.filter((token) => token.startsWith('bg-card/')),
      'an opaque surface carries no alpha'
    ).toEqual([])
    expect(borderTokens(card), `border utilities: ${borderTokens(card).join(', ')}`).toEqual([])
  })

  it('gives the recent-project chip and the starter chip the plate and no persistent border', async () => {
    renderHome()
    await screen.findByText(HOME_HEADLINE)

    const stack = document.querySelector('[data-slot="home-stack"]')
    const recentChip = stack?.querySelector(`[title="${ROOT}"]`) ?? null
    expect(recentChip, 'the remembered folder is drawn').not.toBeNull()
    expect(borderTokens(recentChip), `recent chip borders: ${borderTokens(recentChip).join(', ')}`).toEqual([])
    expect(tokens(recentChip)).toContain('bg-card')
    expect(tokens(recentChip)).toContain('shadow-sm')

    const starter = screen.getByRole('button', { name: HOME_STARTERS[0] })
    expect(borderTokens(starter), `starter chip borders: ${borderTokens(starter).join(', ')}`).toEqual([])
    expect(tokens(starter)).toContain('bg-card')
    expect(tokens(starter)).toContain('shadow-sm')
  })
})

describe('the send button', () => {
  it('is ink at reduced opacity when disabled, with no grey fill', async () => {
    renderHome()
    await screen.findByText(HOME_HEADLINE)

    const send = screen.getByRole('button', { name: 'Send message' })
    // `toBeDisabled` is a jest-dom matcher and this runner installs only Testing Library, so the
    // attribute itself is what is asserted.
    expect((send as HTMLButtonElement).disabled).toBe(true)

    const sendTokens = tokens(send)
    expect(sendTokens).toContain('disabled:opacity-40')
    expect(
      sendTokens.filter((token) => token.startsWith('disabled:bg-')),
      'a disabled control is not painted a second colour'
    ).toEqual([])
    // The enabled state is the same ink the rest of the app's primary controls use.
    expect(sendTokens).toContain('bg-primary')
  })
})
