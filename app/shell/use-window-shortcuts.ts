import { useEffect } from 'react'
import { conveyor } from '@/conveyor/client'
import { isTextEntryTarget, resolveWindowShortcut, type WindowCommand } from './window-shortcuts'
import { useWindowStore } from './window-store'

/**
 * The six window acts, dispatched through the commands the View menu's entries called.
 *
 * `conveyor.web.*` rather than `conveyor.window.*`, deliberately: the menu's Reload, DevTools and
 * fullscreen entries reached these, and an accelerator is the menu's behaviour with the menu gone. The
 * titlebar's own buttons keep their own commands — the zoom ladder's are bounded, which is what makes a
 * held-down button stop at the end of it — so nothing here re-points a control that already works.
 *
 * A record rather than six closures in the listener, so `resolveWindowShortcut`'s return type and this
 * table are the same six names: a seventh command in the table would not compile without an entry here.
 */
const DISPATCH: Record<WindowCommand, () => void> = {
  reload: () => conveyor.web.reload(),
  toggleDevtools: () => conveyor.web.toggleDevtools(),
  zoomIn: () => conveyor.web.zoomIn(),
  zoomOut: () => conveyor.web.zoomOut(),
  actualSize: () => conveyor.web.actualSize(),
  toggleFullscreen: () => conveyor.web.toggleFullscreen(),
}

/**
 * The menu-independent path to the six shortcuts.
 *
 * Two gates, and they answer two different questions. The window's focus is the one the store already
 * tracks from main's `focus`/`blur` events: a chord belongs to the window the reader is in, and a listener
 * that acted while another window was in front would be acting on a window nobody was looking at. The
 * field gate is `resolveWindowShortcut`'s own — the element that will receive the keystroke is read at the
 * moment of the press, because focus moves without React re-rendering anything, and a value captured at
 * mount would be the field the reader was in when the window opened.
 *
 * The listener is installed and removed with the focus rather than left listening and ignoring: a window
 * that has been defocused holds no key listener at all, which is the cheapest possible form of "not this
 * window's keystroke".
 */
export function useWindowShortcuts(): void {
  const isFocused = useWindowStore((s) => s.isFocused)

  useEffect(() => {
    if (!isFocused) return

    const onKey = (event: KeyboardEvent) => {
      const command = resolveWindowShortcut(event, { textEntry: isTextEntryTarget(document.activeElement) })
      if (!command) return
      // Taken, not merely observed: several of these are chords the page would otherwise answer itself,
      // and a reload that also typed is the defect this line prevents.
      event.preventDefault()
      DISPATCH[command]()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isFocused])
}
