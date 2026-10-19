import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select'

/**
 * The select's two surfaces, as the classes they carry.
 *
 * A picker is a field and a list, and both had the same flaw this pass fixed on the input: nothing to see
 * inside the outline. The trigger now wears the input's own recessed tone in light mode (and the input's
 * raised tint in dark, because a control that looked like a hole in one mode and a plate in the other
 * would be two controls), and the option a reader has already picked wears the accent-soft plate the
 * navigator uses for the row that is current, so "which one is chosen" survives the checkmark being
 * small.
 *
 * jsdom applies no stylesheet, so nothing here measures a colour: what is asserted is the class contract
 * that produces it — the same contract the input's own suite states beside it. Whether the plate reads
 * at 12px against the popover is a pixel judgement, made in the running window, in both themes.
 */

/** Class tokens, so an assertion names the utility rather than a substring of the string. */
function tokensOf(element: Element | null | undefined): Set<string> {
  if (!element) throw new Error('expected an element')
  return new Set((element.className ?? '').toString().split(/\s+/).filter(Boolean))
}

/** A picker with one chosen option, opened, so both surfaces are on the screen. */
function renderOpenSelect() {
  render(
    <Select value="alpha" onValueChange={() => undefined}>
      <SelectTrigger aria-label="surface probe">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="beta">Beta</SelectItem>
      </SelectContent>
    </Select>
  )
  return screen.getByRole('combobox', { name: 'surface probe' })
}

describe('the select surface', () => {
  it('dresses the trigger in the same recessed tone the input wears, in both modes', async () => {
    const trigger = renderOpenSelect()
    const tokens = tokensOf(trigger)

    // Light: the page-family tone, exactly as the input takes it.
    expect(tokens.has('bg-background/60')).toBe(true)
    expect(tokens.has('bg-transparent')).toBe(false)
    // Dark: the raised tint the input kept from the previous pass, so the two fields agree in both modes.
    expect(tokens.has('dark:bg-input/50')).toBe(true)
  })

  it('gives the chosen option the accent-soft plate, and leaves the others unplated', async () => {
    const trigger = renderOpenSelect()
    await userEvent.click(trigger)

    const options = within(await screen.findByRole('listbox')).getAllByRole('option')
    const chosen = options.find((option) => option.getAttribute('aria-selected') === 'true')
    expect(chosen, 'the chosen option is drawn').toBeTruthy()
    const other = options.find((option) => option.getAttribute('aria-selected') !== 'true')
    expect(other, 'an option nothing has picked is drawn').toBeTruthy()

    // The plate is a `data-[state=checked]` rule, so the class sits on the component and only the row the
    // value names matches it: the chosen row states the state and the row beside it states that it does
    // not. Which one is painted is therefore the value's answer rather than a class applied by hand.
    expect(tokensOf(chosen).has('data-[state=checked]:bg-brand-soft')).toBe(true)
    expect(chosen?.getAttribute('data-state')).toBe('checked')
    expect(other?.getAttribute('data-state')).toBe('unchecked')
  })
})
