import { useEffect, type ReactNode } from 'react'
import { Minus, Square, Copy, X, Sun, Moon, SquareTerminal, ZoomIn, ZoomOut, Ratio, Maximize } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { cn } from '@/lib/utils'
import { useWindowStore } from './window-store'
import { useThemeStore } from './theme-store'
import { MENUS } from './menu'
import { TitlebarMenu } from './titlebar-menu'
import { ControlButton } from './control-button'
import { ControlTooltip } from './control-tooltip'
import { UpdateBadge } from './update-badge'
import { BrightnessButton, ContrastButton, ThemeButton } from './theme-controls'
import { Separator } from '../components/ui/separator'
import { useWorkbenchStore } from '../components/workbench/store'

/**
 * Custom window titlebar: core shell chrome, styled with Tailwind on the theme tokens (no legacy
 * window.css). A conveyor consumer itself: the menu + controls call the window/web modules. macOS
 * keeps its native inset traffic lights; win32/linux render these controls.
 *
 * The theme chooser, the brightness control and the contrast control sit beside the light/dark toggle, in
 * that order: the four of them are one subject — what the window looks like — and the toggle is the one that
 * decides which mode the other three are chosen for.
 *
 * Every icon in that cluster carries the same tooltip, from `ControlTooltip`: one component, one placement,
 * one delay. A row of glyphs is read by hovering along it, and a row whose hovers each arrived on their own
 * terms would be a row nobody could learn. The window controls at the end are in it for the same reason — the
 * smallest glyphs in the bar are the ones a label helps most — and their words are the ones every window
 * manager already uses.
 *
 * The bottom terminal panel's toggle comes after them, behind a vertical divider, because it is the
 * row's one control that is not about how the window looks. The row is read in groups — zoom, layout,
 * theme, update, terminal — and every seam between them carries the same hairline, so the divider says
 * which group the toggle belongs to rather than that it is an exception to the rest of the row. It
 * reports a state rather than an action — pressed while the panel is showing — and that state is the
 * persisted flag and nothing else, so what the glyph says cannot drift from what the panel below is
 * doing.
 *
 * The zoom ladder and fullscreen lead the row, immediately before the light/dark toggle: they are the
 * acts the View menu's own zoom and fullscreen entries perform, drawn on the bar because a reader
 * reaches for them while looking at the page rather than while looking for the View menu. Nothing here
 * remembers a level — each press dispatches its act and the window's own page stays the only thing that
 * knows what size it is drawn at — so the four are buttons and tooltips and no state at all.
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
        <ViewActions />
        <TitlebarGroupSeparator />
        <ThemeToggle />
        <ThemeButton />
        <BrightnessButton />
        <ContrastButton />
        <TitlebarGroupSeparator />
        <UpdateBadge />
        <TerminalPanelToggle />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}

/**
 * The View menu's own words for an action: its label, and its accelerator when the menu shows one.
 *
 * Read from the menu rather than written again here, so a button and the entry it mirrors cannot
 * disagree — and so an accelerator added to the View menu turns up on the button without a second edit.
 * Three of the four entries carry no accelerator today, so their tooltips are the label alone; only
 * fullscreen names one, and it names the F11 the menu declares.
 */
function viewActionTooltip(label: string): string {
  const entry = MENUS.find((menu) => menu.label === 'View')?.items.find((item) => item.label === label)

  return entry?.shortcut ? `${entry.label} (${entry.shortcut})` : label
}

/** One view action: the row's own square control, under a tooltip that names it and its accelerator. */
function ViewAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <ControlTooltip label={viewActionTooltip(label)}>
      <ControlButton label={label} onClick={onClick}>
        {children}
      </ControlButton>
    </ControlTooltip>
  )
}

/**
 * One window control: the row's square button, under the row's tooltip for the same action.
 *
 * The three are the OS's own minimise, maximise and close, and the words are the ones a title bar has used
 * for them for decades: the row's smallest glyphs are the ones a hover helps most, and the words are already
 * the words a reader knows.
 */
function WindowControl({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string
  onClick: () => void
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <ControlTooltip label={label}>
      <ControlButton label={label} onClick={onClick} destructive={destructive}>
        {children}
      </ControlButton>
    </ControlTooltip>
  )
}

/**
 * The hairline between two of the row's functional groups.
 *
 * A rule rather than a wrapper element, and deliberately: the buttons stay children of the row, so a
 * group cannot take one of them out of the tab order or out of the order a reader walks them in. What
 * says "these belong together" is the spacing and the rule; what holds them together is nothing. The
 * mark is a data attribute because a separator and a divider are the same element in a snapshot, and a
 * test that had to guess which one it was looking at would be a test of the guess.
 */
function TitlebarGroupSeparator() {
  return <Separator orientation="vertical" data-titlebar-separator="" className="mx-1.5 h-5" />
}

/**
 * The zoom ladder and fullscreen, in the order the View menu lists them, before the theme toggle.
 *
 * The glyphs are the ladder read left to right — a magnifier gaining, a magnifier losing, the sizes a
 * page can be drawn at — and the window's own corners for fullscreen, which is the one of the four that
 * is not about size. A fragment rather than a wrapping element: the four are buttons of the row, level
 * with the theme controls beside them, and a box around them would put a gap in the row where there is
 * none between any of the others. The rule after the ladder is the one seam *inside* this group: zoom
 * is what a reader changes while reading, fullscreen is where the window is put, and the hairline says
 * so without moving either of them.
 */
function ViewActions() {
  return (
    <>
      <ViewAction label="Zoom In" onClick={() => conveyor.window.zoomIn()}>
        <ZoomIn className="size-4" />
      </ViewAction>
      <ViewAction label="Zoom Out" onClick={() => conveyor.window.zoomOut()}>
        <ZoomOut className="size-4" />
      </ViewAction>
      <ViewAction label="Actual Size" onClick={() => conveyor.window.resetZoom()}>
        <Ratio className="size-4" />
      </ViewAction>
      <TitlebarGroupSeparator />
      <ViewAction label="Toggle Fullscreen" onClick={() => conveyor.window.toggleFullscreen()}>
        <Maximize className="size-4" />
      </ViewAction>
    </>
  )
}

/**
 * The mode the window is in, and the one control in the row whose tooltip is not its own name.
 *
 * The toggle has no label to borrow: "Toggle theme" says what pressing does, and a hover that repeated it
 * would say nothing a reader had not already read on the button. What a reader wants to know before pressing
 * is which mode they are looking at, so the tooltip names the mode — and follows it, because a sentence that
 * named the other mode after a flip would be the one thing a tooltip must never be. The accessible name stays
 * "Toggle theme": a screen reader gets the control and the state, in that order.
 */
function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const toggle = useThemeStore((s) => s.toggle)
  const Icon = theme === 'dark' ? Sun : Moon
  return (
    <ControlTooltip label={theme === 'dark' ? 'Dark mode' : 'Light mode'}>
      <ControlButton label="Toggle theme" onClick={toggle}>
        <Icon className="size-4" />
      </ControlButton>
    </ControlTooltip>
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
 * The hover sentence is the `title` this control used to carry, moved into the row's tooltip. A native
 * `title` and a tooltip on one control arrive at different moments, in different styling, after different
 * delays — two descriptions of one thing rather than one — so the sentence travels with the shape the rest of
 * the row wears, and the control keeps only its own name.
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
      <Separator orientation="vertical" data-titlebar-separator="" className="mx-1.5 h-5" />
      <ControlTooltip label={bottomPanelOpen ? 'Hide the terminal panel' : 'Show the terminal panel'}>
        <ControlButton
          label="Terminal panel"
          aria-pressed={bottomPanelOpen}
          onClick={toggleBottomPanel}
          // Drawn the way the rail draws a docked resident, and with the hover treatment restated so the
          // pressed state stays pressed under the pointer: the control's own hover class would otherwise
          // be the last word while a reader is pointing at it.
          className={bottomPanelOpen ? 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand' : undefined}
        >
          <SquareTerminal className="size-4" />
        </ControlButton>
      </ControlTooltip>
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
        <WindowControl label="Minimize" onClick={() => conveyor.window.minimize()}>
          <Minus className="size-4" />
        </WindowControl>
      )}
      {maximizable && (
        <WindowControl label="Maximize" onClick={() => conveyor.window.maximizeToggle()}>
          {isMaximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </WindowControl>
      )}
      <WindowControl label="Close" onClick={() => conveyor.window.close()} destructive>
        <X className="size-4" />
      </WindowControl>
    </div>
  )
}
