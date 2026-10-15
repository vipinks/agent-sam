import { useId, useState } from 'react'
import { useConveyorStore } from 'electron-conveyor/react'
import { ENGINE_MODEL_MAX_LENGTH, engineTakesModel } from '@/conveyor/protocol/engine'
import { engineModelsStore } from '@/conveyor/stores/engine-models'
import { Input } from '../ui/input'
import { useWorkbenchStore } from './store'

/** The words this control is found by, by a reader and by a suite. */
export const ENGINE_MODEL_LABEL = 'Engine model'

/**
 * How many matches the open list draws.
 *
 * A bound rather than the whole catalogue, and it is not a hedge: OpenCode advertises several hundred models, and
 * a list that drew every one of them on each keystroke would be a control that cost more the better the engine's
 * catalogue is. The search is what narrows it — the field is a search over the advertised ids — so a bound the
 * typing reaches within a few characters is a bound a user never meets.
 */
const MATCH_LIMIT = 50

/**
 * The model one engine runs under, in the chat header's model-picker slot.
 *
 * Drawn only once an engine is chosen, because a conversation running the app's own loop already has the
 * `provider::model` picker beside it: the two controls answer the same question about different things, and
 * exactly one of them is ever live. The existing picker keeps its behaviour and its meaning — it is refused while
 * an engine owns the conversation, which is unchanged — so this is drawn *beside* it rather than replacing it,
 * and a reader can see both the choice in force and the one that has been taken over.
 *
 * Drawn, too, only for an engine that advertises a model catalogue — `engineTakesModel`. That is the rule rather
 * than an accident: a field is a choice only where there is a source of ids to choose from, and an engine that
 * publishes no catalogue resolves its own model — the value of a field here would be a word nothing judged and no
 * runner read, while the turn quietly ran that engine's default.
 *
 * For the engine that does answer with a list, the field *is* the search over it: typing filters the advertised
 * ids, the matches are offered beneath, and picking one records it as this engine's model. The list is the
 * engine's own advertisement, read off `session/new` and published as state by the turn that observed it, so the
 * ids offered here are the ids the runner judges a choice against — one list, read once.
 *
 * The catalogue arrives with the first turn under that engine, because that is where the session is opened; until
 * then the entry is absent and the field is drawn with nothing to open, which is the honest state rather than a
 * list of guesses. The session's own `currentModelId` is deliberately *not* folded into the list: it is what the
 * session is running rather than something the engine offered, and the runner already treats it as a valid choice
 * whether or not the catalogue names it.
 *
 * The value lives in the workbench store rather than in this component, because the send path reads the same
 * value at the moment the turn is started: one writer, one reader, and no draft that could disagree with the turn
 * already in flight. An empty field is not an error but the ordinary state: it names no model, so the engine keeps
 * its own.
 */
export function EngineModelPicker({ engineId }: { engineId: string | null }) {
  const engineModels = useWorkbenchStore((s) => s.engineModels)
  const setEngineModel = useWorkbenchStore((s) => s.setEngineModel)
  const catalogues = useConveyorStore(engineModelsStore, (s) => s.catalogues)
  const [open, setOpen] = useState(false)
  const listId = useId()

  // Nothing at all for an engine that advertises no catalogue: there would be no ids to choose between, and the
  // row would carry a control asking a question nothing can answer.
  if (!engineTakesModel(engineId)) return null

  const value = engineModels[engineId] ?? ''
  const ids = catalogues?.[engineId]?.ids ?? []
  const needle = value.trim().toLowerCase()
  const matches = (needle === '' ? ids : ids.filter((id) => id.toLowerCase().includes(needle))).slice(0, MATCH_LIMIT)
  const showing = open && matches.length > 0

  const pick = (id: string): void => {
    setEngineModel(engineId, id)
    setOpen(false)
  }

  return (
    <div className="relative flex min-w-0 shrink-7 items-center">
      <Input
        // A combobox by role rather than a textbox, because that is what it comes from: the field is the surface a
        // catalogue is searched by, and the list it opens is that engine's own. `aria-expanded` and the list's id
        // are stated so the relationship is a fact of the markup rather than a convention of this layout.
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ENGINE_MODEL_LABEL}
        maxLength={ENGINE_MODEL_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="Engine default"
        // A native title rather than a tooltip, for the reason the pickers around it carry one: the header row has
        // no pointer target to hang a tooltip on that a caption would not serve better.
        title="The model this engine runs. Type to search the models it advertises, or leave it empty for the engine's own default."
        onFocus={() => setOpen(true)}
        // Focus leaving the row closes the list. Picking is done on `mousedown`-prevented options, so a click never
        // reaches this path — which is what keeps a click landing on the option it was aimed at rather than
        // dismissing the list out from under it.
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setEngineModel(engineId, event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          // The keyboard path to the same pick a click makes: the first match, which is the model whose id starts
          // closest to what was typed.
          if (event.key === 'Enter' && showing) pick(matches[0])
        }}
        // Sized and painted to sit in the same row as the pickers beside it, in the monospace a model id is read
        // in — an id is a token, not prose.
        className="h-6 w-32 min-w-0 px-1.5 py-0 font-mono text-[11px]"
      />

      {showing && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Advertised models"
          // Absolutely placed over the row rather than pushing it: the header's height belongs to the pickers in
          // it, and a list that moved them when it opened would move the field a user is typing into.
          className="absolute top-7 left-0 z-50 max-h-56 w-56 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {matches.map((id) => (
            <li
              key={id}
              role="option"
              aria-selected={id === value}
              // The pick runs on click, and the mousedown is prevented so the field keeps focus until it does:
              // letting the press move focus would fire the field's blur, which would close the list before the
              // click it belongs to could arrive.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(id)}
              className="cursor-pointer truncate rounded-sm px-1.5 py-1 font-mono text-[11px] hover:bg-accent hover:text-accent-foreground"
            >
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
