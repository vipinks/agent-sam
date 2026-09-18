import { useState } from 'react'
import { Check, KeyRound, Loader2, Settings as SettingsIcon, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { PaneHeader } from './pane-header'

/**
 * Settings: one row per provider, each holding its own key. This is the only screen that handles a
 * secret, and it hands the value straight to main — nothing is kept in renderer state beyond the
 * input the user is typing into, and the save clears it immediately afterwards.
 */
export function SettingsView() {
  const providers = conveyor.settings.listProviders.useQuery()
  const configured = conveyor.settings.listConfigured.useQuery()
  const encryptionAvailable = conveyor.settings.isEncryptionAvailable.useQuery()

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={SettingsIcon} title="Settings" />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-8 py-7">
          <header className="mb-6">
            <h1 className="text-lg font-semibold tracking-tight">Model providers</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Keys are encrypted with your operating system keychain and never leave the main process. The chat
              interface reads them from there, so the window you are looking at never holds one.
            </p>
          </header>

          {encryptionAvailable.data === false && (
            <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-destructive/35 bg-destructive/8 px-3.5 py-3">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <p className="text-[13px] font-medium">No OS keychain available</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  This system cannot store secrets securely, so keys cannot be saved here. On Linux this usually means
                  no secret service is running for your desktop session.
                </p>
              </div>
            </div>
          )}

          {providers.isLoading && <p className="text-[13px] text-muted-foreground">Loading providers…</p>}

          <div className="flex flex-col gap-2.5">
            {providers.data?.map((provider) => (
              <ProviderRow
                key={provider.id}
                id={provider.id}
                name={provider.name}
                defaultModel={provider.defaultModel}
                configured={(configured.data ?? []).includes(provider.id)}
                disabled={encryptionAvailable.data === false}
                onSaved={() => void configured.refetch()}
                onCleared={() => void configured.refetch()}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The error copy for a failed save, branched on the code rather than on the message text. */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    if (error.code === 'ENCRYPTION_UNAVAILABLE') return 'No OS keychain is available, so this key was not saved.'
    if (error.code === 'UNKNOWN_PROVIDER') return 'That provider is not supported.'
    if (error.code === 'INVALID_INPUT') return 'That key does not look valid. Check it and try again.'
  }
  return 'The key could not be saved.'
}

function ProviderRow({
  id,
  name,
  defaultModel,
  configured,
  disabled,
  onSaved,
  onCleared,
}: {
  id: string
  name: string
  defaultModel: string
  configured: boolean
  disabled: boolean
  onSaved: () => void
  onCleared: () => void
}) {
  const [value, setValue] = useState('')
  const save = conveyor.settings.saveApiKey.useMutation()
  const clear = conveyor.settings.clearApiKey.useMutation()

  const onSave = async () => {
    if (!value.trim()) return
    try {
      await save.mutateAsync({ providerId: id, apiKey: value.trim() })
      // Clear the field as soon as main has the ciphertext: the input is the only place the
      // plaintext was ever held on this side.
      setValue('')
      toast.success(`${name} key saved`, { description: 'Encrypted and stored on this machine.' })
      onSaved()
    } catch (err) {
      toast.error(`${name} key was not saved`, { description: saveErrorMessage(err) })
    }
  }

  const onClear = async () => {
    try {
      await clear.mutateAsync({ providerId: id })
      setValue('')
      toast.success(`${name} key removed`)
      onCleared()
    } catch {
      toast.error(`${name} key could not be removed`)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <KeyRound className={cn('size-3.5 shrink-0', configured ? 'text-brand' : 'text-muted-foreground')} />
        <span className="text-[13px] font-medium">{name}</span>
        {configured && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10.5px] font-medium text-brand">
            <Check className="size-2.5" />
            saved
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{defaultModel}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Input
          type="password"
          value={value}
          disabled={disabled || save.isPending}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${name} API key`}
          placeholder={configured ? 'Replace the saved key…' : 'Paste your API key'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSave()
          }}
          className="h-8 font-mono text-[12px]"
        />
        <Button size="sm" disabled={disabled || !value.trim() || save.isPending} onClick={() => void onSave()}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save
        </Button>
        {configured && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${name} key`}
            disabled={clear.isPending}
            onClick={() => void onClear()}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  )
}
