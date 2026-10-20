import { useEffect, type ReactNode } from 'react'
import {
  Minus,
  Square,
  Copy,
  X,
  Sun,
  Moon,
  SquareTerminal,
  ZoomIn,
  ZoomOut,
  Ratio,
  Maximize,
  RotateCw,
} from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { cn } from '@/lib/utils'
import { useWindowStore } from './window-store'
import { useThemeStore } from './theme-store'
import { CHROME_BAND_HEIGHT, CHROME_ICON_GAP } from './chrome'
import { windowShortcut, type WindowCommand } from './window-shortcuts'
import { useWindowShortcuts } from './use-window-shortcuts'
import { ControlButton } from './control-button'
import { ControlTooltip } from './control-tooltip'
import { UpdateBadge } from './update-badge'
import { BrightnessButton, ContrastButton, ThemeButton } from './theme-controls'
import { TitlebarGroupSeparator } from './group-separator'
import { useWorkbenchStore } from '../components/workbench/store'

/**
 * Custom window titlebar: core shell chrome, styled with Tailwind on the theme tokens (no legacy
 * window.css). A conveyor consumer itself: the controls call the window/web modules, and the six
 * accelerators are dispatched from here too. macOS keeps its native inset traffic lights; win32/linux
 * render these controls.
 *
 * Phase 100 took the File, Edit and View menus off this bar for good, and with them the Alt press that
 * showed and hid them. What the bar holds instead is what those menus performed, as controls and as
 * chords: the row leads with reload — the View menu's own Reload entry, drawn where a reader reaches for
 * it while looking at the page — and the six shortcuts survive through a listener that reads no menu at
 * all (`useWindowShortcuts`). DevTools and actual size stay keyboard-only: a bar with a glyph for every
 * entry a menu listed would be a bar nobody read.
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
 * row's one control that is not about how the window looks. The row is read in groups — reload, zoom,
 * layout, theme, update, terminal — and every seam between them carries the same hairline, so the
 * divider says which group the toggle belongs to rather than that it is an exception to the rest of the
 * row. It reports a state rather than an action — pressed while the panel is showing — and that state is
 * the persisted flag and nothing else, so what the glyph says cannot drift from what the panel below is
 * doing.
 *
 * The gaps and the rules are one grid rather than two decisions: the same token that separates two icons
 * of a group is the token the rails use between theirs (`app/shell/chrome.ts`), and a rule is drawn only
 * at a seam, so what a reader sees between two glyphs is either a small gap or a group boundary and never
 * an accident of margins.
 *
 * The zoom ladder and fullscreen are the acts the View menu's own zoom and fullscreen entries performed,
 * unchanged by its removal. Nothing here remembers a level — each press dispatches its act and the
 * window's own page stays the only thing that knows what size it is drawn at — so they are buttons and
 * tooltips and no state at all.
 */
export function Titlebar() {
  const platform = useWindowStore((s) => s.platform)
  const isMac = platform === 'darwin'

  useWindowShortcuts()

  return (
    <header
      className={cn(
        'relative flex shrink-0 items-center border-b border-border bg-card select-none [-webkit-app-region:drag]',
        CHROME_BAND_HEIGHT,
        isMac && 'pl-20'
      )}
    >
      <div className="flex items-center gap-2.5 pl-3 [-webkit-app-region:no-drag]">
        {/* The native traffic lights already anchor the left edge on macOS, where a same-sized dot
            beside them just reads as a fourth window control. */}
        {!isMac && <span className="size-3.25 rounded-lg bg-brand ring-[3px] ring-brand/20" />}
      </div>

      {/* No words in the bar: the window's own title says what the window is, and a second copy of it in
          the middle of the chrome is a label nobody reads twice. The bar itself is still the drag region,
          which is why nothing replaced the span — the space it took is the space the drag region keeps. */}
      <div className={cn('ml-auto flex items-center [-webkit-app-region:no-drag]', CHROME_ICON_GAP)}>
        <ReloadAction />
        <TitlebarGroupSeparator />
        <ZoomActions />
        <TitlebarGroupSeparator />
        <FullscreenAction />
        <TitlebarGroupSeparator />
        <ThemeToggle />
        <ThemeButton />
        <BrightnessButton />
        <ContrastButton />
        {/* The update group draws its own rule, so a bar with no badge in it carries no bare seam: the
            badge is absent outside a packaged build, and two rules with nothing between them is what
            that used to look like. */}
        <UpdateBadge />
        <TerminalPanelToggle />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}

/**
 * One view action: the row's own square control, under the tooltip that names it and its chord.
 *
 * The words come from the shortcut table rather than from a menu, and from the same row the listener
 * resolves against: a tooltip that taught a chord the listener did not answer would be the one defect a
 * row of glyphs cannot afford. All four of these buttons name an accelerator now — the View menu listed
 * none for the ladder, so before this phase their tooltips were the label alone.
 */
function ViewAction({
  command,
  onClick,
  children,
}: {
  command: WindowCommand
  onClick: () => void
  children: ReactNode
}) {
  const { label, accelerator } = windowShortcut(command)

  return (
    <ControlTooltip label={`${label} (${accelerator})`}>
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
 * Reload, leading the row: the View menu's own Reload entry, kept where a reader reaches for it.
 *
 * `web.reload` is the command that entry called, reused rather than reimplemented, which is what makes
 * the menu's removal a move of its behaviour onto the bar instead of a second reload of the shell's own
 * making. The glyph is the arrow coming round on itself that every browser puts on the same act, and the
 * chord in its tooltip is the one the listener answers, read from the same table.
 */
function ReloadAction() {
  return (
    <ViewAction command="reload" onClick={() => conveyor.web.reload()}>
      <RotateCw className="size-4" />
    </ViewAction>
  )
}

/**
 * The zoom ladder, in the order a page's size runs: gaining, losing, and back to the size it was drawn at.
 *
 * A fragment rather than a wrapping element: the three are buttons of the row, level with the groups
 * beside them, and a box around them would put a gap in the row where there is none between any of the
 * others. Actual Size belongs to this group rather than to the one after it — it is a level, and the
 * next group is about where the window is put.
 */
function ZoomActions() {
  return (
    <>
      <ViewAction command="zoomIn" onClick={() => conveyor.window.zoomIn()}>
        <ZoomIn className="size-4" />
      </ViewAction>
      <ViewAction command="zoomOut" onClick={() => conveyor.window.zoomOut()}>
        <ZoomOut className="size-4" />
      </ViewAction>
      <ViewAction command="actualSize" onClick={() => conveyor.window.resetZoom()}>
        <Ratio className="size-4" />
      </ViewAction>
    </>
  )
}

/**
 * Where the window is put: the window's own corners, in a group of its own after the ladder.
 *
 * It is one control because the titlebar has no other: a panel is opened from the right rail and put
 * away from its own header, so the layout group this row can honestly draw is fullscreen alone. The rule
 * before it is the seam the old row drew between zoom and fullscreen, promoted from a division inside
 * one group to a boundary between two — the ladder is what a reader changes while reading, fullscreen is
 * where the window is put, and now that reload leads the row the two read as the two subjects they are.
 */
function FullscreenAction() {
  return (
    <ViewAction command="toggleFullscreen" onClick={() => conveyor.window.toggleFullscreen()}>
      <Maximize className="size-4" />
    </ViewAction>
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
      <TitlebarGroupSeparator />
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
