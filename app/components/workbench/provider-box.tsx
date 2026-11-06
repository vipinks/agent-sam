import { useState, type ReactNode } from 'react'
import { Check, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { CardSurface } from '../ui/surface'
import { Switch } from '../ui/switch'
import { ModelList, type ModelEntry } from './model-list'
import type { ProviderDraftRejection } from '@/conveyor/protocol/custom-provider'
import type { ModelRates } from '@/conveyor/protocol/session-usage'
import type { ModelWindows } from '@/conveyor/protocol/context-window'

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
  'provider-enabled-models',
  'provider-model-list',
] as const

/** The subset of the above that is present whatever the box's state is. */
export const PROVIDER_BOX_CORE_CONTROLS = ['provider-key-input', 'provider-key-save', 'provider-actions'] as const

/**
 * The slots only a provider the user added carries: its name and base URL, each editable in place, and
 * the two affordances a predefined provider has no use for — asking the server itself for its catalogue,
 * and removing the provider. A predefined provider is asked through this app's own `settings` module,
 * and its name is this app's to state rather than the user's to change; it is not the user's to delete.
 *
 * Listed in the order a custom box renders them, because the parity suite compares this list with that
 * box's own slots in document order.
 */
export const CUSTOM_PROVIDER_ONLY_CONTROLS = [
  'provider-edit-name',
  'provider-fetch-models',
  'provider-delete',
  'provider-base-url',
] as const

/**
 * Where a refused draft belongs, and what it says. One field at a time, because the rules answer one.
 *
 * Here rather than in the settings section because the field a refusal belongs to is drawn here now: the
 * add form and the two in-place editors ask the same rules, so they say the same sentence on the same
 * field, and a second copy of this map would be a second answer to the same refusal.
 */
export function draftError(code: ProviderDraftRejection): { field: 'name' | 'baseUrl'; message: string } {
  switch (code) {
    case 'NAME_REQUIRED':
      return { field: 'name', message: 'A name is required.' }
    case 'NAME_TAKEN':
      return { field: 'name', message: 'A provider with this name already exists.' }
    case 'BASE_URL_INVALID':
      return { field: 'baseUrl', message: 'Enter an http(s) URL, like http://localhost:1234/v1.' }
  }
}

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
  modelRates,
  modelWindows,
  onRateChange,
  onWindowChange,
  enabledModels,
  models,
  modelsOpen = false,
  onToggleModel,
  actions,
  notice,
  baseUrl,
  onSaveBaseUrl,
  onSaveName,
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
   * The prices this provider's models were declared at, by model id, as the record holds them.
   *
   * Optional, and absent is the ordinary state: a provider nobody has priced carries no map. Each entry's
   * three sides are optional too — a record short of a side prices nothing and the built-in table prices
   * the model meanwhile — and the rows draw that as an empty field rather than as a zero, because a
   * stored zero would be a declaration that the model is free, which is a price rather than a missing one.
   */
  modelRates?: ModelRates
  /**
   * The windows this provider's models were declared at, by model id, as the record holds them.
   *
   * Passed through for the reason the prices above are: a row draws what the record says and asks
   * `resolveWindow` for what the model is measured against meanwhile, so the placeholder behind an empty
   * field is the shipped table's own number for that model.
   */
  modelWindows?: ModelWindows
  /**
   * Declare a price for one side of one model, or take it back with `undefined`.
   *
   * The model id travels with the side because the price belongs to the model the row was drawn for; one
   * side at a time because the other two are re-stated from the record by the caller, which is what lets
   * a user fill in three fields across three edits without any one of them clearing its neighbours.
   */
  onRateChange: (modelId: string, side: 'input' | 'cacheHit' | 'output', value: number | undefined) => void
  /**
   * Declare how many tokens one model accepts, or take the declaration back with `undefined`.
   *
   * One number for one model, and the model id travels with it because a window belongs to the model that
   * enforces it: one gateway serves a model with a small window and one with a large one.
   */
  onWindowChange: (modelId: string, value: number | undefined) => void
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
  /**
   * The base URL this provider is called at, and the act of changing it.
   *
   * Custom-only, and absent for a predefined provider — its endpoint is this app's, not the user's, so
   * passing neither is what keeps its box exactly the box it was. The two travel together because a URL
   * with no way to save an edit would be a row that only looks editable; the callback answers with why an
   * edit was refused, or null when it was written, so the sentence lands on the field that caused it.
   */
  baseUrl?: string
  onSaveBaseUrl?: (baseUrl: string) => ProviderDraftRejection | null
  /**
   * Rename this provider in place, answering with why the name was refused or null when it was written.
   *
   * Custom-only for the reason the URL is: the id a custom provider was created under does not move when
   * the name does, so a rename is a label rather than an identity.
   */
  onSaveName?: (name: string) => ProviderDraftRejection | null
}) {
  // The two in-place editors: which one is open, the draft it is holding, and the sentence a refusal left.
  // Local rather than in the store, because a half-typed name is nobody's state but this box's.
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [editingBaseUrl, setEditingBaseUrl] = useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl ?? '')
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)

  const startNameEdit = () => {
    setNameDraft(name)
    setNameError(null)
    setEditingName(true)
  }

  const cancelNameEdit = () => {
    setNameError(null)
    setEditingName(false)
  }

  const commitName = () => {
    if (!onSaveName) return
    const rejection = onSaveName(nameDraft)
    if (rejection) {
      // Still editing: the field the user has to fix is the field they are already in.
      setNameError(draftError(rejection).message)
      return
    }
    setNameError(null)
    setEditingName(false)
  }

  const startBaseUrlEdit = () => {
    setBaseUrlDraft(baseUrl ?? '')
    setBaseUrlError(null)
    setEditingBaseUrl(true)
  }

  const cancelBaseUrlEdit = () => {
    setBaseUrlError(null)
    setEditingBaseUrl(false)
  }

  const commitBaseUrl = () => {
    if (!onSaveBaseUrl) return
    const rejection = onSaveBaseUrl(baseUrlDraft)
    if (rejection) {
      setBaseUrlError(draftError(rejection).message)
      return
    }
    setBaseUrlError(null)
    setEditingBaseUrl(false)
  }

  return (
    <CardSurface
      data-slot="provider-box"
      data-provider-kind={kind}
      data-provider-id={id}
      className="rounded-lg border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <KeyRound className={cn('size-3.5 shrink-0', configured ? 'text-brand' : 'text-muted-foreground')} />
        {/*
          The name is a control for a provider the user added and a statement for one that ships here: a
          custom provider's name is theirs to change, and clicking it turns the text into the field in
          place — same header row, same gap beside the badge, no dialog over the screen.
        */}
        {onSaveName ? (
          editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              aria-label="Provider name"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName()
                if (event.key === 'Escape') cancelNameEdit()
              }}
              className="h-7 w-40 min-w-0 px-1.5 text-[13px] font-medium"
            />
          ) : (
            <button
              type="button"
              data-slot="provider-edit-name"
              title="Rename this provider"
              onClick={startNameEdit}
              className="-mx-1 min-w-0 truncate rounded px-1 text-left text-[13px] font-medium transition-colors hover:bg-muted"
            >
              {name}
            </button>
          )
        ) : (
          <span className="text-[13px] font-medium">{name}</span>
        )}
        {configured && (
          <span
            data-slot="provider-saved-badge"
            className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10.5px] font-medium text-brand-text"
          >
            <Check className="size-2.5" />
            saved
          </span>
        )}

        <div data-slot="provider-actions" className="ml-auto flex items-center gap-0.5">
          {actions}
        </div>
      </div>

      {nameError && (
        <p data-slot="provider-name-error" role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          {nameError}
        </p>
      )}

      {/*
        The endpoint, on the screen rather than behind a form: a provider the user typed a URL for is one
        they may have typed wrong, and moving it to a server they have since started elsewhere is the
        same kind of edit as renaming it. Custom-only, so a predefined provider's box does not grow a row
        it has no value for.
      */}
      {baseUrl !== undefined && onSaveBaseUrl && (
        <div data-slot="provider-base-url" className="mt-2.5 flex items-center gap-2">
          <Label className="w-[52px] shrink-0 text-[11.5px] font-normal text-muted-foreground">API URL</Label>
          {editingBaseUrl ? (
            <Input
              autoFocus
              value={baseUrlDraft}
              aria-label="API URL"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitBaseUrl()
                if (event.key === 'Escape') cancelBaseUrlEdit()
              }}
              className="h-8 min-w-0 font-mono text-[12px]"
            />
          ) : (
            <button
              type="button"
              title="Change this provider's base URL"
              onClick={startBaseUrlEdit}
              className="min-w-0 truncate rounded text-left font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {baseUrl}
            </button>
          )}
        </div>
      )}

      {baseUrlError && (
        <p data-slot="provider-url-error" role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          {baseUrlError}
        </p>
      )}

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
            modelRates={modelRates}
            modelWindows={modelWindows}
            defaultOpen={modelsOpen}
            onToggle={onToggleModel}
            onRateChange={onRateChange}
            onWindowChange={onWindowChange}
          />
        </div>
      )}
    </CardSurface>
  )
}
