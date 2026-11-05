import { useState } from 'react'
import { Check, ChevronsUpDown, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ScrollArea } from '../ui/scroll-area'

/**
 * The model side of a combo member, and the chat header's provider-and-model picker, as one control.
 *
 * A Radix Select cannot host a text field — its typeahead is the select's own and a box inside the
 * content is outside the select's focus and interaction rules — so a searchable model list is a
 * popover combobox: a Button trigger, a filter box and a list. Every part already ships as a
 * primitive, so the search costs no dependency and no second way to draw a field or a row.
 *
 * One component because the two callers differ in what they offer, not in how they offer it. The
 * combobox is absent a `grouped` source and draws exactly the single provider's models the Combos
 * settings row has always drawn. Given one, it draws a section per provider that has matches and one
 * Combos section after them, for the chat header. The filter predicate, the bounded list, the
 * no-match row and the trigger's accessible-name rule are one implementation, so the two cannot
 * drift into two answers to the same question.
 *
 * The provider control above the settings picker stays the bare Select it was. That is not symmetry
 * for its own sake: a provider list is short enough to scan and a model list is not, and the search
 * was added only to the side that needed it.
 */

/** Rows that fit before the list scrolls rather than grows: the cap below, in row heights. */
const ROWS_BEFORE_SCROLL = 7

/** One provider's models, as the grouped mode draws them. */
export interface PickerGroup {
  id: string
  label: string
  models: readonly string[]
}

/** One combo row, as the grouped mode's Combos section draws it. */
export interface PickerCombo {
  id: string
  name: string
  memberCount: number
}

/** What the grouped mode offers: every provider with something to pick, then the enabled combos. */
export interface GroupedPickerSource {
  groups: readonly PickerGroup[]
  combos: readonly PickerCombo[]
  /** What the trigger names as chosen; null when nothing is. */
  selectedValue: string | null
  /** What the trigger reads while nothing is chosen. */
  placeholder: string
  selectedModel?: { providerId: string; model: string } | null
  selectedComboId?: string | null
  onSelectModel: (providerId: string, model: string) => void
  onSelectCombo: (comboId: string) => void
}

type PickerBaseProps = {
  /** The trigger's id, so a field's Label can name it. */
  id?: string
  disabled?: boolean
  /** A native title, for the reason a disabled control is not a pointer target. */
  title?: string
  triggerClassName?: string
}

type SinglePickerProps = PickerBaseProps & {
  grouped?: undefined
  /** False until a provider is chosen: there is no list to search yet, and the trigger says so. */
  providerSelected: boolean
  /** The selected provider's models, exactly as `knownTargets` reports them. */
  models: readonly string[]
  modelId: string
  /** Sets the member's model. The caller clears it when the provider changes. */
  onSelect: (modelId: string) => void
}

type GroupedPickerProps = PickerBaseProps & {
  grouped: GroupedPickerSource
}

export function CombosModelPicker(props: SinglePickerProps | GroupedPickerProps) {
  const [open, setOpen] = useState(false)
  // The term is this control's own ephemeral state: it narrows what is drawn now and is never sent,
  // stored or restored. Closing clears it, so reopening never hides a row behind a half-remembered
  // query — and the caller remounts this component when the provider changes, which clears it there
  // too rather than leaving one provider's query narrowing the next provider's list.
  const [filter, setFilter] = useState('')

  const term = filter.trim()
  const matches = (value: string) => term === '' || value.toLowerCase().includes(term.toLowerCase())

  // Mode-specific answers, resolved once so the trigger and the list read the same ones.
  let fieldLabel = ''
  let selectedValue: string | null = null
  let placeholder = ''
  let disabled = false
  let monoValue = true
  let groups: readonly PickerGroup[] = []
  let combos: readonly PickerCombo[] = []
  let selectedModel: { providerId: string; model: string } | null = null
  let selectedComboId: string | null = null
  let onSelectModel: (providerId: string, model: string) => void = () => undefined
  let onSelectCombo: (comboId: string) => void = () => undefined

  if (props.grouped) {
    fieldLabel = 'Provider and model'
    selectedValue = props.grouped.selectedValue
    placeholder = props.grouped.placeholder
    disabled = props.disabled ?? false
    monoValue = false
    groups = props.grouped.groups
    combos = props.grouped.combos
    selectedModel = props.grouped.selectedModel ?? null
    selectedComboId = props.grouped.selectedComboId ?? null
    onSelectModel = props.grouped.onSelectModel
    onSelectCombo = props.grouped.onSelectCombo
  } else {
    fieldLabel = 'Model'
    selectedValue = props.providerSelected && props.modelId !== '' ? props.modelId : null
    placeholder = props.providerSelected ? 'Choose a model' : 'Choose a provider first'
    disabled = !props.providerSelected
    // The single-provider mode still has one group; it is only drawn without a heading, because the
    // field above already says which provider's list this is.
    groups = props.providerSelected ? [{ id: 'models', label: '', models: props.models }] : []
    selectedModel = selectedValue === null ? null : { providerId: 'models', model: selectedValue }
    onSelectModel = (_providerId, model) => props.onSelect(model)
  }

  const shownGroups = groups
    .map((group) => ({ ...group, shownModels: group.models.filter(matches) }))
    .filter((group) => group.shownModels.length > 0)
  const shownCombos = combos.filter((combo) => matches(combo.name))
  const rowCount = shownGroups.reduce((count, group) => count + group.shownModels.length, 0) + shownCombos.length

  // Two different empties: a term that matched nothing is a typo to fix, and a provider that lists
  // nothing is a fetch that has not happened yet. The grouped mode says "available" rather than
  // naming one provider, because its empty belongs to the whole list.
  const emptyText =
    term === ''
      ? props.grouped
        ? 'No models available.'
        : 'This provider lists no models.'
      : `No models match '${term}'`

  const close = () => {
    setOpen(false)
    setFilter('')
  }

  const modelRow = (group: PickerGroup, model: string) => {
    const chosen = selectedModel !== null && selectedModel.providerId === group.id && selectedModel.model === model

    return (
      <button
        key={`${group.id}::${model}`}
        type="button"
        role="option"
        aria-selected={chosen}
        data-slot="model-picker-row"
        onClick={() => {
          onSelectModel(group.id, model)
          close()
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[12px] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none',
          chosen ? 'bg-accent text-accent-foreground' : 'text-foreground'
        )}
      >
        <span className="min-w-0 flex-1 truncate">{model}</span>
        {chosen && <Check aria-hidden className="size-3.5 shrink-0" />}
      </button>
    )
  }

  const comboRow = (combo: PickerCombo) => {
    const chosen = combo.id === selectedComboId

    return (
      <button
        key={combo.id}
        type="button"
        role="option"
        aria-selected={chosen}
        data-slot="combo-picker-row"
        onClick={() => {
          onSelectCombo(combo.id)
          close()
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none',
          chosen ? 'bg-accent text-accent-foreground' : 'text-foreground'
        )}
      >
        <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{combo.name}</span>
        <span className="shrink-0 text-muted-foreground">
          · {combo.memberCount} model{combo.memberCount === 1 ? '' : 's'}
        </span>
        {chosen && <Check aria-hidden className="size-3.5 shrink-0" />}
      </button>
    )
  }

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
          id={props.id}
          type="button"
          // The grouped source is the chat header's replacement for a combobox, so it keeps that role.
          // The settings picker was a plain button and stays one: its name changed, not its widget.
          role={props.grouped ? 'combobox' : undefined}
          aria-label={`${fieldLabel}: ${selectedValue ?? 'none selected'}`}
          aria-expanded={open}
          aria-haspopup="listbox"
          variant="outline"
          size="sm"
          disabled={disabled}
          title={props.title}
          className={cn(
            'h-7 w-full min-w-0 justify-between px-2 text-[12px] font-normal',
            selectedValue === null && 'text-muted-foreground',
            props.triggerClassName
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate', monoValue && selectedValue !== null && 'font-mono')}>
            {selectedValue ?? placeholder}
          </span>
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className={cn('p-1', props.grouped ? 'w-72' : 'w-64')}>
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
          className={cn('mt-1', rowCount > ROWS_BEFORE_SCROLL ? 'h-56' : 'max-h-56')}
        >
          <div
            role="listbox"
            aria-label={props.grouped ? 'Models and combos' : 'Models'}
            className="flex flex-col p-0.5"
          >
            {shownGroups.map((group) => (
              <div key={group.id} className="flex flex-col">
                {/* The heading is the provider's name in grouped mode. The settings picker has its
                    field above instead, and drawing a heading there would name the same provider twice. */}
                {props.grouped && (
                  <div
                    data-slot="picker-group-label"
                    className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {group.label}
                  </div>
                )}
                {group.shownModels.map((model) => modelRow(group, model))}
              </div>
            ))}

            {props.grouped && shownCombos.length > 0 && (
              <div className="flex flex-col">
                <div
                  data-slot="picker-group-label"
                  className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase"
                >
                  Combos
                </div>
                {shownCombos.map(comboRow)}
              </div>
            )}
          </div>
        </ScrollArea>

        {rowCount === 0 && (
          <p data-slot="model-picker-empty" className="px-2 py-1.5 text-[11.5px] text-muted-foreground">
            {emptyText}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
