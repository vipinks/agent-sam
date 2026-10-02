import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineModule, query, command, event } from '../init'
import { ConveyorError, createEmitter } from 'electron-conveyor/main'
import { FULLSCREEN_UNAVAILABLE, ZOOM_UNAVAILABLE, zoomNext, type ZoomDirection } from '../protocol/window'

/**
 * Run a window act, turning anything it raises into this app's own refusal code.
 *
 * The handle is a live electron object, and the failure mode that matters is the one no caller can see
 * coming: a window that has been destroyed throws its own sentence at the very property access, and a
 * page that refuses a zoom level throws another. Both are messages about electron's internals, and the
 * renderer branches on codes, so neither may travel out of this module wearing one.
 */
function windowAct(code: string, message: string, act: () => void): void {
  try {
    act()
  } catch (err) {
    // A refusal raised by the act itself is more precise than this one and passes through: it already
    // carries a code.
    if (err instanceof ConveyorError) throw err
    throw new ConveyorError(code, message)
  }
}

/**
 * One zoom act, applied to the window's own page.
 *
 * `ctx.window` is the handle every other act in this module uses, and its web contents are the page
 * those acts are for: the level read is that page's, and the level written is the rule's next one. The
 * original size is a level rather than an absence of one, so a reset is this same act with a different
 * direction.
 */
export function applyZoom(win: BrowserWindow | null | undefined, direction: ZoomDirection): void {
  windowAct(ZOOM_UNAVAILABLE, 'This window cannot be zoomed right now.', () => {
    const contents = win?.webContents
    if (!contents) throw new ConveyorError(ZOOM_UNAVAILABLE, 'There is no window to zoom.')
    contents.setZoomLevel(zoomNext(contents.getZoomLevel(), direction))
  })
}

/**
 * The fullscreen act, on the same handle.
 *
 * The window's own answer is the only state consulted, and nothing about it is remembered here: a
 * toggle read off a stored flag would drift from the window the moment anything else changed it — the
 * OS's own fullscreen gesture, a native menu elsewhere, or another act on the same window.
 */
export function toggleWindowFullscreen(win: BrowserWindow | null | undefined): void {
  windowAct(FULLSCREEN_UNAVAILABLE, 'This window cannot go fullscreen right now.', () => {
    if (!win) throw new ConveyorError(FULLSCREEN_UNAVAILABLE, 'There is no window to make fullscreen.')
    win.setFullScreen(!win.isFullScreen())
  })
}

export const windowModule = defineModule({
  init: query(({ ctx }) => {
    const win = ctx.window
    if (!win) throw new Error('window.init called without an owning window')
    const { width, height } = win.getBounds()
    return {
      width,
      height,
      minimizable: win.isMinimizable(),
      maximizable: win.isMaximizable(),
      platform: process.platform,
    }
  }),

  isMinimizable: query(({ ctx }) => ctx.window?.isMinimizable() ?? false),
  isMaximizable: query(({ ctx }) => ctx.window?.isMaximizable() ?? false),

  /**
   * Whether the window this call came from is maximized, right now.
   *
   * `onMaximizeChange` carries every change *after* a renderer subscribes, and nothing about the window
   * a launch already found — so a window that is maximized before the first paint would never be
   * reported as such. This is the read that answers for the window as it already is; the event keeps
   * the answer current from then on.
   */
  isMaximized: query(({ ctx }) => ctx.window?.isMaximized() ?? false),

  minimize: command(({ ctx }) => {
    ctx.window?.minimize()
  }),

  maximize: command(({ ctx }) => {
    ctx.window?.maximize()
  }),

  close: command(({ ctx }) => {
    ctx.window?.close()
  }),

  maximizeToggle: command(({ ctx }) => {
    const win = ctx.window
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  }),

  /**
   * The four view acts the titlebar's own buttons call: the zoom ladder, its reset, and fullscreen.
   *
   * They act on the window rather than on the calling frame — `ctx.window`, like every act above — so a
   * click on one window's chrome zooms that window's page and no other. The View menu reaches the same
   * four behaviours through `web.*`, which acts on `ctx.sender` and has no bound on the level; these are
   * the same acts with the rule's bounds on them, which is what makes a held-down button stop at the end
   * of the ladder instead of walking off it.
   */
  zoomIn: command(({ ctx }) => applyZoom(ctx.window, 'in')),
  zoomOut: command(({ ctx }) => applyZoom(ctx.window, 'out')),
  resetZoom: command(({ ctx }) => applyZoom(ctx.window, 'reset')),
  toggleFullscreen: command(({ ctx }) => toggleWindowFullscreen(ctx.window)),

  // main → renderer push
  onFocusChange: event(z.boolean()),
  onMaximizeChange: event(z.boolean()),
})

/** Wire this window's native events to the module's push emitters. */
export function setupWindowEvents(win: BrowserWindow): void {
  const emit = createEmitter(windowModule, win)
  win.on('focus', () => emit.onFocusChange(true))
  win.on('blur', () => emit.onFocusChange(false))
  win.on('maximize', () => emit.onMaximizeChange(true))
  win.on('unmaximize', () => emit.onMaximizeChange(false))
}
