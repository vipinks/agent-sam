import { beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { WindowFrame, useThemeStore } from '@/app/shell'
import { DEFAULT_THEME_ID } from '@/app/components/workbench/themes'
import { BRIGHTNESS_DEFAULT, BRIGHTNESS_MAX } from '@/app/components/workbench/theme-engine'
import { themeVarsFor, useThemeApplication } from '@/app/components/workbench/theme-apply'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { createBridgeStub, setActiveStub } from './bridge-stub'
import { rgbOf, stylesheetTokens } from './theme-css'

/**
 * The theme engine as wiring: what reaches the document when a store changes.
 *
 * The arithmetic is `theme-rules.test.ts`'s. What can only be seen here is that the resolved map is
 * handed to `documentElement` as inline custom properties, that a change of theme or brightness
 * re-resolves, and that the shell's `.dark` class still flips and is still what decides the mode the
 * engine resolves for.
 *
 * `WindowFrame` is rendered rather than a stub of it, because the class toggle asserted below is its
 * layout effect and nothing else in the app performs it. The component beside it calls the same hook the
 * workbench mounts, so the two halves the app composes are composed here in the same order.
 *
 * The stylesheet is read from disk for the assertion that matters most: at the default theme and
 * brightness, the inline values are the values `globals.css` declares. Comparing them against
 * `resolveThemeVars` instead would only show that the engine agrees with itself.
 */

/** The hook as the app mounts it. */
function Applied() {
  useThemeApplication()
  return null
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

/**
 * Assert a whole applied map against an expected one, channel for channel.
 *
 * `--radius` is skipped rather than compared: it is a length, not a colour, and it is the one variable
 * in the map the engine passes through untouched. The keys are compared before the values, so a map that
 * lost a property fails here instead of quietly comparing the properties it kept.
 */
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

/** The tree the app composes: the shell that owns the mode, and the hook that applies the palette. */
function renderApp() {
  return render(
    <WindowFrame>
      <Applied />
    </WindowFrame>
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  for (const name of Array.from(document.documentElement.style)) {
    if (name.startsWith('--')) document.documentElement.style.removeProperty(name)
  }
  // `WindowFrame` asks main for the window's capabilities on mount, so the stub answers that one call —
  // otherwise the rejection is reported as an unhandled error rather than as a failure of this suite.
  setActiveStub(createBridgeStub({ init: () => ({ platform: 'win32', minimizable: true, maximizable: true }) }))
  useWorkbenchStore.setState({ themeId: DEFAULT_THEME_ID, brightness: BRIGHTNESS_DEFAULT })
  useThemeStore.setState({ theme: 'light' })
})

describe('applying the theme to the document', () => {
  it('writes every variable the stylesheet declares, as inline custom properties', () => {
    renderApp()

    expectSameVars(inlineVars(), stylesheetTokens().light, 'at the defaults')
  })

  it('is the stylesheet’s own values at the default theme and brightness', () => {
    renderApp()

    // The claim the phase makes about the default experience, stated as a comparison against the file
    // rather than against the engine: crimson at brightness 0 renders today's colours, not new ones.
    const sheet = stylesheetTokens().light
    for (const [name, value] of Object.entries(inlineVars())) {
      if (name === 'radius') continue
      expect(rgbOf(value), `--${name} (stylesheet ${sheet[name]}, applied ${value})`).toEqual(rgbOf(sheet[name]))
    }
  })

  it('rewrites the properties when the store’s theme changes, and returns to the stylesheet on reset', () => {
    renderApp()

    const before = inlineVars()
    act(() => useWorkbenchStore.getState().setThemeId('ocean'))

    // The properties were rewritten in place: same document, new values, and the ocean palette's.
    expectSameVars(inlineVars(), themeVarsFor('ocean', 'light', BRIGHTNESS_DEFAULT), 'after choosing ocean')
    expect(inlineVars().background, 'the surface actually moved').not.toBe(before.background)

    act(() => useWorkbenchStore.getState().setThemeId(DEFAULT_THEME_ID))

    const reset = inlineVars()
    expectSameVars(reset, before, 'after resetting to the default theme')
    for (const [name, value] of Object.entries(reset)) {
      if (name === 'radius') continue
      expect(rgbOf(value), `--${name} against the stylesheet`).toEqual(rgbOf(stylesheetTokens().light[name]))
    }
  })

  it('re-resolves when the brightness changes, moving the surfaces and leaving the ink where it was', () => {
    renderApp()

    const before = inlineVars()
    act(() => useWorkbenchStore.getState().setBrightness(BRIGHTNESS_MAX))

    const expected = themeVarsFor(DEFAULT_THEME_ID, 'light', BRIGHTNESS_MAX)
    const after = inlineVars()
    expect(rgbOf(after.background), 'the page moved with the brightness').toEqual(rgbOf(expected.background))
    expect(after.background).not.toBe(before.background)
    // The ink is what has to stay readable on the brighter page, so brightness leaves it alone — and the
    // brand colour is a signal rather than a surface, so it does not move either.
    expect(after.foreground).toBe(before.foreground)
    expect(after.brand).toBe(before.brand)
  })
})

describe('the mode toggle', () => {
  it('still flips the class on the document, and re-resolves for the new mode', () => {
    renderApp()

    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => useThemeStore.getState().toggle())

    // The class toggle is the shell's, unchanged: it is still what decides the mode.
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expectSameVars(inlineVars(), themeVarsFor(DEFAULT_THEME_ID, 'dark', BRIGHTNESS_DEFAULT), 'after flipping to dark')

    act(() => useThemeStore.getState().toggle())

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expectSameVars(inlineVars(), themeVarsFor(DEFAULT_THEME_ID, 'light', BRIGHTNESS_DEFAULT), 'after flipping back')
  })

  it('re-resolves with the theme and brightness that are current, not with the defaults', () => {
    renderApp()

    act(() => useWorkbenchStore.getState().setThemeId('forest'))
    act(() => useWorkbenchStore.getState().setBrightness(BRIGHTNESS_MAX))
    act(() => useThemeStore.getState().toggle())

    const expected = themeVarsFor('forest', 'dark', BRIGHTNESS_MAX)
    const applied = inlineVars()
    // A flip that re-resolved for the defaults would land on crimson, so the two are asserted apart
    // before the whole map is compared.
    expect(applied.background).not.toBe(themeVarsFor(DEFAULT_THEME_ID, 'dark', BRIGHTNESS_DEFAULT).background)
    expectSameVars(applied, expected, 'forest in dark at the top of the range')
  })
})

describe('the theme preference', () => {
  it('resolves to crimson at brightness 0 when nothing was stored, and applies that', () => {
    // The additive half of the persistence: a renderer that has never stored a theme opens on the
    // default rather than on nothing, which is what the stylesheet comparison above then relies on.
    expect(useWorkbenchStore.getState().themeId).toBe(DEFAULT_THEME_ID)
    expect(useWorkbenchStore.getState().brightness).toBe(BRIGHTNESS_DEFAULT)
    expect(JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? 'null')).toBeNull()
  })

  it('stores the theme and the brightness alongside the chat target rather than over it', () => {
    act(() => useWorkbenchStore.getState().setTarget({ providerId: 'anthropic', model: 'claude-sonnet-4' }))
    act(() => useWorkbenchStore.getState().setThemeId('amber'))
    act(() => useWorkbenchStore.getState().setBrightness(BRIGHTNESS_MAX))

    const stored = JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ themeId: 'amber', brightness: BRIGHTNESS_MAX })
    // The slice that was already persisted is untouched: the theme preference was added beside it.
    expect(JSON.parse(localStorage.getItem('sam-ai-chat-target') ?? '{}')).toEqual({
      providerId: 'anthropic',
      model: 'claude-sonnet-4',
    })
  })

  it('holds a brightness the store was handed inside the range, whatever it was handed', () => {
    act(() => useWorkbenchStore.getState().setBrightness(BRIGHTNESS_MAX + 40))

    expect(useWorkbenchStore.getState().brightness).toBe(BRIGHTNESS_MAX)
    expect(JSON.parse(localStorage.getItem('sam-ai-theme-preference') ?? '{}')).toEqual({
      themeId: DEFAULT_THEME_ID,
      brightness: BRIGHTNESS_MAX,
    })
  })
})
