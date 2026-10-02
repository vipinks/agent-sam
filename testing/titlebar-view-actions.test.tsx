import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowFrame } from '@/app/shell'
import { MENUS } from '@/app/shell/menu'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/**
 * The titlebar's four view actions, as wiring: where the buttons sit, what their tooltips say, and what
 * a click reaches.
 *
 * The window frame is rendered rather than a stub of the titlebar, for the reason the suite beside it
 * gives: the buttons are titlebar children and nothing else in the app puts them there. Everything else
 * is the app's real code — the conveyor client, the bridge transport, and the shell that owns the row.
 *
 * jsdom proves wiring and words, not pixels. It cannot say whether four more glyphs crowd the row at a
 * narrow windowed width, whether they read at 16px, or how they sit against the theme toggle in either
 * theme: that is Boss's eyes on the running window. What is asserted here is the order in the DOM, the
 * words a hover produces, and the one call each button makes.
 */

/** The four buttons, in the order the View menu lists them, with the act each one dispatches. */
const VIEW_ACTIONS = [
  { label: 'Zoom In', act: 'zoomIn' },
  { label: 'Zoom Out', act: 'zoomOut' },
  { label: 'Actual Size', act: 'resetZoom' },
  { label: 'Toggle Fullscreen', act: 'toggleFullscreen' },
] as const

/** The View menu's own entry for a label — the words the button has to carry. */
function viewMenuItem(label: string) {
  return MENUS.find((menu) => menu.label === 'View')?.items.find((item) => item.label === label)
}

/** The tooltip a button must show: the menu's own label, and its accelerator when the menu has one. */
function expectedTooltip(label: string): string {
  const item = viewMenuItem(label)
  return item?.shortcut ? `${item.label} (${item.shortcut})` : label
}

/**
 * The buttons sitting immediately before the theme toggle, in the row's own order.
 *
 * Walked from the theme toggle backwards, and only while the siblings are buttons — so a wrapper such
 * as a div around the four, or anything else wedged between them and the toggle, makes this empty and
 * fails the order test rather than passing over the gap.
 */
function buttonsBeforeThemeToggle(): HTMLElement[] {
  const theme = screen.getByRole('button', { name: 'Toggle theme' })
  const before: HTMLElement[] = []
  for (let node = theme.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.tagName !== 'BUTTON') break
    before.unshift(node as HTMLElement)
  }
  return before
}

/**
 * The text of every tooltip that is currently open.
 *
 * Radix marks an open tooltip `instant-open` or `delayed-open` rather than `open`, so the state is read
 * as "not closed" — a selector for `open` matches nothing and reads as a tooltip that never appeared.
 */
function openTooltipText(): string {
  const open = document.querySelectorAll('[role="tooltip"]:not([data-state="closed"])')
  return Array.from(open)
    .map((node) => node.textContent ?? '')
    .join(' ')
}

let stub: BridgeStub

beforeEach(() => {
  // The shell asks main for the window's capabilities on mount and the four buttons dispatch commands,
  // so the stub answers all five — an unanswered call is reported as an unhandled error rather than as
  // a failure. Each of the four is a command in the manifest the client bootstraps from; without those
  // entries the client refuses the member before any handler could be reached.
  stub = createBridgeStub({
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    resetZoom: () => undefined,
    toggleFullscreen: () => undefined,
  })
  setActiveStub(stub)
})

describe('the titlebar’s view actions', () => {
  it('sits the four of them immediately before the theme toggle, in the View menu’s own order', () => {
    render(<WindowFrame>{null}</WindowFrame>)

    expect(buttonsBeforeThemeToggle().map((button) => button.getAttribute('aria-label'))).toEqual(
      VIEW_ACTIONS.map((action) => action.label)
    )
  })

  it('names the action and the accelerator on each button, exactly as the View menu shows them', async () => {
    render(<WindowFrame>{null}</WindowFrame>)

    for (const { label } of VIEW_ACTIONS) {
      const button = screen.getByRole('button', { name: label })
      act(() => button.focus())

      await waitFor(() => expect(openTooltipText(), `${label}: its tooltip`).toContain(expectedTooltip(label)))

      act(() => button.blur())
    }

    // The menu is the source of these words, so the two facts that make the claim worth having are
    // stated on their own: fullscreen's tooltip carries the one accelerator the View menu declares, and
    // the three zoom entries carry none, so neither do their buttons.
    const fullscreen = MENUS.find((menu) => menu.label === 'View')?.items.find(
      (item) => item.label === 'Toggle Fullscreen'
    )
    expect(fullscreen?.shortcut, 'the View menu declares F11 for fullscreen').toBe('F11')
    expect(expectedTooltip('Toggle Fullscreen')).toContain('F11')

    for (const { label } of VIEW_ACTIONS.filter((action) => action.label !== 'Toggle Fullscreen')) {
      expect(viewMenuItem(label)?.shortcut, `${label}: the View menu declares no accelerator`).toBeUndefined()
      expect(expectedTooltip(label), `${label}: so its tooltip names no accelerator`).not.toContain('(')
    }
  })

  it('dispatches each action through the bridge, once per click and in the row’s order', async () => {
    render(<WindowFrame>{null}</WindowFrame>)

    for (const { label } of VIEW_ACTIONS) {
      await userEvent.click(screen.getByRole('button', { name: label }))
    }

    // `init` is the shell's own mount read, not one of the four. The record is synchronous — the bridge
    // is reached inside the click — so nothing is waited for here that would hide a deferred dispatch.
    expect(stub.methodsOn('window').filter((method) => method !== 'init')).toEqual(
      VIEW_ACTIONS.map((action) => action.act)
    )
  })

  it('leaves the rest of the row where it was', () => {
    render(<WindowFrame>{null}</WindowFrame>)

    // The theme toggle, the theme chooser and the terminal panel are the row's other controls, and none
    // of them moved or was renamed to make room.
    for (const name of ['Toggle theme', 'Theme: Crimson', 'Brightness', 'Terminal panel']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) }), name).toBeTruthy()
    }
  })
})
