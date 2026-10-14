import { ENGINE_MODEL_MAX_LENGTH, engineTakesModel } from '@/conveyor/protocol/engine'
import { Input } from '../ui/input'
import { useWorkbenchStore } from './store'

/** The words this control is found by, by a reader and by a suite. */
export const ENGINE_MODEL_LABEL = 'Engine model'

/**
 * The model one engine runs under, in the chat header's model-picker slot.
 *
 * Drawn only once an engine is chosen, because a conversation running the app's own loop already has the
 * `provider::model` picker beside it: the two controls answer the same question about different things, and
 * exactly one of them is ever live. The existing picker keeps its behaviour and its meaning — it is refused while
 * an engine owns the conversation, which is unchanged — so this is drawn *beside* it rather than replacing it,
 * and a reader can see both the choice in force and the one that has been taken over.
 *
 * Drawn, too, only for an engine this app sets a model for — `engineTakesModel`, which is Codex alone, and that
 * is not a narrowing of taste: the value travels to the runner as `-m <id>`, so for an engine whose runner reads
 * no such field the control would collect a word nothing acted on while the turn quietly ran the engine's own
 * default. An engine that takes its model from a catalogue of its own is a selection this app has to read, which
 * is a later turn's question rather than a field this one can answer.
 *
 * A free-text combobox with nothing to open, because that is what Codex offers: an id and no catalogue. So the
 * field *is* the whole control, and the only thing this side can check is the length the protocol states. Whether
 * the id names a model the CLI knows is the CLI's own answer, and it surfaces as the engine's refusal on the turn
 * that used it — through the same path every other engine error travels, with no second vocabulary written here.
 *
 * An empty field is not an error but the ordinary state: it leaves the engine on its own default, and the runner
 * injects no flag for it — so a conversation that never named a model runs exactly as it did before this control
 * existed. That is why the placeholder says so rather than the field arriving with a value nobody chose.
 *
 * The value lives in the workbench store rather than in this component, because the send path reads the same
 * value at the moment the turn is started: one writer, one reader, and no draft that could disagree with the turn
 * already in flight.
 */
export function EngineModelPicker({ engineId }: { engineId: string | null }) {
  const engineModels = useWorkbenchStore((s) => s.engineModels)
  const setEngineModel = useWorkbenchStore((s) => s.setEngineModel)

  // Nothing at all until an engine this app sets a model for is chosen: there would be no engine for the value to
  // belong to, and the row would carry a second control for a question nothing is asking.
  if (!engineTakesModel(engineId)) return null

  return (
    <Input
      // A combobox by role rather than a textbox, because that is what it is: the field is the control's whole
      // surface, and the list one would open is empty — the engine publishes nothing to fill it with.
      role="combobox"
      aria-expanded={false}
      aria-label={ENGINE_MODEL_LABEL}
      maxLength={ENGINE_MODEL_MAX_LENGTH}
      autoComplete="off"
      spellCheck={false}
      value={engineModels[engineId] ?? ''}
      placeholder="Engine default"
      // A native title rather than a tooltip, for the reason the pickers around it carry one: the header row has
      // no pointer target to hang a tooltip on that a caption would not serve better.
      title="The model this engine runs. An empty field leaves it on the engine's own default."
      onChange={(event) => setEngineModel(engineId, event.target.value)}
      // Sized and painted to sit in the same row as the pickers beside it, in the monospace a model id is read
      // in — an id is a token, not prose.
      className="h-6 w-32 min-w-0 shrink-7 px-1.5 py-0 font-mono text-[11px]"
    />
  )
}
