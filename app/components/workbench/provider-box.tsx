import type { ReactNode } from 'react'
import { Check, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { ModelList, type ModelEntry } from './model-list'

/**
 * One provider's box, in Settings: the controls every provider has, whether it ships with the app or
 * was added by someone typing a URL.
 *
 * Extracted so the two kinds cannot drift. A custom provider's box is not a lookalike of a predefined
 * one — it is the same box, rendered from the same markup, which is the only form of parity a test can
 * assert without asserting the same thing twice. What differs between the two kinds is *wiring*: which
 * command a key is saved through, and what the actions beside the name do. Both arrive as props, so
 * this component never has to know which kind it is drawing.
 *
 * The slot names below are that parity, stated as data. A box renders the controls it is given state
 * for — a key row always, the saved badge and the clear button once there is a key, the model list once
 * there is a catalogue — and a suite compares those slots between the two kinds rather than comparing
 * markup, which would pass on a box that had quietly lost a control.
 */
export const PROVIDER_BOX_CONTROLS = [
  'provider-key-input',
  'provider-key-save',
  'provider-actions',
  'provider-saved-badge',
  'provider-key-clear',
  'provider-image-support',
  'provider-rate-input',
  'provider-rate-output',
  'provider-enabled-models',
  'provider-model-list',
] as const

/** The subset of the above that is present whatever the box's state is. */
export const PROVIDER_BOX_CORE_CONTROLS = ['provider-key-input', 'provider-key-save', 'provider-actions'] as const

/**
 * The two affordances only a provider the user added carries: asking the server itself for its
 * catalogue, and removing the provider. A predefined provider is asked through this app's own
 * `settings` module and removed by editing nothing — it is not the user's to delete.
 */
export const CUSTOM_PROVIDER_ONLY_CONTROLS = ['provider-fetch-models', 'provider-delete'] as const

export function ProviderBox({
  id,
  name,
  kind,
  configured,
  disabled,
  keyValue,
  onKeyChange,
  onSaveKey,
  saving,
  onClearKey,
  clearing = false,
  imagesSupported,
  onToggleImages,
  rates,
  onRateChange,
  enabledModels,
  models,
  modelsOpen = false,
  onToggleModel,
  actions,
  notice,
}: {
  id: string
  name: string
  kind: 'predefined' | 'custom'
  configured: boolean
  /** True when this system cannot hold a secret, so the key controls say so by being unusable. */
  disabled: boolean
  keyValue: string
  onKeyChange: (value: string) => void
  onSaveKey: () => void
  saving: boolean
  /** Absent for a kind whose key cannot be forgotten from here. */
  onClearKey?: () => void
  clearing?: boolean
  /**
   * Whether this provider takes images, as the store records it.
   *
   * Required of both kinds, because both kinds are asked: the box is the same box, and a custom provider
   * whose models can see a screenshot is exactly as ordinary as a predefined one whose cannot.
   */
  imagesSupported: boolean
  onToggleImages: (supported: boolean) => void
  /**
   * The prices this provider was declared at, in dollars per million tokens, as the record holds them.
   *
   * Optional per side, and absent is the ordinary state: a provider nobody has priced carries neither
   * number. The fields below show that as an empty box rather than as a zero, because a stored zero
   * would be a declaration that the model is free, which is a price rather than a missing one.
   */
  rates: { input?: number; output?: number }
  /**
   * Declare a price for one side, or take it back with `undefined`.
   *
   * One side at a time because that is how the fields are typed into: the other side's value is read
   * from the record by the caller, which is what lets a user fill in the pair across two edits without
   * either one clearing the other.
   */
  onRateChange: (side: 'input' | 'output', value: number | undefined) => void
  /** The models switched on, in the order they were switched on. */
  enabledModels: string[]
  /** The catalogue to show, in the order the provider listed it. */
  models: ModelEntry[]
  /** Opened on the render right after a fetch, so the thing just asked for is visible. */
  modelsOpen?: boolean
  onToggleModel: (modelId: string) => void
  /** The provider-shaped controls beside the name: a fetch, a delete, whatever this kind offers. */
  actions: ReactNode
  /**
   * What a failed call said, in this app's words.
   *
   * Kept in the box rather than toasted: it stands until the next attempt says something newer, which
   * is what a user retrying after a fix needs to see change.
   */
  notice?: string | null
}) {
  return (
    <div
      data-slot="provider-box"
      data-provider-kind={kind}
      data-provider-id={id}
      className="rounded-lg border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <KeyRound className={cn('size-3.5 shrink-0', configured ? 'text-brand' : 'text-muted-foreground')} />
        <span className="text-[13px] font-medium">{name}</span>
        {configured && (
          <span
            data-slot="provider-saved-badge"
            className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10.5px] font-medium text-brand"
          >
            <Check className="size-2.5" />
            saved
          </span>
        )}

        <div data-slot="provider-actions" className="ml-auto flex items-center gap-0.5">
          {actions}
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Input
          data-slot="provider-key-input"
          type="password"
          value={keyValue}
          disabled={disabled || saving}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${name} API key`}
          placeholder={configured ? 'Replace the saved key…' : 'Paste your API key'}
          onChange={(event) => onKeyChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSaveKey()
          }}
          className="h-8 font-mono text-[12px]"
        />
        <Button
          data-slot="provider-key-save"
          size="sm"
          disabled={disabled || !keyValue.trim() || saving}
          onClick={onSaveKey}
        >
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
        {configured && onClearKey && (
          <Button
            data-slot="provider-key-clear"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${name} key`}
            disabled={clearing}
            onClick={onClearKey}
          >
            <Trash2 />
          </Button>
        )}
      </div>

      {notice && (
        <p data-slot="provider-notice" role="status" className="mt-2.5 text-[12px] leading-relaxed text-destructive">
          {notice}
        </p>
      )}

      {/*
        Image support, stated in words and not only as a switch position.

        A declaration rather than something this app discovers, which the helper text says: the person
        setting it up is the one who knows whether the model they chose can see a picture, and a switch
        read as "the app checked" would be trusted for something nobody checked. Off is the default, so the
        sentence says what off means for the composer rather than leaving the user to find out by pasting.
      */}
      <div
        data-slot="provider-image-support"
        className="mt-2.5 flex items-center justify-between gap-2 border-t border-border pt-2.5"
      >
        <div className="min-w-0">
          <label htmlFor={`${id}-image-support`} className="text-[12px] font-medium">
            Image support
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {imagesSupported
              ? 'The composer can attach images while this provider is selected.'
              : 'Declare it if this provider can see images; the composer refuses them until you do.'}
          </p>
        </div>
        <Switch
          id={`${id}-image-support`}
          size="sm"
          checked={imagesSupported}
          onCheckedChange={onToggleImages}
          aria-label={`Image support for ${name}`}
        />
      </div>

      {/*
        What this provider charges, stated in the unit the number is in.

        A declaration, like the image switch above it: this app cannot discover a price, and a build that
        guessed would show a confident number for a provider that had changed what it charges. Blank is
        the ordinary state and it is not zero — it means the built-in list prices this provider's models,
        and for a model that list does not know, the Overview draws an em dash rather than a free session.
      */}
      <div className="mt-2.5 border-t border-border pt-2.5">
        <p className="text-[12px] font-medium">Rates</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          What this provider charges, in dollars per million tokens. Leave blank to price its models from the built-in
          list.
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          <RateField
            id={`${id}-rate-input`}
            slot="provider-rate-input"
            label="Input price"
            value={rates.input}
            onChange={(next) => onRateChange('input', next)}
          />
          <RateField
            id={`${id}-rate-output`}
            slot="provider-rate-output"
            label="Output price"
            value={rates.output}
            onChange={(next) => onRateChange('output', next)}
          />
        </div>
      </div>

      {/* Enabled models, always visible: this is what the chat picker will actually offer. */}
      {enabledModels.length > 0 && (
        <div
          data-slot="provider-enabled-models"
          className="mt-2.5 flex flex-wrap items-center gap-1.5"
          aria-label={`Enabled ${name} models`}
        >
          {enabledModels.map((modelId) => (
            <span
              key={modelId}
              className="inline-flex max-w-full items-center rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10.5px] text-foreground/80"
            >
              <span className="truncate">{modelId}</span>
            </span>
          ))}
        </div>
      )}

      {models.length > 0 && (
        <div data-slot="provider-model-list">
          <ModelList
            providerName={name}
            models={models}
            enabled={enabledModels}
            defaultOpen={modelsOpen}
            onToggle={onToggleModel}
          />
        </div>
      )}
    </div>
  )
}

/**
 * One side of a provider's declared price.
 *
 * Bounded at the field rather than checked afterwards: a negative price and a slipped decimal point are
 * both refusals the browser can make before a store write is attempted, and the upper bound is high
 * enough to be a typo-catcher rather than a policy — no published list rate is anywhere near it.
 *
 * `type=number` in a box about a human-typed price, because the spinners and the keyboard are what a
 * person entering a rate actually uses. Blank is passed up as `undefined` rather than as a zero, which is
 * the difference between "nobody priced this" and "this is free" — the same distinction the whole
 * feature is built around.
 */
function RateField({
  id,
  slot,
  label,
  value,
  onChange,
}: {
  id: string
  slot: string
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        data-slot={slot}
        type="number"
        min={0}
        max={10_000}
        step={0.01}
        inputMode="decimal"
        aria-label={label}
        placeholder="not declared"
        value={value === undefined ? '' : String(value)}
        onChange={(event) => {
          const typed = event.target.value
          if (typed.trim() === '') return onChange(undefined)
          const next = Number(typed)
          onChange(Number.isFinite(next) && next >= 0 ? next : undefined)
        }}
        className="h-8 font-mono text-[12px]"
      />
    </div>
  )
}
