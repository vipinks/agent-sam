import { useEffect } from 'react'
import { Minus, Square, Copy, X, Sun, Moon, SquareTerminal } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { cn } from '@/lib/utils'
import { useWindowStore } from './window-store'
import { useThemeStore } from './theme-store'
import { TitlebarMenu } from './titlebar-menu'
import { ControlButton } from './control-button'
import { BrightnessButton, ThemeButton } from './theme-controls'
import { Separator } from '../components/ui/separator'
import { useWorkbenchStore } from '../components/workbench/store'

/**
 * Custom window titlebar: core shell chrome, styled with Tailwind on the theme tokens (no legacy
 * window.css). A conveyor consumer itself: the menu + controls call the window/web modules. macOS
 * keeps its native inset traffic lights; win32/linux render these controls.
 *
 * The theme chooser and the brightness control sit beside the light/dark toggle, in that order: the
 * three of them are one subject — what the window looks like — and the toggle is the one that decides
 * which mode the other two are chosen for.
 *
 * The bottom terminal panel's toggle comes after them, behind a vertical divider, because it is the
 * row's one control that is not about how the window looks: the divider is what says so, and nothing
 * else in this row needs one. It reports a state rather than an action — pressed while the panel is
 * showing — and that state is the persisted flag and nothing else, so what the glyph says cannot drift
 * from what the panel below is doing.
 */
export function Titlebar({ title = 'Electron React App' }: { title?: string }) {
  const platform = useWindowStore((s) => s.platform)
  const menuVisible = useWindowStore((s) => s.menuVisible)
  const toggleMenu = useWindowStore((s) => s.toggleMenu)
  const isMac = platform === 'darwin'

  // Alt shows/hides the menu bar, like a normal Electron window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !e.repeat) {
        e.preventDefault()
        toggleMenu()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMenu])

  return (
    <header
      className={cn(
        'relative flex h-10 shrink-0 items-center border-b border-border bg-card select-none [-webkit-app-region:drag]',
        isMac && 'pl-20'
      )}
    >
      <div className="flex items-center gap-2.5 pl-3 [-webkit-app-region:no-drag]">
        {/* The native traffic lights already anchor the left edge on macOS, where a same-sized dot
            beside them just reads as a fourth window control. */}
        {!isMac && <span className="size-3.25 rounded-lg bg-brand ring-[3px] ring-brand/20" />}
        {menuVisible && <TitlebarMenu />}
      </div>

      {/* Centered title. pointer-events-none so the drag region shows through. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="text-[13px] font-medium text-foreground/60">{title}</span>
      </div>

      <div className="ml-auto flex items-center [-webkit-app-region:no-drag]">
        <ThemeToggle />
        <ThemeButton />
        <BrightnessButton />
        <TerminalPanelToggle />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}

function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const toggle = useThemeStore((s) => s.toggle)
  const Icon = theme === 'dark' ? Sun : Moon
  return (
    <ControlButton label="Toggle theme" onClick={toggle}>
      <Icon className="size-4" />
    </ControlButton>
  )
}

/**
 * The bottom terminal panel, opened and closed from the window's own chrome.
 *
 * Here rather than inside the workbench because the panel is the whole window's: it is there with no
 * folder open and with no file shown, and the title bar is the one part of the window that is always
 * there whatever the workbench is doing. What it reads and writes is the workbench's own state, so the
 * glyph and the panel cannot disagree — the persisted flag is the only thing either of them consults.
 *
 * It is absent, and so is its chord, while the settings screen has taken the workbench over: the panel
 * belongs to the workbench, and a control that opened a panel behind a screen with no chat column in it
 * would open nothing a reader could see. The flag itself is untouched by that, so leaving settings
 * brings the glyph back and finds the panel where it was left.
 *
 * Ctrl+` is the same toggle for a reader who is typing, and it is what the chord means in the editors
 * this app sits beside. It is taken before the shell underneath sees it, which is the point: a chord
 * that reached the shell would be a chord that opened a panel *and* typed at a prompt.
 */
function TerminalPanelToggle() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const bottomPanelOpen = useWorkbenchStore((s) => s.bottomPanelOpen)
  const toggleBottomPanel = useWorkbenchStore((s) => s.toggleBottomPanel)
  const inWorkbench = activeActivity !== 'settings'

  // The chord is installed and removed with the glyph, so a screen that took the workbench over takes
  // the shortcut with it: a listener that outlived its control would be a keystroke that changed a
  // panel nobody could see and left the change behind.
  useEffect(() => {
    if (!inWorkbench) return

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === '`') {
        e.preventDefault()
        toggleBottomPanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inWorkbench, toggleBottomPanel])

  if (!inWorkbench) return null

  return (
    <div className="flex items-center">
      <Separator orientation="vertical" className="mx-1.5 h-5" />
      <ControlButton
        label="Terminal panel"
        aria-pressed={bottomPanelOpen}
        title={bottomPanelOpen ? 'Hide the terminal panel' : 'Show the terminal panel'}
        onClick={toggleBottomPanel}
        // Drawn the way the rail draws a docked resident, and with the hover treatment restated so the
        // pressed state stays pressed under the pointer: the control's own hover class would otherwise
        // be the last word while a reader is pointing at it.
        className={bottomPanelOpen ? 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand' : undefined}
      >
        <SquareTerminal className="size-4" />
      </ControlButton>
    </div>
  )
}

function WindowControls() {
  const minimizable = useWindowStore((s) => s.minimizable)
  const maximizable = useWindowStore((s) => s.maximizable)
  const isMaximized = useWindowStore((s) => s.isMaximized)

  return (
    <div className="flex">
      {minimizable && (
        <ControlButton label="Minimize" onClick={() => conveyor.window.minimize()}>
          <Minus className="size-4" />
        </ControlButton>
      )}
      {maximizable && (
        <ControlButton label="Maximize" onClick={() => conveyor.window.maximizeToggle()}>
          {isMaximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </ControlButton>
      )}
      <ControlButton label="Close" onClick={() => conveyor.window.close()} destructive>
        <X className="size-4" />
      </ControlButton>
    </div>
  )
}
