import { useConveyorStore } from 'electron-conveyor/react'
import { appearancePreferencesStore } from '@/conveyor/stores/appearance-preferences'
import {
  BUBBLE_ALIGNMENTS,
  BUBBLE_ALIGNMENT_LABELS,
  checkAppearance,
  FONT_PRESET_IDS,
  FONT_PRESETS,
} from '@/conveyor/protocol/appearance'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/**
 * The Appearance section: how a conversation is drawn — which side the user's own bubbles sit on, and how
 * large the message text is painted.
 *
 * Here rather than on the pane, and that is the placement decision rather than a convenience. The two are
 * set once and then belong to every conversation: a control in the transcript would be a control that
 * scrolled away, and one that asked which conversation it applied to would be a question the preference
 * does not have. Both values apply to both themes, which is why nothing here reads the theme.
 *
 * Both values are the store's, not this component's: `appearancePreferences` is main's, persisted under
 * the app's own data directory and mirrored to every window, so the pane that draws a turn and the field
 * that sets it read one value. The component keeps no local draft, unlike the two bounded number fields
 * elsewhere in Settings: a choice from a list is a value the moment it is made, and there is nothing
 * half-typed to hold.
 *
 * A `Select` rather than the section row's tabs, because these are values rather than panes: the two
 * controls are the same primitive the Buddies editor draws its provider and model with, one field apart.
 * Radix hands its value back as a string, and it is narrowed through `checkAppearance` — the pair's own
 * rule, the one main's schemas mirror — rather than cast, so the two controls and the boundary a payload
 * crosses agree about what an alignment and a preset are.
 */
export function AppearanceSection() {
  const alignment = useConveyorStore(appearancePreferencesStore, (s) => s.alignment)
  const fontPreset = useConveyorStore(appearancePreferencesStore, (s) => s.fontPreset)
  const { setAlignment, setFontPreset } = useConveyorStore(appearancePreferencesStore)

  // Each control is checked as the pair it is half of, with the other half read from the store, so the
  // rule sees the state the app would hold rather than one field on its own. A refusal cannot arrive from
  // an option this control offers; the check is here so that a value the rule would refuse is dropped
  // rather than stored, and so the union arrives narrowed instead of asserted.
  const chooseAlignment = (next: string) => {
    const checked = checkAppearance({ alignment: next, fontPreset })
    if (!checked.ok) return
    setAlignment({ alignment: checked.alignment })
  }

  const chooseFontPreset = (next: string) => {
    const checked = checkAppearance({ alignment, fontPreset: next })
    if (!checked.ok) return
    setFontPreset({ preset: checked.fontPreset })
  }

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Appearance</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          How a conversation is drawn. Both choices cover every conversation and both themes, and are kept on this
          machine.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="appearance-alignment">Bubble alignment</Label>
          <Select value={alignment} onValueChange={chooseAlignment}>
            <SelectTrigger
              id="appearance-alignment"
              data-slot="appearance-alignment"
              aria-label="Bubble alignment"
              className="h-8 w-56 text-[12.5px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUBBLE_ALIGNMENTS.map((id) => (
                <SelectItem key={id} value={id} className="text-[12.5px]">
                  {BUBBLE_ALIGNMENT_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">
            Split keeps your messages on the right and Sam&rsquo;s on the left. Same side puts both on the left, one
            under the other.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="appearance-font-size">Chat font size</Label>
          <Select value={fontPreset} onValueChange={chooseFontPreset}>
            <SelectTrigger
              id="appearance-font-size"
              data-slot="appearance-font-size"
              aria-label="Chat font size"
              className="h-8 w-56 text-[12.5px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* The pixel size travels with the name: four sizes otherwise read as four adjectives, and the
                  whole point of the control is that the reader can tell 15 from 17 without trying both. */}
              {FONT_PRESET_IDS.map((id) => (
                <SelectItem key={id} value={id} className="text-[12.5px]">
                  {FONT_PRESETS[id].label} · {FONT_PRESETS[id].pixels}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">
            The size every message is drawn at, in both themes. Default is the 13px Agent Sam has always used.
          </p>
        </div>
      </div>
    </>
  )
}
