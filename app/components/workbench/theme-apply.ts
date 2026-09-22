import { useLayoutEffect } from 'react'
import { useThemeStore } from '@/app/shell'
import { THEME_VARIABLES, type ThemeMode } from './themes'
import { ensureReadable, resolveThemeVars, type ThemeVars } from './theme-engine'
import { useWorkbenchStore } from './store'

/**
 * The theme, applied: the engine's resolved variables written onto the document as inline custom
 * properties.
 *
 * This is the whole of the renderer's part in the theme engine, and it is deliberately thin. Every
 * decision — what a theme's tokens are, what a brightness step does to them, whether a pair needs
 * moving to stay legible — was made in `themes.ts` and `theme-engine.ts`, which are pure. All that is
 * left here is the one thing a pure function cannot do, which is hand the answer to a document.
 *
 * Inline custom properties on `documentElement` rather than a second stylesheet: they sit on the same
 * element the `.dark` class does, they win over the stylesheet's `:root` block by specificity, and they
 * are observable in a test without reading a computed style. There is no new `.css` file and no new
 * dependency, and the stylesheet keeps its values — which is what makes the claim that crimson at
 * brightness 0 is pixel-identical to today checkable by comparing the two.
 *
 * Mode is *read*, never decided: `useThemeStore` remains the source of the `.dark` class, and this file
 * does not touch that class. The engine follows the same theme, the same window and the same brightness
 * the mode toggle does, so a flip to dark re-resolves rather than leaving light values behind.
 */

/** The variables to set for a theme, mode and brightness, after the readability pass has had its say. */
export function themeVarsFor(themeId: string, mode: ThemeMode, brightness: number): ThemeVars {
  return ensureReadable(resolveThemeVars(themeId, mode, brightness)).vars
}

/** Every property name this module sets, so applying and clearing are the same list. */
const properties = THEME_VARIABLES.map((name) => `--${name}`)

/**
 * Write a resolved set of variables onto the document.
 *
 * A property the map does not name is removed rather than left at its previous value: the map is
 * always complete, so if one is missing the honest result is the stylesheet's own value rather than
 * whatever theme was applied before it.
 */
export function applyThemeVars(vars: ThemeVars): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(`--${name}`, value)
}

/** Hand the document back to the stylesheet, as a property-removing counterpart to `applyThemeVars`. */
export function clearThemeVars(): void {
  const root = document.documentElement
  for (const property of properties) root.style.removeProperty(property)
}

/**
 * Apply the current theme and keep it applied.
 *
 * Re-resolving on theme, mode or brightness is not an optimisation to skip: the resolved values depend
 * on all three, and any one of them changing while the others stay put is still a different document.
 * A layout effect rather than a passive one for the same reason the shell's `.dark` toggle uses one —
 * the variables have to be set in the same frame the class is, or a mode flip paints one frame with the
 * other mode's colours.
 *
 * The dependencies are the store's own values rather than the resolved map, because the map is a fresh
 * object on every render and comparing it would apply on every paint.
 */
export function useThemeApplication(): void {
  const mode = useThemeStore((state) => state.theme)
  const themeId = useWorkbenchStore((state) => state.themeId)
  const brightness = useWorkbenchStore((state) => state.brightness)

  useLayoutEffect(() => {
    applyThemeVars(themeVarsFor(themeId, mode, brightness))
  }, [themeId, mode, brightness])
}
