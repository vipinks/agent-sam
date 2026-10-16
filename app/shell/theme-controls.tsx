import { useState, type CSSProperties } from 'react'
import { Check, Contrast, Palette, RotateCcw, SunMedium } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Slider } from '../components/ui/slider'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  CONTRAST_DEFAULT,
  CONTRAST_MAX,
  CONTRAST_MIN,
} from '../components/workbench/theme-engine'
import { THEMES, themeById, type Theme, type ThemeMode } from '../components/workbench/themes'
import { useWorkbenchStore } from '../components/workbench/store'
import { ControlButton } from './control-button'
import { ControlTooltip } from './control-tooltip'
import { useThemeStore } from './theme-store'

/**
 * The theme chooser, the brightness control and the contrast control: three titlebar buttons over the
 * engine's own store.
 *
 * None of them resolves a colour. They write `themeId`, `brightness` and `contrast` to the workbench store
 * and close; `useThemeApplication` — mounted once by the workbench — is what turns that into the document's
 * variables. That is the whole reason syntax highlighting, markdown tables and the spreadsheet grid
 * follow a theme switch without any of them knowing a theme exists: they read the same custom
 * properties, and the properties are re-resolved from these three values.
 *
 * Mode is not touched here either. The light/dark toggle beside these controls still owns the `.dark`
 * class and remains the only thing that decides the mode; a theme chosen here is chosen for whichever
 * mode the window is in, and a flip afterwards re-resolves with this theme and this brightness.
 *
 * Every button here wears the row's one tooltip shape — `ControlTooltip`, which the icons in `titlebar.tsx`
 * wear as well — because a hover that means one thing on the chooser and another on the toggle beside it is
 * how a row of glyphs stops being readable.
 *
 * The popover is the app's existing `ui/popover` (Radix, already a dependency), and the slider is the
 * app's `ui/slider` over the same package — no new dependency for the slider, and no `.css` file.
 */

/** How far one arrow key moves the brightness slider: one point of lightness, on a forty-one point range. */
const BRIGHTNESS_STEP = 1

/** How far one arrow key moves the contrast slider: one per cent of spread, on a hundred point range. */
const CONTRAST_STEP = 1

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

/** The contrast as a number a person reads: the percentage of extra spread the surfaces are given. */
function contrastLabel(contrast: number): string {
  return `${contrast}%`
}

/**
 * The contrast as a sentence, for the slider's `aria-valuetext`, for the reason the brightness has one.
 *
 * The number is not the whole value here either, but what is missing is not a direction: the bottom of the
 * range is not "no contrast", it is the contrast the theme itself was authored with, and that is the one
 * value the sentence has to get right.
 */
function contrastValueText(contrast: number): string {
  if (contrast === CONTRAST_DEFAULT) return "0%, the theme's own contrast"
  return `${contrast}% more contrast`
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
      <ControlTooltip label={name}>
        <PopoverTrigger asChild>
          <ControlButton label={name}>
            <Palette className="size-4" />
          </ControlButton>
        </PopoverTrigger>
      </ControlTooltip>

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
 *
 * The glyph is a sun rather than the contrast mark this control used to carry: that mark now belongs to the
 * contrast control beside it, and one icon doing duty for two different controls in the same row is how a
 * reader learns to stop reading the row. The tooltip is the control's own name, which is the shape the
 * chooser's hover already had.
 */
export function BrightnessButton() {
  const brightness = useWorkbenchStore((state) => state.brightness)
  const setBrightness = useWorkbenchStore((state) => state.setBrightness)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip label="Brightness">
        <PopoverTrigger asChild>
          <ControlButton label="Brightness">
            <SunMedium className="size-4" />
          </ControlButton>
        </PopoverTrigger>
      </ControlTooltip>

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

/**
 * The contrast control: the brightness control's twin, one multiplier further along.
 *
 * It is a slider over the engine's own range, written to the store on every step for the reason the
 * brightness slider is — the same write is what moves the page and what remembers the value. What it moves
 * is the surface ladder: every surface's distance from the page is multiplied, and the ink is left where the
 * theme put it, so the page gains separation between its own layers rather than heavier text. That is the
 * engine's decision, not this control's; this control is the number.
 *
 * The glyph is the contrast mark the brightness control used to carry, which is now free and is what the
 * control is: a page whose layers are being pulled apart. The value reads as a percentage because the number
 * it holds is one — how much more spread the surfaces are given than the theme authored them with.
 */
export function ContrastButton() {
  const contrast = useWorkbenchStore((state) => state.contrast)
  const setContrast = useWorkbenchStore((state) => state.setContrast)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip label="Contrast">
        <PopoverTrigger asChild>
          <ControlButton label="Contrast">
            <Contrast className="size-4" />
          </ControlButton>
        </PopoverTrigger>
      </ControlTooltip>

      <PopoverContent align="end" className="w-64 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Contrast</span>
          <span data-slot="contrast-value" className="text-[12px] tabular-nums">
            {contrastLabel(contrast)}
          </span>
        </div>

        <Slider
          className="my-2.5"
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={CONTRAST_STEP}
          value={[contrast]}
          onValueChange={([next]) => setContrast(next ?? CONTRAST_DEFAULT)}
          aria-label="Contrast"
          aria-valuetext={contrastValueText(contrast)}
        />

        <button
          type="button"
          onClick={() => setContrast(CONTRAST_DEFAULT)}
          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none"
        >
          <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
          Reset
        </button>
      </PopoverContent>
    </Popover>
  )
}
