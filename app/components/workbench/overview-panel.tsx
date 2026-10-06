import { ChartColumn } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { overviewTiles, resolveRates } from '@/conveyor/protocol/session-usage'
import { useChatSessionsContext } from './chat-sessions-context'
import { ContextWindowCard } from './context-window-card'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'

/**
 * The Overview resident: what the conversation on screen has spent, in four tiles, and what its next
 * request is about to spend, in the context card beneath them.
 *
 * A reader's surface rather than a settings one, which is why it is docked beside the chat and why it
 * is deliberately four numbers: the question "what has this cost me" is asked while reading an answer,
 * and a surface that answered it with a table would be a second thing to interpret. The declared prices
 * that decide the Cost tile's arithmetic are a preference about a model and live in Settings, in the
 * model's own row — beside the switch that puts that model in the chat picker.
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
 *
 * The one thing this file adds to that read is the conversation's `engineId`, forwarded as the record
 * carries it: a conversation an engine ran has no price this build can compute, and the rule that
 * withholds the figure has to be told which loop ran the turn rather than left to infer it from a
 * provider name.
 */
export function OverviewPanel() {
  const { atHome, transcript } = useChatSessionsContext()
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)

  const session = sessions.find((s) => s.id === activeSessionId)
  // The declared prices, by the model the conversation is running on. Read as the store's own map rather
  // than as a triple, so the selector's answer is the store's own object: a fresh object on every render
  // would re-render this panel on every unrelated broadcast.
  const declaration = useConveyorStore(providerConfigStore, (s) =>
    session === undefined ? undefined : s.providers[session.providerId]?.modelRates
  )
  // Main's mirror is the source of truth for the numbers; this is only reading it. A session the store
  // has not broadcast yet — the round trip after a send creates one — reads as nothing measured yet,
  // which is exactly what it is.
  const usage = session?.usage
  // The engine this conversation runs, absent for the Sam loop — the same field the row label and the
  // transcript header read, passed through so the Cost tile can tell an engine's tokens from this
  // build's own.
  const engineId = session?.engineId
  const rates = session === undefined ? null : resolveRates({ model: session.model, modelRates: declaration })

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
          <>
            <OverviewTileRow usage={usage} rates={rates} turns={turns} engineId={engineId} />
            {/* Beneath the tiles rather than in Settings: the quick surface answers "what is this
                conversation about to cost me", and the card is the elaboration of the same question.
                The percent it is measured against is the preference, and that one is in Settings. */}
            <ContextWindowCard />
          </>
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
  engineId,
}: {
  usage: { prompt: number; completion: number; cached?: number } | undefined
  rates: { input: number; cacheHit: number; output: number } | null
  turns: number
  engineId: string | undefined
}) {
  const tiles = overviewTiles({ usage, rates, turns, engineId })

  return (
    <div data-slot="overview-tiles" className="grid grid-cols-2 gap-2">
      <Tile id="tokens" label="Tokens" value={tiles.tokens} note="prompt and completion, this session" />
      <Tile id="cost" label="Cost" value={tiles.cost} note={tiles.costNote} />
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
 * as they change, which matters most while they are changing on their own during a run. The caption
 * carries a slot of its own for the same reason the value does: it is the text a test has to read, and
 * it is where the tile says in words what a withheld figure means.
 */
function Tile({ id, label, value, note }: { id: string; label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <p data-slot={`overview-${id}`} className="mt-1 text-[19px] leading-tight font-semibold tabular-nums">
        {value}
      </p>
      <p data-slot={`overview-${id}-note`} className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
        {note}
      </p>
    </div>
  )
}
