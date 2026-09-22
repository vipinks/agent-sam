import { describe, expect, it } from 'vitest'
import { initialLayoutSizes, percentSize } from '@/app/components/workbench/layout'

/**
 * The workbench's starting proportions, as arithmetic rather than as markup.
 *
 * The reason this is a module rather than two literals in the layout: the workbench is two *nested*
 * groups, so a panel's size and its share of the window are different numbers, and the one a user
 * actually sees is the second. The viewer's 37.5 is a share of the main column, which is itself 80 of
 * the window — so the viewer opens at 30 percent of the window and the chat at 50, and the drawer
 * takes the rest. Those two products are the whole point of writing the numbers down, which is why
 * they are asserted here rather than left to whoever reads the JSX next.
 *
 * Nothing in here touches the DOM, React or the resize library. What the library does with these
 * numbers — and the unit trap that makes them percentages rather than pixels — is asserted in
 * `layout-wiring.test.tsx`.
 */

describe('the workbench’s initial sizes', () => {
  it('gives the outer group a 20/80 split between the drawer and the main area', () => {
    const sizes = initialLayoutSizes()

    expect(sizes.outer.drawer).toBe(20)
    expect(sizes.outer.main).toBe(80)
  })

  it('gives the main group a 62.5/37.5 split between the chat and the viewer', () => {
    const sizes = initialLayoutSizes()

    expect(sizes.main.chat).toBe(62.5)
    expect(sizes.main.viewer).toBe(37.5)
  })

  it('fills each group exactly, so no panel opens with a size nothing accounts for', () => {
    const sizes = initialLayoutSizes()

    expect(sizes.outer.drawer + sizes.outer.main).toBe(100)
    expect(sizes.main.chat + sizes.main.viewer).toBe(100)
  })

  it('leaves the viewer a third of the window and the chat half of it', () => {
    const sizes = initialLayoutSizes()

    // The nested product: a panel's share of the window is its own share of its group multiplied by
    // the share its group has of the outer one.
    const viewerOfWindow = (sizes.outer.main / 100) * sizes.main.viewer
    const chatOfWindow = (sizes.outer.main / 100) * sizes.main.chat

    expect(viewerOfWindow).toBe(30)
    expect(chatOfWindow).toBe(50)
  })

  it('answers the same numbers every time it is asked', () => {
    // Purity in the sense that matters here: nothing is memoised across calls and nothing the caller
    // can do to one answer changes the next.
    const first = initialLayoutSizes()
    const second = initialLayoutSizes()

    expect(second).toEqual(first)
    expect(second).not.toBe(first)
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
