import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { useConveyorStore } from 'electron-conveyor/react'
import {
  newProviderId,
  resolveProviderEdit,
  validateProviderDraft,
  type CustomProvider,
  type ProviderEditCheck,
  type ProviderEditRejection,
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
import { draftError, ProviderBox } from './provider-box'

/**
 * The providers the user added: the button that adds one, the dialog that describes it, and one box
 * each in the list.
 *
 * A custom provider is not a second kind of thing on this screen. Its configuration is a name, a base
 * URL and an optional key, which is what a predefined provider's key row already asks for, so its box
 * *is* that box — `ProviderBox` — and the affordances it adds are the ones a predefined provider has no
 * use for: its name and base URL edited in place, asking the server itself what it offers, and deleting
 * the entry.
 *
 * The key is the one value that has to travel carefully. The list of providers is mirrored to every
 * window, so it can never hold a credential. The form therefore derives the id the provider is about to
 * have — `newProviderId` is stable for a given name and set of ids, which is exactly why the protocol
 * derives rather than randomises — and stores the key under that id, which is where main reads it from
 * when a turn runs against the provider. A plaintext key exists in the renderer only while a user is
 * typing one.
 */

/**
 * The added providers, as the tail of the Settings list.
 *
 * The boxes only, in the order they were added: a provider that was just added is the last one, which is
 * also where a reader looks for it. The control that grows the list is not one of its rows — it lives in
 * the section header beside the heading it adds to, which is where the MCP section's own add control sits
 * and what makes both screens read as the same screen with different lists.
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

  /*
   * TEMPORARY (Turn 7 probe): where the store dispatch goes after `onSaveName`/`onSaveBaseUrl` hand it
   * over, and what becomes of it. Removed in Turn 8.
   *
   * A store action is dispatched by conveyor's bound action, which is `void
   * window.conveyor.invoke(storeChannel, name, { payload })` — the promise is dropped, so a rejection
   * (main refusing the payload) and a resolution (main returning state) are equally invisible to the
   * renderer. Wrapping `invoke` is the one place both are visible. The bridge is exposed through
   * `contextBridge`, though, and Electron freezes that object when the `ContextBridgeMutability`
   * feature is off (it is off in this build), so the assignment below is refused at runtime and only
   * succeeds against the plain stub object the DOM suites install. When it is refused, the effect falls
   * back to `unhandledrejection`, which is where the dropped promise's rejection surfaces; the mount
   * line says which path was taken, so a silent L3 is never read as "invoke never happened".
   *
   * Only `updateCustomProvider` is logged: every other call on this bridge (store reads included) would
   * bury the one dispatch this probe is about.
   */
  useEffect(() => {
    const bridge = window.conveyor
    const original = bridge.invoke
    let installed = false

    const wrapped = (channel: string, method: string, ...args: unknown[]): Promise<unknown> => {
      if (method !== 'updateCustomProvider') return original(channel, method, ...args)
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const result = original(channel, method, ...args)
      result.then(
        (value) => console.warn('[PROBE] invoke resolved', { channel, method, payload, value }),
        (reason: unknown) =>
          console.warn('[PROBE] invoke rejected', {
            channel,
            method,
            payload,
            reason: String(reason),
            code: (reason as { code?: string } | null)?.code ?? null,
          })
      )
      return result
    }

    try {
      bridge.invoke = wrapped
      installed = bridge.invoke === wrapped
    } catch {
      installed = false
    }

    if (installed) {
      return () => {
        bridge.invoke = original
      }
    }

    console.warn('[PROBE] invoke wrapper unavailable', {
      reason: 'window.conveyor is frozen by contextBridge; watching unhandledrejection instead',
    })
    const onUnhandled = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { code?: string; message?: string } | null
      console.warn('[PROBE] invoke rejected (unhandled)', {
        reason: String(reason?.message ?? reason),
        code: reason?.code ?? null,
      })
    }
    window.addEventListener('unhandledrejection', onUnhandled)
    return () => window.removeEventListener('unhandledrejection', onUnhandled)
  }, [])

  return (
    <>
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
 * The form that describes a provider before it exists, and the one control that opens it.
 *
 * The trigger is the section header's, beside the heading it belongs to, and it is a plus glyph followed
 * by the words: the icon is the plus, so the text that follows it is "Add Provider" and never a second
 * one. `disabled` is the keychain's answer rather than this form's own reading — a system that cannot
 * hold a secret still lists its providers, it just cannot accept a key for one.
 *
 * Saving does two things in one gesture, because a user who types a key means it to be used: the
 * provider joins the list, and — when a key was typed — that key is stored by main under the id the
 * provider is about to have. The rules that decide whether the draft is acceptable are turn A's, applied
 * here so a refusal lands on the field it belongs to instead of leaving the dialog silently open, and
 * applied again by the store, which owns the list the name must be unique against.
 */
export function AddProviderDialog({ disabled, onAdded }: { disabled: boolean; onAdded: () => void }) {
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
        className="shrink-0"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />
        Add Provider
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
 * Deleting asks first. The name and the base URL are edited in place instead: both are labels on the
 * provider rather than its identity, so the id it was created under does not move — and with the id
 * still, the saved key, the per-model declarations and the conversations that name it all survive.
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

  const providers = useConveyorStore(providerConfigStore, (s) => s.customProviders)
  const config = useConveyorStore(providerConfigStore, (s) => s.providers[provider.id])
  const {
    toggleModel,
    setSupportsImages,
    setCustomProviderModels,
    setEnabledModels,
    updateCustomProvider,
    removeCustomProvider,
    setModelRates,
    setModelWindows,
  } = useConveyorStore(providerConfigStore)

  const enabled = useMemo(() => config?.enabledModels ?? [], [config])
  const catalogue = useMemo(() => provider.models.map((id) => ({ id })), [provider.models])

  /**
   * Why an edit was refused, in the words the form's own rules use — every code the rules can answer
   * with, not only the three a draft can produce.
   *
   * The check the store applies is run here too, so a refusal lands on the field that caused it: an
   * action cannot answer with an error, and a name another provider holds would otherwise look like a
   * save that did nothing. `NOT_FOUND` and `NO_FIELDS` are statements about the edit rather than about
   * anything the user typed — the box was drawn from a provider the list held, and both commit sites
   * name one field — so reading them as impossible read the tree as inevitable, and either refusal was
   * dropped on the floor. Dropped is the one thing a refusal may not be: a commit that closed without
   * writing is indistinguishable, on screen, from one that saved, and a user cannot report a silence
   * they were never told about.
   */
  const refusal = (check: ProviderEditCheck): ProviderEditRejection | null => (check.ok ? null : check.code)

  const onSaveName = (next: string): ProviderEditRejection | null => {
    const check = resolveProviderEdit(providers, provider.id, { name: next })
    // TEMPORARY (Turn 7 probe): the local check's verdict and the payload the dispatch carries.
    console.warn('[PROBE] dispatch', {
      ok: check.ok,
      code: check.ok ? null : check.code,
      payload: { id: provider.id, name: next },
    })
    if (check.ok) updateCustomProvider({ id: provider.id, name: next })
    return refusal(check)
  }

  /**
   * Ask a newly saved URL what it offers, and make the store agree with the answer.
   *
   * The catalogue and the enable list both name models of one endpoint, so neither outlives a URL that
   * does not serve them. A successful answer replaces the catalogue and drops the enabled ids it no
   * longer lists — the rule a refresh applies to a shipped provider — while the per-model declarations
   * are the record's and stay: they are keyed by model id and harmless until that id reappears. A failed
   * answer clears both sets, because keeping them would offer the chat picker a model the new server has
   * never heard of, and says why in the box, in the words the code chose.
   */
  const refetchCatalogue = async (baseUrl: string) => {
    try {
      const models = await listModels.mutateAsync({ baseUrl, apiKey: '', providerId: provider.id })
      setCustomProviderModels({ id: provider.id, models })
      const available = new Set(models)
      const kept = enabled.filter((modelId) => available.has(modelId))
      if (kept.length !== enabled.length) setEnabledModels({ providerId: provider.id, modelIds: kept })
      setJustFetched(true)
      setNotice(null)
    } catch (err) {
      setCustomProviderModels({ id: provider.id, models: [] })
      setEnabledModels({ providerId: provider.id, modelIds: [] })
      setJustFetched(false)
      setNotice(fetchNotice(err, provider.name))
    }
  }

  /**
   * Save the new URL, then ask it for its catalogue.
   *
   * In that order, and as two facts: the URL is what the user asked for, so it is written whatever the
   * server answers, and the catalogue is what the server said, so it is the fetch that decides it. The
   * refetch carries no key — main reads the one stored under the id, which did not move — and it is not
   * awaited by the commit: the box shows the saved URL and then the answer.
   */
  const onSaveBaseUrl = (next: string): ProviderEditRejection | null => {
    const check = resolveProviderEdit(providers, provider.id, { baseUrl: next })
    if (!check.ok) return refusal(check)

    const baseUrl = check.edit.baseUrl ?? next
    // TEMPORARY (Turn 7 probe): the local check's verdict and the payload the dispatch carries.
    console.warn('[PROBE] dispatch', {
      ok: check.ok,
      code: null,
      payload: { id: provider.id, baseUrl },
    })
    updateCustomProvider({ id: provider.id, baseUrl })
    void refetchCatalogue(baseUrl)
    return null
  }

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
        enabledModels={enabled}
        models={catalogue}
        modelsOpen={justFetched}
        onToggleModel={(modelId) => toggleModel({ providerId: provider.id, modelId })}
        // The same two props as a predefined box, off the same slice: a gateway someone added is priced
        // exactly as a provider that ships with the app, model by model.
        modelRates={config?.modelRates}
        // And the same route for the window, for the third time and the same reason: a model reached
        // through a gateway someone added is measured against a window exactly as a shipped one is.
        modelWindows={config?.modelWindows}
        onRateChange={(modelId, side, next) => {
          const declared = config?.modelRates?.[modelId]
          setModelRates({
            providerId: provider.id,
            modelId,
            input: side === 'input' ? next : declared?.inputRate,
            cacheHit: side === 'cacheHit' ? next : declared?.cacheHitRate,
            output: side === 'output' ? next : declared?.outputRate,
          })
        }}
        onWindowChange={(modelId, window) => setModelWindows({ providerId: provider.id, modelId, window })}
        notice={notice}
        // The two facts a custom provider has that a predefined one does not: an endpoint the user typed,
        // and a name that is a label rather than this app's own. Both are edited in the box, in place.
        baseUrl={provider.baseUrl}
        onSaveBaseUrl={onSaveBaseUrl}
        onSaveName={onSaveName}
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
