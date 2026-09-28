import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { rateText, resolveRates, type ModelRates } from '@/conveyor/protocol/session-usage'
import { resolveWindow, type ModelWindows } from '@/conveyor/protocol/context-window'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'

/** A model as a provider's catalogue describes it. */
export interface ModelEntry {
  id: string
  name?: string
}

/**
 * The fetched-model list for one provider: a filter box, then a row per model with its switch and its
 * three price fields.
 *
 * Extracted from the provider card because it is the one part of Settings with real internal state
 * (the filter, and whether the list is expanded) — keeping it separate means that state is scoped
 * here rather than re-rendered with the card, and the list can be exercised on its own.
 *
 * A model's price is declared on the model's own row rather than once for the provider, because a price
 * belongs to the model that was billed: one provider serves a cheap model and a dear one, and a triple
 * shared between them would have to be wrong about at least one.
 *
 * There is no save button by design: flipping a switch calls `onToggle`, and a price field calls
 * `onRateChange`, which write straight to the persisted store.
 */
export function ModelList({
  providerName,
  models,
  enabled,
  modelRates,
  modelWindows,
  defaultOpen = false,
  onToggle,
  onRateChange,
  onWindowChange,
}: {
  providerName: string
  models: ModelEntry[]
  enabled: string[]
  /**
   * The prices this provider's models were declared at, by model id, as the record holds them.
   *
   * Passed through rather than resolved here: a row draws what the record says and asks `resolveRates`
   * for what the model costs meanwhile, so the placeholder it shows is the very number the Overview
   * bills with until someone overrides it.
   */
  modelRates?: ModelRates
  /**
   * The windows these models were declared at, by model id, as the record holds them.
   *
   * The same shape as the prices above, and read the same way: a row draws what the record says and asks
   * `resolveWindow` for what the model is measured against meanwhile, so the placeholder it shows is the
   * very number the Overview card places that conversation against until someone overrides it.
   */
  modelWindows?: ModelWindows
  /** Opened automatically right after a fetch, so the thing you just asked for is visible. */
  defaultOpen?: boolean
  /** Called with the model id the user flipped. The parent owns which provider that belongs to. */
  onToggle: (modelId: string) => void
  /**
   * Called with the model id, the side, and what was typed — or `undefined` when the field was blanked.
   *
   * One side at a time because that is how the fields are typed into: the other two are re-stated from
   * the record by the caller, which is what lets a user fill in three fields across three edits without
   * any one of them clearing its neighbours.
   */
  onRateChange: (modelId: string, side: 'input' | 'cacheHit' | 'output', value: number | undefined) => void
  /**
   * Declare how many tokens one model accepts, or take the declaration back with `undefined`.
   *
   * One number for one model rather than a triple, because a window is one number: there is no
   * half-typed entry to keep, and blanking the field is the only way to be partial — which the caller
   * passes up as the absence of a declaration rather than as a nought.
   */
  onWindowChange: (modelId: string, value: number | undefined) => void
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [filter, setFilter] = useState('')

  const enabledSet = useMemo(() => new Set(enabled), [enabled])

  /** Filter by id or label, case-insensitively — OpenRouter alone lists hundreds of entries. */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return models
    return models.filter((m) => m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle))
  }, [models, filter])

  return (
    <div className="mt-2.5 border-t border-border pt-2.5">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Hide' : 'Show'} ${providerName} models`}
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} />
        {models.length} models available
        <span className="ml-auto font-mono text-[10.5px]">{enabled.length} on</span>
      </button>

      {isOpen && (
        <>
          <div className="relative mt-2">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label={`Search ${providerName} models`}
              placeholder="Filter by model id…"
              spellCheck={false}
              className="h-8 pl-8 font-mono text-[12px]"
            />
          </div>

          {/* Capped height: the card must stay scannable when a provider lists hundreds. */}
          <ul
            aria-label={`${providerName} models`}
            className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border"
          >
            {visible.length === 0 ? (
              <li className="px-2.5 py-2 text-[12px] text-muted-foreground">No model matches “{filter}”.</li>
            ) : (
              visible.map((model) => {
                const isOn = enabledSet.has(model.id)
                const declared = modelRates?.[model.id]
                // What this model costs until someone says otherwise: the shipped table's entry for it, or
                // nothing at all for an id the table has never heard of — a gateway's own name for a
                // model, which is the case the fields exist for.
                const builtIn = resolveRates({ model: model.id })
                // And the window this model is placed against until someone declares one: the shipped
                // table's entry for it, or nothing at all for an id the table has never heard of, which
                // is the case a gateway's own names for models make.
                const builtInWindow = resolveWindow({ model: model.id })
                const declaredWindow = modelWindows?.[model.id]?.contextWindow

                return (
                  <li
                    key={model.id}
                    className="flex flex-col gap-1.5 border-b border-border px-2.5 py-1.5 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[11.5px]" title={model.id}>
                          {model.id}
                        </p>
                        {model.name && model.name !== model.id && (
                          <p className="truncate text-[11px] text-muted-foreground">{model.name}</p>
                        )}
                      </div>
                      <Switch
                        size="sm"
                        checked={isOn}
                        aria-label={`${isOn ? 'Disable' : 'Enable'} ${model.id}`}
                        onCheckedChange={() => onToggle(model.id)}
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-1.5">
                      <RateField
                        slot="model-rate-input"
                        caption="in"
                        ariaLabel={`Input price for ${model.id}`}
                        placeholder={builtIn === null ? '' : rateText(builtIn.input)}
                        value={declared?.inputRate}
                        onChange={(next) => onRateChange(model.id, 'input', next)}
                      />
                      <RateField
                        slot="model-rate-cache"
                        caption="cache"
                        ariaLabel={`Cache hit price for ${model.id}`}
                        placeholder={builtIn === null ? '' : rateText(builtIn.cacheHit)}
                        value={declared?.cacheHitRate}
                        onChange={(next) => onRateChange(model.id, 'cacheHit', next)}
                      />
                      <RateField
                        slot="model-rate-output"
                        caption="out"
                        ariaLabel={`Output price for ${model.id}`}
                        placeholder={builtIn === null ? '' : rateText(builtIn.output)}
                        value={declared?.outputRate}
                        onChange={(next) => onRateChange(model.id, 'output', next)}
                      />
                      <WindowField
                        slot="model-window"
                        caption="window"
                        ariaLabel={`Context window for ${model.id}`}
                        placeholder={builtInWindow === null ? '' : String(builtInWindow)}
                        value={declaredWindow}
                        onChange={(next) => onWindowChange(model.id, next)}
                      />
                    </div>
                  </li>
                )
              })
            )}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * One side of one model's declared price.
 *
 * Bounded at the field rather than checked afterwards: a negative price and a slipped decimal point are
 * both refusals the browser can make before a store write is attempted, and the upper bound is high
 * enough to be a typo-catcher rather than a policy — no published list rate is anywhere near it.
 *
 * `type=number` in a form about a human-typed price, because the spinners and the keyboard are what a
 * person entering a rate actually uses. Blank is passed up as `undefined` rather than as a zero, which is
 * the difference between "nobody priced this" and "this is free" — the same distinction the fields are
 * built around.
 *
 * The caption is a `<span>` rather than a `<label for=…>`: the same three captions repeat in every row,
 * so a label would need an id built out of a provider and a model id to stay unique, and the accessible
 * name says more than the caption anyway — a screen reader hears which price of which model it is, and
 * a sighted reader has the row the caption sits in.
 */
function RateField({
  slot,
  caption,
  ariaLabel,
  placeholder,
  value,
  onChange,
}: {
  slot: string
  caption: string
  ariaLabel: string
  /** The built-in table's number, in dollars per million, or empty for a model nothing has priced. */
  placeholder: string
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{caption}</span>
      <Input
        data-slot={slot}
        type="number"
        min={0}
        max={10_000}
        step={0.01}
        inputMode="decimal"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value === undefined ? '' : String(value)}
        onChange={(event) => {
          const typed = event.target.value
          if (typed.trim() === '') return onChange(undefined)
          const next = Number(typed)
          onChange(Number.isFinite(next) && next >= 0 ? next : undefined)
        }}
        className="h-8 font-mono text-[11.5px]"
      />
    </div>
  )
}

/**
 * One model's declared context window, in tokens.
 *
 * A field of its own rather than the price field with different bounds, because the two refuse
 * different things: a price is a decimal that may be zero, and a window is a whole number of tokens that
 * may not be — a model that accepts nothing is not a model this app can send to, and a nought stored
 * where a window belongs would place every request over it.
 *
 * `type=number`, like the price fields beside it, because the spinners and the keyboard are what a
 * person entering a token count uses. They move in thousands because a window is a round number of
 * tokens in practice; the field is not inside a form, so a typed 4096 is stored rather than refused.
 *
 * Blank travels up as `undefined` rather than as a zero, and that is the same distinction the prices are
 * built around: "nobody declared a window for this model" falls through to the shipped table, and
 * "declared as nothing" would be a window every conversation is already over. `min` is one for the
 * reason the declaration schema's bound is positive.
 */
function WindowField({
  slot,
  caption,
  ariaLabel,
  placeholder,
  value,
  onChange,
}: {
  slot: string
  caption: string
  ariaLabel: string
  /** The shipped table's window for this model, in tokens, or empty for a model nothing knows. */
  placeholder: string
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{caption}</span>
      <Input
        data-slot={slot}
        type="number"
        min={1}
        max={10_000_000}
        step={1000}
        inputMode="numeric"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value === undefined ? '' : String(value)}
        onChange={(event) => {
          const typed = event.target.value
          if (typed.trim() === '') return onChange(undefined)
          const next = Number(typed)
          // Whole and positive, or no declaration at all: the store's schema is what main would validate
          // this against, and a decimal that reached it would be refused with nothing said on screen.
          onChange(Number.isFinite(next) && Number.isInteger(next) && next >= 1 ? next : undefined)
        }}
        className="h-8 font-mono text-[11.5px]"
      />
    </div>
  )
}
