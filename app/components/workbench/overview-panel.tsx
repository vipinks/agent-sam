import { ChartColumn } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { declaredRates, overviewTiles, resolveRates } from '@/conveyor/protocol/session-usage'
import { useChatSessionsContext } from './chat-sessions-context'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'

/**
 * The Overview resident: what the conversation on screen has spent, in four tiles.
 *
 * A reader's surface rather than a settings one, which is why it is docked beside the chat and why it
 * is deliberately four numbers: the question "what has this cost me" is asked while reading an answer,
 * and a surface that answered it with a table would be a second thing to interpret. The rate overrides
 * that decide the Cost tile's arithmetic are a provider preference and live in Settings, where the
 * provider they belong to is configured.
 *
 * The panel owns no numbers. Everything drawn here is read: the running total off the session store
 * main keeps, the prices off the provider-config store, the reply count off the transcript on screen.
 * That is what makes the live case work without a reload — the streamed usage frame is recorded into
 * the store, the mirror broadcasts, and this panel re-reads between the frames the user is watching.
 *
 * Three of the four tiles are measurements, and the display rule for what they say when there is no
 * measurement is `overviewTiles`'s rather than this file's: an em dash is not a decorative zero, it is
 * the statement that nothing has been measured yet. See that function for why each boundary falls
 * where it does; all this file decides is where the strings sit.
 */
export function OverviewPanel() {
  const { atHome, transcript } = useChatSessionsContext()
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)

  const session = sessions.find((s) => s.id === activeSessionId)
  // The declared prices, by the provider the conversation is running against. Read as the record rather
  // than as a pair of numbers, so the selector's answer is the store's own object: a fresh object on
  // every render would re-render this panel on every unrelated broadcast.
  const declaration = useConveyorStore(providerConfigStore, (s) =>
    session === undefined ? undefined : s.providers[session.providerId]
  )
  // Main's mirror is the source of truth for the numbers; this is only reading it. A session the store
  // has not broadcast yet — the round trip after a send creates one — reads as nothing measured yet,
  // which is exactly what it is.
  const usage = session?.usage
  const rates =
    session === undefined ? null : resolveRates({ model: session.model, override: declaredRates(declaration) })

  // The replies the transcript holds. Not the number of turns in the running stream: this is "how much
  // conversation is here", so it counts what is on screen, whether it arrived from disk or from the
  // frames just watched.
  const turns = transcript.turns.filter((turn) => turn.role === 'assistant').length

  return (
    <div data-slot="overview-panel" className="flex h-full flex-col bg-background">
      <PaneHeader icon={ChartColumn} title="Overview">
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {atHome ? (
          /*
           * Nothing is open, so there is nothing to report. One sentence, and no tiles: a row of four
           * zeros would be the app claiming it had measured a conversation that does not exist, which is
           * the same lie the em dashes exist to avoid — told louder.
           */
          <p data-slot="overview-empty" className="text-[12.5px] leading-relaxed text-muted-foreground">
            Open a conversation to see what it has spent.
          </p>
        ) : (
          <OverviewTileRow usage={usage} rates={rates} turns={turns} />
        )}
      </div>
    </div>
  )
}

/** The four tiles, as the rules above derive them. Split out so the panel's own body stays readable. */
function OverviewTileRow({
  usage,
  rates,
  turns,
}: {
  usage: { prompt: number; completion: number; cached?: number } | undefined
  rates: { input: number; output: number } | null
  turns: number
}) {
  const tiles = overviewTiles({ usage, rates, turns })

  return (
    <div data-slot="overview-tiles" className="grid grid-cols-2 gap-2">
      <Tile id="tokens" label="Tokens" value={tiles.tokens} note="prompt and completion, this session" />
      <Tile id="cost" label="Cost" value={tiles.cost} note="at the rates this provider is priced with" />
      <Tile id="cache" label="Cache" value={tiles.cache} note="of the prompt, served from cache" />
      <Tile id="turns" label="Turns" value={tiles.turns} note="replies in this conversation" />
    </div>
  )
}

/**
 * One tile.
 *
 * The value carries the slot rather than the card, because the number is what a reader of this panel is
 * looking for and what a test can state exactly. `tabular-nums` so the four values do not shift sideways
 * as they change, which matters most while they are changing on their own during a run.
 */
function Tile({ id, label, value, note }: { id: string; label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <p data-slot={`overview-${id}`} className="mt-1 text-[19px] leading-tight font-semibold tabular-nums">
        {value}
      </p>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  )
}
