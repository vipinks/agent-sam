import { useState } from 'react'
import { useConveyorStore } from 'electron-conveyor/react'
import { terminalPreferencesStore } from '@/conveyor/stores/terminal-preferences'
import {
  checkFontSize,
  checkScrollbackLines,
  type TerminalPreferenceCheck,
} from '@/conveyor/protocol/terminal-preferences'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { terminalHost } from './terminal-host'

/**
 * The Terminal section: the two preferences that shape the shell in the right rail.
 *
 * Here rather than in the pane, and that is a placement decision rather than a convenience. The pane is
 * the quick surface — the thing you keep docked beside the code, where a stray control costs a command
 * line's width and a stray click costs keystrokes. These two are set once and then belong to every
 * folder, so they live with the other advanced preferences, one rail click away.
 *
 * Both values are the store's, not this component's: `terminalPreferences` is main's, persisted under
 * the app's own data directory and mirrored to every window, so the scrollback limit reaches the
 * process that bounds a session's transcript and the font size reaches the host that owns the drawn
 * terminal. What this component owns is only the field's *draft* — the string being typed — because a
 * half-typed number is not a value.
 *
 * The field rules come from `protocol/terminal-preferences`, which is the same declaration the store
 * validates a dispatch against. A number that is out of range is therefore refused twice, in the two
 * places it can be refused: here, in words under the field, and in main, before any action runs.
 */
export function TerminalSection() {
  const scrollbackLines = useConveyorStore(terminalPreferencesStore, (s) => s.scrollbackLines)
  const fontSize = useConveyorStore(terminalPreferencesStore, (s) => s.fontSize)
  const { setScrollbackLines, setFontSize } = useConveyorStore(terminalPreferencesStore)

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Terminal</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          The shell you dock beside your work. Both values are kept on this machine and apply to every folder.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <PreferenceField
          id="terminal-scrollback"
          label="Scrollback limit"
          unit="lines"
          value={scrollbackLines}
          hint="How many lines of a shell's output are kept for a pane that comes back to it. A shell that is already open keeps the limit it started with; the next one uses this."
          check={checkScrollbackLines}
          onCommit={(lines) => setScrollbackLines({ lines })}
        />

        <PreferenceField
          id="terminal-font-size"
          label="Font size"
          unit="pixels"
          value={fontSize}
          hint="How large the terminal draws its text. Applied to the terminal as you change it."
          check={checkFontSize}
          onCommit={(pixels) => {
            setFontSize({ pixels })
            // The pane that would otherwise apply this is not on screen — Settings takes the whole main
            // area — and the terminal it draws into outlives it. So the retained instance is re-painted
            // here, which is the only moment the change can be seen: the pane is the *other* writer, and
            // it applies the stored value when it mounts.
            terminalHost().setFontSize(pixels)
          }}
        />
      </div>
    </>
  )
}

/**
 * One bounded number, with the words that explain a refusal under it.
 *
 * The draft is local state and the value is the store's, and the two are deliberately not the same
 * thing: `1` is on the way to `1500`, so a field that only ever showed the stored value could not be
 * typed into. What the draft is checked against is the same rule main enforces, and a draft that fails
 * it dispatches nothing at all — so the failure mode is a sentence under the field rather than a value
 * the app has to walk back.
 */
function PreferenceField({
  id,
  label,
  unit,
  value,
  hint,
  check,
  onCommit,
}: {
  id: string
  label: string
  unit: string
  value: number
  hint: string
  check: (raw: string) => TerminalPreferenceCheck
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)

  const onChange = (next: string) => {
    setDraft(next)

    const checked = check(next)
    if (!checked.ok) {
      setError(checked.message)
      return
    }

    setError(null)
    onCommit(checked.value)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-slot={`${id}-field`}
          className="max-w-32"
          // A text field with a numeric keyboard rather than `type="number"`: the browser's own number
          // input swallows letters silently, and this field's words are what should say a letter is not a
          // number — the same sentence the rule produces for main.
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          value={draft}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="text-[12.5px] text-muted-foreground">{unit}</span>
      </div>

      {error === null ? (
        <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : (
        <p role="alert" data-slot={`${id}-error`} className="text-[11.5px] leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
