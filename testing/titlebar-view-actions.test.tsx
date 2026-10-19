import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowFrame } from '@/app/shell'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/**
 * The titlebar's four view actions, as wiring: where the buttons sit, what their tooltips say, and what
 * a click reaches.
 *
 * The window frame is rendered rather than a stub of the titlebar, for the reason the suite beside it
 * gives: the buttons are titlebar children and nothing else in the app puts them there. Everything else
 * is the app's real code — the conveyor client, the bridge transport, and the shell that owns the row.
 *
 * Phase 100 changed two things here, and both were forced rather than incidental. The File/Edit/View
 * menus are gone, so the words a tooltip carries can no longer be read off the View menu: they come from
 * the shortcut table, and all four of these buttons now name an accelerator where the menu named one for
 * fullscreen alone. And reload joined the row ahead of the ladder, so the walk back from the theme toggle
 * finds five controls rather than four. What did not change is the order of the four, which is what this
 * file has always been about.
 *
 * jsdom proves wiring and words, not pixels. It cannot say whether five glyphs crowd the row at a narrow
 * windowed width, whether they read at 16px, or how they sit against the theme toggle in either theme:
 * that is Boss's eyes on the running window. What is asserted here is the order in the DOM, the words a
 * hover produces, and the one call each button makes.
 */

/** The four window acts, in the row's order, with the act and the chord each one names. */
const VIEW_ACTIONS = [
  { label: 'Zoom In', act: 'zoomIn', tooltip: 'Zoom In (Ctrl+Plus)' },
  { label: 'Zoom Out', act: 'zoomOut', tooltip: 'Zoom Out (Ctrl+Minus)' },
  { label: 'Actual Size', act: 'resetZoom', tooltip: 'Actual Size (Ctrl+0)' },
  { label: 'Toggle Fullscreen', act: 'toggleFullscreen', tooltip: 'Toggle Fullscreen (F11)' },
] as const

/**
 * The buttons sitting immediately before the theme toggle, in the row's own order.
 *
 * Walked from the theme toggle backwards, and only while the siblings are buttons — so a wrapper such
 * as a div around a group, or anything else wedged between them and the toggle, makes this stop early
 * and fail the order test rather than passing over the gap. The one thing skipped is the group
 * separator Phase 96 puts on every seam: it is a rule drawn between two groups, not a box around one,
 * so the controls on either side of it are still each other's neighbours in everything but position.
 */
function buttonsBeforeThemeToggle(): HTMLElement[] {
  const theme = screen.getByRole('button', { name: 'Toggle theme' })
  const before: HTMLElement[] = []
  for (let node = theme.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.hasAttribute('data-titlebar-separator')) continue
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
  // The shell asks main for the window's capabilities on mount, the four buttons dispatch commands, and
  // the reload button beside them dispatches a fifth — so the stub answers all of them. Each is a command
  // in the manifest the client bootstraps from; without those entries the client refuses the member
  // before any handler could be reached.
  stub = createBridgeStub({
    init: () => ({ platform: 'win32', minimizable: true, maximizable: true }),
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    resetZoom: () => undefined,
    toggleFullscreen: () => undefined,
    reload: () => undefined,
  })
  setActiveStub(stub)
})

describe('the titlebar’s view actions', () => {
  it('sits the four of them immediately before the theme toggle, behind reload and in the row’s order', () => {
    render(<WindowFrame>{null}</WindowFrame>)

    expect(buttonsBeforeThemeToggle().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Reload',
      ...VIEW_ACTIONS.map((action) => action.label),
    ])
  })

  it('names the action and its accelerator on each button, from the shortcut table', async () => {
    render(<WindowFrame>{null}</WindowFrame>)

    for (const { label, tooltip } of VIEW_ACTIONS) {
      const button = screen.getByRole('button', { name: label })
      act(() => button.focus())

      await waitFor(() => expect(openTooltipText(), `${label}: its tooltip`).toContain(tooltip))

      act(() => button.blur())
    }

    // All four name a chord now. Before this phase the View menu declared one for fullscreen alone and
    // listed no accelerator for the ladder, so three of these tooltips were the label and nothing else —
    // that difference is the one this assertion exists to pin, in both directions at once.
    for (const { label, tooltip } of VIEW_ACTIONS) {
      expect(tooltip, `${label}: the tooltip names a chord`).toContain('(')
      expect(tooltip, `${label}: in parentheses`).toContain(')')
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
