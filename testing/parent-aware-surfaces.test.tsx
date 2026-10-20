import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@/app/components/ui/alert-dialog'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select'
import { SurfaceProvider, SURFACE_FILL } from '@/app/components/ui/surface'
import { WindowFrame } from '@/app/shell'
import { createBridgeStub, setActiveStub } from './bridge-stub'

/**
 * Controls that read against the surface they sit on, as the classes they carry.
 *
 * The app draws on two light tones — the page and the card that lies on it — and a field, a select trigger
 * or a bordered button painted in the tone of the surface under it disappears into that surface. One fixed
 * fill cannot answer both, so the contract is a pair: the Recent-projects pill's raised plate on a page, and
 * the page's own tone on a card. `SURFACE_FILL` is the one table both answers come from, and what these
 * cases pin is that each primitive reads it from the family it is actually inside — including through a
 * dialog, whose content is portalled out of the tree it was opened from.
 *
 * The titlebar's own case is here for the same reason: the bar is chrome, and the words that used to sit in
 * the middle of it are gone. What is asserted is the absence of a text node — not of styling — plus the drag
 * region staying where it was, since the bar is still the thing the window is moved by.
 *
 * jsdom applies no stylesheet, so nothing here measures a colour. What is asserted is the class contract that
 * produces it. Whether the plate reads on a page, on a card, in both modes and across five themes, is a pixel
 * judgement the running window makes.
 */

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokensOf(element: Element | null | undefined): Set<string> {
  if (!element) throw new Error('expected an element')
  return new Set((element.className ?? '').toString().split(/\s+/).filter(Boolean))
}

/** The raised plate the home screen's Recent-projects pill wears, which is the reference fill. */
const PILL_FILL = 'bg-card'
/** The page's own tone, which is what a control recesses to when it is drawn on a card. */
const PAGE_FILL = 'bg-background'

/** The primitives are read off their own markers rather than by role, so a wrapper cannot answer for them. */
const field = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-slot="input"]')
  if (!found) throw new Error('no field was drawn')
  return found
}

/** A select trigger, drawn closed: the plate is the trigger's, not the list's. */
function selectTrigger(): HTMLElement {
  render(
    <Select value="alpha" onValueChange={() => undefined}>
      <SelectTrigger aria-label="surface probe">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
      </SelectContent>
    </Select>
  )
  return screen.getByRole('combobox', { name: 'surface probe' })
}

beforeEach(() => {
  setActiveStub(createBridgeStub({ init: () => ({ platform: 'win32', minimizable: true, maximizable: true }) }))
})

describe('the fill a field takes from its parent', () => {
  it('takes the pill plate on a page, so a field is not the page it lies on', () => {
    render(<Input aria-label="page field" />)

    const tokens = tokensOf(field())
    expect(tokens.has(PILL_FILL), 'the raised plate the Recent-projects pill wears').toBe(true)
    expect(tokens.has(PAGE_FILL), 'not the page tone it would dissolve into').toBe(false)
    // The recessed tone Phase 99 fixed on the field assumed one parent. It is gone, not doubled.
    expect(tokens.has('bg-background/60'), 'the single-parent fill is replaced, not kept').toBe(false)
    // Dark is untouched: the raised tint still outranks whatever light fill the family named.
    expect(tokens.has('dark:bg-input/50'), 'the dark tint is unchanged').toBe(true)
  })

  it('recesses to the page tone on a card, and does not take the card’s own colour', () => {
    render(
      <SurfaceProvider kind="card">
        <Input aria-label="card field" />
      </SurfaceProvider>
    )

    const tokens = tokensOf(field())
    expect(tokens.has(PAGE_FILL), 'recessed, not the card it lies on').toBe(true)
    expect(tokens.has(PILL_FILL), 'the page plate is the page family’s, not this one’s').toBe(false)
    expect(tokens.has('dark:bg-input/50'), 'the dark tint is unchanged').toBe(true)
  })

  it('gives a select trigger the same two answers as the field beside it', () => {
    const onPage = selectTrigger()
    expect(tokensOf(onPage).has(PILL_FILL)).toBe(true)
    expect(tokensOf(onPage).has(PAGE_FILL)).toBe(false)
    expect(tokensOf(onPage).has('bg-background/60')).toBe(false)
    expect(tokensOf(onPage).has('dark:bg-input/50')).toBe(true)
  })

  it('reads the family through a dialog, whose content is portalled out of its opener', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Card surface</AlertDialogTitle>
          <Input aria-label="dialog field" />
        </AlertDialogContent>
      </AlertDialog>
    )

    const content = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')
    // The premise, read off the surface rather than assumed: a dialog's plate is the card tone.
    expect(tokensOf(content).has(PILL_FILL), 'the dialog is a card').toBe(true)

    const tokens = tokensOf(field())
    expect(tokens.has(PAGE_FILL), 'the field recesses into the dialog’s card').toBe(true)
    expect(tokens.has(PILL_FILL)).toBe(false)
  })
})

describe('the fill the bordered button variants take from their parent', () => {
  it('paints the outline button as a plate on a page', () => {
    render(<Button variant="outline">New skill</Button>)

    const tokens = tokensOf(screen.getByRole('button', { name: 'New skill' }))
    expect(tokens.has(SURFACE_FILL.page)).toBe(true)
    expect(tokens.has(PILL_FILL)).toBe(true)
    // The border and the dark branch are the variant's, and neither is the thing that changed.
    expect(tokens.has('border')).toBe(true)
    expect(tokens.has('dark:bg-input/30')).toBe(true)
  })

  it('recesses the outline button on a card', () => {
    render(
      <SurfaceProvider kind="card">
        <Button variant="outline">Manage MCPs</Button>
      </SurfaceProvider>
    )

    const tokens = tokensOf(screen.getByRole('button', { name: 'Manage MCPs' }))
    expect(tokens.has(SURFACE_FILL.card)).toBe(true)
    expect(tokens.has(PAGE_FILL)).toBe(true)
    expect(tokens.has(PILL_FILL), 'not the card it lies on').toBe(false)
    expect(tokens.has('dark:bg-input/30')).toBe(true)
  })

  it('gives the secondary variant the same two answers', () => {
    const { unmount } = render(<Button variant="secondary">New buddy</Button>)
    const onPage = tokensOf(screen.getByRole('button', { name: 'New buddy' }))
    expect(onPage.has(PILL_FILL)).toBe(true)
    expect(onPage.has('bg-secondary'), 'the flat plate that dissolved is replaced').toBe(false)
    expect(onPage.has('text-secondary-foreground'), 'the variant’s ink is unchanged').toBe(true)
    unmount()

    render(
      <SurfaceProvider kind="card">
        <Button variant="secondary">New buddy</Button>
      </SurfaceProvider>
    )
    const onCard = tokensOf(screen.getByRole('button', { name: 'New buddy' }))
    expect(onCard.has(PAGE_FILL)).toBe(true)
    expect(onCard.has(PILL_FILL)).toBe(false)
  })

  it('leaves the primary and ghost variants exactly as they were', () => {
    render(
      <>
        <Button>Send message</Button>
        <Button variant="ghost">Cancel</Button>
      </>
    )

    const primary = tokensOf(screen.getByRole('button', { name: 'Send message' }))
    expect(primary.has('bg-primary')).toBe(true)
    expect(primary.has(PILL_FILL)).toBe(false)

    const ghost = tokensOf(screen.getByRole('button', { name: 'Cancel' }))
    expect(ghost.has('hover:bg-accent')).toBe(true)
    expect(ghost.has(PILL_FILL)).toBe(false)
    expect(ghost.has(PAGE_FILL)).toBe(false)
  })
})

describe('the titlebar', () => {
  it('draws no words, and keeps the drag region the bar is moved by', () => {
    render(<WindowFrame>{null}</WindowFrame>)

    const header = document.querySelector('header')
    if (!header) throw new Error('the titlebar rendered no header')

    // The bar is chrome: a name in the middle of it repeats the window's own title, and the window is the
    // thing that says what it is. Nothing of that span is left — not the text, and not an empty stand-in.
    expect(header.textContent?.trim(), 'the bar draws no text at all').toBe('')
    expect(screen.queryByText('Agent Sam'), 'the app name is not in the bar').toBeNull()
    expect(header.querySelector('span.text-\\[13px\\]'), 'no title span is left behind').toBeNull()

    expect(tokensOf(header).has('[-webkit-app-region:drag]'), 'the bar is still the drag region').toBe(true)
  })
})
