import { Cpu, Lock } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { AGENT_SAM_ENGINE_NAME, SAM_ENGINE_VALUE, type EngineRow } from '@/conveyor/protocol/engine'
import { engineStatusStore } from '@/conveyor/stores/engine-status'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select'

/**
 * Which engine a conversation runs as, beside the Buddy picker in the chat header.
 *
 * The list starts with the app's own loop and then every engine this build knows, each with what the last
 * probe found: an engine the machine has not got is drawn and disabled rather than hidden, because a row
 * that disappeared would be an engine the user cannot find and cannot be told about. The words for that are
 * the protocol's `ENGINE_NOT_INSTALLED_NOTE`, not a second sentence written here.
 *
 * Row labels are drawn rather than routed through `SelectValue`, for the reason the Buddy picker does the
 * same: a conversation whose engine is missing from this build still has an id, and the label rule answers
 * for it, which is what lets a conversation outlive the release that created it.
 *
 * The control is live only while the pane is home. What a conversation runs as is snapshotted onto its record
 * when it starts — the consent it was given and the adapter that speaks to it belong to that record — so a
 * switch inside one would leave the turns already run and the turns still to come running as two different
 * things. It is drawn rather than hidden, though: what a conversation runs as is the first thing a reader
 * wants to know, and the caption states why the control will not move instead of leaving a refusal to be read
 * as a fault.
 */
export function EnginePicker({
  atHome,
  engineId,
  pendingEngineId,
  lockCaption,
  onPick,
}: {
  atHome: boolean
  /** The open conversation's engine, or null for the Sam loop. Ignored while home. */
  engineId: string | null
  /** The choice made while there is no conversation yet, or null. */
  pendingEngineId: string | null
  /** Why the control will not move, printed by the pane that owns the words. */
  lockCaption: string
  onPick: (engineId: string | null) => void
}) {
  const probes = useConveyorStore(engineStatusStore, (s) => s.rows)
  // Every engine is drawn before main's first probe lands, as not installed. That is the honest state of a row
  // nobody has asked about yet, and it is also why the picker needs no spinner: the list is complete and says
  // only what is known, which is nothing until the read lands.
  const rows: EngineRow[] = probes ?? []

  const chosen = atHome ? pendingEngineId : engineId
  const row = rows.find((candidate) => candidate.id === chosen) ?? null
  const label = row?.name ?? chosen ?? AGENT_SAM_ENGINE_NAME
  // The version in the native title, where there is room for it and no cost when there is not: it is what a
  // user reads when a row has already answered "installed" and the next question is "which one".
  const liveCaption = row?.version == null ? label : `${label} ${row.version}`

  return (
    <Select
      value={chosen ?? SAM_ENGINE_VALUE}
      // The app's own row is stored as the absent id rather than as itself: the Sam loop is what a
      // conversation that names no engine runs, so picking it clears the choice instead of recording one.
      onValueChange={(picked) => onPick(picked === SAM_ENGINE_VALUE ? null : picked)}
      disabled={!atHome}
    >
      <SelectTrigger
        aria-label="Engine"
        // A native title rather than a tooltip, for the reason the Buddy picker beside it carries one: a
        // disabled control is not a pointer target, so a tooltip would mount on a hover it never receives.
        title={atHome ? liveCaption : lockCaption}
        className="max-w-36 min-w-0 shrink-7"
      >
        {/* Drawn rather than only explained, as the lock beside it is: a control that refuses without
            saying so reads as broken, and the caption above says the rest. */}
        {!atHome && <Lock aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
        <Cpu aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        {rows.map((candidate) => (
          <SelectItem
            key={candidate.id ?? SAM_ENGINE_VALUE}
            value={candidate.id ?? SAM_ENGINE_VALUE}
            // A row the probe could not find is offered and refused: what the user needs to know is that the
            // engine exists, that it is not here, and which of the two they are looking at.
            disabled={!candidate.installed}
          >
            <span data-slot="engine-name">
              {candidate.note === null || candidate.installed
                ? candidate.name
                : `${candidate.name} · ${candidate.note}`}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
