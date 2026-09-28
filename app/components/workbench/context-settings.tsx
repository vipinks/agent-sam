import { useState } from 'react'
import { useConveyorStore } from 'electron-conveyor/react'
import { contextPreferencesStore } from '@/conveyor/stores/context-preferences'
import { checkCompactPoint, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT } from '@/conveyor/protocol/context-window'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * The Context section: the share of a model's window this app calls the compact point.
 *
 * Here rather than on the card, and that is the placement decision rather than a convenience. The
 * Overview card is the quick surface kept docked beside an answer, and a number that is set once and
 * kept belongs with the other advanced preferences, one rail click away. The card reads this value;
 * nothing on the card writes it.
 *
 * One field, because there is one preference. The value is the store's — `contextPreferences`, which is
 * main's, persisted under the app's own data directory and mirrored to every window, so the rule that
 * measures a request against a window reads the same percent this field shows. What this component owns
 * is only the field's *draft*: the string being typed, which is not a value, and `null` until someone
 * types one.
 *
 * A null draft rather than a copy of the value taken at mount, deliberately: the mirror lands a tick
 * after the window opens, and a field holding whatever it saw first would sit showing a stale percent
 * beside a store that had already changed. Until an edit, the field draws the store.
 *
 * The rule the draft is checked against is `protocol/context-window`'s, the same declaration main
 * validates a dispatch against, so an out-of-range percent is refused twice, in the two places it can
 * be: here, in words under the field, and in main, before any action runs.
 */
export function ContextSection() {
  const compactPoint = useConveyorStore(contextPreferencesStore, (s) => s.compactPoint)
  const { setCompactPoint } = useConveyorStore(contextPreferencesStore)

  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onChange = (next: string) => {
    setDraft(next)

    const checked = checkCompactPoint(next)
    if (!checked.ok) {
      setError(checked.message)
      return
    }

    setError(null)
    setCompactPoint({ percent: checked.value })
  }

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Context</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          How full a conversation is allowed to get before the Overview calls it past its compact point. Sam AI does not
          compact yet, so the point marks where starting a new session is the cheaper move.
        </p>
      </header>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="context-compact-point">Compact point</Label>
        <div className="flex items-center gap-2">
          <Input
            id="context-compact-point"
            data-slot="context-compact-point-field"
            className="max-w-32"
            // A text field with a numeric keyboard rather than `type="number"`: the browser's own number
            // input swallows letters silently, and this field's words are what should say a letter is not
            // a percent — the same sentence the rule produces for main.
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null}
            value={draft ?? String(compactPoint)}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="text-[12.5px] text-muted-foreground">percent of the window</span>
        </div>

        {error === null ? (
          <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">
            The Overview measures the conversation against this share of its model&rsquo;s window. Between{' '}
            {MIN_COMPACT_PERCENT} and {MAX_COMPACT_PERCENT} percent.
          </p>
        ) : (
          <p
            role="alert"
            data-slot="context-compact-point-error"
            className="text-[11.5px] leading-relaxed text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </>
  )
}
