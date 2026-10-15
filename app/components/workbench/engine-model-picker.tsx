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
 * Drawn, too, only for an engine that advertises a model catalogue — `engineTakesModel`, whose set is empty, so this
 * draws nowhere today. That is the rule rather than an accident: a field is a choice only where there is a source of
 * ids to choose from, and an engine that publishes no catalogue resolves its own model — the value of a field here
 * would be a word nothing judged and no runner read, while the turn quietly ran that engine's default. The control
 * keeps its place in the row for the engine that does answer with a list: the field then becomes the search over it,
 * which is a change to this component rather than a second control beside it.
 *
 * A free-text combobox with nothing to open, which is the shape a catalogue is read in until there is a catalogue.
 * An empty field is not an error but the ordinary state: it names no model, so the engine keeps its own — and that
 * is what every turn does today, since nothing draws this field. That is why the placeholder says so rather than
 * the field arriving with a value nobody chose.
 *
 * The value lives in the workbench store rather than in this component, because the send path reads the same
 * value at the moment the turn is started: one writer, one reader, and no draft that could disagree with the turn
 * already in flight.
 */
export function EngineModelPicker({ engineId }: { engineId: string | null }) {
  const engineModels = useWorkbenchStore((s) => s.engineModels)
  const setEngineModel = useWorkbenchStore((s) => s.setEngineModel)

  // Nothing at all for an engine that advertises no catalogue, which is every engine today: there would be no ids
  // to choose between, and the row would carry a control asking a question nothing can answer.
  if (!engineTakesModel(engineId)) return null

  return (
    <Input
      // A combobox by role rather than a textbox, because that is what it comes from: the field is the surface a
      // catalogue is searched by, and the list it opens is that engine's own.
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
