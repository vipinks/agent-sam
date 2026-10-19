import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowFrame, useThemeStore } from '@/app/shell'
import { BRIGHTNESS_DEFAULT, BRIGHTNESS_MAX, BRIGHTNESS_MIN } from '@/app/components/workbench/theme-engine'
import { THEMES, themeById } from '@/app/components/workbench/themes'
import { themeVarsFor, useThemeApplication } from '@/app/components/workbench/theme-apply'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { createBridgeStub, setActiveStub } from './bridge-stub'
import { rgbOf } from './theme-css'

/**
 * The theme controls in the titlebar, as wiring: what a click and a drag reach.
 *
 * The arithmetic is `theme-rules.test.ts`'s and the application is `theme-apply-wiring.test.tsx`'s.
 * What can only be seen here is the chrome in between — that the chooser offers every theme the
 * registry holds with the colours that theme actually is, that picking one writes the store the engine
 * reads, and that the brightness popover's slider moves the same value through the same store. The
 * suite renders `WindowFrame` rather than a stub of the titlebar because the controls are titlebar
 * children and nothing else in the app puts them there.
 *
 * The two tones of a swatch are asserted as data — the custom properties the swatch is painted from —
 * rather than as a computed background: the swatch has to reach the registry's values at runtime, and a
 * Tailwind class cannot be built from a runtime string, so the value travels as a variable. jsdom does
 * not run Tailwind at all, so the class that reads the variable is the one thing here that the built
 * stylesheet has to prove.
 */

/** The hook as the app mounts it, beside the shell that owns the mode. */
function Applied() {
  useThemeApplication()
  return null
}

/** The tree the app composes: the shell with its titlebar, and the hook that applies the palette. */
function renderChrome() {
  return render(
    <WindowFrame>
      <Applied />
    </WindowFrame>
  )
}

/** The document's inline custom properties, as this suite reads them. */
function inlineVars(): Record<string, string> {
  const root = document.documentElement
  const vars: Record<string, string> = {}
  for (const name of Array.from(root.style)) {
    if (name.startsWith('--')) vars[name.slice(2)] = root.style.getPropertyValue(name).trim()
  }
  return vars
}

/** The whole applied map against an expected one, channel for channel, keys before values. */
function expectSameVars(actual: Record<string, string>, expected: Record<string, string>, where: string): void {
  expect(Object.keys(actual).sort(), `${where}: the applied variable names`).toEqual(Object.keys(expected).sort())
  for (const [name, value] of Object.entries(actual)) {
    if (name === 'radius') {
      expect(value, `${where} --${name}`).toBe(expected[name])
      continue
    }
    expect(rgbOf(value), `${where} --${name} (applied ${value}, expected ${expected[name]})`).toEqual(
      rgbOf(expected[name])
    )
  }
}

/** One row of the chooser, by the theme it offers. */
function rowFor(themeId: string): HTMLElement | null {
  return document.querySelector(`[data-slot="theme-option"][data-theme-id="${themeId}"]`)
}

/** A swatch's two tones, read from the variables it is painted from. */
function swatchTones(themeId: string): { surface: string; accent: string } {
  const swatch = rowFor(themeId)?.querySelector('[data-slot="theme-swatch"]') as HTMLElement | null
  const accent = swatch?.querySelector('[data-slot="theme-swatch-primary"]') as HTMLElement | null
  if (!swatch || !accent) throw new Error(`no swatch for ${themeId}`)
  return {
    surface: swatch.style.getPropertyValue('--swatch-surface').trim(),
    accent: accent.style.getPropertyValue('--swatch-accent').trim(),
  }
}

/**
 * The text of every tooltip that is currently open.
 *
 * Radix marks an open tooltip `instant-open` or `delayed-open` rather than `open`, so the state is read
 * as "not closed" — a selector for `open` matches nothing and reads as a tooltip that never appeared.
 * Joined rather than read from the first match because a closing tooltip is kept mounted while it
 * animates out, and reading the wrong one would report the previous theme as the current one.
 */
function openTooltipText(): string {
  const open = document.querySelectorAll('[role="tooltip"]:not([data-state="closed"])')
  return Array.from(open)
    .map((node) => node.textContent ?? '')
    .join(' ')
}

/** The brightness slider's handle, once its popover is open. */
function brightnessHandle(): HTMLElement {
  return screen.getByRole('slider', { name: 'Brightness' })
}

/** The contrast slider's handle, once its popover is open. */
function contrastHandle(): HTMLElement {
  return screen.getByRole('slider', { name: 'Contrast' })
}

/** Step the handle the way a keyboard does, which is the path a DOM test can drive deterministically. */
function nudge(handle: HTMLElement, key: 'ArrowRight' | 'ArrowLeft', times: number): void {
  for (let i = 0; i < times; i += 1) fireEvent.keyDown(handle, { key })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  for (const name of Array.from(document.documentElement.style)) {
    if (name.startsWith('--')) document.documentElement.style.removeProperty(name)
  }
  // The titlebar's own controls ask main for the window's capabilities on mount, so the stub answers
  // that call — otherwise the rejection is reported as an unhandled error rather than as a failure.
  setActiveStub(createBridgeStub({ init: () => ({ platform: 'win32', minimizable: true, maximizable: true }) }))
  useWorkbenchStore.setState({ themeId: 'crimson', brightness: BRIGHTNESS_DEFAULT, contrast: 0 })
  useThemeStore.setState({ theme: 'light' })
})

describe('the theme chooser', () => {
  it('offers every theme in the registry, each with a two-tone swatch and exactly one check', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Theme: Crimson' }))

    const rows = Array.from(document.querySelectorAll('[data-slot="theme-option"]'))
    expect(rows.length).toBe(THEMES.length)

    for (const theme of THEMES) {
      const row = rowFor(theme.id)
      expect(row, `a row offering ${theme.id}`).not.toBeNull()
      expect(row?.textContent).toContain(theme.label)
      // The swatch leads the row, so the colours are read before the name rather than after it.
      expect(row?.firstElementChild?.getAttribute('data-slot'), `${theme.id}: the row's first child`).toBe(
        'theme-swatch'
      )

      const tones = swatchTones(theme.id)
      expect(rgbOf(tones.surface), `${theme.id}: the swatch's surface`).toEqual(rgbOf(theme.swatch.light))
      expect(rgbOf(tones.accent), `${theme.id}: the swatch's brand tone`).toEqual(rgbOf(theme.tokens.light.primary))
      // Two tones, not one drawn twice: a light theme whose accent matched its own surface would
      // advertise nothing about the theme it offers.
      expect(tones.accent, `${theme.id}: the swatch's two tones`).not.toBe(tones.surface)
    }

    const checks = Array.from(document.querySelectorAll('[data-slot="theme-check"]'))
    expect(checks.length, 'exactly one check').toBe(1)
    expect(checks[0].closest('[data-slot="theme-option"]')?.getAttribute('data-theme-id')).toBe('crimson')

    // The same fact to a screen reader, which cannot see a check mark.
    const current = Array.from(document.querySelectorAll('[data-slot="theme-option"][aria-current="true"]'))
    expect(current.length, 'exactly one row marked current').toBe(1)
    expect(current[0].getAttribute('data-theme-id')).toBe('crimson')
  })

  it('writes the chosen theme to the store, re-resolves the document, and closes', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Theme: Crimson' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ocean' }))

    expect(useWorkbenchStore.getState().themeId).toBe('ocean')
    expect(rowFor('ocean'), 'the chooser is closed once a theme is picked').toBeNull()
    // The engine resolves for the store, so the document follows without the chooser touching it.
    expectSameVars(inlineVars(), themeVarsFor('ocean', 'light', BRIGHTNESS_DEFAULT), 'after choosing ocean')
    expect(rgbOf(inlineVars().background), 'the surface actually moved').not.toEqual(
      rgbOf(themeVarsFor('crimson', 'light', BRIGHTNESS_DEFAULT).background)
    )
    // And the choice is the one a restart would read back.
    const stored = JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ themeId: 'ocean', brightness: BRIGHTNESS_DEFAULT, contrast: 0 })
  })

  it('names the current theme on its button, and follows the store when the theme changes', async () => {
    renderChrome()

    const trigger = screen.getByRole('button', { name: 'Theme: Crimson' })
    act(() => trigger.focus())

    await waitFor(() => {
      expect(openTooltipText(), 'the tooltip names the theme that is current').toContain('Crimson')
    })

    // The name is read from the store rather than remembered by the button, so a theme chosen
    // elsewhere — or restored from a stored preference — is named here too.
    act(() => useWorkbenchStore.getState().setThemeId('forest'))

    const renamed = screen.getByRole('button', { name: 'Theme: Forest' })
    expect(renamed).toBe(trigger)
    act(() => renamed.blur())
    act(() => renamed.focus())

    await waitFor(() => {
      expect(openTooltipText(), 'and follows the theme it is naming').toContain('Forest')
    })
  })
})

describe('the brightness control', () => {
  it('opens from its button into a slider bounded by the brightness range', async () => {
    renderChrome()

    expect(screen.queryByRole('slider'), 'nothing is open until the button is pressed').toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Brightness' }))

    const handle = brightnessHandle()
    expect(handle.getAttribute('aria-valuemin')).toBe(String(BRIGHTNESS_MIN))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(BRIGHTNESS_MAX))
    expect(handle.getAttribute('aria-valuenow')).toBe('0')
    expect(handle.getAttribute('aria-valuetext')).toBe("0 points, the theme's own brightness")
  })

  it('moves the brightness, and the document with it, in both directions', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Brightness' }))
    nudge(brightnessHandle(), 'ArrowRight', 8)

    expect(useWorkbenchStore.getState().brightness).toBe(8)
    expect(brightnessHandle().getAttribute('aria-valuenow')).toBe('8')
    expect(brightnessHandle().getAttribute('aria-valuetext')).toBe('8 points lighter')
    expect(document.querySelector('[data-slot="brightness-value"]')?.textContent).toBe('+8')
    expect(rgbOf(inlineVars().background), 'the page moved with the brightness').toEqual(
      rgbOf(themeVarsFor('crimson', 'light', 8).background)
    )
    // Live-applied while the handle moves, and persisted as it moves: a restart must not lose it.
    const stored = JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ themeId: 'crimson', brightness: 8, contrast: 0 })

    nudge(brightnessHandle(), 'ArrowLeft', 20)

    expect(useWorkbenchStore.getState().brightness).toBe(-12)
    expect(brightnessHandle().getAttribute('aria-valuenow')).toBe('-12')
    expect(brightnessHandle().getAttribute('aria-valuetext')).toBe('12 points darker')
    expect(document.querySelector('[data-slot="brightness-value"]')?.textContent).toBe('-12')
    expect(rgbOf(inlineVars().background)).toEqual(rgbOf(themeVarsFor('crimson', 'light', -12).background))
  })

  it('resets to zero, and says so', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Brightness' }))
    nudge(brightnessHandle(), 'ArrowLeft', 5)
    expect(useWorkbenchStore.getState().brightness).toBe(-5)

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    expect(useWorkbenchStore.getState().brightness).toBe(BRIGHTNESS_DEFAULT)
    expect(brightnessHandle().getAttribute('aria-valuenow')).toBe('0')
    expect(brightnessHandle().getAttribute('aria-valuetext')).toBe("0 points, the theme's own brightness")
    expect(document.querySelector('[data-slot="brightness-value"]')?.textContent).toBe('0')
    expectSameVars(inlineVars(), themeVarsFor('crimson', 'light', BRIGHTNESS_DEFAULT), 'after resetting')
    const stored = JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ themeId: 'crimson', brightness: BRIGHTNESS_DEFAULT, contrast: 0 })
  })
})

describe('a stored preference', () => {
  it('restores both the theme and the brightness it names', async () => {
    localStorage.setItem('sam-ai-theme-preference', JSON.stringify({ themeId: 'forest', brightness: 12 }))

    // The store reads storage once, when its module is first evaluated, so a rehydrated preference is
    // only reachable by loading the module a second time — which is what a restart does.
    vi.resetModules()
    const fresh = await import('@/app/components/workbench/store')

    expect(fresh.useWorkbenchStore.getState().themeId).toBe('forest')
    expect(fresh.useWorkbenchStore.getState().brightness).toBe(12)
  })
})

describe('the mode toggle beside them', () => {
  it('still flips the mode under a non-default theme, and re-resolves with it', async () => {
    renderChrome()

    act(() => useWorkbenchStore.getState().setThemeId('ocean'))
    expect(screen.getByRole('button', { name: 'Theme: Ocean' }), 'the chrome follows the theme').toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expectSameVars(inlineVars(), themeVarsFor('ocean', 'dark', BRIGHTNESS_DEFAULT), 'ocean in dark')

    // The swatches are drawn for the mode the window is in, so the same theme is offered in its dark
    // colours — a swatch that stayed light-mode would be advertising the other half of the theme.
    await userEvent.click(screen.getByRole('button', { name: 'Theme: Ocean' }))
    const tones = swatchTones('ocean')
    expect(rgbOf(tones.surface), 'the dark surface').toEqual(rgbOf(themeById('ocean').swatch.dark))
    expect(rgbOf(tones.accent), 'the dark brand tone').toEqual(rgbOf(themeById('ocean').tokens.dark.primary))
  })
})

/**
 * The row's tooltips, and the contrast control beside the brightness one.
 *
 * Both halves are chrome, which is why they are here rather than in the suites that own the arithmetic:
 * `theme-rules.test.ts` holds the contrast range to the readability floor and `theme-contrast-test.ts`
 * holds the slot and the map, and what can only be seen in a document is that every icon in the row
 * carries the same tooltip shape, and that the contrast control sits where the brightness control does
 * and writes the store the same way.
 *
 * The row is enumerated rather than sampled. A tooltip is a thing a control either has or does not have,
 * so the assertion that matters is the one about the row's whole inventory — a glyph added without one
 * fails as a name that was never reached, which is the shape of defect this case exists for.
 */

/** Every open tooltip in the document, as elements, in the order they were mounted. */
function openTooltips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]:not([data-state="closed"])'))
}

/**
 * Focus a control, and hold the tooltip it opens to the row's one shape: the words, the placement, the
 * primitive, and the trigger being the icon itself.
 *
 * jsdom can see all four of those and cannot see the fifth — the delay, because the shape's delay is one
 * constant in `ControlTooltip` and Radix keeps it in a timer rather than in the document. So the delay
 * is uniform by construction, and everything about the shape a document can be asked about is asserted
 * here: a control given a tooltip of its own — another component, the other side, a description wedged
 * between the icon and its hover — fails this rather than passing as "has a tooltip".
 */
async function expectTooltip(name: string, tooltip: string): Promise<void> {
  const button = screen.getByRole('button', { name })
  act(() => button.blur())
  act(() => button.focus())

  await waitFor(() => expect(openTooltipText(), `${name}: a tooltip`).toContain(tooltip))

  const content = openTooltips().find((node) => (node.textContent ?? '').trim() === tooltip)
  expect(content, `${name}: an open tooltip reading ${tooltip}`).toBeTruthy()
  expect(content?.getAttribute('data-side'), `${name}: placed below the icon`).toBe('bottom')
  expect(content?.getAttribute('data-slot'), `${name}: drawn by the app's tooltip primitive`).toBe('tooltip-content')
  // The trigger is the icon button itself rather than a wrapper around it: the description hangs on the
  // control a reader reaches, which is what makes the hover reachable from the control.
  expect(button.getAttribute('aria-describedby'), `${name}: the trigger is the icon`).toBe(content?.id)

  act(() => button.blur())
}

/**
 * The row's icon controls, in the order the row draws them, with the words each hover produces.
 *
 * The names are the controls' own accessible names, which is how a reader reaches them and how this
 * suite finds them; the wording is what the hover says. The mode toggle is not here: its tooltip names
 * the mode the window is in, so it has its own case rather than a table entry that is true half the
 * time.
 */
const ROW_ICONS = [
  { name: 'Reload', tooltip: 'Reload (Ctrl+R)' },
  { name: 'Zoom In', tooltip: 'Zoom In (Ctrl+Plus)' },
  { name: 'Zoom Out', tooltip: 'Zoom Out (Ctrl+Minus)' },
  { name: 'Actual Size', tooltip: 'Actual Size (Ctrl+0)' },
  { name: 'Toggle Fullscreen', tooltip: 'Toggle Fullscreen (F11)' },
  { name: 'Theme: Crimson', tooltip: 'Theme: Crimson' },
  { name: 'Brightness', tooltip: 'Brightness' },
  { name: 'Contrast', tooltip: 'Contrast' },
  { name: 'Terminal panel', tooltip: 'Show the terminal panel' },
  { name: 'Minimize', tooltip: 'Minimize' },
  { name: 'Maximize', tooltip: 'Maximize' },
  { name: 'Close', tooltip: 'Close' },
] as const

/** Every button in the row's own cluster, by the name it is reached by. */
function clusterNames(): string[] {
  const header = screen.getByRole('button', { name: 'Close' }).closest('header')
  const cluster = header?.lastElementChild
  return Array.from(cluster?.querySelectorAll('button') ?? []).map((button) => button.getAttribute('aria-label') ?? '')
}

describe('the tooltips on the row', () => {
  it('carries one on every icon in the row, in the row’s one shape', async () => {
    renderChrome()

    for (const { name, tooltip } of ROW_ICONS) await expectTooltip(name, tooltip)

    // And nothing in the row was left out of that: the controls reached above are the cluster's whole
    // inventory, so a glyph added without a tooltip lands here as a name no hover produced.
    expect(clusterNames().sort()).toEqual([...ROW_ICONS.map((icon) => icon.name), 'Toggle theme'].sort())
  })

  it('names the mode the window is in on the mode toggle, and follows a flip', async () => {
    renderChrome()

    await expectTooltip('Toggle theme', 'Light mode')

    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))

    expect(useThemeStore.getState().theme, 'the flip reached the shell').toBe('dark')
    await expectTooltip('Toggle theme', 'Dark mode')
  })
})

describe('the contrast control', () => {
  it('sits beside the brightness control, where the two are chosen together', () => {
    renderChrome()

    const brightness = screen.getByRole('button', { name: 'Brightness' })
    const contrast = screen.getByRole('button', { name: 'Contrast' })

    expect(brightness.nextElementSibling, 'the contrast control is the brightness control’s neighbour').toBe(contrast)
  })

  it('opens into a slider over the whole range, on the theme’s own contrast', async () => {
    renderChrome()

    expect(screen.queryByRole('slider', { name: 'Contrast' }), 'nothing is open until it is pressed').toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Contrast' }))

    const handle = contrastHandle()
    expect(handle.getAttribute('aria-valuemin')).toBe('0')
    expect(handle.getAttribute('aria-valuemax')).toBe('100')
    expect(handle.getAttribute('aria-valuenow')).toBe('0')
    expect(handle.getAttribute('aria-valuetext')).toBe("0%, the theme's own contrast")
  })

  it('moves the contrast, and the document’s surfaces with it', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Contrast' }))
    nudge(contrastHandle(), 'ArrowRight', 25)

    expect(useWorkbenchStore.getState().contrast).toBe(25)
    expect(contrastHandle().getAttribute('aria-valuenow')).toBe('25')
    expect(contrastHandle().getAttribute('aria-valuetext')).toBe('25% more contrast')
    expect(document.querySelector('[data-slot="contrast-value"]')?.textContent).toBe('25%')

    // The page's own surfaces are what a contrast step is about, and the ink is not: the same split the
    // brightness control makes, for the same reason — the ink is what has to stay readable on the
    // result, so what moves is everything drawn under it.
    const applied = inlineVars()
    expect(rgbOf(applied.border), 'the border followed the contrast').toEqual(
      rgbOf(themeVarsFor('crimson', 'light', 0, 25).border)
    )
    expect(rgbOf(applied.border), 'and the border actually moved').not.toEqual(
      rgbOf(themeVarsFor('crimson', 'light', 0, 0).border)
    )
    expect(applied.foreground, 'the ink is left where the theme put it').toBe(
      themeVarsFor('crimson', 'light', 0, 25).foreground
    )

    // Persisted as it moves, beside the theme and the brightness it is chosen with.
    const stored = JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ themeId: 'crimson', brightness: 0, contrast: 25 })
  })

  it('resets to the theme’s own contrast, and says so', async () => {
    renderChrome()

    await userEvent.click(screen.getByRole('button', { name: 'Contrast' }))
    nudge(contrastHandle(), 'ArrowRight', 30)
    expect(useWorkbenchStore.getState().contrast).toBe(30)

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    expect(useWorkbenchStore.getState().contrast).toBe(0)
    expect(contrastHandle().getAttribute('aria-valuenow')).toBe('0')
    expect(contrastHandle().getAttribute('aria-valuetext')).toBe("0%, the theme's own contrast")
    expect(document.querySelector('[data-slot="contrast-value"]')?.textContent).toBe('0%')
    expectSameVars(inlineVars(), themeVarsFor('crimson', 'light', 0, 0), 'after resetting the contrast')
  })
})
