import { useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { useConveyorStore } from 'electron-conveyor/react'
import {
  newProviderId,
  validateProviderDraft,
  type CustomProvider,
  type ProviderDraftRejection,
} from '@/conveyor/protocol/custom-provider'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { fetchNotice, keySaveErrorMessage } from './provider-notices'
import { ProviderBox } from './provider-box'

/**
 * The providers the user added: the button that adds one, the dialog that describes it, and one box
 * each in the list.
 *
 * A custom provider is not a second kind of thing on this screen. Its configuration is a name, a base
 * URL and an optional key, which is what a predefined provider's key row already asks for, so its box
 * *is* that box — `ProviderBox` — and the two affordances it adds are the two a predefined provider has
 * no use for: asking the server itself what it offers, and deleting the entry.
 *
 * The key is the one value that has to travel carefully. The list of providers is mirrored to every
 * window, so it can never hold a credential. The form therefore derives the id the provider is about to
 * have — `newProviderId` is stable for a given name and set of ids, which is exactly why the protocol
 * derives rather than randomises — and stores the key under that id, which is where main reads it from
 * when a turn runs against the provider. A plaintext key exists in the renderer only while a user is
 * typing one.
 */

/** Where a refused draft belongs, and what it says. One field at a time, because the rules answer one. */
function draftError(code: ProviderDraftRejection): { field: 'name' | 'baseUrl'; message: string } {
  switch (code) {
    case 'NAME_REQUIRED':
      return { field: 'name', message: 'A name is required.' }
    case 'NAME_TAKEN':
      return { field: 'name', message: 'A provider with this name already exists.' }
    case 'BASE_URL_INVALID':
      return { field: 'baseUrl', message: 'Enter an http(s) URL, like http://localhost:1234/v1.' }
  }
}

/**
 * The added providers, as the tail of the Settings list.
 *
 * The add button comes first and the boxes after it, in the order they were added: a provider that was
 * just added is the last one, which is also where a reader looks for it.
 */
export function CustomProviders({
  configured,
  disabled,
  onProvidersChanged,
}: {
  /** Ids that currently hold a key, as `settings.listConfigured` reports them. */
  configured: readonly string[]
  /** True when this system cannot hold a secret at all, so the key controls are unusable. */
  disabled: boolean
  onProvidersChanged: () => void
}) {
  const providers = useConveyorStore(providerConfigStore, (s) => s.customProviders)

  return (
    <>
      <AddProviderDialog disabled={disabled} onAdded={onProvidersChanged} />
      {providers.map((provider) => (
        <CustomProviderCard
          key={provider.id}
          provider={provider}
          configured={configured.includes(provider.id)}
          disabled={disabled}
          onKeyChanged={onProvidersChanged}
        />
      ))}
    </>
  )
}

/**
 * The form that describes a provider before it exists.
 *
 * Saving does two things in one gesture, because a user who types a key means it to be used: the
 * provider joins the list, and — when a key was typed — that key is stored by main under the id the
 * provider is about to have. The rules that decide whether the draft is acceptable are turn A's, applied
 * here so a refusal lands on the field it belongs to instead of leaving the dialog silently open, and
 * applied again by the store, which owns the list the name must be unique against.
 */
function AddProviderDialog({ disabled, onAdded }: { disabled: boolean; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'baseUrl'; message: string } | null>(null)

  const existing = useConveyorStore(providerConfigStore, (s) => s.customProviders)
  const { addCustomProvider } = useConveyorStore(providerConfigStore)
  const saveKey = conveyor.settings.saveApiKey.useMutation()

  const close = () => {
    setOpen(false)
    setName('')
    setBaseUrl('')
    setApiKey('')
    setRevealed(false)
    setError(null)
  }

  const onSave = async () => {
    const check = validateProviderDraft(
      { name, baseUrl, apiKey },
      existing.map((p) => p.name)
    )
    if (!check.ok) {
      setError(draftError(check.code))
      return
    }
    setError(null)

    const id = newProviderId(
      check.draft.name,
      existing.map((p) => p.id)
    )
    addCustomProvider({ name: check.draft.name, baseUrl: check.draft.baseUrl })

    if (check.draft.apiKey) {
      try {
        await saveKey.mutateAsync({ providerId: id, apiKey: check.draft.apiKey })
      } catch (err) {
        // The provider is in the list either way — it is usable without a key, which is the ordinary
        // case for a server on this machine — so this says what did *not* happen rather than undoing
        // what did.
        toast.error(`${check.draft.name} was added without a key`, { description: keySaveErrorMessage(err) })
      }
    }

    close()
    onAdded()
  }

  return (
    <>
      <Button
        data-slot="add-provider"
        size="sm"
        variant="outline"
        className="mt-2.5 w-full justify-center"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />+ Add Provider
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add a provider</AlertDialogTitle>
            <AlertDialogDescription>
              A server this app can reach that speaks the OpenAI chat dialect. Its models are read from the server
              itself, so the URL is the only thing that has to be exactly right.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-provider-name">Provider name</Label>
              <Input
                id="add-provider-name"
                value={name}
                autoComplete="off"
                spellCheck={false}
                placeholder="Local Llama"
                onChange={(event) => setName(event.target.value)}
                className="h-8 text-[12.5px]"
              />
              {error?.field === 'name' && (
                <p data-slot="provider-name-error" role="alert" className="text-[12px] text-destructive">
                  {error.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-provider-key">API key</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="add-provider-key"
                  type={revealed ? 'text' : 'password'}
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Optional — a server on this machine may want none"
                  onChange={(event) => setApiKey(event.target.value)}
                  className="h-8 font-mono text-[12px]"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={revealed ? 'Hide API key' : 'Show API key'}
                  onClick={() => setRevealed((shown) => !shown)}
                >
                  {revealed ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                Encrypted with your operating system keychain and never shown again.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-provider-url">API URL</Label>
              <Input
                id="add-provider-url"
                value={baseUrl}
                autoComplete="off"
                spellCheck={false}
                placeholder="http://localhost:1234/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
                className="h-8 font-mono text-[12px]"
              />
              {error?.field === 'baseUrl' && (
                <p data-slot="provider-url-error" role="alert" className="text-[12px] text-destructive">
                  {error.message}
                </p>
              )}
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
            <Button size="sm" disabled={saveKey.isPending} onClick={() => void onSave()}>
              {saveKey.isPending && <Loader2 className="animate-spin" />}
              Save provider
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * One added provider, in the same box a predefined provider gets.
 *
 * Fetching is the one call this app cannot make on the user's behalf: a custom provider has no
 * catalogue here and no curated list to fall back on, so the list comes from the server, asked through
 * `provider.listModels` with the URL and — when the user has one typed in the field — the key. When no
 * key is typed, the id travels too and main reads the key it already holds, because a key that was saved
 * is not in the renderer to send.
 *
 * Deleting asks first. There is no edit: changing a provider's URL or name is delete-plus-add, which is
 * named as a residual rather than hidden behind a field that would have to move a key between ids.
 */
function CustomProviderCard({
  provider,
  configured,
  disabled,
  onKeyChanged,
}: {
  provider: CustomProvider
  configured: boolean
  disabled: boolean
  onKeyChanged: () => void
}) {
  const [keyValue, setKeyValue] = useState('')
  const [justFetched, setJustFetched] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const save = conveyor.settings.saveApiKey.useMutation()
  const clear = conveyor.settings.clearApiKey.useMutation()
  const listModels = conveyor.provider.listModels.useMutation()

  const config = useConveyorStore(providerConfigStore, (s) => s.providers[provider.id])
  const { toggleModel, setSupportsImages, setCustomProviderModels, removeCustomProvider, setRates } =
    useConveyorStore(providerConfigStore)

  const enabled = useMemo(() => config?.enabledModels ?? [], [config])
  const catalogue = useMemo(() => provider.models.map((id) => ({ id })), [provider.models])
  // Memoised like the two above, and for the same reason: absent is the ordinary state of a price, and a
  // fresh object each render would hand the box a new pair on every store broadcast.
  const rates = useMemo(
    () => ({ input: config?.inputRate, output: config?.outputRate }),
    [config?.inputRate, config?.outputRate]
  )

  const onSaveKey = async () => {
    if (!keyValue.trim()) return
    try {
      await save.mutateAsync({ providerId: provider.id, apiKey: keyValue.trim() })
      setKeyValue('')
      toast.success(`${provider.name} key saved`, { description: 'Encrypted and stored on this machine.' })
      onKeyChanged()
    } catch (err) {
      toast.error(`${provider.name} key was not saved`, { description: keySaveErrorMessage(err) })
    }
  }

  const onClearKey = async () => {
    try {
      await clear.mutateAsync({ providerId: provider.id })
      setKeyValue('')
      toast.success(`${provider.name} key removed`)
      onKeyChanged()
    } catch {
      toast.error(`${provider.name} key could not be removed`)
    }
  }

  const onFetch = async () => {
    try {
      const models = await listModels.mutateAsync({
        baseUrl: provider.baseUrl,
        apiKey: keyValue.trim(),
        providerId: provider.id,
      })
      setCustomProviderModels({ id: provider.id, models })
      setJustFetched(true)
      setNotice(null)
      toast.success(`${models.length} ${provider.name} models`, {
        description: 'Switch on the ones you want to use.',
      })
    } catch (err) {
      // In the box rather than in a toast: a toast about a URL the user is about to fix should still be
      // there while they fix it, and it is the box's own state that just changed.
      setNotice(fetchNotice(err, provider.name))
    }
  }

  const onConfirmDelete = async () => {
    removeCustomProvider({ id: provider.id })
    // The key goes with it: a provider that is gone must not leave a credential behind under an id
    // nothing will ever name again.
    if (configured) await clear.mutateAsync({ providerId: provider.id }).catch(() => undefined)
    onKeyChanged()
  }

  return (
    <>
      <ProviderBox
        id={provider.id}
        name={provider.name}
        kind="custom"
        configured={configured}
        disabled={disabled}
        keyValue={keyValue}
        onKeyChange={setKeyValue}
        onSaveKey={() => void onSaveKey()}
        saving={save.isPending}
        onClearKey={() => void onClearKey()}
        clearing={clear.isPending}
        // The same switch a predefined provider carries, wired to the same store slice: a provider the user
        // added is asked the same question, and its answer is read by the same gate in the composer.
        imagesSupported={config?.supportsImages === true}
        onToggleImages={(supported) => setSupportsImages({ providerId: provider.id, supported })}
        // The same two fields, wired to the same slice: a gateway someone added is priced exactly as a
        // provider that ships with the app, which is the case the overrides exist for.
        rates={rates}
        onRateChange={(side, next) =>
          setRates({
            providerId: provider.id,
            input: side === 'input' ? next : config?.inputRate,
            output: side === 'output' ? next : config?.outputRate,
          })
        }
        enabledModels={enabled}
        models={catalogue}
        modelsOpen={justFetched}
        onToggleModel={(modelId) => toggleModel({ providerId: provider.id, modelId })}
        notice={notice}
        actions={
          <>
            <Button
              data-slot="provider-fetch-models"
              size="icon-sm"
              variant="ghost"
              aria-label={`Fetch models for ${provider.name}`}
              disabled={listModels.isPending}
              onClick={() => void onFetch()}
            >
              {listModels.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
            <Button
              data-slot="provider-delete"
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${provider.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 />
            </Button>
          </>
        }
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {provider.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its saved key is forgotten too. The models switched on for it stop appearing in the chat picker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-slot="provider-delete-confirm"
              disabled={clear.isPending}
              onClick={() => void onConfirmDelete()}
            >
              Remove provider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
