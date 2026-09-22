import { describe, expect, it } from 'vitest'
import {
  WINDOW_STATES,
  defaultLayoutForState,
  layoutFor,
  layoutSetKey,
  mainGroupLayout,
  mergeSavedLayout,
  outerGroupLayout,
  percentSize,
  type LayoutSizes,
  type StoredLayoutSets,
  type WindowState,
} from '@/app/components/workbench/layout'
import { layoutChangeFor } from '@/app/components/workbench/layout-memory'

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

describe('a window’s state and a window’s saved set', () => {
  it('names one stored key per state, so a set is written and read under the same name', () => {
    expect(layoutSetKey('windowed')).toBe('layoutWindowed')
    expect(layoutSetKey('maximized')).toBe('layoutMaximized')
  })

  it('resolves to that state’s defaults when nothing was ever saved', () => {
    expect(layoutFor('windowed', {})).toEqual(defaultLayoutForState('windowed'))
    expect(layoutFor('maximized', {})).toEqual(defaultLayoutForState('maximized'))
  })

  it('prefers a saved set to the default, per state and not across states', () => {
    // The whole point of two keys: what was dragged in a windowed window says nothing about the
    // maximized one, and a single record could only ever answer for one of them.
    const saved: StoredLayoutSets = {
      layoutWindowed: { outer: { drawer: 40, main: 60 }, main: { chat: 55, viewer: 45 } },
    }

    expect(layoutFor('windowed', saved)).toEqual({ outer: { drawer: 40, main: 60 }, main: { chat: 55, viewer: 45 } })
    expect(layoutFor('maximized', saved)).toEqual(defaultLayoutForState('maximized'))
  })

  it('answers with a fresh set rather than the stored object, so a caller cannot write through it', () => {
    const saved: StoredLayoutSets = {
      layoutWindowed: { outer: { drawer: 40, main: 60 }, main: { chat: 55, viewer: 45 } },
    }

    const resolved = layoutFor('windowed', saved)

    expect(resolved).not.toBe(saved.layoutWindowed)
    expect(resolved.outer).not.toBe(saved.layoutWindowed?.outer)
  })

  describe('a saved set that is malformed', () => {
    // Every one of these is a record some earlier version — or a hand edit — could have left behind,
    // and each resolves to the state's defaults rather than to a half-applied layout.
    const malformed: Record<string, unknown> = {
      'not an object': 'windowed',
      'an array': [34, 66],
      'no outer group': { main: { chat: 50, viewer: 50 } },
      'an outer group that is not an object': { outer: 34, main: { chat: 50, viewer: 50 } },
      'a share that is a string': { outer: { drawer: '34', main: 66 }, main: { chat: 50, viewer: 50 } },
      'a share that is not finite': { outer: { drawer: Number.NaN, main: 66 }, main: { chat: 50, viewer: 50 } },
      'a share that is not positive': { outer: { drawer: 0, main: 100 }, main: { chat: 50, viewer: 50 } },
      'a group that does not fill 100': { outer: { drawer: 34, main: 50 }, main: { chat: 50, viewer: 50 } },
      'a missing panel in the inner group': { outer: { drawer: 34, main: 66 }, main: { chat: 50 } },
    }

    for (const [what, value] of Object.entries(malformed)) {
      it(`resolves ${what} to the defaults rather than to it`, () => {
        const saved = { layoutWindowed: value } as StoredLayoutSets

        expect(layoutFor('windowed', saved)).toEqual(defaultLayoutForState('windowed'))
      })
    }
  })

  it('fills each group of a saved set exactly, so a stored set and a default are the same kind of number', () => {
    const saved: StoredLayoutSets = {
      layoutMaximized: { outer: { drawer: 25, main: 75 }, main: { chat: 60, viewer: 40 } },
    }

    const resolved = layoutFor('maximized', saved)

    expect(resolved.outer.drawer + resolved.outer.main).toBe(100)
    expect(resolved.main.chat + resolved.main.viewer).toBe(100)
  })
})

describe('writing a dragged set back', () => {
  const windowed = { outer: { drawer: 34, main: 66 }, main: { chat: 50, viewer: 50 } }
  const maximized = { outer: { drawer: 20, main: 80 }, main: { chat: 53.75, viewer: 46.25 } }

  it('replaces the named state’s set and leaves the other state’s set alone', () => {
    // The rule that keeps a swap honest: a drag in one window state is a fact about that state, and a
    // record written for it must not touch — or drop — what the other state was dragged to.
    const saved: StoredLayoutSets = { layoutWindowed: windowed, layoutMaximized: maximized }
    const next = { outer: { drawer: 45, main: 55 }, main: { chat: 50, viewer: 50 } }

    const merged = mergeSavedLayout(saved, 'windowed', next)

    expect(merged.layoutWindowed).toEqual(next)
    expect(merged.layoutMaximized).toEqual(maximized)
    // Nor the record that was handed in: the stored sets are replaced, not edited in place.
    expect(saved.layoutWindowed).toEqual(windowed)
  })

  it('keeps a saved state’s set when the other state is written', () => {
    const merged = mergeSavedLayout({ layoutWindowed: windowed }, 'maximized', maximized)

    expect(merged).toEqual({ layoutWindowed: windowed, layoutMaximized: maximized })
  })

  it('turns an outer drag into the active state’s set, with the inner group as it already was', () => {
    const change = layoutChangeFor({
      active: 'windowed',
      sizes: defaultLayoutForState('windowed'),
      group: 'outer',
      layout: { secondary: 42, main: 58 },
      viewerExpanded: false,
    })

    expect(change).toEqual({
      state: 'windowed',
      sizes: { outer: { drawer: 42, main: 58 }, main: { chat: 50, viewer: 50 } },
    })
  })

  it('turns an inner drag into the active state’s set, with the outer group as it already was', () => {
    const change = layoutChangeFor({
      active: 'maximized',
      sizes: defaultLayoutForState('maximized'),
      group: 'main',
      layout: { chat: 30, code: 70 },
      viewerExpanded: false,
    })

    expect(change).toEqual({
      state: 'maximized',
      sizes: { outer: { drawer: 20, main: 80 }, main: { chat: 30, viewer: 70 } },
    })
  })

  it('writes nothing for an inner drag while the viewer is expanded, because that group has one panel', () => {
    // Phase 21: the chat column is removed rather than narrowed, so the inner group holds one panel
    // while expanded. Its layout is then the viewer's own width and says nothing about the 50/50 split
    // of two columns — a fact that would overwrite the split the user comes back to.
    const change = layoutChangeFor({
      active: 'windowed',
      sizes: defaultLayoutForState('windowed'),
      group: 'main',
      layout: { code: 100 },
      viewerExpanded: true,
    })

    expect(change).toBeNull()
  })

  it('still writes the outer group while the viewer is expanded, because that group is unchanged by it', () => {
    const change = layoutChangeFor({
      active: 'windowed',
      sizes: defaultLayoutForState('windowed'),
      group: 'outer',
      layout: { secondary: 30, main: 70 },
      viewerExpanded: true,
    })

    expect(change).toEqual({
      state: 'windowed',
      sizes: { outer: { drawer: 30, main: 70 }, main: { chat: 50, viewer: 50 } },
    })
  })

  it('writes nothing for a drag the library reports unusably', () => {
    // The library hands back panel id to share, so a report missing a panel — or carrying a share that
    // is not a positive number — describes no layout that could be restored. Writing it would replace a
    // good set with one that resolves to a default.
    const sizes: LayoutSizes = defaultLayoutForState('windowed')

    expect(
      layoutChangeFor({ active: 'windowed', sizes, group: 'outer', layout: { secondary: 34 }, viewerExpanded: false })
    ).toBeNull()
    expect(
      layoutChangeFor({
        active: 'windowed',
        sizes,
        group: 'main',
        layout: { chat: 0, code: 100 },
        viewerExpanded: false,
      })
    ).toBeNull()
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
