import { describe, expect, it } from 'vitest'
import {
  WINDOW_STATES,
  defaultLayoutForState,
  mainGroupLayout,
  outerGroupLayout,
  percentSize,
  type WindowState,
} from '@/app/components/workbench/layout'

/**
 * The workbench's starting proportions, per window state, as arithmetic rather than as markup.
 *
 * The reason this is a module rather than four literals in the layout: the workbench is two *nested*
 * groups, so a panel's size and its share of the window are different numbers, and the one a user
 * actually sees is the second. A maximized viewer's 46.25 is a share of the main column, which is
 * itself 80 of the window — so the viewer opens at 37 percent of the window and the chat at 43, and
 * the drawer takes the fifth that is left. Those products are the whole point of writing the numbers
 * down, which is why they are asserted here rather than left to whoever reads the JSX next.
 *
 * Two states rather than one set, because the numbers only mean anything against the window they open
 * in: a windowed window is short of width and splits its three columns near-evenly, while maximized
 * one has width to spare and gives the drawer a fifth of it. A single set would have to be wrong for
 * one of them, and the defaults are what a launch falls back to when nothing was ever dragged.
 *
 * Nothing in here touches the DOM, React or the resize library. What the library does with these
 * numbers — and the unit trap that makes them percentages rather than pixels — is asserted in
 * `layout-wiring.test.tsx`.
 */

describe('the workbench’s defaults, per window state', () => {
  it('opens a windowed window at 34/66, with its main column split 50/50', () => {
    const sizes = defaultLayoutForState('windowed')

    expect(sizes.outer.drawer).toBe(34)
    expect(sizes.outer.main).toBe(66)
    expect(sizes.main.chat).toBe(50)
    expect(sizes.main.viewer).toBe(50)
  })

  it('opens a maximized window at 20/80, with its main column split 53.75/46.25', () => {
    const sizes = defaultLayoutForState('maximized')

    expect(sizes.outer.drawer).toBe(20)
    expect(sizes.outer.main).toBe(80)
    expect(sizes.main.chat).toBe(53.75)
    expect(sizes.main.viewer).toBe(46.25)
  })

  it('fills each group of each state exactly, so no panel opens with a size nothing accounts for', () => {
    for (const state of WINDOW_STATES) {
      const sizes = defaultLayoutForState(state)

      expect(sizes.outer.drawer + sizes.outer.main, `${state}'s outer group`).toBe(100)
      expect(sizes.main.chat + sizes.main.viewer, `${state}'s main column`).toBe(100)
    }
  })

  it('gives a windowed window three near-equal columns and a maximized one 20/43/37', () => {
    // The nested product: a panel's share of the window is its own share of its group multiplied by
    // the share its group has of the outer one. This is the arithmetic the two nested sets exist for —
    // reading either set alone tells you what a panel has of its own group and nothing about the
    // window, and it is the window the user is looking at.
    const windowed = defaultLayoutForState('windowed')
    const maximized = defaultLayoutForState('maximized')

    const columnsOfWindow = (state: WindowState) => {
      const sizes = defaultLayoutForState(state)
      const mainShare = sizes.outer.main / 100
      return {
        drawer: sizes.outer.drawer,
        chat: mainShare * sizes.main.chat,
        viewer: mainShare * sizes.main.viewer,
      }
    }

    expect(columnsOfWindow('windowed')).toEqual({ drawer: 34, chat: 33, viewer: 33 })
    expect(columnsOfWindow('maximized')).toEqual({ drawer: 20, chat: 43, viewer: 37 })
    // Stated apart from the arithmetic as well, because the point of the pair is that they differ:
    // one split cannot be right for both windows.
    expect(windowed.main.chat).not.toBe(maximized.main.chat)
  })

  it('answers the same numbers every time it is asked', () => {
    // Purity in the sense that matters here: nothing is memoised across calls and nothing the caller
    // can do to one answer changes the next.
    for (const state of WINDOW_STATES) {
      const first = defaultLayoutForState(state)
      const second = defaultLayoutForState(state)

      expect(second).toEqual(first)
      expect(second).not.toBe(first)
      expect(second.outer).not.toBe(first.outer)
    }
  })
})

describe('the layouts the workbench declares to each group', () => {
  it('keys the outer layout by the panel ids that group is built with', () => {
    // The share and the panel it belongs to are named together here because the drag that comes back
    // is keyed the same way: the library hands back a map of panel id to share, and the two maps have
    // to agree about what the drawer is called.
    expect(outerGroupLayout(defaultLayoutForState('windowed'))).toEqual({ secondary: 34, main: 66 })
  })

  it('keys the main column’s layout by the chat and the viewer’s panel id', () => {
    expect(mainGroupLayout(defaultLayoutForState('maximized'))).toEqual({ chat: 53.75, code: 46.25 })
  })

  it('declares each group from the one set, so the two cannot be given numbers that were written apart', () => {
    const sizes = defaultLayoutForState('maximized')

    expect(outerGroupLayout(sizes)).toEqual({ secondary: sizes.outer.drawer, main: sizes.outer.main })
    expect(mainGroupLayout(sizes)).toEqual({ chat: sizes.main.chat, code: sizes.main.viewer })
  })
})

describe('the size unit', () => {
  it('writes a share as a percentage, because the library reads a bare number as pixels', () => {
    // The trap this exists to close: `defaultSize={20}` is twenty pixels, and `defaultSize="20"` is
    // twenty percent while rendering as invalid CSS. Naming the unit is what makes the sizes above
    // mean what they say — and what makes them observable in a DOM test at all.
    expect(percentSize(20)).toBe('20%')
    expect(percentSize(62.5)).toBe('62.5%')
  })
})
