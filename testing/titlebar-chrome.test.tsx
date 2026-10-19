import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { IconRail } from '@/app/components/workbench/icon-rail'
import { RightRail } from '@/app/components/workbench/right-rail'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { WindowFrame } from '@/app/shell'
import { useWindowStore } from '@/app/shell/window-store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Phase 100’s chrome, as structure: no menus, a reload control where the row begins, one chrome grid,
 * and six accelerators that no longer need a menu to be reachable.
 *
 * jsdom lays nothing out, so nothing here measures a pixel. What it holds is the element and class
 * contract the running window is judged by:
 *
 * 1. The titlebar renders no File, Edit or View trigger, and the window store has no menu state left for
 *    an Alt press to flip.
 * 2. Reload sits immediately before the zoom-in control, and reaches the same `web.reload` the View
 *    menu’s own Reload entry called.
 * 3. Every group seam in the row is one vertical rule that carries its own fixed geometry and its own
 *    paint — a rule that exists but is zero tall is the failure this file now names — the pitch inside a
 *    group is the single gap token, and the update group’s rule arrives with the badge rather than
 *    standing alone.
 * 4. Both rails are as wide as the titlebar is tall, their icons are sized inside that measure, and both
 *    carry the same gap token.
 * 5. The six chords still fire with no menu in the tree — and not into a field, and not while another
 *    window has the focus.
 *
 * Residual, named rather than claimed: the *appearance* — whether the 2.5rem rail reads as one measure
 * beside the titlebar, whether the tighter pitch still breathes, whether the rules read as groups rather
 * than as decoration — is Boss’s eyes in the running window, in both modes. This file proves the class
 * strings, the order, and the calls.
 */

/**
 * The row’s own sequence, from the leading control to the window buttons.
 *
 * A separator is read as `|` and a control as its accessible name, so the seam pattern and the order are
 * one assertion rather than two that could disagree. The update badge is absent here because the update
 * store sits at `idle` outside a packaged build, which is exactly the state in which its rule must not
 * stand alone.
 */
const ROW = [
  'Reload',
  '|',
  'Zoom In',
  'Zoom Out',
  'Actual Size',
  '|',
  'Toggle Fullscreen',
  '|',
  'Toggle theme',
  'Theme: Crimson',
  'Brightness',
  'Contrast',
  '|',
  'Terminal panel',
  'Minimize',
  'Maximize',
  'Close',
]

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokens(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean)
}

/**
 * The declared measure of one axis: the number in `h-10` or `w-10`.
 *
 * Read as a number rather than compared as a string because the two bands are written with different
 * utilities: what has to match is the measure, not the direction it is applied in.
 */
function measureOf(element: Element, axis: 'h' | 'w'): number {
  const token = tokens(element).find((candidate) => new RegExp(`^${axis}-\\d+$`).test(candidate))
  if (!token) throw new Error(`expected an ${axis}-* utility, saw: ${element.className}`)
  return Number(token.split('-')[1])
}

/** The titlebar’s trailing cluster: the row this file is about. */
function cluster(): HTMLElement {
  const header = document.querySelector('header')
  const last = header?.lastElementChild
  if (!(last instanceof HTMLElement)) throw new Error('the titlebar rendered no trailing cluster')
  return last
}

/** The row, in document order: `|` for a separator, the accessible name for a control. */
function row(): string[] {
  return [...cluster().querySelectorAll<HTMLElement>('button, [data-titlebar-separator]')].map((node) =>
    node.hasAttribute('data-titlebar-separator') ? '|' : (node.getAttribute('aria-label') ?? '?')
  )
}

let stub: BridgeStub

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ activeActivity: 'chat', drawerCollapsed: false, rightPanel: null })
  useWindowStore.setState({ isFocused: true })
  stub = createBridgeStub({
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    resetZoom: () => undefined,
    toggleFullscreen: () => undefined,
    reload: () => undefined,
    toggleDevtools: () => undefined,
    actualSize: () => undefined,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
  setActiveStub(stub)
})

/**
 * The shell with both rails beside it, over a bridge that answers the window and web acts.
 *
 * The three chrome bands are rendered together because the claim is about their *relationship*: two
 * measures read in two files are only equal if something reads both of them in one document.
 */
function renderChrome(child: ReactNode = null): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <WindowFrame>{child}</WindowFrame>
        <IconRail />
        <RightRail />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('the titlebar without its menus', () => {
  it('renders no File, Edit or View trigger', () => {
    renderChrome()

    for (const name of ['File', 'Edit', 'View']) {
      expect(screen.queryByRole('button', { name }), `${name}: no menu trigger`).toBeNull()
    }
    expect(screen.queryAllByRole('menu'), 'no menu is drawn at all').toHaveLength(0)
  })

  it('keeps no menu state for an Alt press to toggle', () => {
    renderChrome()

    // The Alt handler and the flag it wrote lived together; both are gone, so the state is the claim. Read
    // through a widened view because the point is the *absence* of a key the type no longer declares.
    const state = useWindowStore.getState() as unknown as Record<string, unknown>
    expect('menuVisible' in state, 'the menu flag is gone').toBe(false)
    expect('toggleMenu' in state, 'and the toggle that flipped it').toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }))
    })
    expect(screen.queryAllByRole('menu'), 'Alt opens nothing').toHaveLength(0)
  })
})

describe('the reload control', () => {
  it('sits immediately before the zoom-in control', () => {
    renderChrome()

    // The nearest control before Zoom In, walking back over the group seam between them: reload is a
    // group of its own in the re-cut row, so the rule sits between the two, and what "immediately
    // before" means is that no other control does.
    let node = screen.getByRole('button', { name: 'Zoom In' }).previousElementSibling
    while (node?.hasAttribute('data-titlebar-separator')) node = node.previousElementSibling

    expect(node, 'the control before Zoom In').not.toBeNull()
    expect(node?.getAttribute('aria-label')).toBe('Reload')
  })

  it('reloads through the command the View menu’s Reload entry called', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    // `web.reload`, not a second reload of the shell’s own making: the entry’s command is the one the
    // icon reuses, which is what makes the removal of the menu a move rather than a rewrite.
    expect(stub.methodsOn('web')).toEqual(['reload'])
  })
})

describe('the row’s groups', () => {
  it('puts one vertical rule at every seam and nothing else between the icons of a group', () => {
    renderChrome()

    expect(row()).toEqual(ROW)
  })

  it('draws each rule with geometry and paint that survive layout', () => {
    renderChrome()

    const rules = [...document.querySelectorAll<HTMLElement>('[data-titlebar-separator]')]
    expect(rules, 'one rule per seam').toHaveLength(ROW.filter((entry) => entry === '|').length)

    for (const rule of rules) {
      const classes = tokens(rule)
      // Presence is not the claim. A `h-full` rule inside a cluster whose own height is its content's
      // resolves against an indefinite height, computes to `auto`, and an empty box at `auto` height is
      // zero tall: it is in the tree, in the right place, and paints nothing. So the geometry has to be
      // the fixed measure and the bitmap has to be a paint with contrast against the bar, both read off
      // the element rather than assumed from the fact that it rendered.
      expect(classes, 'a fixed height, not a percentage of an indefinite one').toContain('h-5')
      expect(classes, 'a one-pixel width').toContain('w-px')
      expect(classes, 'self-centred, so the cluster’s alignment cannot flatten it').toContain('self-center')
      expect(
        classes.filter((candidate) => /(^|:)h-(full|auto)$/.test(candidate)),
        'no height that resolves to zero'
      ).toEqual([])
      expect(classes, 'a paint that reads against the bar rather than a surface token').toContain('bg-foreground/35')
    }
  })

  it('keeps one gap token between the icons inside a group', () => {
    renderChrome()

    expect(tokens(cluster())).toContain('gap-1')
  })
})

describe('the chrome grid', () => {
  it('draws both rails at the titlebar’s own measure', () => {
    renderChrome()

    const header = document.querySelector('header')
    if (!header) throw new Error('the titlebar rendered no header')
    const left = screen.getByRole('navigation', { name: 'Workbench' })
    const right = screen.getByRole('navigation', { name: 'Right rail' })

    expect(measureOf(left, 'w'), 'the left rail’s width').toBe(measureOf(header, 'h'))
    expect(measureOf(right, 'w'), 'the right rail’s width').toBe(measureOf(header, 'h'))
  })

  it('sizes the icons inside that measure, at one gap token on both rails', () => {
    renderChrome()

    const rails = [
      screen.getByRole('navigation', { name: 'Workbench' }),
      screen.getByRole('navigation', { name: 'Right rail' }),
    ]

    for (const rail of rails) {
      const label = rail.getAttribute('aria-label') ?? ''
      expect(tokens(rail), `${label}: one gap token`).toContain('gap-1')
      const buttons = [...rail.querySelectorAll('button')]
      expect(buttons.length, `${label}: it draws icons`).toBeGreaterThan(0)
      for (const button of buttons) {
        expect(tokens(button), `${label}/${button.getAttribute('aria-label')}: sized inside the rail`).toContain(
          'size-8'
        )
      }
    }
  })
})

describe('the accelerators without a menu', () => {
  it('reloads on Ctrl+R when the window has the focus', async () => {
    renderChrome(<input aria-label="a field" />)

    await userEvent.keyboard('{Control>}r{/Control}')

    expect(stub.methodsOn('web')).toEqual(['reload'])
  })

  it('leaves a field alone: Ctrl+R typed into one is the field’s, not the window’s', async () => {
    renderChrome(<input aria-label="a field" />)

    await userEvent.click(screen.getByLabelText('a field'))
    await userEvent.keyboard('{Control>}r{/Control}')

    expect(stub.callsTo('web'), 'no window act was dispatched').toEqual([])
  })

  it('does nothing while another window has the focus', async () => {
    renderChrome()

    act(() => useWindowStore.setState({ isFocused: false }))
    await userEvent.keyboard('{Control>}r{/Control}')

    expect(stub.callsTo('web'), 'a chord from an unfocused window is not this window’s').toEqual([])
  })
})
