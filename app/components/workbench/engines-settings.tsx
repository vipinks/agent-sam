import { useState } from 'react'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { enginePreferencesStore } from '@/conveyor/stores/engine-preferences'
import { engineStatusStore } from '@/conveyor/stores/engine-status'
import {
  ENGINE_AUTH_HINTS,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_NOT_INSTALLED_NOTE,
  ENGINE_PERMISSION_MODE_IDS,
  ENGINE_PERMISSION_MODE_LABELS,
  ENGINE_PERMISSION_MODE_WARNINGS,
  enginePathRefusalWord,
  enginePermissionMode,
  isEnginePermissionMode,
  type EngineRow,
} from '@/conveyor/protocol/engine'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/**
 * The Engines section: one row per engine, with its detected version, how it is signed in to, where its
 * binary is, and what it is allowed to do.
 *
 * Here rather than in the picker, and the placement is the same decision the Terminal's two values are: the
 * picker is the quick surface — the thing in the chat header you switch between turns — while these four
 * facts are set once and then belong to the machine. One of them, the permission mode, is a grant rather
 * than a convenience, so it is drawn where a user has to come looking for it rather than beside the composer.
 *
 * Both stored values are the *store's*, not this component's. `enginePreferences` is main's, persisted under
 * the app's own data directory and mirrored to every window, so the path the probe resolves and the mode a
 * turn is started under are the ones set here. What this component owns is only the field's draft — the
 * string being typed — because a half-typed path is not a value, and it is exactly the string a probe would
 * otherwise be asked to run.
 *
 * The detected version is read from `engine-status`, which is main's probe's answer and the *same* rows the
 * picker draws: a section that probed for itself would be a second detection path for one fact, and could
 * disagree with the picker about the engine in front of the user. Nothing here starts anything.
 *
 * A path is saved through the module's command rather than by writing the store, and that is the design: the
 * save *is* the re-probe, so the store only ever holds a path something has executed. A refusal arrives as a
 * `ConveyorError` and is drawn from its code — never from its message — which is what lets the section say
 * which of the ways it failed and leave the last good value where it was.
 */
export function EnginesSection() {
  const rows = useConveyorStore(engineStatusStore, (s) => s.rows) ?? []

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Engines</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          The command-line engines this app can run a conversation with. Each is started by this app on your machine,
          with the settings kept here.
        </p>
      </header>

      <div className="flex flex-col gap-2.5">
        {ENGINE_IDS.map((id) => (
          <EngineRowCard key={id} engineId={id} row={rows.find((candidate) => candidate.id === id) ?? null} />
        ))}
      </div>
    </>
  )
}

/**
 * One engine, as a box.
 *
 * The box is per engine rather than per section because every control in it is per engine: two engines may
 * have two binaries in two places and two different grants, and a shared control would be a control that
 * turned one engine's grant into the other's.
 */
function EngineRowCard({ engineId, row }: { engineId: string; row: EngineRow | null }) {
  const preference = useConveyorStore(enginePreferencesStore, (s) => s.engines[engineId])
  const { setPermissionMode } = useConveyorStore(enginePreferencesStore)
  const setBinaryPath = conveyor.engine.setBinaryPath.useMutation()

  // The draft, and the refusal it produced. Both are this component's, because both belong to the moment —
  // what is in the field while it is being typed, and what the last save said about it.
  const [draft, setDraft] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const stored = typeof preference?.binaryPath === 'string' ? preference.binaryPath : ''
  // The field shows the stored path until it is touched, then whatever is being typed: a value that snapped
  // back on every keystroke would be a field nobody can type into, and one that showed a draft as if it were
  // saved would be a field that lied about which binary a turn would run.
  const value = draft ?? stored
  const mode = enginePermissionMode(preference?.permissionMode, engineId)
  const warning = ENGINE_PERMISSION_MODE_WARNINGS[mode]

  const save = async (path: string) => {
    setRefusal(null)
    try {
      await setBinaryPath.mutateAsync({ engineId, path })
      // The stored path is the field's again: the save has been probed, so what is shown is what a turn will
      // run.
      setDraft(null)
    } catch (error: unknown) {
      // Branched on the code, and worded by the protocol's table for that code. The last good value is left
      // in the store — this writes nothing — so the field falls back to it rather than to the refused draft,
      // which is what makes a bad save cost the user nothing but the sentence.
      setDraft(null)
      setRefusal(error instanceof ConveyorError ? enginePathRefusalWord(error.code) : 'That path was not saved.')
    }
  }

  return (
    <section
      data-slot="engine-row"
      className="rounded-lg border border-border bg-card/40 px-3.5 py-3"
      aria-label={ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS]}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 data-slot="engine-name" className="text-[13px] font-medium">
          {ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS]}
        </h2>
        {/* What the probe answered, or the not-installed note: the same rows the chat header's picker reads. */}
        <span data-slot="engine-status" className="text-[12.5px] tabular-nums text-muted-foreground">
          {row?.installed === true && row.version !== null ? row.version : ENGINE_NOT_INSTALLED_NOTE}
        </span>
      </div>

      <p data-slot="engine-auth-hint" className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        {ENGINE_AUTH_HINTS[engineId as keyof typeof ENGINE_AUTH_HINTS]}
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        <Label
          htmlFor={`engine-path-${engineId}`}
        >{`${ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS]} binary path`}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`engine-path-${engineId}`}
            value={value}
            spellCheck={false}
            placeholder="On PATH"
            onChange={(event) => {
              setDraft(event.target.value)
              setRefusal(null)
            }}
            className="text-[12.5px]"
          />
          <Button
            size="sm"
            variant="outline"
            // Named for the engine it saves: two rows draw the same control, and an unqualified "Save" would
            // be a name that reads the same in both.
            aria-label={`${ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS]} save binary path`}
            disabled={setBinaryPath.isPending}
            onClick={() => void save(value)}
          >
            Save
          </Button>
        </div>
        {/* The refusal, worded from the code. A path that failed is the one thing here a user has to act on. */}
        {refusal !== null && (
          <p data-slot="engine-path-refusal" role="alert" className="text-[12.5px] text-destructive">
            {refusal}
          </p>
        )}
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Leave this empty to use the engine on your <code className="text-[12px]">PATH</code>. A path is only saved
          once it has been run and answered with its version.
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        <Label
          htmlFor={`engine-mode-${engineId}`}
        >{`${ENGINE_LABELS[engineId as keyof typeof ENGINE_LABELS]} permission mode`}</Label>
        <Select
          value={mode}
          onValueChange={(next) => {
            // A string from the primitive, narrowed by the protocol's guard rather than cast: the schema in
            // main would refuse anything else, and refusing it here means no dispatch is made at all.
            if (isEnginePermissionMode(next)) setPermissionMode({ engineId, mode: next })
          }}
        >
          <SelectTrigger id={`engine-mode-${engineId}`} data-slot="engine-mode" className="h-8 text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENGINE_PERMISSION_MODE_IDS.map((id) => (
              <SelectItem key={id} value={id} className="text-[12.5px]">
                {ENGINE_PERMISSION_MODE_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Never silently: the mode that grants more than the default says what it grants, in the protocol's
            own words for it. The other two say nothing, which is what makes these words read. */}
        {warning !== null && (
          <p data-slot="engine-mode-warning" className="text-[12.5px] leading-relaxed text-destructive">
            {warning}
          </p>
        )}
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          What the engine is allowed to do with your machine. It is handed to the engine as its sandbox when a turn
          starts, so the next turn runs under this choice.
        </p>
      </div>
    </section>
  )
}
