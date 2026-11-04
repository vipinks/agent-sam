import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ScrollArea } from '../ui/scroll-area'

/**
 * The model side of a combo member: the selected provider's models, narrowed as the user types.
 *
 * A Radix Select cannot host a text field — its typeahead is the select's own and a box inside the
 * content is outside the select's focus and interaction rules — so the model side is a popover
 * combobox: a Button trigger, a filter box and a list. Every part already ships as a primitive, so
 * the search costs no dependency and no second way to draw a field or a row.
 *
 * The provider control above it stays the bare Select it was. That is not symmetry for its own sake:
 * a provider list is short enough to scan and a model list is not, and D1 changed only the side that
 * needed the search.
 *
 * The chosen id is still checked by the add-member guard. This control offers exactly what the
 * registry reports, so the guard should never refuse an id picked here — which is the point: the
 * registry stays the one authority on what a combo may name, and the control does not become a second.
 */

/** Rows that fit before the list scrolls rather than grows: the cap below, in row heights. */
const ROWS_BEFORE_SCROLL = 7

export function CombosModelPicker({
  id,
  providerSelected,
  models,
  modelId,
  onSelect,
}: {
  /** The trigger's id, so the field's Label names it. */
  id: string
  /** False until a provider is chosen: there is no list to search yet, and the trigger says so. */
  providerSelected: boolean
  /** The selected provider's models, exactly as `knownTargets` reports them. */
  models: readonly string[]
  modelId: string
  /** Sets the member's model. The caller clears it when the provider changes. */
  onSelect: (modelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  // The term is this control's own ephemeral state: it narrows what is drawn now and is never sent,
  // stored or restored. Closing clears it, so reopening never hides a model behind a half-remembered
  // query — and the caller remounts this component when the provider changes, which clears it there
  // too rather than leaving one provider's query narrowing the next provider's list.
  const [filter, setFilter] = useState('')

  const term = filter.trim()
  const matches = term === '' ? models : models.filter((model) => model.toLowerCase().includes(term.toLowerCase()))

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setFilter('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          aria-label="Model"
          disabled={!providerSelected}
          className={cn(
            'h-7 w-full justify-between px-2 text-[12px] font-normal',
            modelId === '' && 'text-muted-foreground'
          )}
        >
          <span className={cn('truncate', modelId !== '' && 'font-mono')}>
            {!providerSelected ? 'Choose a provider first' : modelId === '' ? 'Choose a model' : modelId}
          </span>
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-1">
        <Input
          autoFocus
          aria-label="Filter models"
          placeholder="Filter models"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-7 text-[12px]"
        />

        {/*
          The list is bounded, not the popover: the box above it and the note below stay put while a
          long list scrolls between them.

          Radix sizes this region's viewport from a definite height, so a cap that is only a maximum
          would clip a long list instead of scrolling it. The height is stated once the list is long
          enough to reach the cap, and shorter lists keep their own height rather than leaving a hole.
        */}
        <ScrollArea
          data-slot="model-picker-scroll"
          className={cn('mt-1', matches.length > ROWS_BEFORE_SCROLL ? 'h-56' : 'max-h-56')}
        >
          <div role="listbox" aria-label="Models" className="flex flex-col p-0.5">
            {matches.map((model) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={model === modelId}
                data-slot="model-picker-row"
                onClick={() => {
                  onSelect(model)
                  setOpen(false)
                  setFilter('')
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[12px] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none',
                  model === modelId ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{model}</span>
                {model === modelId && <Check aria-hidden className="size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        </ScrollArea>

        {/* Two different empties: a term that matched nothing is a typo to fix, and a provider that
            lists nothing is a fetch that has not happened yet. */}
        {matches.length === 0 && (
          <p data-slot="model-picker-empty" className="px-2 py-1.5 text-[11.5px] text-muted-foreground">
            {term === '' ? 'This provider lists no models.' : `No models match '${term}'`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
