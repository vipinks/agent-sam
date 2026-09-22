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
  useWorkbenchStore.setState({ themeId: 'crimson', brightness: BRIGHTNESS_DEFAULT })
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
    expect(stored).toEqual({ themeId: 'ocean', brightness: BRIGHTNESS_DEFAULT })
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
    expect(stored).toEqual({ themeId: 'crimson', brightness: 8 })

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
    expect(stored).toEqual({ themeId: 'crimson', brightness: BRIGHTNESS_DEFAULT })
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
