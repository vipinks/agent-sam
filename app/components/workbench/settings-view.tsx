import { useMemo, useState } from 'react'
import { ArrowLeft, Loader2, RefreshCw, Settings as SettingsIcon, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { PaneHeader } from './pane-header'
import { ProviderBox } from './provider-box'
import { CustomProviders } from './custom-provider-settings'
import { McpServersSection } from './mcp-settings'
import { SkillsSection } from './skills-settings'
import { TerminalSection } from './terminal-settings'
import { keySaveErrorMessage } from './provider-notices'
import { useWorkbenchStore, type SettingsSection } from './store'

/**
 * Settings: a screen of sections, and the row at the top that switches between them.
 *
 * The screen takes the whole main area rather than the drawer, so leaving it is its own business: the
 * back glyph beside the title returns to whatever the drawer was showing when the visit began, and it
 * is the only control in this header that belongs to the view rather than to the section below it.
 * Which view that was, and which section is showing, are memories of the visit — the store's
 * `settingsReturnView` and `settingsSection` — and neither is written anywhere.
 *
 * The section row is the primitive the app already ships, so there is no second way to present a
 * choice of panes here. Radix renders the selected section and only the selected one, which is what
 * makes "the Providers section" a thing a reader of the DOM can point at.
 *
 * Providers, in that first section, is one row per provider, each holding its own key and its own model
 * list. This is the only screen that handles a secret, and it hands the value straight to main —
 * nothing is kept in renderer state beyond the input the user is typing into, and the save clears it
 * immediately. Model choices are different: they are the user's intent, so they live in the persisted
 * `provider-config` store and are written the moment a switch is flipped.
 *
 * Both kinds of provider are drawn by one sub-component, `ProviderBox`: a provider the user added is
 * the same box with different wiring, not a lookalike of it, and the parity suite compares the two
 * through the slots that sub-component renders.
 */
export function SettingsView() {
  const providers = conveyor.settings.listProviders.useQuery()
  const configured = conveyor.settings.listConfigured.useQuery()
  const encryptionAvailable = conveyor.settings.isEncryptionAvailable.useQuery()

  const section = useWorkbenchStore((s) => s.settingsSection)
  const setSection = useWorkbenchStore((s) => s.setSettingsSection)
  const closeSettings = useWorkbenchStore((s) => s.closeSettings)

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader
        icon={SettingsIcon}
        title="Settings"
        leading={
          <Button
            data-slot="settings-back"
            size="icon-xs"
            variant="ghost"
            aria-label="Back"
            title="Back"
            onClick={closeSettings}
          >
            <ArrowLeft />
          </Button>
        }
      />

      <Tabs
        value={section}
        // One cast, at the boundary where Radix hands back a string: the values below are the union, and
        // the store is the only writer, so nothing else can arrive here.
        onValueChange={(next) => setSection(next as SettingsSection)}
        className="min-h-0 flex-1 gap-0"
      >
        {/* The row is the panel's own top: it stays put while a section scrolls under it, so the choice
            of section is never something the reader has scrolled away from. */}
        <div className="border-b border-border px-8 py-2.5">
          <TabsList data-slot="settings-sections">
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="mcp-servers">MCP Servers</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="providers" data-slot="settings-section-providers" className="mx-auto max-w-2xl px-8 py-7">
            <header className="mb-6">
              <h1 className="text-lg font-semibold tracking-tight">Model providers</h1>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Keys are encrypted with your operating system keychain and never leave the main process. Fetch a
                provider&rsquo;s models, switch on the ones you want, and they appear in the chat picker.
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
                <ProviderCard
                  key={provider.id}
                  id={provider.id}
                  name={provider.name}
                  configured={(configured.data ?? []).includes(provider.id)}
                  disabled={encryptionAvailable.data === false}
                  onKeyChanged={() => void configured.refetch()}
                />
              ))}

              {/* After the ones that ship, because a provider the user added is an addition to that list —
                  and the button between them is where the list grows. */}
              <CustomProviders
                configured={configured.data ?? []}
                disabled={encryptionAvailable.data === false}
                onProvidersChanged={() => void configured.refetch()}
              />
            </div>
          </TabsContent>

          <TabsContent value="mcp-servers" data-slot="settings-section-mcp" className="mx-auto max-w-2xl px-8 py-7">
            <McpServersSection />
          </TabsContent>

          <TabsContent value="skills" data-slot="settings-section-skills" className="mx-auto max-w-2xl px-8 py-7">
            <SkillsSection />
          </TabsContent>

          <TabsContent value="terminal" data-slot="settings-section-terminal" className="mx-auto max-w-2xl px-8 py-7">
            <TerminalSection />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

/** The error copy for a failed fetch, branched on the code rather than on the message text. */
function fetchErrorMessage(error: unknown, name: string): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'NO_API_KEY':
        return `Save a ${name} API key first — the catalogue is fetched with it.`
      case 'AUTH_FAILED':
        return `${name} rejected the saved key. Check it and try again.`
      case 'RATE_LIMITED':
        return `${name} is rate limiting this key. Try again shortly.`
      case 'NETWORK_ERROR':
        return `Could not reach ${name}. Check your connection.`
      case 'ENCRYPTION_UNAVAILABLE':
        return 'No OS keychain is available, so the saved key cannot be decrypted.'
      default:
        return `${name} returned a catalogue this app could not read.`
    }
  }
  return 'The model list could not be fetched.'
}

function ProviderCard({
  id,
  name,
  configured,
  disabled,
  onKeyChanged,
}: {
  id: string
  name: string
  configured: boolean
  disabled: boolean
  onKeyChanged: () => void
}) {
  const [value, setValue] = useState('')
  // Opened on the render right after a fetch, so the list you just asked for is visible. The list
  // itself owns whether it is expanded after that.
  const [justFetched, setJustFetched] = useState(false)

  const save = conveyor.settings.saveApiKey.useMutation()
  const clear = conveyor.settings.clearApiKey.useMutation()
  const fetchModels = conveyor.settings.fetchModels.useMutation()

  // The store is the source of truth for both lists, so it survives a window close. Both are
  // memoised because the store slice is absent for an unfetched provider, and a fresh `?? []` each
  // render would invalidate every memo that depends on them.
  const config = useConveyorStore(providerConfigStore, (s) => s.providers[id])
  const { toggleModel, setFetchedModels, setSupportsImages, setRates } = useConveyorStore(providerConfigStore)

  const fetched = useMemo(() => config?.fetchedModels ?? [], [config])
  const enabled = useMemo(() => config?.enabledModels ?? [], [config])
  // Memoised for the same reason the two lists above are: the store slice is absent for a provider that
  // has never been configured, and a fresh object every render would hand the box a new pair each time.
  const rates = useMemo(
    () => ({ input: config?.inputRate, output: config?.outputRate }),
    [config?.inputRate, config?.outputRate]
  )

  const onSave = async () => {
    if (!value.trim()) return
    try {
      await save.mutateAsync({ providerId: id, apiKey: value.trim() })
      // Clear the field as soon as main holds the ciphertext: this input was the only place the
      // plaintext ever lived on the renderer side.
      setValue('')
      toast.success(`${name} key saved`, { description: 'Encrypted and stored on this machine.' })
      onKeyChanged()
    } catch (err) {
      toast.error(`${name} key was not saved`, { description: keySaveErrorMessage(err) })
    }
  }

  const onClear = async () => {
    try {
      await clear.mutateAsync({ providerId: id })
      setValue('')
      toast.success(`${name} key removed`)
      onKeyChanged()
    } catch {
      toast.error(`${name} key could not be removed`)
    }
  }

  const onFetch = async () => {
    try {
      const models = await fetchModels.mutateAsync({ providerId: id })
      // Record the catalogue, then open the list: fetching to see nothing would be a dead end.
      setFetchedModels({ providerId: id, models })
      setJustFetched(true)
      toast.success(`${models.length} ${name} models`, { description: 'Switch on the ones you want to use.' })
    } catch (err) {
      toast.error(`${name} models could not be fetched`, { description: fetchErrorMessage(err, name) })
    }
  }

  return (
    <ProviderBox
      id={id}
      name={name}
      kind="predefined"
      configured={configured}
      disabled={disabled}
      keyValue={value}
      onKeyChange={setValue}
      onSaveKey={() => void onSave()}
      saving={save.isPending}
      onClearKey={() => void onClear()}
      clearing={clear.isPending}
      // Absence is off: a provider nobody has said anything about is not one the composer may attach an
      // image for, and the switch shows that as an off position rather than as a third state.
      imagesSupported={config?.supportsImages === true}
      onToggleImages={(supported) => setSupportsImages({ providerId: id, supported })}
      rates={rates}
      // Both sides travel in one payload, and the side the user did not touch is re-stated from the
      // record: the pair is one declaration, so clearing a field must not silently clear its neighbour,
      // and a blank field has to send no key rather than a zero the Overview would bill at.
      onRateChange={(side, next) =>
        setRates({
          providerId: id,
          input: side === 'input' ? next : config?.inputRate,
          output: side === 'output' ? next : config?.outputRate,
        })
      }
      enabledModels={enabled}
      models={fetched}
      modelsOpen={justFetched}
      onToggleModel={(modelId) => toggleModel({ providerId: id, modelId })}
      actions={
        <Button
          data-slot="provider-refresh"
          size="icon-sm"
          variant="ghost"
          aria-label={`Fetch ${name} models`}
          disabled={fetchModels.isPending}
          onClick={() => void onFetch()}
        >
          {fetchModels.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      }
    />
  )
}
