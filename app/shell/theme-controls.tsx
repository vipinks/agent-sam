import { useState, type CSSProperties } from 'react'
import { Check, Contrast, Palette, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Slider } from '../components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { BRIGHTNESS_DEFAULT, BRIGHTNESS_MAX, BRIGHTNESS_MIN } from '../components/workbench/theme-engine'
import { THEMES, themeById, type Theme, type ThemeMode } from '../components/workbench/themes'
import { useWorkbenchStore } from '../components/workbench/store'
import { ControlButton } from './control-button'
import { useThemeStore } from './theme-store'

/**
 * The theme chooser and the brightness control: two titlebar buttons over the engine's own store.
 *
 * Neither of them resolves a colour. They write `themeId` and `brightness` to the workbench store and
 * close; `useThemeApplication` — mounted once by the workbench — is what turns that into the document's
 * variables. That is the whole reason syntax highlighting, markdown tables and the spreadsheet grid
 * follow a theme switch without any of them knowing a theme exists: they read the same custom
 * properties, and the properties are re-resolved from these two values.
 *
 * Mode is not touched here either. The light/dark toggle beside these controls still owns the `.dark`
 * class and remains the only thing that decides the mode; a theme chosen here is chosen for whichever
 * mode the window is in, and a flip afterwards re-resolves with this theme and this brightness.
 *
 * The popover is the app's existing `ui/popover` (Radix, already a dependency), and the slider is the
 * app's `ui/slider` over the same package — no new dependency for the slider, and no `.css` file.
 */

/** How far one arrow key moves the slider: one point of lightness, on a forty-one point range. */
const BRIGHTNESS_STEP = 1

/** The brightness as a number a person reads: signed, because the sign is the direction it moved. */
function brightnessLabel(brightness: number): string {
  if (brightness === 0) return '0'
  return brightness > 0 ? `+${brightness}` : `${brightness}`
}

/**
 * The brightness as a sentence, for the slider's `aria-valuetext`.
 *
 * A screen reader announces `aria-valuenow` as a bare number out of a range, which for this control
 * says nothing: "8" of "-20 to 20" is not a brightness. The direction and the unit are the value.
 */
function brightnessValueText(brightness: number): string {
  if (brightness === 0) return "0 points, the theme's own brightness"
  const points = Math.abs(brightness)
  return `${points} ${points === 1 ? 'point' : 'points'} ${brightness > 0 ? 'lighter' : 'darker'}`
}

/**
 * A theme's two tones for the mode the window is in: the page it paints, and the colour it accents with.
 *
 * The values travel as custom properties on the swatch and are read by ordinary Tailwind
 * arbitrary-value utilities, because a class name cannot be built from a runtime string — and these
 * values *are* runtime data, the colours a registry hands over. A theme is not a stylesheet here; it is
 * a record, so what the swatch carries is the record's own values rather than a second copy of them.
 */
function ThemeSwatch({ theme, mode }: { theme: Theme; mode: ThemeMode }) {
  return (
    <span
      data-slot="theme-swatch"
      aria-hidden="true"
      style={{ '--swatch-surface': theme.swatch[mode] } as CSSProperties}
      className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border bg-(--swatch-surface)"
    >
      <span
        data-slot="theme-swatch-primary"
        style={{ '--swatch-accent': theme.tokens[mode].primary } as CSSProperties}
        className="size-1.5 rounded-full bg-(--swatch-accent)"
      />
    </span>
  )
}

/**
 * The chooser: one row per theme in the registry, with the theme's own colours in front of its name.
 *
 * The list is the registry rather than a list kept here, so a theme that is added — or removed — is
 * offered by this control the moment it exists. The check and `aria-current` are the same fact to two
 * audiences: which theme the engine is currently resolving.
 */
export function ThemeButton() {
  const themeId = useWorkbenchStore((state) => state.themeId)
  const setThemeId = useWorkbenchStore((state) => state.setThemeId)
  const mode = useThemeStore((state) => state.theme)
  const [open, setOpen] = useState(false)
  const name = `Theme: ${themeById(themeId).label}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <ControlButton label={name}>
                <Palette className="size-4" />
              </ControlButton>
            </PopoverTrigger>
          </TooltipTrigger>
          {/* The button's name is the theme it would change, so a tooltip that only said "Theme"
              would make the one thing a hover is for the one thing it does not say. */}
          <TooltipContent side="bottom">{name}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Theme</p>

        <ul>
          {THEMES.map((theme) => {
            const active = theme.id === themeId
            return (
              <li key={theme.id}>
                <button
                  type="button"
                  data-slot="theme-option"
                  data-theme-id={theme.id}
                  // Stated as well as drawn: a check mark is invisible to a screen reader.
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    setThemeId(theme.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-accent hover:text-accent-foreground focus-visible:outline-none',
                    active ? 'font-medium text-foreground' : 'text-muted-foreground'
                  )}
                >
                  <ThemeSwatch theme={theme} mode={mode} />
                  <span className="truncate">{theme.label}</span>
                  {active ? (
                    <Check data-slot="theme-check" aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
                  ) : (
                    // The check's width, kept by something that is not a check, so the labels of
                    // active and inactive rows line up.
                    <span aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The brightness control: a slider over the engine's range, applying as it moves.
 *
 * Written to the store on every step rather than on release, which is what makes the page move under
 * the handle — the same write is also what persists the value, so a brightness is remembered at the
 * moment it is chosen and not at the moment the popover is closed.
 */
export function BrightnessButton() {
  const brightness = useWorkbenchStore((state) => state.brightness)
  const setBrightness = useWorkbenchStore((state) => state.setBrightness)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ControlButton label="Brightness">
          <Contrast className="size-4" />
        </ControlButton>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Brightness</span>
          <span data-slot="brightness-value" className="text-[12px] tabular-nums">
            {brightnessLabel(brightness)}
          </span>
        </div>

        <Slider
          className="my-2.5"
          min={BRIGHTNESS_MIN}
          max={BRIGHTNESS_MAX}
          step={BRIGHTNESS_STEP}
          value={[brightness]}
          onValueChange={([next]) => setBrightness(next ?? BRIGHTNESS_DEFAULT)}
          aria-label="Brightness"
          aria-valuetext={brightnessValueText(brightness)}
        />

        <button
          type="button"
          onClick={() => setBrightness(BRIGHTNESS_DEFAULT)}
          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none"
        >
          <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
          Reset
        </button>
      </PopoverContent>
    </Popover>
  )
}
